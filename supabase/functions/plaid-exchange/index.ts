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

    return json({ ok: true, item_id, institution: body.institution?.name ?? null });
  } catch (error) {
    console.error("plaid-exchange error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
