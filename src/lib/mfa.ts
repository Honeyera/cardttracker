import { supabase } from '@/integrations/supabase/client';

// Thin client wrapper over the `mfa` edge function. Keeps the auth flow in Auth.tsx
// readable and centralizes the "function not deployed yet" bootstrap fallback.

export interface SessionTokens { access_token: string; refresh_token: string }
export type LoginResult =
  | { status: 'authenticated'; session: SessionTokens }
  | { status: 'mfa_required'; challengeId: string }
  | { status: 'fallback' }; // function not deployed — caller signs in directly

// Per-email trusted-device token, kept in localStorage so a remembered browser
// skips the code next time. Keyed by email so multiple household users on one
// browser don't clobber each other.
const deviceKey = (email: string) => `mfa_device:${email.toLowerCase()}`;
export const getDeviceToken = (email: string) => localStorage.getItem(deviceKey(email)) ?? '';
export const setDeviceToken = (email: string, token: string) => localStorage.setItem(deviceKey(email), token);
export const clearDeviceToken = (email: string) => localStorage.removeItem(deviceKey(email));

async function callMfa(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('mfa', { body });
  if (error) {
    // Surface the function's own JSON error message when present.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      const parsed = await ctx.json().catch(() => null);
      if (parsed?.error) throw new Error(parsed.error);
    }
    throw error;
  }
  return data as Record<string, unknown>;
}

// Is the mfa function deployed? A 404 here means we're in the pre-deploy window;
// login falls back to a direct password sign-in so nobody is ever locked out
// before the function exists. (Harmless: no user is enrolled until it's live.)
async function functionMissing(err: unknown): Promise<boolean> {
  const ctx = (err as { context?: Response })?.context;
  return ctx?.status === 404;
}

export async function mfaLogin(email: string, password: string): Promise<LoginResult> {
  try {
    const data = await callMfa({ action: 'login', email, password, deviceToken: getDeviceToken(email) });
    if (data.status === 'mfa_required') return { status: 'mfa_required', challengeId: String(data.challengeId) };
    return { status: 'authenticated', session: data.session as SessionTokens };
  } catch (err) {
    if (await functionMissing(err)) return { status: 'fallback' };
    throw err;
  }
}

export async function mfaVerify(
  email: string, password: string, challengeId: string, code: string, remember: boolean,
): Promise<SessionTokens> {
  const data = await callMfa({
    action: 'verify', email, password, challengeId, code,
    remember, deviceLabel: navigator.userAgent,
  });
  // If we asked to be remembered, persist the returned device token.
  if (remember && data.deviceToken) setDeviceToken(email, String(data.deviceToken));
  return data.session as SessionTokens;
}

export async function mfaForgetDevices(): Promise<void> {
  await callMfa({ action: 'forget-devices' });
}

export async function mfaEnrollSend(): Promise<string> {
  const data = await callMfa({ action: 'enroll-send' });
  return String(data.challengeId);
}

export async function mfaEnrollConfirm(challengeId: string, code: string): Promise<void> {
  await callMfa({ action: 'enroll-confirm', challengeId, code });
}

export async function mfaDisable(): Promise<void> {
  await callMfa({ action: 'disable' });
}

// Whether the signed-in user currently has email 2FA on (reads their own row).
// Cast: user_security isn't in the generated Supabase types (added by
// docs/setup-mfa.sql, not a repo migration).
export async function mfaIsEnabled(): Promise<boolean> {
  const { data } = await (supabase as unknown as {
    from: (t: string) => { select: (c: string) => { maybeSingle: () => Promise<{ data: { email_mfa_enabled?: boolean } | null }> } };
  }).from('user_security').select('email_mfa_enabled').maybeSingle();
  return !!data?.email_mfa_enabled;
}
