// Urgent-attention email alerts.
//
// Runs on a daily pg_cron schedule (see docs/setup-attention-alerts.sql).
// Emails (via Resend, same setup as send-points-email) a digest of cards that
// urgently need attention:
//   • overdue  — the card is past due with a balance still owed, or the issuer
//                flagged it overdue (credit_cards.is_overdue)
//   • due soon — a statement balance is owed and the payment is due within
//                ATTENTION_DUE_WINDOW_DAYS, and it isn't already covered by
//                payments made since the statement closed
//
// Dedup: each urgent occurrence has a signature that includes the due date, so
// it emails exactly once per cycle. Signatures live in attention_alerts; a new
// statement/due date produces a new signature and re-alerts next cycle.
//
// This mirrors the dashboard's "Due this week" / "Needs Attention" logic in
// src/pages/Dashboard.tsx — keep the two roughly in sync.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DUE_WINDOW_DAYS = 3; // "due soon" = unpaid statement due within N days

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const todayUTC = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};
const daysBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 86_400_000);

serve(async (req) => {
  // verify_jwt is off (cron caller) — require the shared secret instead.
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  try {
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const today = todayUTC();

    const { data: cards, error: cardsErr } = await db
      .from("credit_cards")
      .select("id, name, last_four, is_overdue, current_balance, last_statement_balance, minimum_payment, next_payment_due_date, last_statement_date");
    if (cardsErr) throw cardsErr;

    type Urgent = { kind: "overdue" | "due"; sig: string; name: string; last4: string; owed: number; due: Date | null; days: number | null };
    const urgent: Urgent[] = [];

    for (const c of cards ?? []) {
      // What's owed this cycle: the statement balance, falling back to the full
      // balance. Nothing owed → nothing to alert.
      const stmt = Number(c.last_statement_balance) > 0.005
        ? Number(c.last_statement_balance)
        : Number(c.current_balance) || 0;
      if (stmt <= 0.005) continue;

      // Subtract payments made since the statement closed, so a statement that
      // was already paid doesn't trigger a false alert.
      let paid = 0;
      if (c.last_statement_date) {
        const { data: pays, error: payErr } = await db
          .from("transactions")
          .select("amount")
          .eq("credit_card_id", c.id)
          .eq("transaction_type", "payment")
          .gte("transaction_date", c.last_statement_date);
        if (payErr) throw payErr;
        paid = (pays ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      }
      const owed = stmt - paid;
      if (owed <= 0.005) continue; // statement covered

      const due = c.next_payment_due_date ? new Date(`${c.next_payment_due_date}T00:00:00Z`) : null;
      const days = due ? daysBetween(due, today) : null;
      const overdue = c.is_overdue === true || (days != null && days < 0);
      const dueSoon = days != null && days >= 0 && days <= DUE_WINDOW_DAYS;
      if (!overdue && !dueSoon) continue;

      const kind = overdue ? "overdue" : "due";
      const cycle = c.next_payment_due_date ?? c.last_statement_date ?? "na";
      urgent.push({
        kind,
        sig: `${kind}:${c.id}:${cycle}`,
        name: c.name,
        last4: c.last_four ?? "",
        owed,
        due,
        days,
      });
    }

    if (urgent.length === 0) {
      return new Response(JSON.stringify({ ok: true, urgent: 0, sent: 0 }), { status: 200 });
    }

    // Only email items we haven't already emailed this cycle.
    const { data: already, error: ledErr } = await db
      .from("attention_alerts")
      .select("signature")
      .in("signature", urgent.map((u) => u.sig));
    if (ledErr) throw ledErr;
    const done = new Set((already ?? []).map((r) => r.signature as string));
    const toSend = urgent.filter((u) => !done.has(u.sig));
    if (toSend.length === 0) {
      return new Response(JSON.stringify({ ok: true, urgent: urgent.length, sent: 0 }), { status: 200 });
    }

    // Sort worst-first: overdue, then soonest due.
    toSend.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "overdue" ? -1 : 1;
      return (a.days ?? 99) - (b.days ?? 99);
    });

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const recipients = (Deno.env.get("ALERT_EMAIL_RECIPIENTS") ?? "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (!resendKey || recipients.length === 0) {
      console.error("Email config missing", { hasKey: !!resendKey, recipients: recipients.length });
      return new Response(JSON.stringify({ error: "email config missing (RESEND_API_KEY / ALERT_EMAIL_RECIPIENTS)" }), { status: 500 });
    }

    const overdueCount = toSend.filter((u) => u.kind === "overdue").length;
    const total = toSend.reduce((s, u) => s + u.owed, 0);
    const subject = overdueCount > 0
      ? `🚨 ${overdueCount} overdue card${overdueCount === 1 ? "" : "s"} — ${fmt(total)} needs attention`
      : `⚠️ ${toSend.length} card${toSend.length === 1 ? "" : "s"} due soon — ${fmt(total)}`;

    const rows = toSend.map((u) => {
      const when = u.kind === "overdue"
        ? "OVERDUE"
        : u.days === 0 ? "Due today" : u.days === 1 ? "Due in 1 day" : `Due in ${u.days} days`;
      const dueStr = u.due ? u.due.toISOString().slice(0, 10) : "—";
      const color = u.kind === "overdue" ? "#b91c1c" : "#b45309";
      return `
        <tr>
          <td style="padding:10px 0;border-top:1px solid #eee;">
            <div style="font-weight:600;color:#111;">${escapeHtml(u.name)} <span style="color:#888;font-weight:400;">•••• ${escapeHtml(u.last4)}</span></div>
            <div style="font-size:13px;color:${color};font-weight:600;">${when}${u.kind === "overdue" ? "" : ` · ${dueStr}`}</div>
          </td>
          <td style="padding:10px 0;border-top:1px solid #eee;text-align:right;font-weight:700;color:#111;white-space:nowrap;">${fmt(u.owed)}</td>
        </tr>`;
    }).join("");

    const checkedAt = new Date().toISOString().slice(0, 10);
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:540px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 4px;color:${overdueCount > 0 ? "#b91c1c" : "#b45309"};">${escapeHtml(subject)}</h2>
        <p style="font-size:14px;color:#555;margin:0 0 16px;">The following need attention on your cards:</p>
        <table style="width:100%;border-collapse:collapse;font-size:15px;">
          ${rows}
          <tr>
            <td style="padding:12px 0;border-top:2px solid #333;font-weight:700;color:#111;">Total to pay</td>
            <td style="padding:12px 0;border-top:2px solid #333;text-align:right;font-weight:700;color:#111;">${fmt(total)}</td>
          </tr>
        </table>
        <p style="font-size:13px;color:#888;margin-top:20px;">Checked ${checkedAt} · Open the dashboard to review and pay. You'll only get this once per card per statement cycle.</p>
      </div>`;
    const text = `${subject}\n\n`
      + toSend.map((u) => {
          const when = u.kind === "overdue" ? "OVERDUE" : u.days === 0 ? "due today" : `due in ${u.days} day(s)`;
          return `- ${u.name} ••${u.last4}: ${fmt(u.owed)} (${when})`;
        }).join("\n")
      + `\n\nTotal to pay: ${fmt(total)}\nChecked ${checkedAt}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "CardTrack Alerts <cardtrack@honeyera.com>",
        to: recipients,
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);

    const { error: insErr } = await db.from("attention_alerts").insert(
      toSend.map((u) => ({ signature: u.sig, card_name: u.name, owed: u.owed })),
    );
    if (insErr) throw insErr;

    return new Response(JSON.stringify({ ok: true, urgent: urgent.length, sent: toSend.length }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("attention-alert failed", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
