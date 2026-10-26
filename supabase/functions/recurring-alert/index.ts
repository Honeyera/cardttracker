// New-recurring-charge email alerts.
//
// Runs daily on pg_cron (see docs/setup-recurring-alerts.sql). Detects recurring
// charges from the full transaction history (same logic as src/utils/recurring.ts
// — keep in sync), and emails (via Resend) when a NEW one first appears, so a
// subscription you forgot you signed up for surfaces on its own.
//
// Dedup: each detected series has a stable signature stored in known_recurring.
// On the very first run the table is empty, so it emails the FULL current list
// (a "here's everything you're paying for" digest) and seeds the table; after
// that it only emails genuinely new series. POST {"test":true} previews the full
// current list without touching the table.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Recurring detection (ported from src/utils/recurring.ts) ──────────────
type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "semiannual" | "yearly";
interface Txn { date: string; description: string; merchantName: string | null; amount: number; type: string; creditCardId: string | null; accountId: string | null }
interface Recurring { key: string; label: string; cadence: Cadence; typicalAmount: number; count: number; lastDate: string; nextExpectedDate: string; monthlyEquivalent: number; source: string | null; possible: boolean }

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function normalizeKey(t: Txn): string {
  if (t.merchantName && t.merchantName.trim()) return t.merchantName.trim().toLowerCase();
  return (t.description || "").toLowerCase().replace(/\*.*/, " ").replace(/#?\d{2,}/g, " ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}
function cadenceFor(g: number): Cadence | null {
  if (g >= 5 && g <= 9) return "weekly";
  if (g >= 10 && g <= 18) return "biweekly";
  if (g >= 19 && g <= 45) return "monthly";
  if (g >= 46 && g <= 135) return "quarterly";
  if (g >= 150 && g <= 250) return "semiannual";
  if (g >= 300 && g <= 430) return "yearly";
  return null;
}
const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30.44, quarterly: 91.3, semiannual: 182.6, yearly: 365 };
const CADENCE_LABEL: Record<Cadence, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", quarterly: "Quarterly", semiannual: "Every 6 months", yearly: "Yearly" };

function detectRecurring(transactions: Txn[]): Recurring[] {
  const charges = transactions.filter((t) => t.type === "expense" || t.type === "fee");
  const groups = new Map<string, Txn[]>();
  for (const t of charges) {
    const key = normalizeKey(t);
    if (!key || key.length < 3) continue;
    const gkey = `${key}::${t.creditCardId ?? t.accountId ?? "none"}`;
    (groups.get(gkey) ?? groups.set(gkey, []).get(gkey)!).push(t);
  }
  const out: Recurring[] = [];
  for (const [gkey, txns] of groups) {
    if (txns.length < 2) continue;
    const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
    const byDate: Txn[] = [];
    for (const t of sorted) if (!byDate.length || byDate[byDate.length - 1].date !== t.date) byDate.push(t);
    if (byDate.length < 2) continue;
    const possible = byDate.length < 3;
    const gaps: number[] = [];
    for (let i = 1; i < byDate.length; i++) gaps.push(daysBetween(byDate[i - 1].date, byDate[i].date));
    const medGap = median(gaps);
    const cadence = cadenceFor(medGap);
    if (!cadence) continue;
    const consistent = gaps.filter((g) => Math.abs(g - medGap) <= Math.max(4, medGap * 0.4)).length;
    if (consistent / gaps.length < 0.6) continue;
    const amounts = txns.map((t) => t.amount);
    const medAmt = median(amounts);
    if (medAmt <= 0) continue;
    const nearMedian = amounts.filter((a) => Math.abs(a - medAmt) <= Math.max(2, medAmt * 0.25)).length;
    if (nearMedian / amounts.length < 0.6) continue;
    if (possible) {
      if (cadence !== "weekly" && cadence !== "biweekly" && cadence !== "monthly") continue;
      if (Math.abs(amounts[0] - amounts[1]) > Math.max(1, medAmt * 0.12)) continue;
    }
    const last = byDate[byDate.length - 1];
    if (daysBetween(last.date, new Date().toISOString().slice(0, 10)) > 90) continue;
    out.push({
      key: gkey,
      label: titleCase((last.merchantName || last.description || "Charge").toLowerCase()).slice(0, 48),
      cadence,
      typicalAmount: medAmt,
      count: txns.length,
      lastDate: last.date,
      nextExpectedDate: addDays(last.date, Math.round(medGap)),
      monthlyEquivalent: medAmt * (30.44 / CADENCE_DAYS[cadence]),
      source: last.creditCardId ?? last.accountId ?? null,
      possible,
    });
  }
  return out.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
  }
  let test = false;
  try { const b = await req.json(); test = b?.test === true; } catch { /* no body */ }

  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Pull the full transaction history (1000-row API cap → page through).
    const rows: any[] = [];
    for (let offset = 0; offset < 200000; offset += 1000) {
      const { data, error } = await db
        .from("transactions")
        .select("transaction_date, description, merchant_name, amount, transaction_type, credit_card_id, account_id")
        .order("transaction_date", { ascending: false })
        .range(offset, offset + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const txns: Txn[] = rows.map((t) => ({
      date: t.transaction_date, description: t.description ?? "", merchantName: t.merchant_name ?? null,
      amount: Number(t.amount) || 0, type: t.transaction_type ?? "expense",
      creditCardId: t.credit_card_id ?? null, accountId: t.account_id ?? null,
    }));

    // Only alert on CONFIRMED series (3+ charges) — "possible" 2-charge guesses
    // would be too noisy for a proactive email.
    const detected = detectRecurring(txns).filter((r) => !r.possible);

    const { data: knownRows, error: knownErr } = await db.from("known_recurring").select("signature");
    if (knownErr) throw knownErr;
    const known = new Set((knownRows ?? []).map((r) => r.signature as string));
    const firstRun = known.size === 0;

    // What to email: on first run everything (a full digest + seed); otherwise
    // only series we haven't recorded yet. Test mode always shows everything.
    const toEmail = test ? detected : detected.filter((r) => !known.has(r.key));
    if (!test && !firstRun && toEmail.length === 0) {
      return new Response(JSON.stringify({ ok: true, detected: detected.length, new: 0 }), { status: 200, headers: corsHeaders });
    }
    if (toEmail.length === 0) {
      return new Response(JSON.stringify({ ok: true, detected: 0, new: 0 }), { status: 200, headers: corsHeaders });
    }

    // Label each with its card/account.
    const cardIds = [...new Set(detected.map((r) => r.source).filter(Boolean))] as string[];
    const nameBySource = new Map<string, string>();
    if (cardIds.length) {
      const [{ data: cards }, { data: accounts }] = await Promise.all([
        db.from("credit_cards").select("id, name, last_four").in("id", cardIds),
        db.from("accounts").select("id, name, last_four").in("id", cardIds),
      ]);
      for (const c of cards ?? []) nameBySource.set(c.id, `${c.name}${c.last_four ? ` ••${c.last_four}` : ""}`);
      for (const a of accounts ?? []) nameBySource.set(a.id, `${a.name}${a.last_four ? ` ••${a.last_four}` : ""}`);
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const recipients = (Deno.env.get("RECURRING_ALERT_RECIPIENTS") ?? Deno.env.get("ALERT_EMAIL_RECIPIENTS") ?? "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (!resendKey || recipients.length === 0) {
      return new Response(JSON.stringify({ error: "email config missing (RESEND_API_KEY / RECURRING_ALERT_RECIPIENTS)" }), { status: 500, headers: corsHeaders });
    }

    const monthlyTotal = toEmail.reduce((s, r) => s + r.monthlyEquivalent, 0);
    const prefix = test ? "[TEST] " : "";
    const subject = firstRun && !test
      ? `${prefix}🔁 Now tracking ${toEmail.length} recurring charge${toEmail.length === 1 ? "" : "s"} · ${fmt(monthlyTotal)}/mo`
      : test
        ? `${prefix}🔁 Your ${toEmail.length} recurring charge${toEmail.length === 1 ? "" : "s"} · ${fmt(monthlyTotal)}/mo`
        : `${prefix}🔁 ${toEmail.length} new recurring charge${toEmail.length === 1 ? "" : "s"} detected · +${fmt(monthlyTotal)}/mo`;

    const rowsHtml = toEmail.map((r) => `
      <tr>
        <td style="padding:10px 0;border-top:1px solid #eee;">
          <div style="font-weight:600;color:#111;">${escapeHtml(r.label)}</div>
          <div style="font-size:13px;color:#555;">${CADENCE_LABEL[r.cadence]} · ${r.count}× · next ~${r.nextExpectedDate}${r.source && nameBySource.get(r.source) ? ` · ${escapeHtml(nameBySource.get(r.source)!)}` : ""}</div>
        </td>
        <td style="padding:10px 0;border-top:1px solid #eee;text-align:right;white-space:nowrap;">
          <div style="font-weight:700;color:#111;">${fmt(r.typicalAmount)}</div>
          <div style="font-size:12px;color:#777;">${fmt(r.monthlyEquivalent * 12)}/yr</div>
        </td>
      </tr>`).join("");
    const intro = firstRun && !test
      ? "Here is everything on a recurring schedule we found in your history — a good moment to cancel anything you forgot about. You'll only be emailed about NEW ones from now on."
      : test
        ? "Snapshot of every recurring charge currently detected:"
        : "These started repeating and weren't on your list before:";
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 4px;color:#111;">${escapeHtml(subject)}</h2>
        <p style="font-size:14px;color:#555;margin:0 0 16px;">${intro}</p>
        <table style="width:100%;border-collapse:collapse;font-size:15px;">
          ${rowsHtml}
          <tr><td style="padding:12px 0;border-top:2px solid #333;font-weight:700;color:#111;">Total</td>
          <td style="padding:12px 0;border-top:2px solid #333;text-align:right;font-weight:700;color:#111;white-space:nowrap;">${fmt(monthlyTotal)}/mo · ${fmt(monthlyTotal * 12)}/yr</td></tr>
        </table>
        <p style="font-size:13px;color:#888;margin-top:20px;">Checked ${new Date().toISOString().slice(0, 10)}.</p>
      </div>`;
    const text = `${subject}\n\n` + toEmail.map((r) => `- ${r.label}: ${fmt(r.typicalAmount)} ${CADENCE_LABEL[r.cadence]} (${fmt(r.monthlyEquivalent * 12)}/yr)`).join("\n") + `\n\nTotal: ${fmt(monthlyTotal)}/mo`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "CardTrack Alerts <cardtrack@honeyera.com>", to: recipients, subject, html, text }),
    });
    if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);

    // Record the detected series so we don't re-alert (test mode records nothing).
    if (!test) {
      const upserts = detected.map((r) => ({ signature: r.key, label: r.label, amount: r.typicalAmount }));
      if (upserts.length) {
        const { error: insErr } = await db.from("known_recurring").upsert(upserts, { onConflict: "signature" });
        if (insErr) throw insErr;
      }
    }

    return new Response(JSON.stringify({ ok: true, test, firstRun, detected: detected.length, emailed: toEmail.length }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("recurring-alert failed", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
