// Stale-sync / broken-connection email alert for the Plaid pipeline.
//
// Runs on a daily pg_cron schedule (see docs/setup-sync-watchdog.sql). Emails
// leo@honeyera.com via Resend when EITHER:
//   - no Plaid item has synced in STALE_HOURS (the daily sync has stopped), or
//   - one or more bank connections need to be reconnected (needs_reauth).
// Authenticated by the x-cron-secret header (CRON_SECRET).
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

    const { data: items } = await admin
      .from("plaid_items")
      .select("institution_name, status, last_synced_at");

    const active = (items ?? []).filter((i: any) => i.status !== "removed");
    const stamps = active.map((i: any) => i.last_synced_at).filter(Boolean) as string[];
    const latest = stamps.map((s) => new Date(s).getTime()).sort((a, b) => b - a)[0] ?? null;
    const hoursAgo = latest ? (Date.now() - latest) / 3_600_000 : Infinity;
    const stale = hoursAgo >= STALE_HOURS;

    const needsReauth = active
      .filter((i: any) => i.status === "needs_reauth")
      .map((i: any) => i.institution_name ?? "a bank");

    if (!stale && needsReauth.length === 0) {
      return new Response(JSON.stringify({ ok: true, stale: false, hoursAgo: Math.round(hoursAgo) }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 500 });
    }

    const daysAgo = latest ? Math.floor(hoursAgo / 24) : null;
    const lastStr = latest ? new Date(latest).toUTCString() : "unknown";

    const subject = needsReauth.length
      ? `⚠️ Cardtracker: ${needsReauth.length} bank connection${needsReauth.length === 1 ? "" : "s"} need${needsReauth.length === 1 ? "s" : ""} reconnecting`
      : `⚠️ Cardtracker hasn't synced in ${daysAgo != null ? `${daysAgo} day${daysAgo === 1 ? "" : "s"}` : "a while"}`;

    let html = `<p><strong>Cardtracker needs attention.</strong></p>`;
    if (stale) {
      html +=
        `<p>The last successful Plaid sync was <strong>${lastStr}</strong>` +
        `${daysAgo != null ? ` (${daysAgo} day${daysAgo === 1 ? "" : "s"} ago)` : ""}. ` +
        `Balances and transactions may be out of date.</p>`;
    }
    if (needsReauth.length) {
      html +=
        `<p>These bank connections need to be reconnected (their login expired or ` +
        `requires re-verification):</p><ul>` +
        needsReauth.map((n) => `<li>${n}</li>`).join("") +
        `</ul><p>Open <a href="https://cardtracker.honeyera.com">cardtracker.honeyera.com</a> → ` +
        `<strong>Connect bank</strong> to reconnect them.</p>`;
    } else {
      html += `<p>Open <a href="https://cardtracker.honeyera.com">cardtracker.honeyera.com</a> and click <strong>Sync now</strong>, or check that the daily sync is still scheduled.</p>`;
    }

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

    console.log(`Watchdog email sent to ${RECIPIENT}; stale=${stale}, needsReauth=${needsReauth.length}`);
    return new Response(JSON.stringify({ ok: true, stale, daysAgo, needsReauth, emailed: RECIPIENT, id: body.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("sync-watchdog error:", error);
    return new Response(JSON.stringify({ error: String((error as Error)?.message ?? error) }), { status: 500 });
  }
});
