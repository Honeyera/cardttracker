// Pulls balances + transactions for every linked Plaid item into the same tables
// the dashboard reads (accounts / credit_cards / transactions / balance_snapshots).
//
// Runs two ways:
//   - Scheduled: pg_cron POSTs with header x-cron-secret: <CRON_SECRET>
//   - On demand: the dashboard "Sync now" button POSTs with a logged-in JWT
//
// Depository accounts -> accounts table; credit accounts -> credit_cards table.
// Transactions are linked to account_id (depository) or credit_card_id (credit).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, plaid, OWNER_USER_ID } from "../_shared/plaid.ts";

const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

// Plaid amount is positive for money leaving the account, negative for money in.
function classifyTxn(amount: number, isCredit: boolean): { type: string; amount: number } {
  const abs = Math.abs(amount);
  if (isCredit) return { type: amount >= 0 ? "expense" : "payment", amount: abs };
  return { type: amount >= 0 ? "expense" : "income", amount: abs };
}

function txnCategory(t: any): string | null {
  const pfc = t.personal_finance_category;
  const raw = pfc?.detailed ?? pfc?.primary ?? (Array.isArray(t.category) ? t.category[0] : null);
  return raw ? String(raw).toLowerCase() : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Auth: cron secret OR a logged-in user.
  const cronSecret = Deno.env.get("CRON_SECRET");
  const providedCron = req.headers.get("x-cron-secret");
  let authorized = false;
  if (cronSecret && providedCron && providedCron === cronSecret) {
    authorized = true;
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (authHeader) {
      const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data } = await anon.auth.getUser();
      if (data?.user) authorized = true;
    }
  }
  if (!authorized) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  try {
    const { data: items, error: itemsErr } = await admin
      .from("plaid_items")
      .select("*")
      .eq("status", "active");
    if (itemsErr) return json({ error: itemsErr.message }, 500);

    const summary: any[] = [];

    for (const item of items ?? []) {
      const result: any = { institution: item.institution_name, item_id: item.item_id, accounts: 0, transactions: 0 };
      try {
        // --- Accounts + balances ---
        const acctRes = await plaid("/accounts/get", { access_token: item.access_token });
        const plaidAccounts: any[] = acctRes.accounts ?? [];
        const instName = item.institution_name ?? acctRes.item?.institution_id ?? null;

        // Map Plaid account_id -> { kind, ourId } for linking transactions.
        const map = new Map<string, { kind: "account" | "card" }>();

        for (const a of plaidAccounts) {
          const isCredit = a.type === "credit";
          map.set(a.account_id, { kind: isCredit ? "card" : "account" });
          const bal = a.balances ?? {};
          if (isCredit) {
            await admin.from("credit_cards").upsert(
              {
                user_id: OWNER_USER_ID,
                finance_external_account_id: a.account_id,
                name: a.official_name ?? a.name,
                owner_name: instName ?? a.official_name ?? a.name ?? "",
                last_four: a.mask ?? null,
                credit_limit: bal.limit ?? null,
                current_balance: bal.current ?? 0,
                total_balance: bal.current ?? 0,
                finance_synced_at: nowIso(),
              },
              { onConflict: "finance_external_account_id" },
            );
          } else {
            await admin.from("accounts").upsert(
              {
                user_id: OWNER_USER_ID,
                external_id: a.account_id,
                name: a.official_name ?? a.name,
                institution_name: instName,
                account_type: a.subtype ?? a.type ?? "checking",
                account_subtype: a.subtype ?? null,
                last_four: a.mask ?? null,
                current_balance: bal.current ?? 0,
                available_balance: bal.available ?? bal.current ?? 0,
                is_active: true,
                updated_at: nowIso(),
              },
              { onConflict: "external_id" },
            );
          }
          result.accounts++;
        }

        // Resolve our internal ids for this item's accounts/cards.
        const plaidIds = plaidAccounts.map((a) => a.account_id);
        const { data: acctRows } = await admin
          .from("accounts")
          .select("id, external_id")
          .in("external_id", plaidIds);
        const { data: cardRows } = await admin
          .from("credit_cards")
          .select("id, finance_external_account_id")
          .in("finance_external_account_id", plaidIds);
        const acctIdByPlaid = new Map((acctRows ?? []).map((r: any) => [r.external_id, r.id]));
        const cardIdByPlaid = new Map((cardRows ?? []).map((r: any) => [r.finance_external_account_id, r.id]));

        // --- Balance snapshots (depository only; one row per account per day) ---
        for (const a of plaidAccounts) {
          if (a.type === "credit") continue;
          const ourId = acctIdByPlaid.get(a.account_id);
          if (!ourId) continue;
          const bal = a.balances ?? {};
          await admin.from("balance_snapshots").upsert(
            {
              user_id: OWNER_USER_ID,
              account_id: ourId,
              snapshot_date: today(),
              current_balance: bal.current ?? 0,
              available_balance: bal.available ?? bal.current ?? 0,
            },
            { onConflict: "account_id, snapshot_date" },
          );
        }

        // --- Transactions (incremental via /transactions/sync) ---
        let cursor = item.transactions_cursor ?? undefined;
        let hasMore = true;
        const added: any[] = [];
        const modified: any[] = [];
        const removed: string[] = [];
        while (hasMore) {
          const body: Record<string, unknown> = { access_token: item.access_token };
          if (cursor) body.cursor = cursor;
          const sync = await plaid("/transactions/sync", body);
          added.push(...(sync.added ?? []));
          modified.push(...(sync.modified ?? []));
          removed.push(...(sync.removed ?? []).map((r: any) => r.transaction_id));
          cursor = sync.next_cursor;
          hasMore = sync.has_more;
        }

        const toRow = (t: any) => {
          const link = map.get(t.account_id);
          const isCredit = link?.kind === "card";
          const { type, amount } = classifyTxn(Number(t.amount) || 0, isCredit);
          return {
            user_id: OWNER_USER_ID,
            external_id: t.transaction_id,
            account_id: isCredit ? null : acctIdByPlaid.get(t.account_id) ?? null,
            credit_card_id: isCredit ? cardIdByPlaid.get(t.account_id) ?? null : null,
            transaction_date: t.date,
            description: t.name ?? "",
            merchant_name: t.merchant_name ?? null,
            amount,
            transaction_type: type,
            category: txnCategory(t),
            is_pending: !!t.pending,
          };
        };

        const upserts = [...added, ...modified].map(toRow);
        // Chunk to stay well under any statement limits.
        for (let i = 0; i < upserts.length; i += 500) {
          const chunk = upserts.slice(i, i + 500);
          const { error } = await admin.from("transactions").upsert(chunk, { onConflict: "external_id" });
          if (error) throw new Error(`transactions upsert: ${error.message}`);
        }
        if (removed.length) {
          await admin.from("transactions").delete().in("external_id", removed);
        }
        result.transactions = upserts.length;

        await admin
          .from("plaid_items")
          .update({ transactions_cursor: cursor, last_synced_at: nowIso(), last_error: null, updated_at: nowIso() })
          .eq("item_id", item.item_id);
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        result.error = msg;
        const needsReauth = (e as any)?.plaid?.error_code === "ITEM_LOGIN_REQUIRED";
        await admin
          .from("plaid_items")
          .update({ last_error: msg, status: needsReauth ? "needs_reauth" : "active", updated_at: nowIso() })
          .eq("item_id", item.item_id);
      }
      summary.push(result);
    }

    return json({ ok: true, items: summary.length, summary });
  } catch (error) {
    console.error("plaid-sync error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
