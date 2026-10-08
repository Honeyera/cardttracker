// Creates a Plaid Link token for the frontend to open Plaid Link.
//
// Two modes:
//   { }                      -> new connection (user links a fresh bank)
//   { item_id: "..." }       -> update mode (re-authenticate an existing item
//                               that went into needs_reauth)
//
// Auth: caller must send a valid Supabase JWT (verify_jwt is off; we check in-code).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json, plaid } from "../_shared/plaid.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // Verify the caller is a logged-in user.
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anon.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));

    const base: Record<string, unknown> = {
      user: { client_user_id: userId },
      client_name: "Cardtracker",
      country_codes: ["US"],
      language: "en",
    };

    if (body.item_id) {
      // Update mode: re-auth an existing item. Needs its access_token, no products.
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
        auth: { persistSession: false },
      });
      const { data: item, error } = await admin
        .from("plaid_items")
        .select("access_token")
        .eq("item_id", body.item_id)
        .single();
      if (error || !item) return json({ error: "Unknown item_id" }, 404);
      const res = await plaid("/link/token/create", { ...base, access_token: item.access_token });
      return json({ link_token: res.link_token });
    }

    // New connection: request transactions (covers depository + credit accounts).
    const res = await plaid("/link/token/create", {
      ...base,
      products: ["transactions"],
    });
    return json({ link_token: res.link_token });
  } catch (error) {
    console.error("plaid-link-token error:", error);
    return json({ error: String((error as Error)?.message ?? error) }, 500);
  }
});
