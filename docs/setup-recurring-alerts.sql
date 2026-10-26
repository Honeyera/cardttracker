-- New-recurring-charge email alerts — one-time setup (PERSONAL instance).
-- Run in the Supabase SQL editor of the PERSONAL project: cihandjyoojthqjfqarf.
--
-- Prereqs (Dashboard / CLI, not SQL):
--   1. Deploy:  npx supabase functions deploy recurring-alert --project-ref cihandjyoojthqjfqarf
--   2. Secrets (already set from the other alerts, EXCEPT optionally the recipient):
--        CRON_SECRET                 = (same one used by attention-alert)
--        RESEND_API_KEY              = (already set)
--        RECURRING_ALERT_RECIPIENTS  = (optional) who gets these; defaults to
--                                      ALERT_EMAIL_RECIPIENTS if unset.
--
-- Replace <CRON_SECRET> below with the same value before running.

-- Ledger of recurring series we've already told you about, so only NEW ones email.
create table if not exists public.known_recurring (
  signature text primary key,   -- stable key: '<merchant>::<card/account id>'
  label text,
  amount numeric(12,2),
  first_seen timestamptz not null default now()
);
alter table public.known_recurring enable row level security;  -- service-role only

-- Daily at 15:00 UTC (after the morning sync + attention alert).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'recurring-alert-daily',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://cihandjyoojthqjfqarf.supabase.co/functions/v1/recurring-alert',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);

-- First real run emails the FULL current list (a "here's everything you're paying
-- for" digest) and seeds the table; after that only NEW series email.
--
-- To preview now without seeding (shows all current recurring charges):
--   select net.http_post(
--     url := 'https://cihandjyoojthqjfqarf.supabase.co/functions/v1/recurring-alert',
--     headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--     body := '{"test": true}'::jsonb
--   );
-- To verify:   select jobname, schedule, active from cron.job;
-- To undo:     select cron.unschedule('recurring-alert-daily');
