// admin-users — OWNER-ONLY management of additional logins and their per-account
// view grants. Gated to OWNER_USER_ID; uses the service-role key for auth.admin
// and writes to public.account_grants. Pairs with docs/setup-user-access.sql.
//
// POST body: { action, ... }
//   { action: 'list' }
//   { action: 'create',    email, password }
//   { action: 'delete',    userId }
//   { action: 'setGrants', userId, accountIds: string[], cardIds: string[] }
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Fail CLOSED: if OWNER_USER_ID isn't configured, nobody passes the owner gate.
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // --- Authenticate the caller ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await caller.auth.getUser(token);
    if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);

    // --- Owner gate ---
    if (!OWNER_USER_ID || user.id !== OWNER_USER_ID) return json({ error: "Forbidden — owner only" }, 403);

    const admin = createClient(url, serviceKey);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = String((body as any).action ?? "");

    if (action === "list") {
      const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) return json({ error: error.message }, 400);
      const users = (list?.users ?? []).filter((u) => u.id !== OWNER_USER_ID);
      const ids = users.map((u) => u.id);
      let grants: any[] = [];
      if (ids.length) {
        const { data } = await admin
          .from("account_grants")
          .select("id, viewer_id, account_id, credit_card_id")
          .in("viewer_id", ids);
        grants = data ?? [];
      }
      const byViewer = new Map<string, any[]>();
      for (const g of grants) {
        const arr = byViewer.get(g.viewer_id) ?? [];
        arr.push(g);
        byViewer.set(g.viewer_id, arr);
      }
      return json({
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: (u as any).last_sign_in_at ?? null,
          // best-effort: the admin user object may carry enrolled MFA factors
          mfaEnrolled: Array.isArray((u as any).factors)
            ? (u as any).factors.some((f: any) => f?.status === "verified")
            : null,
          grants: byViewer.get(u.id) ?? [],
        })),
      });
    }

    if (action === "create") {
      const email = String((body as any).email ?? "").trim().toLowerCase();
      const password = String((body as any).password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email address" }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        const m = (error.message ?? "").toLowerCase();
        if (m.includes("already") || m.includes("exist") || m.includes("registered") || m.includes("duplicate"))
          return json({ error: "A user with this email already exists" }, 409);
        return json({ error: error.message }, 400);
      }
      return json({ user: { id: data.user.id, email: data.user.email } });
    }

    if (action === "delete") {
      const userId = String((body as any).userId ?? "");
      if (!userId) return json({ error: "userId required" }, 400);
      if (userId === OWNER_USER_ID) return json({ error: "Cannot delete the owner" }, 400);
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json({ error: error.message }, 400);
      // account_grants rows cascade-delete via the FK on auth.users.
      return json({ ok: true });
    }

    if (action === "setGrants") {
      const userId = String((body as any).userId ?? "");
      if (!userId || userId === OWNER_USER_ID) return json({ error: "Invalid userId" }, 400);
      const accountIds: string[] = Array.isArray((body as any).accountIds) ? (body as any).accountIds : [];
      const cardIds: string[] = Array.isArray((body as any).cardIds) ? (body as any).cardIds : [];

      // Only allow granting accounts/cards the OWNER actually owns.
      const [{ data: ownAccts }, { data: ownCards }] = await Promise.all([
        admin.from("accounts").select("id").eq("user_id", OWNER_USER_ID),
        admin.from("credit_cards").select("id").eq("user_id", OWNER_USER_ID),
      ]);
      const okAcct = new Set((ownAccts ?? []).map((a) => a.id));
      const okCard = new Set((ownCards ?? []).map((c) => c.id));
      const validAcct = [...new Set(accountIds)].filter((id) => okAcct.has(id));
      const validCard = [...new Set(cardIds)].filter((id) => okCard.has(id));

      // Replace this viewer's grants with the new set.
      const { error: delErr } = await admin.from("account_grants").delete().eq("viewer_id", userId);
      if (delErr) return json({ error: delErr.message }, 400);
      const rows = [
        ...validAcct.map((id) => ({ viewer_id: userId, account_id: id, granted_by: OWNER_USER_ID })),
        ...validCard.map((id) => ({ viewer_id: userId, credit_card_id: id, granted_by: OWNER_USER_ID })),
      ];
      if (rows.length) {
        const { error: insErr } = await admin.from("account_grants").insert(rows);
        if (insErr) return json({ error: insErr.message }, 400);
      }
      return json({ ok: true, accounts: validAcct.length, cards: validCard.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("admin-users error:", e instanceof Error ? e.message : "unknown");
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
