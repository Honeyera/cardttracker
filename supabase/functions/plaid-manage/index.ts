// Lists and removes Plaid connections for the dashboard "Manage banks" UI.
//   { action: "list" }                 -> [{ item_id, institution_name, status, last_synced_at, last_error }]
//   { action: "remove", item_id }      -> deletes the item at Plaid + all its synced rows
// Auth: valid Supabase JWT (checked in-code).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, plaid } from "../_shared/plaid.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "list";

    if (action === "list") {
      const { data, error } = await admin
        .from("plaid_items")
        .select("item_id, institution_name, status, last_synced_at, last_error, access_token")
        .order("institution_name");
      if (error) return json({ error: error.message }, 500);
      // Attach each connection's card/account last-4s so duplicates are visible.
      const items = [];
      for (const it of data ?? []) {
        let masks: string[] = [];
        try {
          const a = await plaid("/accounts/get", { access_token: it.access_token });
          masks = (a.accounts ?? []).map((x: any) => x.mask).filter(Boolean);
        } catch (_) { /* leave masks empty if unreadable */ }
        items.push({
          item_id: it.item_id,
          institution_name: it.institution_name,
          status: it.status,
          last_synced_at: it.last_synced_at,
          last_error: it.last_error,
          masks,
        });
      }
      return json({ ok: true, items });
    }

    if (action === "remove") {
      if (!body.item_id) return json({ error: "item_id required" }, 400);
      const { data: item, error } = await admin
        .from("plaid_items")
        .select("access_token")
        .eq("item_id", body.item_id)
        .single();
      if (error || !item) return json({ error: "Unknown item_id" }, 404);

      // Find this item's accounts so we can clean up their synced rows.
      let plaidIds: string[] = [];
      try {
        const acctRes = await plaid("/accounts/get", { access_token: item.access_token });
        plaidIds = (acctRes.accounts ?? []).map((a: any) => a.account_id);
      } catch (_) {
        // Item may already be invalid; fall through and still remove the record.
      }

      if (plaidIds.length) {
        const { data: acctRows } = await admin.from("accounts").select("id").in("external_id", plaidIds);
        const { data: cardRows } = await admin
          .from("credit_cards")
          .select("id")
          .in("finance_external_account_id", plaidIds);
        const acctIds = (acctRows ?? []).map((r: any) => r.id);
        const cardIds = (cardRows ?? []).map((r: any) => r.id);

        if (acctIds.length) {
          await admin.from("transactions").delete().in("account_id", acctIds);
          await admin.from("balance_snapshots").delete().in("account_id", acctIds);
        }
        if (cardIds.length) await admin.from("transactions").delete().in("credit_card_id", cardIds);
        await admin.from("accounts").delete().in("external_id", plaidIds);
        await admin.from("credit_cards").delete().in("finance_external_account_id", plaidIds);
      }

      // Invalidate the item at Plaid (best-effort), then drop our record.
      try {
        await plaid("/item/remove", { access_token: item.access_token });
      } catch (_) {
        // ignore — removing our record is what matters for the app
      }
      await admin.from("plaid_items").delete().eq("item_id", body.item_id);

      return json({ ok: true, removed: body.item_id });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error("plaid-manage error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
