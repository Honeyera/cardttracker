-- =====================================================================
-- Stage 1 — per-user, per-account/card VIEW access (personal cardtracker)
-- Run ONCE in the PERSONAL Supabase project (cihandjyoojthqjfqarf) SQL editor.
-- Idempotent and safe to re-run.
--
-- The SQL editor runs with a superuser role that BYPASSES row-level security,
-- so running/altering this can never lock YOU out of the database — if anything
-- looks wrong, just fix and re-run here.
--
-- Model: every finance row carries your user_id (you = owner). Additional logins
-- see NOTHING until you grant them a specific account or credit card via
-- public.account_grants. Owner always sees everything they own; granted users get
-- READ-ONLY access to exactly their granted accounts/cards. Aggregate tables with
-- no account link (cashflow/projection) stay owner-only. Edge functions use the
-- service-role key and bypass all of this, so Plaid sync is unaffected.
-- =====================================================================

-- ---- 1. Grant table -------------------------------------------------
create table if not exists public.account_grants (
  id             uuid primary key default gen_random_uuid(),
  viewer_id      uuid not null references auth.users(id) on delete cascade,
  account_id     uuid references public.accounts(id) on delete cascade,
  credit_card_id uuid references public.credit_cards(id) on delete cascade,
  granted_by     uuid,
  created_at     timestamptz not null default now(),
  -- exactly one target per row (an account OR a card)
  constraint account_grants_one_target check (num_nonnulls(account_id, credit_card_id) = 1)
);
create unique index if not exists account_grants_acct_uniq
  on public.account_grants (viewer_id, account_id)     where account_id is not null;
create unique index if not exists account_grants_card_uniq
  on public.account_grants (viewer_id, credit_card_id) where credit_card_id is not null;
create index if not exists account_grants_viewer_idx on public.account_grants (viewer_id);

grant select, insert, update, delete on public.account_grants to authenticated;

-- ---- 2. Helper functions --------------------------------------------
-- SECURITY DEFINER so they read accounts/cards/grants with the definer's rights,
-- i.e. they bypass RLS on those tables (no policy recursion). search_path pinned.
create or replace function public.owns_account(p_uid uuid, p_account_id uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from accounts a where a.id = p_account_id and a.user_id = p_uid);
$$;
create or replace function public.owns_card(p_uid uuid, p_card_id uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from credit_cards c where c.id = p_card_id and c.user_id = p_uid);
$$;
-- "Am I the owner of this finance data at all?" (true only for you, not viewers)
create or replace function public.is_finance_owner(p_uid uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from accounts     a where a.user_id = p_uid)
      or exists (select 1 from credit_cards c where c.user_id = p_uid);
$$;
create or replace function public.can_view_account(p_uid uuid, p_account_id uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select public.owns_account(p_uid, p_account_id)
      or exists (select 1 from account_grants g where g.viewer_id = p_uid and g.account_id = p_account_id);
$$;
create or replace function public.can_view_card(p_uid uuid, p_card_id uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select public.owns_card(p_uid, p_card_id)
      or exists (select 1 from account_grants g where g.viewer_id = p_uid and g.credit_card_id = p_card_id);
$$;
grant execute on function
  public.owns_account(uuid,uuid), public.owns_card(uuid,uuid),
  public.is_finance_owner(uuid),
  public.can_view_account(uuid,uuid), public.can_view_card(uuid,uuid)
  to authenticated;

-- ---- 3. account_grants RLS: owner of the target manages; viewer sees own ----
alter table public.account_grants enable row level security;
drop policy if exists account_grants_select on public.account_grants;
create policy account_grants_select on public.account_grants for select to authenticated
  using (
    viewer_id = (select auth.uid())
    or public.owns_account((select auth.uid()), account_id)
    or public.owns_card((select auth.uid()), credit_card_id)
  );
drop policy if exists account_grants_write on public.account_grants;
create policy account_grants_write on public.account_grants for all to authenticated
  using (
    public.owns_account((select auth.uid()), account_id)
    or public.owns_card((select auth.uid()), credit_card_id)
  )
  with check (
    public.owns_account((select auth.uid()), account_id)
    or public.owns_card((select auth.uid()), credit_card_id)
  );

-- ---- 4. Lock down + scope the core data tables ----------------------
-- Drop ALL existing policies on these four (this removes the leftover
-- "any authenticated user can view/update/delete ALL cards" policies and the
-- stale hardcoded shared_read on transactions), then recreate cleanly:
--   SELECT -> owner OR a viewer granted that row's account/card
--   INSERT/UPDATE/DELETE -> owner only (viewers are strictly read-only)
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('accounts','credit_cards','transactions','balance_snapshots')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.accounts          enable row level security;
alter table public.credit_cards      enable row level security;
alter table public.transactions      enable row level security;
alter table public.balance_snapshots enable row level security;

-- accounts
create policy accounts_select on public.accounts for select to authenticated
  using (public.can_view_account((select auth.uid()), id));
create policy accounts_cud on public.accounts for all to authenticated
  using (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()))
  with check (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()));

-- credit_cards
create policy credit_cards_select on public.credit_cards for select to authenticated
  using (public.can_view_card((select auth.uid()), id));
create policy credit_cards_cud on public.credit_cards for all to authenticated
  using (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()))
  with check (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()));

-- transactions (visible if you own it, or are granted its account or its card)
create policy transactions_select on public.transactions for select to authenticated
  using (
    user_id = (select auth.uid())
    or (account_id     is not null and public.can_view_account((select auth.uid()), account_id))
    or (credit_card_id is not null and public.can_view_card((select auth.uid()), credit_card_id))
  );
create policy transactions_cud on public.transactions for all to authenticated
  using (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()))
  with check (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()));

-- balance_snapshots
create policy balance_snapshots_select on public.balance_snapshots for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.can_view_account((select auth.uid()), account_id)
  );
create policy balance_snapshots_cud on public.balance_snapshots for all to authenticated
  using (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()))
  with check (public.is_finance_owner((select auth.uid())) and user_id = (select auth.uid()));

-- ---- 5. Close the open points-table policies (owner-only) -----------
-- These had "any authenticated user can view/insert/... all points" policies.
-- Points aren't shared with viewers in this stage; lock them to the owner.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('credit_card_points','card_available_points','points_change_log')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.credit_card_points    enable row level security;
alter table public.card_available_points enable row level security;
alter table public.points_change_log      enable row level security;

create policy credit_card_points_owner on public.credit_card_points for all to authenticated
  using (user_id = (select auth.uid()) or public.owns_card((select auth.uid()), card_id))
  with check (public.is_finance_owner((select auth.uid())));
create policy card_available_points_owner on public.card_available_points for all to authenticated
  using (user_id = (select auth.uid()) or public.owns_card((select auth.uid()), card_id))
  with check (public.is_finance_owner((select auth.uid())));
create policy points_change_log_owner on public.points_change_log for all to authenticated
  using (user_id = (select auth.uid()) or public.owns_card((select auth.uid()), card_id))
  with check (public.is_finance_owner((select auth.uid())));

-- =====================================================================
-- VERIFY / TEST (do this before trusting it, and before Stage 2/3)
-- =====================================================================
-- 1) As the OWNER (log in to the app normally): you should still see ALL your
--    accounts, cards and transactions exactly as before.
--
-- 2) Make a TEST viewer: Supabase Dashboard > Authentication > Users > Add user
--    (email + password, enable "Auto Confirm").
--
-- 3) Grant that viewer ONE account (edit the email + last-4):
--    insert into public.account_grants (viewer_id, account_id, granted_by)
--    select u.id, a.id, null
--    from auth.users u
--    join public.accounts a on a.last_four = '5097'          -- account to share
--    where u.email = 'viewer@example.com'
--      and not exists (select 1 from public.account_grants g
--                      where g.viewer_id = u.id and g.account_id = a.id);
--
--    -- …or grant ONE card instead:
--    insert into public.account_grants (viewer_id, credit_card_id, granted_by)
--    select u.id, c.id, null
--    from auth.users u
--    join public.credit_cards c on c.last_four = '6125'       -- card to share
--    where u.email = 'viewer@example.com'
--      and not exists (select 1 from public.account_grants g
--                      where g.viewer_id = u.id and g.credit_card_id = c.id);
--
-- 4) Log in AS the test viewer (private window). They must see ONLY the granted
--    account/card + its transactions — NOT your other accounts or cards.
--
-- 5) Spot-check isolation (optional): run as the viewer's role is hard here, so
--    rely on the app view in step 4. To list what a viewer can reach:
--      select * from public.account_grants where viewer_id =
--        (select id from auth.users where email = 'viewer@example.com');
--
-- 6) Revoke everything for a viewer:
--      delete from public.account_grants where viewer_id =
--        (select id from auth.users where email = 'viewer@example.com');
-- =====================================================================
