-- VOWIDEAS business account (Chase ••7015): every DEPOSIT is business income.
--
-- plaid-sync now classifies incoming deposits to ••7015 as income going forward
-- (see BUSINESS_INCOME_MASKS in plaid-sync). This fixes the already-synced rows:
-- incoming transfers (e.g. client RTP "Instant Payment Credit", Zelle/wire in)
-- were typed 'transfer' and so weren't counted as income — flip them to 'income'.
--
-- Incoming is identified by Plaid's transfer_IN category, so OUTGOING money from
-- 7015 (payroll/owner draws) is left untouched. Run once in the PERSONAL project.

-- Preview first:
-- select transaction_date, amount, description, category
-- from public.transactions
-- where account_id in (select id from public.accounts where last_four = '7015')
--   and transaction_type = 'transfer' and category ~* '^transfer_in'
-- order by transaction_date desc;

update public.transactions
set transaction_type = 'income'
where account_id in (select id from public.accounts where last_four = '7015')
  and transaction_type = 'transfer'
  and category ~* '^transfer_in';
