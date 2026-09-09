// Ad-spend cap alerts.
//
// Runs on a daily pg_cron schedule (see docs/setup-ad-spend-alerts.sql).
// Computes calendar-year ad spend per tracked card and emails (via Resend,
// same setup as send-points-email) when a threshold is crossed. Each
// (card, year, threshold) emails exactly once — dedup rows live in the
// ad_spend_alerts table.
//
// NOTE: the merchant patterns and card limits mirror src/utils/adSpend.ts —
// keep the two in sync.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AD_SPEND_LIMITS: { cardMatch: RegExp; annualLimit: number }[] = [
  { cardMatch: /amex|american express/i, annualLimit: 150_000 },
];
const THRESHOLDS = [0.8, 0.9, 1.0];

const AD_PATTERNS: RegExp[] = [
  /google\s*ads|googleads|adwords|google\s*adw/i,
  /facebk.*ads|facebook\s*ads?\b|meta\s*ads?\b|meta\s*platforms/i,
  /tiktok\s*ads?/i,
  /microsoft\s*ad|bing\s*ads?/i,
  /amazon\s*ad(vertising|s)/i,
  /linkedin\s*ads?/i,
  /pinterest\s*ads?/i,
  /snap(chat)?\s*ads?/i,
  /twitter\s*ads?|x\s*ads\b/i,
  /reddit\s*ads?/i,
  /taboola|outbrain|criteo/i,
  /advertis/i,
];

const isAd = (t: { merchant_name?: string | null; description?: string | null; category?: string | null }) => {
  const hay = `${t.merchant_name ?? ""} ${t.description ?? ""} ${t.category ?? ""}`;
  return AD_PATTERNS.some((p) => p.test(hay));
};

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

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

    const year = new Date().getFullYear();
    const from = `${year}-01-01`;

    const { data: cards, error: cardsErr } = await db
      .from("credit_cards").select("id, name, company_name");
    if (cardsErr) throw cardsErr;

    const tracked = (cards ?? []).flatMap((c) => {
      const rule = AD_SPEND_LIMITS.find((r) => r.cardMatch.test(`${c.name} ${c.company_name ?? ""}`));
      return rule ? [{ ...c, limit: rule.annualLimit }] : [];
    });
    if (tracked.length === 0) {
      return new Response(JSON.stringify({ ok: true, tracked: 0 }), { status: 200 });
    }

    const sent: unknown[] = [];
    for (const card of tracked) {
      // Page through the card's transactions for the year (1000-row API cap).
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; offset < 100000; offset += 1000) {
        const { data, error } = await db
          .from("transactions")
          .select("merchant_name, description, category, amount, transaction_type")
          .eq("credit_card_id", card.id)
          .gte("transaction_date", from)
          .range(offset, offset + 999);
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }

      let spent = 0;
      for (const t of rows) {
        if (!isAd(t)) continue;
        const amt = Number(t.amount) || 0;
        const type = String(t.transaction_type ?? "expense");
        if (type === "expense" || type === "fee") spent += amt;
        else if (type === "refund") spent -= amt;
      }
      spent = Math.max(0, spent);
      const fraction = spent / card.limit;

      // Highest threshold reached that hasn't been emailed for this year yet.
      const reached = THRESHOLDS.filter((t) => fraction >= t);
      if (reached.length === 0) continue;
      const { data: already } = await db
        .from("ad_spend_alerts").select("threshold")
        .eq("card_id", card.id).eq("year", year);
      const done = new Set((already ?? []).map((r) => Number(r.threshold)));
      const toSend = reached.filter((t) => !done.has(Math.round(t * 100)));
      if (toSend.length === 0) continue;
      const top = Math.max(...toSend);

      const over = fraction >= 1;
      const subject = over
        ? `🚨 ${card.name}: ad spend OVER the ${fmt(card.limit)} annual cap`
        : `⚠️ ${card.name}: ad spend at ${Math.round(fraction * 100)}% of the ${fmt(card.limit)} cap`;
      const line = over
        ? `${fmt(spent)} spent — ${fmt(spent - card.limit)} over the cap.`
        : `${fmt(spent)} of ${fmt(card.limit)} used · ${fmt(card.limit - spent)} remaining this year.`;

      const resendKey = Deno.env.get("RESEND_API_KEY");
      const recipients = (Deno.env.get("EMAIL_RECIPIENTS") ?? "")
        .split(",").map((e) => e.trim()).filter(Boolean);
      if (!resendKey || recipients.length === 0) {
        console.error("Email config missing", { hasKey: !!resendKey, recipients: recipients.length });
        return new Response(JSON.stringify({ error: "email config missing" }), { status: 500 });
      }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "CardTrack <onboarding@resend.dev>",
          to: recipients,
          subject,
          html: `
            <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
              <h2 style="margin:0 0 8px;color:${over ? "#b91c1c" : "#b45309"};">${subject}</h2>
              <p style="font-size:15px;color:#111;">${line}</p>
              <p style="font-size:13px;color:#555;">Card: ${card.name} · Year: ${year} · Checked ${new Date().toISOString().slice(0, 10)}</p>
              <p style="font-size:13px;color:#555;">Open the dashboard and click the card to review the matched ad transactions.</p>
            </div>`,
          text: `${subject}\n${line}\nCard: ${card.name} · Year: ${year}`,
        }),
      });
      if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);

      // Record every threshold covered by this email so lower ones don't re-fire.
      const { error: insErr } = await db.from("ad_spend_alerts").insert(
        toSend.map((t) => ({ card_id: card.id, year, threshold: Math.round(t * 100), spent })),
      );
      if (insErr) throw insErr;
      sent.push({ card: card.name, threshold: top, spent });
    }

    return new Response(JSON.stringify({ ok: true, tracked: tracked.length, sent }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ad-spend-alert failed", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
