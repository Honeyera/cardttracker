-- Grant leo@honeyera.com and tomer@honeyera.com read access to the shared
-- finance data. Paste into Supabase SQL Editor and Run. Safe to re-run.

do $$
declare
  t text;
  uids uuid[];
begin
  select array_agg(id) into uids
  from auth.users
  where email in ('leo@honeyera.com', 'tomer@honeyera.com');

  foreach t in array array[
    'accounts', 'transactions', 'balance_snapshots', 'cashflow_daily',
    'cashflow_forecast', 'alerts', 'credit_cards',
    'card_available_points', 'credit_card_points', 'points_change_log'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists shared_read on public.%I', t);
      execute format(
        'create policy shared_read on public.%I for select using (auth.uid() = any(%L::uuid[]))',
        t, uids
      );
    end if;
  end loop;
end $$;
