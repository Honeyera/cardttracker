// Stale-sync email alert.
//
// Runs on a daily pg_cron schedule (see docs/setup-sync-watchdog.sql). Checks
// the most recent finance sync (credit_cards.finance_synced_at and
// accounts.updated_at) and emails leo@honeyera.com via Resend if the data is
// 2+ days old. Authenticated by the x-cron-secret header (CRON_SECRET).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STALE_HOURS = 48;
const RECIPIENT = "leo@honeyera.com";

serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const [{ data: cards }, { data: accts }] = await Promise.all([
      admin.from("credit_cards").select("finance_synced_at").order("finance_synced_at", { ascending: false }).limit(1),
      admin.from("accounts").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    ]);
    const stamps = [cards?.[0]?.finance_synced_at, accts?.[0]?.updated_at].filter(Boolean) as string[];
    const latest = stamps.map((s) => new Date(s).getTime()).sort((a, b) => b - a)[0] ?? null;

    const hoursAgo = latest ? (Date.now() - latest) / 3_600_000 : Infinity;
    const stale = hoursAgo >= STALE_HOURS;

    if (!stale) {
      return new Response(JSON.stringify({ stale: false, hoursAgo: Math.round(hoursAgo) }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 500 });
    }

    const daysAgo = latest ? Math.floor(hoursAgo / 24) : null;
    const lastStr = latest ? new Date(latest).toUTCString() : "unknown";
    const subject = `⚠️ Cardtracker hasn't synced in ${daysAgo != null ? `${daysAgo} day${daysAgo === 1 ? "" : "s"}` : "a while"}`;
    const html =
      `<p><strong>Your Cardtracker data is stale.</strong></p>` +
      `<p>The last finance sync was <strong>${lastStr}</strong>` +
      `${daysAgo != null ? ` (${daysAgo} day${daysAgo === 1 ? "" : "s"} ago)` : ""}.</p>` +
      `<p>Balances and transactions may be out of date. Run the sync in ChatGPT to refresh, ` +
      `then check <a href="https://cardtracker.honeyera.com">cardtracker.honeyera.com</a>.</p>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "CardTrack <cardtrack@honeyera.com>", to: [RECIPIENT], subject, html }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.error("Resend error:", body);
      return new Response(JSON.stringify({ error: "Failed to send email", details: body }), { status: 502 });
    }

    console.log(`Stale-sync email sent to ${RECIPIENT}; last sync ${lastStr}`);
    return new Response(JSON.stringify({ stale: true, daysAgo, emailed: RECIPIENT, id: body.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("sync-watchdog error:", error);
    return new Response(JSON.stringify({ error: String((error as Error)?.message ?? error) }), { status: 500 });
  }
});
