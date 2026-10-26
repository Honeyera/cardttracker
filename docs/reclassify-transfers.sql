-- Reclassify already-synced self-transfers as 'transfer' so they stop counting
-- as spending (and their matching deposits stop counting as income).
--
-- Background: plaid-sync previously had no 'transfer' case — bank money-out
-- became 'expense' and money-in became 'income'. The classifier is now fixed
-- (Plaid PFC primary TRANSFER_IN / TRANSFER_OUT → 'transfer'), but /transactions/sync
-- won't re-touch old rows, so run this once to correct history.
--
-- Bank-side only (account_id set, credit_card_id null); card transactions are
-- left alone. Run in the PERSONAL Supabase project (cihandjyoojthqjfqarf).

-- Preview first — see what will change:
-- select transaction_date, description, amount, transaction_type, category
-- from public.transactions
-- where credit_card_id is null and account_id is not null
--   and transaction_type in ('expense','income')
--   and category ~ '^transfer_(in|out)'
-- order by transaction_date desc;

update public.transactions
set transaction_type = 'transfer'
where credit_card_id is null
  and account_id is not null
  and transaction_type in ('expense', 'income')
  and category ~ '^transfer_(in|out)';

-- Owner-specific: payroll / distributions / owner draws between the owner's LLC
-- (VOWIDEAS) and personal accounts are the owner's OWN money — a transfer, not
-- income or spend (Plaid tags payroll as INCOME, so the rule above misses it).
-- Matches the isOwnerBizTransfer rule in plaid-sync classifyTxn.
update public.transactions
set transaction_type = 'transfer'
where account_id is not null
  and description ilike '%vowideas%'
  and transaction_type in ('income', 'expense', 'payment');
