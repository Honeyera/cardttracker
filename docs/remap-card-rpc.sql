-- Narrow, safe operation for ChatGPT to remap a card's last-4 without sending a
-- financial payload. ChatGPT calls:  select remap_card('<plaid_account_id>', '2001');
-- The function updates last_four on the matching account and card, keyed by the
-- stable Plaid external account id (not last-4, so it survives collisions).
-- Paste into Supabase SQL Editor and Run. Safe to re-run.

create or replace function public.remap_card(
  p_external_account_id text,
  p_new_last_four text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_accounts_updated int := 0;
  v_cards_updated int := 0;
begin
  -- Validate the input: 4-5 digit last-four only. Nothing else is touched.
  if p_new_last_four is null or p_new_last_four !~ '^[0-9]{4,5}$' then
    raise exception 'invalid last_four (expected 4-5 digits): %', p_new_last_four;
  end if;
  if p_external_account_id is null or length(p_external_account_id) < 6 then
    raise exception 'invalid external_account_id';
  end if;

  update public.accounts
    set last_four = p_new_last_four, updated_at = now()
    where external_id = p_external_account_id;
  get diagnostics v_accounts_updated = row_count;

  update public.credit_cards
    set last_four = p_new_last_four, updated_at = now()
    where finance_external_account_id = p_external_account_id;
  get diagnostics v_cards_updated = row_count;

  if v_accounts_updated = 0 and v_cards_updated = 0 then
    raise exception 'no account or card found for external id %', p_external_account_id;
  end if;

  return jsonb_build_object(
    'external_account_id', p_external_account_id,
    'new_last_four', p_new_last_four,
    'accounts_updated', v_accounts_updated,
    'cards_updated', v_cards_updated
  );
end;
$$;

grant execute on function public.remap_card(text, text) to authenticated, service_role, anon;
