-- Personal vs Property (investment) tagging, remembered per merchant/payee.
--
-- Tagging a transaction writes a rule keyed by its merchant/payee, so it applies
-- to ALL transactions from that merchant — past and future — and you never have
-- to re-tag the same payee each month. Rules survive Plaid syncs.
--
-- Run once in the PERSONAL Supabase project (cihandjyoojthqjfqarf) SQL editor.

create table if not exists public.merchant_tags (
  user_id      uuid not null default auth.uid(),
  merchant_key text not null,                       -- normalized merchant/payee
  tag          text not null check (tag in ('personal', 'property')),
  updated_at   timestamptz not null default now(),
  primary key (user_id, merchant_key)
);

alter table public.merchant_tags enable row level security;

-- Each user manages only their own rules.
create policy "own merchant_tags" on public.merchant_tags
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
