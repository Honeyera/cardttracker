-- Household shared read-access for the finance dashboard.
-- Lets everyone in household_members see the shared data (accounts, cards,
-- transactions, points, forecasts) while keeping individual logins.
-- Safe to run multiple times. Paste into Supabase SQL Editor and Run.

-- 1) Membership allowlist -------------------------------------------------
create table if not exists public.household_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.household_members enable row level security;

-- 2) SECURITY DEFINER check (bypasses RLS → no recursive-policy issues) ----
create or replace function public.is_household_member(uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.household_members where user_id = uid);
$$;
grant execute on function public.is_household_member(uuid) to authenticated;

-- Members can read the membership list.
drop policy if exists household_view_members on public.household_members;
create policy household_view_members on public.household_members
  for select using (public.is_household_member(auth.uid()));

-- 3) Populate with the two accounts (by email) ----------------------------
insert into public.household_members (user_id)
select id from auth.users
where email in ('leo@honeyera.com', 'tomer@honeyera.com')
on conflict (user_id) do nothing;

-- 4) Add a shared-read policy to every data table -------------------------
-- A household member may read rows owned by any household member.
do $$
declare t text;
begin
  foreach t in array array[
    'accounts', 'transactions', 'balance_snapshots', 'cashflow_daily',
    'cashflow_forecast', 'alerts', 'credit_cards',
    'card_available_points', 'credit_card_points', 'points_change_log'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', 'household_read_' || t, t);
      execute format(
        'create policy %I on public.%I for select using ' ||
        '(public.is_household_member(auth.uid()) and public.is_household_member(user_id))',
        'household_read_' || t, t
      );
    end if;
  end loop;
end $$;

-- Verify who is in the household:
select u.email, hm.added_at
from public.household_members hm
join auth.users u on u.id = hm.user_id;
