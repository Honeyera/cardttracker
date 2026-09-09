// Email two-factor authentication.
//
// One function, four actions:
//   login          {email, password}            → verify password; if the user has
//                                                  email-2FA on, mail a code and return
//                                                  {status:'mfa_required', challengeId};
//                                                  otherwise return {status:'authenticated', session}
//   verify         {email, password, challengeId, code}
//                                                → check the code, then return a session
//   enroll-send    (Bearer JWT)                 → mail a code to the caller to confirm 2FA
//   enroll-confirm (Bearer JWT) {challengeId, code}
//                                                → on valid code, turn email-2FA on
//   disable        (Bearer JWT)                 → turn email-2FA off
//
// Security model: no session is ever returned until the second factor passes, so a
// stolen password alone can't reach the data. Only code HASHES are stored. The
// password is re-checked on verify (never a session token persisted server-side).
//
// verify_jwt is OFF at the platform level (login/verify precede any session); the
// enroll/disable actions verify the caller's JWT in-code below.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PEPPER = Deno.env.get("MFA_PEPPER") ?? "";
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const DEVICE_TTL_DAYS = 30;

const admin = () => createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

// 6-digit code from a CSPRNG (000000–999999).
function newCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

async function hashCode(challengeId: string, code: string): Promise<string> {
  const data = new TextEncoder().encode(`${challengeId}:${code}:${PEPPER}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish compare of two equal-length hex strings.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sendCodeEmail(to: string, code: string, purpose: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY not set");
  const title = purpose === "enroll" ? "Confirm two-factor setup" : "Your sign-in code";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "CardTrack <onboarding@resend.dev>",
      to: [to],
      subject: `${code} — ${title}`,
      html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px;text-align:center;">
        <p style="font-size:13px;color:#555;margin:0 0 8px;">${title}</p>
        <p style="font-size:34px;font-weight:700;letter-spacing:8px;color:#111;margin:0;">${code}</p>
        <p style="font-size:12px;color:#888;margin:12px 0 0;">Expires in ${CODE_TTL_MIN} minutes. If you didn't request this, ignore it.</p>
      </div>`,
      text: `${title}: ${code} (expires in ${CODE_TTL_MIN} minutes)`,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}

// Verify a password without leaving a live session behind.
async function checkPassword(email: string, password: string): Promise<{ id: string; email: string } | null> {
  const c = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) return null;
  // scope:'local' only discards this throwaway client's session. The DEFAULT
  // ('global') would revoke ALL of the user's sessions — signing them out on
  // every other device on every login. The orphaned token here expires on its own.
  await c.auth.signOut({ scope: 'local' });
  return { id: data.user!.id, email: data.user!.email! };
}

// Create + store + email a challenge. Returns its id.
async function issueChallenge(userId: string, email: string, purpose: string): Promise<string> {
  const db = admin();
  const id = crypto.randomUUID();
  const code = newCode();
  const code_hash = await hashCode(id, code);
  const expires_at = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();
  const { error } = await db.from("mfa_challenges").insert({ id, user_id: userId, purpose, code_hash, expires_at });
  if (error) throw error;
  await sendCodeEmail(email, code, purpose);
  return id;
}

// Consume a challenge: returns true only if code is valid, unexpired, unconsumed.
async function consumeChallenge(challengeId: string, userId: string, purpose: string, code: string): Promise<boolean> {
  const db = admin();
  const { data: ch } = await db.from("mfa_challenges").select("*").eq("id", challengeId).maybeSingle();
  if (!ch || ch.user_id !== userId || ch.purpose !== purpose || ch.consumed) return false;
  if (new Date(ch.expires_at).getTime() < Date.now()) return false;
  if (ch.attempts >= MAX_ATTEMPTS) return false;
  const ok = safeEqual(await hashCode(challengeId, code), ch.code_hash);
  if (!ok) {
    await db.from("mfa_challenges").update({ attempts: ch.attempts + 1 }).eq("id", challengeId);
    return false;
  }
  await db.from("mfa_challenges").update({ consumed: true }).eq("id", challengeId);
  return true;
}

// Identify the caller from their Bearer JWT (for enroll/disable).
async function callerFromJwt(req: Request): Promise<{ id: string; email: string } | null> {
  const authz = req.headers.get("Authorization");
  if (!authz) return null;
  const c = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data, error } = await c.auth.getUser();
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email };
}

async function isEnabled(userId: string): Promise<boolean> {
  const { data } = await admin().from("user_security").select("email_mfa_enabled").eq("user_id", userId).maybeSingle();
  return !!data?.email_mfa_enabled;
}

// A hex hash of a device token (same scheme as codes, salted by a fixed tag).
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(`device:${token}:${PEPPER}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// True if this device token is a known, unexpired trusted device for the user.
async function deviceTrusted(userId: string, token: string): Promise<boolean> {
  if (!token) return false;
  const db = admin();
  const { data } = await db.from("trusted_devices").select("id, expires_at")
    .eq("user_id", userId).eq("token_hash", await hashToken(token)).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) return false;
  await db.from("trusted_devices").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return true;
}

// Mint + store a new trusted-device token; returns the plaintext for the client.
async function rememberDevice(userId: string, label: string): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expires_at = new Date(Date.now() + DEVICE_TTL_DAYS * 86_400_000).toISOString();
  await admin().from("trusted_devices").insert({ user_id: userId, token_hash: await hashToken(token), label, expires_at });
  return token;
}

async function signInSession(email: string, password: string) {
  const c = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const { data } = await c.auth.signInWithPassword({ email, password });
  return sessionOut(data.session);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "login") {
      const password = String(body.password ?? "");
      const user = await checkPassword(String(body.email ?? ""), password);
      if (!user) return json({ error: "Invalid email or password" }, 401);
      // No second factor, OR this is a remembered device → sign in directly.
      if (!(await isEnabled(user.id)) || await deviceTrusted(user.id, String(body.deviceToken ?? ""))) {
        return json({ status: "authenticated", session: await signInSession(user.email, password) });
      }
      const challengeId = await issueChallenge(user.id, user.email, "login");
      return json({ status: "mfa_required", challengeId });
    }

    if (action === "verify") {
      const password = String(body.password ?? "");
      const user = await checkPassword(String(body.email ?? ""), password);
      if (!user) return json({ error: "Invalid email or password" }, 401);
      const ok = await consumeChallenge(String(body.challengeId ?? ""), user.id, "login", String(body.code ?? ""));
      if (!ok) return json({ error: "Invalid or expired code" }, 401);
      // Optionally remember this device so it skips the code next time.
      const deviceToken = body.remember
        ? await rememberDevice(user.id, String(body.deviceLabel ?? "").slice(0, 120))
        : null;
      return json({ status: "authenticated", session: await signInSession(user.email, password), deviceToken });
    }

    if (action === "enroll-send") {
      const caller = await callerFromJwt(req);
      if (!caller) return json({ error: "Not authenticated" }, 401);
      const challengeId = await issueChallenge(caller.id, caller.email, "enroll");
      return json({ status: "sent", challengeId });
    }

    if (action === "enroll-confirm") {
      const caller = await callerFromJwt(req);
      if (!caller) return json({ error: "Not authenticated" }, 401);
      const ok = await consumeChallenge(String(body.challengeId ?? ""), caller.id, "enroll", String(body.code ?? ""));
      if (!ok) return json({ error: "Invalid or expired code" }, 401);
      const { error } = await admin().from("user_security")
        .upsert({ user_id: caller.id, email_mfa_enabled: true, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ status: "enabled" });
    }

    if (action === "disable") {
      const caller = await callerFromJwt(req);
      if (!caller) return json({ error: "Not authenticated" }, 401);
      const { error } = await admin().from("user_security")
        .upsert({ user_id: caller.id, email_mfa_enabled: false, updated_at: new Date().toISOString() });
      if (error) throw error;
      // Turning 2FA off clears remembered devices, so re-enabling starts clean.
      await admin().from("trusted_devices").delete().eq("user_id", caller.id);
      return json({ status: "disabled" });
    }

    if (action === "forget-devices") {
      const caller = await callerFromJwt(req);
      if (!caller) return json({ error: "Not authenticated" }, 401);
      const { error } = await admin().from("trusted_devices").delete().eq("user_id", caller.id);
      if (error) throw error;
      return json({ status: "forgotten" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("mfa function error", e);
    return json({ error: "Server error" }, 500);
  }
});

function sessionOut(s: { access_token: string; refresh_token: string } | null) {
  return s ? { access_token: s.access_token, refresh_token: s.refresh_token } : null;
}
