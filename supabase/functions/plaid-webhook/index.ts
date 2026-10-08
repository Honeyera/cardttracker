// Plaid webhook receiver. Plaid calls this when new data is ready (e.g. the
// initial/historical transaction pull completes, or ongoing updates arrive).
// On a relevant TRANSACTIONS or ITEM webhook for an item we know, it triggers a
// full sync by calling plaid-sync with the CRON_SECRET.
//
// Public endpoint (Plaid is unauthenticated to us); we ignore webhooks for item
// ids we don't have, and the sync it triggers is idempotent.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/plaid.ts";

const SYNC_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
  "DEFAULT_UPDATE",
  "TRANSACTIONS_REMOVED",
]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { webhook_type, webhook_code, item_id } = body ?? {};

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Only act on items we actually track.
    if (item_id) {
      const { data: item } = await admin.from("plaid_items").select("item_id").eq("item_id", item_id).single();
      if (!item) return json({ ok: true, ignored: "unknown item" });
    }

    const shouldSync =
      (webhook_type === "TRANSACTIONS" && SYNC_CODES.has(webhook_code)) ||
      (webhook_type === "ITEM" && webhook_code === "NEW_ACCOUNTS_AVAILABLE");

    if (shouldSync) {
      // Fire a full sync (idempotent). plaid-sync authenticates via CRON_SECRET.
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/plaid-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "" },
        body: "{}",
      });
      return json({ ok: true, synced: true, webhook_code });
    }

    return json({ ok: true, synced: false, webhook_code });
  } catch (error) {
    console.error("plaid-webhook error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
