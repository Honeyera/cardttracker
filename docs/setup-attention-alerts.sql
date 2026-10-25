-- Urgent-attention email alerts — one-time setup (PERSONAL instance).
-- Run in the Supabase SQL editor of the PERSONAL project: cihandjyoojthqjfqarf.
-- (Do NOT run against the business project.)
--
-- Prereqs (Dashboard steps, not SQL):
--   1. Deploy the function:  supabase functions deploy attention-alert
--   2. Set its secrets (Dashboard → Edge Functions → attention-alert → Secrets):
--        CRON_SECRET             = <generate a long random string, also used below>
--        RESEND_API_KEY          = (already set for send-points-email)
--        ALERT_EMAIL_RECIPIENTS  = lmezbizer@gmail.com
--      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
--      NOTE: the email is sent from cardtrack@honeyera.com, so that domain must
--      be verified in the personal Resend account (it already is for the points
--      email). If it isn't, change the `from:` in the function first.
--
-- Replace <CRON_SECRET> below with the same value before running.

-- Dedup ledger: one row per urgent occurrence already emailed. The signature
-- includes the card's due/statement date, so a new cycle re-alerts.
create table if not exists public.attention_alerts (
  signature text primary key,         -- e.g. 'overdue:<card_id>:<due_date>'
  card_name text,
  owed numeric(12,2),
  sent_at timestamptz not null default now()
);

-- Service role (the edge function) bypasses RLS; browsers need no access, so
-- enable RLS with no policies to keep the table closed.
alter table public.attention_alerts enable row level security;

-- Daily check at 14:30 UTC (after the morning finance sync + ad-spend check).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'attention-alert-daily',
  '30 14 * * *',
  $$
  select net.http_post(
    url := 'https://cihandjyoojthqjfqarf.supabase.co/functions/v1/attention-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To verify:   select jobname, schedule, active from cron.job;
-- To undo:     select cron.unschedule('attention-alert-daily');
--
-- To send a TEST email right now (snapshot of current balances, ignores the
-- due-window and dedup — always emails). Replace <CRON_SECRET> with your value:
--   select net.http_post(
--     url := 'https://cihandjyoojthqjfqarf.supabase.co/functions/v1/attention-alert',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--     body := '{"test": true}'::jsonb
--   );
