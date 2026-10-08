-- Daily Plaid sync — one-time setup. Run in the Supabase SQL editor.
-- Prereqs: plaid-sync function deployed; PLAID_* and CRON_SECRET secrets set.
-- Replace <CRON_SECRET> with the same value used for the other cron functions.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Pull balances + transactions every day at 13:00 UTC.
select cron.schedule(
  'plaid-sync-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    url := 'https://zndyokpudijoidropdou.supabase.co/functions/v1/plaid-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Verify:   select * from cron.job;
-- Run now:  select net.http_post(url := 'https://zndyokpudijoidropdou.supabase.co/functions/v1/plaid-sync',
--                                headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>'),
--                                body := '{}'::jsonb);
-- Undo:     select cron.unschedule('plaid-sync-daily');
