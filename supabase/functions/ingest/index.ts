// HTTP ingestion endpoint for ChatGPT (Custom GPT Action).
//
// ChatGPT POSTs financial data here instead of writing through its Supabase
// connector (whose writes its safety layer blocks). This endpoint authenticates
// with a shared key and performs the write server-side via the existing RPCs
// (finance_upsert / remap_card / finance_prune_pending) using the service role —
// so all the same transaction rules and conflict handling apply.
//
// Auth: header  x-ingest-key: <INGEST_KEY secret>
// Body (one action per request):
//   {"action":"upsert","table":"transactions","rows":[...],"conflict":"external_id"}
//   {"action":"remap_card","external_account_id":"...","new_last_four":"2001"}
//   {"action":"prune_pending","external_account_id":"...","keep_external_ids":[...]}
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-ingest-key, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const key = Deno.env.get("INGEST_KEY");
  if (!key) return json({ error: "Ingestion not configured (missing INGEST_KEY secret)" }, 500);
  const provided = req.headers.get("x-ingest-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (provided !== key) return json({ error: "Unauthorized" }, 401);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const action = body.action ?? "upsert";

    if (action === "upsert") {
      if (!body.table || !Array.isArray(body.rows)) return json({ error: "upsert requires 'table' and 'rows'[]" }, 400);
      const { data, error } = await admin.rpc("finance_upsert", {
        p_table: body.table, p_rows: body.rows, p_conflict: body.conflict ?? "external_id",
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, result: data });
    }

    if (action === "remap_card") {
      const { data, error } = await admin.rpc("remap_card", {
        p_external_account_id: body.external_account_id, p_new_last_four: body.new_last_four,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, result: data });
    }

    if (action === "prune_pending") {
      const { data, error } = await admin.rpc("finance_prune_pending", {
        p_external_account_id: body.external_account_id, p_keep_external_ids: body.keep_external_ids ?? [],
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, result: data });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    console.error("ingest error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
