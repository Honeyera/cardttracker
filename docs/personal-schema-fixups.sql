-- Schema fix-ups for a fresh personal Supabase project.
-- Run this AFTER applying every file in supabase/migrations/ (in filename order).
-- These changes were applied by hand to the original production database and are
-- not captured in the migrations; the Plaid sync fails without them.

-- Card transactions have no bank account: they use credit_card_id instead.
alter table public.transactions alter column account_id drop not null;

-- The original check failed when account_id and transfer_account_id are BOTH null
-- (which is every credit-card transaction).
alter table public.transactions drop constraint if exists transactions_check;
alter table public.transactions add constraint transactions_check
  check (account_id is null or account_id is distinct from transfer_account_id);

-- Allow every type the Plaid sync classifier emits.
alter table public.transactions drop constraint if exists transactions_transaction_type_check;
alter table public.transactions add constraint transactions_transaction_type_check
  check (transaction_type in
    ('income','expense','transfer','payment','refund','fee','interest','adjustment'));
