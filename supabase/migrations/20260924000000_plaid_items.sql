-- Stores each bank/card connection created through Plaid Link. One row per Plaid
-- "item" (an institution login). The access_token is a long-lived credential
-- Plaid gives us to pull that item's accounts/transactions, so this table is
-- locked down: RLS denies all client access and only the service role (used by
-- the plaid-* edge functions) can read/write it.
create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  item_id text not null unique,            -- Plaid item_id
  access_token text not null,              -- Plaid access_token (server-only secret)
  institution_name text,
  institution_id text,
  transactions_cursor text,                -- /transactions/sync cursor (incremental)
  status text not null default 'active',   -- active | needs_reauth | removed
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.plaid_items enable row level security;

-- No policies for anon/authenticated => clients cannot select/insert/update/delete.
-- The service role bypasses RLS, so only the edge functions can touch this table.
revoke all on public.plaid_items from anon, authenticated;
