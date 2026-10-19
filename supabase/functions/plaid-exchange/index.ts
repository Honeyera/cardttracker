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
    // so the same physical cards/accounts would appear twice. For any OTHER
    // active item whose accounts share a mask (last-4) with this new link,
    // RE-POINT the existing card/account rows to the new Plaid ids instead of
    // deleting them — the row UUIDs survive, so everything hanging off them
    // (reward points via ON DELETE CASCADE, balance snapshots, manual edits)
    // is preserved. Old transactions are cleared because the new item re-pulls
    // the history under new Plaid transaction ids (they would duplicate).
    const removedOld: string[] = [];
    try {
      const newAccts = await plaid("/accounts/get", { access_token });
      const newByMask = new Map<string, string>(
        (newAccts.accounts ?? []).filter((a: any) => a.mask).map((a: any) => [a.mask, a.account_id]),
      );

      const { data: others } = await admin
        .from("plaid_items")
        .select("item_id, access_token")
        .neq("item_id", item_id)
        .eq("status", "active");

      for (const other of others ?? []) {
        let oldAccounts: any[] = [];
        try {
          const oa = await plaid("/accounts/get", { access_token: other.access_token });
          oldAccounts = oa.accounts ?? [];
        } catch (_) {
          continue; // can't read old item; leave it alone
        }
        if (!oldAccounts.some((a: any) => a.mask && newByMask.has(a.mask))) continue;

        // This old item is superseded by the new link.
        const keptCardIds: string[] = [];
        const keptAcctIds: string[] = [];
        const dropPlaidIds: string[] = []; // old accounts with no replacement (or remap failed)
        for (const a of oldAccounts) {
          const newId = a.mask ? newByMask.get(a.mask) : undefined;
          if (!newId) { dropPlaidIds.push(a.account_id); continue; }
          const card = await admin.from("credit_cards")
            .update({ finance_external_account_id: newId })
            .eq("finance_external_account_id", a.account_id).select("id");
          const acct = await admin.from("accounts")
            .update({ external_id: newId })
            .eq("external_id", a.account_id).select("id");
          if (card.error || acct.error) { dropPlaidIds.push(a.account_id); continue; }
          keptCardIds.push(...(card.data ?? []).map((r: any) => r.id));
          keptAcctIds.push(...(acct.data ?? []).map((r: any) => r.id));
        }

        // Clear the superseded transactions (snapshots/points on kept rows stay).
        if (keptCardIds.length) await admin.from("transactions").delete().in("credit_card_id", keptCardIds);
        if (keptAcctIds.length) await admin.from("transactions").delete().in("account_id", keptAcctIds);

        // Accounts with no replacement in the new link: remove fully, as before.
        if (dropPlaidIds.length) {
          const { data: acctRows } = await admin.from("accounts").select("id").in("external_id", dropPlaidIds);
          const { data: cardRows } = await admin.from("credit_cards").select("id").in("finance_external_account_id", dropPlaidIds);
          const aIds = (acctRows ?? []).map((r: any) => r.id);
          const cIds = (cardRows ?? []).map((r: any) => r.id);
          if (aIds.length) {
            await admin.from("transactions").delete().in("account_id", aIds);
            await admin.from("balance_snapshots").delete().in("account_id", aIds);
          }
          if (cIds.length) await admin.from("transactions").delete().in("credit_card_id", cIds);
          await admin.from("accounts").delete().in("external_id", dropPlaidIds);
          await admin.from("credit_cards").delete().in("finance_external_account_id", dropPlaidIds);
        }

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
