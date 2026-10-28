-- BofA "Access Check" = a convenience check drawn against the credit line
-- (like a balance transfer / cash advance), NOT a purchase. plaid-sync now
-- classifies these as 'transfer' going forward; this fixes already-synced rows
-- so they stop counting as spend.
--
-- OPTIONAL: the dashboard already reclassifies these client-side, so the spend
-- numbers are correct without this. Run it only to also fix the stored data
-- (e.g. so email alerts / any future reporting see them as transfers).
-- Run once in the PERSONAL project (cihandjyoojthqjfqarf).

-- Preview first:
-- select transaction_date, amount, description
-- from public.transactions
-- where credit_card_id is not null and transaction_type = 'expense'
--   and description ~* 'access\s*check'
-- order by transaction_date desc;

update public.transactions
set transaction_type = 'transfer'
where credit_card_id is not null
  and transaction_type = 'expense'
  and description ~* 'access\s*check';
