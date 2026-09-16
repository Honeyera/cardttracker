-- Lets ChatGPT clean up stale PENDING transactions after a sync. It deletes
-- only rows that are (a) pending, (b) belong to the given account, and (c) whose
-- external_id is NOT in the authoritative current pending set. Posted rows are
-- never touched. ChatGPT calls, e.g.:
--   select finance_prune_pending('<plaid_account_id>', '["ext_a","ext_b"]'::jsonb);
-- Paste into Supabase SQL Editor and Run. Safe to re-run.

create or replace function public.finance_prune_pending(
  p_external_account_id text,
  p_keep_external_ids jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
  v_keep text[];
  v_deleted int;
begin
  if p_external_account_id is null or length(p_external_account_id) < 6 then
    raise exception 'invalid external_account_id';
  end if;
  if p_keep_external_ids is null or jsonb_typeof(p_keep_external_ids) <> 'array' then
    raise exception 'keep list must be a json array of external_ids';
  end if;

  select id into v_account_id from public.accounts where external_id = p_external_account_id;
  if v_account_id is null then
    raise exception 'no account found for external id %', p_external_account_id;
  end if;

  select coalesce(array_agg(value), array[]::text[]) into v_keep
    from jsonb_array_elements_text(p_keep_external_ids) as value;

  -- Delete only pending rows for this account that are absent from the keep set.
  -- Posted rows (is_pending = false) are never affected.
  delete from public.transactions
    where account_id = v_account_id
      and is_pending = true
      and external_id is not null
      and external_id <> all (v_keep);
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'external_account_id', p_external_account_id,
    'pending_deleted', v_deleted,
    'kept_count', array_length(v_keep, 1)
  );
end;
$$;

grant execute on function public.finance_prune_pending(text, jsonb) to authenticated, service_role, anon;
