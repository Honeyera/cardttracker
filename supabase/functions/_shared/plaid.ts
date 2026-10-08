// Minimal Plaid REST client + shared helpers for the plaid-* edge functions.
// We call Plaid's REST API directly with fetch (the npm `plaid` SDK is Node-only
// and awkward under Deno). All calls inject client_id/secret from env.

export const OWNER_USER_ID =
  Deno.env.get("OWNER_USER_ID") ?? "65b9afb1-c868-4848-a49f-68cd2529ef81";

const PLAID_ENV = (Deno.env.get("PLAID_ENV") ?? "production").toLowerCase();
const PLAID_HOST =
  PLAID_ENV === "sandbox"
    ? "https://sandbox.plaid.com"
    : PLAID_ENV === "development"
    ? "https://development.plaid.com"
    : "https://production.plaid.com";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Call a Plaid endpoint. Throws with Plaid's error payload on non-2xx.
export async function plaid(path: string, body: Record<string, unknown>): Promise<any> {
  const client_id = Deno.env.get("PLAID_CLIENT_ID");
  const secret = Deno.env.get("PLAID_SECRET");
  if (!client_id || !secret) throw new Error("Plaid not configured (missing PLAID_CLIENT_ID / PLAID_SECRET)");

  const res = await fetch(`${PLAID_HOST}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id, secret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error_code ?? res.status;
    const msg = data?.error_message ?? JSON.stringify(data);
    const err = new Error(`Plaid ${path} failed: ${code} ${msg}`);
    (err as any).plaid = data;
    throw err;
  }
  return data;
}
