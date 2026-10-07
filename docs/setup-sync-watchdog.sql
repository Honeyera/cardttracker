-- Stale-sync email alert — one-time setup. Run in the Supabase SQL editor.
--
-- Prereqs (Dashboard steps, not SQL):
--   1. Deploy the function:  supabase functions deploy sync-watchdog
--      (or paste supabase/functions/sync-watchdog/index.ts into the dashboard editor)
--   2. Its secrets (Edge Functions → Secrets) — all already set for other functions:
--        CRON_SECRET      = <the same value used for ad-spend-alert>
--        RESEND_API_KEY   = (already set)
--   Recipient is hardcoded to leo@honeyera.com in the function.
--
-- Replace <CRON_SECRET> below with the same value before running.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Daily check at 15:00 UTC. Emails leo@honeyera.com if no sync in 2+ days.
select cron.schedule(
  'sync-watchdog-daily',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://zndyokpudijoidropdou.supabase.co/functions/v1/sync-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Verify:   select * from cron.job;
-- Test now: select net.http_post(url := 'https://zndyokpudijoidropdou.supabase.co/functions/v1/sync-watchdog',
--                                headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--                                body := '{}'::jsonb);
-- Undo:     select cron.unschedule('sync-watchdog-daily');
