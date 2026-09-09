-- Email two-factor authentication — one-time setup.
-- Run in the Supabase SQL editor (project zndyokpudijoidropdou).
--
-- After running this:
--   1. Deploy the edge function:  supabase/functions/mfa/index.ts  (Editor deploy,
--      name it exactly "mfa", turn "Enforce JWT verification" OFF — the login/verify
--      actions run before a session exists; the function checks the JWT itself for
--      the enroll actions).
--   2. The function needs RESEND_API_KEY as a secret (already set for your other
--      email functions). SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
--      are injected automatically. Optionally set MFA_PEPPER to any long random
--      string for extra code-hash strength.

-- Per-user toggle. A user only gets the email step once they've enabled it and
-- confirmed a test code, so no one is ever locked out by this rolling out.
create table if not exists public.user_security (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_mfa_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_security enable row level security;

-- A signed-in user may read and update only their own security row.
drop policy if exists "own security row - select" on public.user_security;
create policy "own security row - select" on public.user_security
  for select using (auth.uid() = user_id);
drop policy if exists "own security row - upsert" on public.user_security;
create policy "own security row - upsert" on public.user_security
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Short-lived login/enroll challenges. Only the code HASH is stored, never the
-- code itself. Service-role (the edge function) is the only accessor — RLS is on
-- with no policies, so browsers can't read or write it.
create table if not exists public.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null default 'login',   -- 'login' | 'enroll'
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.mfa_challenges enable row level security;
-- (no policies → closed to all client roles; service role bypasses RLS)

-- Optional hygiene: drop expired challenges. Safe to run anytime; or schedule.
-- delete from public.mfa_challenges where expires_at < now();

-- ── Break-glass ───────────────────────────────────────────────────────
-- If someone is locked out (lost email access), disable their second factor:
--   update public.user_security set email_mfa_enabled = false
--   where user_id = (select id from auth.users where email = 'them@example.com');
