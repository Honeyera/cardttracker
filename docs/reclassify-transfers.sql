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

-- Owner-specific: the owner's OWN money moving with their LLC (VOWIDEAS) —
-- payroll, owner draws ("instant payment credit"), payroll-tax debits, account
-- verification — are transfers, not income/spend (Plaid tags payroll as INCOME).
-- NARROW match (mirrors isOwnerBizTransfer in plaid-sync): must name the business
-- AND look like one of those movements, so client payments / purchases are excluded.
update public.transactions
set transaction_type = 'transfer'
where account_id is not null
  and description ~* 'vowideas'
  and description ~* 'payroll|instant payment credit|acct\s*verify'
  and transaction_type in ('income', 'expense', 'payment');

-- Correct rows an earlier broad '%vowideas%' match mis-tagged as transfers:
--   • "Tidy Teds … via mercury.com" = a client paying the business → income
update public.transactions set transaction_type = 'income'
where account_id is not null and transaction_type = 'transfer'
  and description ~* 'tidy teds';
--   • "BOCA FALLS … PURCHASE" = a real purchase → expense
update public.transactions set transaction_type = 'expense'
where account_id is not null and transaction_type = 'transfer'
  and description ~* 'boca falls';
