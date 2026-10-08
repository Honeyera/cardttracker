// Exchanges a Plaid Link public_token for a long-lived access_token and stores
// the connection in plaid_items. Called right after the user finishes Plaid Link.
//
// Body: { public_token: "...", institution: { name, institution_id } }
// Auth: valid Supabase JWT (checked in-code).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, plaid, OWNER_USER_ID } from "../_shared/plaid.ts";

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

    const body = await req.json().catch(() => ({}));
    if (!body.public_token) return json({ error: "public_token required" }, 400);

    const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token });
    const access_token = ex.access_token as string;
    const item_id = ex.item_id as string;

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    // Ownership is fixed to the household owner so all data lands in one place
    // regardless of which household member linked the bank.
    const { error } = await admin.from("plaid_items").upsert(
      {
        user_id: OWNER_USER_ID,
        item_id,
        access_token,
        institution_name: body.institution?.name ?? null,
        institution_id: body.institution?.institution_id ?? null,
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "item_id" },
    );
    if (error) return json({ error: error.message }, 400);

    // De-dupe re-links: a new link to the same bank gets NEW Plaid account ids,
    // so the same physical cards/accounts would appear twice. Find any OTHER
    // active item whose accounts share a mask (last-4) with this new one and
    // remove it (and its now-duplicate synced rows), keeping the fresh link.
    const removedOld: string[] = [];
    try {
      const newAccts = await plaid("/accounts/get", { access_token });
      const newMasks = new Set((newAccts.accounts ?? []).map((a: any) => a.mask).filter(Boolean));

      const { data: others } = await admin
        .from("plaid_items")
        .select("item_id, access_token")
        .neq("item_id", item_id)
        .eq("status", "active");

      for (const other of others ?? []) {
        let overlap = false;
        let oldAccountIds: string[] = [];
        try {
          const oa = await plaid("/accounts/get", { access_token: other.access_token });
          const accts = oa.accounts ?? [];
          oldAccountIds = accts.map((a: any) => a.account_id);
          overlap = accts.some((a: any) => a.mask && newMasks.has(a.mask));
        } catch (_) {
          continue; // can't read old item; leave it alone
        }
        if (!overlap) continue;

        // This old item is superseded by the new link — clean it up.
        const { data: acctRows } = await admin.from("accounts").select("id").in("external_id", oldAccountIds);
        const { data: cardRows } = await admin.from("credit_cards").select("id").in("finance_external_account_id", oldAccountIds);
        const acctIds = (acctRows ?? []).map((r: any) => r.id);
        const cardIds = (cardRows ?? []).map((r: any) => r.id);
        if (acctIds.length) {
          await admin.from("transactions").delete().in("account_id", acctIds);
          await admin.from("balance_snapshots").delete().in("account_id", acctIds);
        }
        if (cardIds.length) await admin.from("transactions").delete().in("credit_card_id", cardIds);
        await admin.from("accounts").delete().in("external_id", oldAccountIds);
        await admin.from("credit_cards").delete().in("finance_external_account_id", oldAccountIds);
        try { await plaid("/item/remove", { access_token: other.access_token }); } catch (_) {}
        await admin.from("plaid_items").delete().eq("item_id", other.item_id);
        removedOld.push(other.item_id);
      }
    } catch (_) { /* de-dupe is best-effort; never block the link */ }

    return json({ ok: true, item_id, institution: body.institution?.name ?? null, replaced: removedOld });
  } catch (error) {
    console.error("plaid-exchange error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
