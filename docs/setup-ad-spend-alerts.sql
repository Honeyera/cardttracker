-- Ad-spend cap email alerts — one-time setup.
-- Run in the Supabase SQL editor (project zndyokpudijoidropdou).
--
-- Prereqs (Dashboard steps, not SQL):
--   1. Deploy the function:  supabase functions deploy ad-spend-alert
--   2. Set its secrets (Dashboard → Edge Functions → ad-spend-alert → Secrets):
--        CRON_SECRET        = <generate a long random string, also used below>
--        RESEND_API_KEY     = (already set for send-points-email)
--        EMAIL_RECIPIENTS   = (already set for send-points-email)
--
-- Replace <CRON_SECRET> below with the same value before running.

-- Dedup ledger: one row per (card, year, threshold) that has been emailed.
create table if not exists public.ad_spend_alerts (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.credit_cards(id) on delete cascade,
  year int not null,
  threshold int not null, -- percent: 80 / 90 / 100
  spent numeric(12,2) not null,
  sent_at timestamptz not null default now(),
  unique (card_id, year, threshold)
);

-- Service role (the edge function) bypasses RLS; no client access is needed,
-- so enable RLS with no policies to keep the table closed to browsers.
alter table public.ad_spend_alerts enable row level security;

-- Daily check at 14:00 UTC (after the morning finance sync).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ad-spend-alert-daily',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://zndyokpudijoidropdou.supabase.co/functions/v1/ad-spend-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To verify:   select * from cron.job;
-- To test now: select net.http_post(url := '...same as above...', headers := ...);
-- To undo:     select cron.unschedule('ad-spend-alert-daily');
