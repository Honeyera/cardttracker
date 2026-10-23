-- Full personal-project schema: structure copied from the business database
-- (no data), plus pgcrypto, a clean reset of public, Supabase grants, and the
-- hand-applied transaction fix-ups. Safe to run on a fresh/half-built project.

create extension if not exists pgcrypto with schema extensions;
drop schema if exists public cascade;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: apply_cardtracker_ad_classification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_cardtracker_ad_classification() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_card_identifier text;
  v_business text;
  v_text text;
  v_raw_signed numeric;
  v_reason text;
begin
  select
    coalesce(cc.last_four, a.metadata->>'card_identifier', a.last_four),
    lower(coalesce(cc.company_name, a.metadata->>'business_name', ''))
  into v_card_identifier, v_business
  from public.accounts a
  left join public.credit_cards cc on cc.account_id = a.id
  where a.id = new.account_id
  limit 1;

  v_text := lower(trim(coalesce(new.description,'') || ' ' || coalesce(new.merchant_name,'')));
  begin
    v_raw_signed := nullif(new.metadata->>'raw_signed_amount','')::numeric;
  exception when others then
    v_raw_signed := null;
  end;

  if new.transaction_type in ('payment','transfer') then
    return new;
  end if;

  -- Explicit advertising labels always win.
  if v_text ~ '(amazon sponsored products|amazon marketing services|amazon advertising|adscrafted|ads crafted)' then
    v_reason := 'explicit_advertising_label';

  -- Recurring Amazon Japan ad billing pattern: treat >= $300 as advertising.
  elsif v_text ~ '(amazon japan|amazon\.co\.jp)' and new.amount >= 300 then
    v_reason := 'amazon_japan_recurring_ad_pattern';

  -- BeeDecor 81003: recurring generic Amazon ad charges are typically >= $500.
  elsif v_card_identifier = '81003'
        and v_text ~ '(^|[^a-z])amazon([^a-z]|$)|amzn\.com/bill'
        and new.amount >= 500 then
    v_reason := 'beedecor_amazon_recurring_ad_pattern';

  -- TidyCubbies 51004: recurring generic Amazon ad charges are typically > $500.
  elsif v_card_identifier = '51004'
        and v_text ~ '(^|[^a-z])amazon([^a-z]|$)|amzn\.com/bill'
        and new.amount > 500 then
    v_reason := 'tidycubbies_amazon_recurring_ad_pattern';

  -- Honeyera AmEx cards: recurring generic Amazon ad billing clusters around $2.5k.
  elsif v_business = 'honeyera'
        and v_text ~ '(^|[^a-z])amazon([^a-z]|$)|amzn\.com/bill'
        and new.amount between 2400 and 2600 then
    v_reason := 'honeyera_amazon_recurring_ad_pattern';
  end if;

  if v_reason is not null then
    new.category := 'advertising';
    if coalesce(v_raw_signed, 1) < 0 or new.transaction_type in ('refund','income') then
      new.transaction_type := 'refund';
    else
      new.transaction_type := 'expense';
    end if;
    new.metadata := coalesce(new.metadata,'{}'::jsonb) || jsonb_build_object(
      'ad_auto_classified', true,
      'ad_auto_classification_reason', v_reason,
      'ad_auto_classified_at', now()
    );
  end if;

  return new;
end;
$_$;


--
-- Name: bulk_upsert_card_history_compact(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_upsert_card_history_compact(p_data text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_line text;
  v_parts text[];
  v_card public.credit_cards%rowtype;
  v_account public.accounts%rowtype;
  v_received int := 0;
  v_inserted int := 0;
  v_skipped int := 0;
  v_rejected int := 0;
  v_type text;
  v_matches int;
begin
  if p_data is null or btrim(p_data) = '' then
    return jsonb_build_object('received',0,'inserted',0,'skipped_existing',0,'rejected',0);
  end if;
  foreach v_line in array regexp_split_to_array(p_data, E'\\n') loop
    if btrim(v_line) = '' then continue; end if;
    v_received := v_received + 1;
    begin
      v_parts := string_to_array(v_line, '|');
      if array_length(v_parts,1) <> 5 then raise exception 'invalid compact row'; end if;

      -- Prefer exact full card identifier (e.g. 31003 vs 81003).
      select cc.* into v_card
      from public.credit_cards cc
      join public.accounts a on a.id = cc.account_id
      where cc.last_four = v_parts[2]
        and cc.account_id is not null
        and coalesce(a.is_active,true)
        and lower(coalesce(a.institution_name,'')) <> 'mercury'
      limit 1;

      if v_card.id is null then
        select count(*) into v_matches
        from public.credit_cards cc
        join public.accounts a on a.id = cc.account_id
        where right(cc.last_four,4) = right(v_parts[2],4)
          and cc.account_id is not null
          and coalesce(a.is_active,true)
          and lower(coalesce(a.institution_name,'')) <> 'mercury';
        if v_matches <> 1 then
          raise exception 'ambiguous or missing card identifier %', v_parts[2];
        end if;
        select cc.* into strict v_card
        from public.credit_cards cc
        join public.accounts a on a.id = cc.account_id
        where right(cc.last_four,4) = right(v_parts[2],4)
          and cc.account_id is not null
          and coalesce(a.is_active,true)
          and lower(coalesce(a.institution_name,'')) <> 'mercury'
        limit 1;
      end if;

      select * into strict v_account from public.accounts where id = v_card.account_id;
      v_type := case v_parts[4]
        when 'e' then 'expense' when 'p' then 'payment' when 't' then 'transfer'
        when 'r' then 'refund' when 'i' then 'income' when 'f' then 'fee'
        when 'n' then 'interest' else 'adjustment' end;
      insert into public.transactions(
        user_id, team_id, account_id, credit_card_id, transaction_date,
        description, transaction_type, amount, currency, is_pending,
        is_recurring, external_id, metadata
      ) values (
        v_account.user_id, v_account.team_id, v_account.id, v_card.id, v_parts[3]::date,
        'Historical Finances backfill', v_type, abs(v_parts[5]::numeric), 'USD', false,
        false, v_parts[1], jsonb_build_object('source','chatgpt_finances','backfill','compact')
      )
      on conflict (user_id, external_id) where external_id is not null do nothing;
      if found then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;
    exception when others then
      v_rejected := v_rejected + 1;
    end;
  end loop;
  return jsonb_build_object('received',v_received,'inserted',v_inserted,'skipped_existing',v_skipped,'rejected',v_rejected);
end;
$$;


--
-- Name: bulk_upsert_finance_transactions(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_upsert_finance_transactions(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_row jsonb;
  v_account public.accounts%rowtype;
  v_transfer_account_id uuid;
  v_credit_card_id uuid;
  v_received integer := 0;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_rejected integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_external_id text;
  v_account_external_id text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_received := v_received + 1;
    v_external_id := nullif(btrim(v_row->>'external_id'), '');
    v_account_external_id := nullif(btrim(v_row->>'account_external_id'), '');
    begin
      if v_external_id is null then raise exception 'external_id is required'; end if;
      if v_account_external_id is null then raise exception 'account_external_id is required'; end if;
      select a.* into strict v_account
      from public.accounts a
      where a.external_id = v_account_external_id
        and coalesce(a.is_active, true);
      v_transfer_account_id := null;
      if nullif(btrim(v_row->>'transfer_account_external_id'), '') is not null then
        select a.id into v_transfer_account_id
        from public.accounts a
        where a.external_id = nullif(btrim(v_row->>'transfer_account_external_id'), '')
          and a.user_id = v_account.user_id
          and coalesce(a.is_active, true)
        limit 1;
      end if;
      select cc.id into v_credit_card_id from public.credit_cards cc where cc.account_id = v_account.id limit 1;
      insert into public.transactions (
        user_id,team_id,account_id,credit_card_id,transfer_account_id,transaction_date,posted_at,description,merchant_name,category,transaction_type,amount,currency,is_pending,is_recurring,external_id,notes,metadata
      ) values (
        v_account.user_id,v_account.team_id,v_account.id,v_credit_card_id,v_transfer_account_id,
        (v_row->>'transaction_date')::date,
        case when nullif(v_row->>'posted_at','') is null then null else (v_row->>'posted_at')::timestamptz end,
        coalesce(nullif(v_row->>'description',''),'Unknown transaction'),nullif(v_row->>'merchant_name',''),nullif(v_row->>'category',''),
        coalesce(nullif(v_row->>'transaction_type',''),'adjustment'),abs((v_row->>'amount')::numeric),upper(coalesce(nullif(v_row->>'currency',''),'USD')),
        coalesce((v_row->>'is_pending')::boolean,false),coalesce((v_row->>'is_recurring')::boolean,false),v_external_id,nullif(v_row->>'notes',''),coalesce(v_row->'metadata','{}'::jsonb)
      )
      on conflict (user_id,external_id) where external_id is not null do nothing;
      if found then v_inserted := v_inserted + 1; else v_skipped := v_skipped + 1; end if;
    exception
      when no_data_found then
        v_rejected := v_rejected + 1;
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('external_id',v_external_id,'account_external_id',v_account_external_id,'error','account not found or inactive'));
      when others then
        v_rejected := v_rejected + 1;
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('external_id',v_external_id,'account_external_id',v_account_external_id,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('received',v_received,'inserted',v_inserted,'skipped_existing',v_skipped,'rejected',v_rejected,'errors',v_errors);
end;
$$;


--
-- Name: FUNCTION bulk_upsert_finance_transactions(p_rows jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bulk_upsert_finance_transactions(p_rows jsonb) IS 'Bulk insert Finances transactions into Cardtracker. Resolves account/card links by account_external_id, excludes Mercury, deduplicates by (user_id, external_id), and returns insert/skip/reject counts.';


--
-- Name: bulk_upsert_finance_transactions_coded(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_upsert_finance_transactions_coded(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_row jsonb;
  v_account public.accounts%rowtype;
  v_transfer_account_id uuid;
  v_credit_card_id uuid;
  v_received integer := 0;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_rejected integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_external_id text;
  v_account_external_id text;
  v_transfer_external_id text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be a JSON array'; end if;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_received := v_received + 1;
    v_external_id := nullif(btrim(v_row->>0), '');
    v_account_external_id := case v_row->>1
      when 'A' then 'ZEa1mgEAeAH9N8dnY4ZJHyZeZvMEjMh8RVm16'
      when 'B' then 'aEMb64vqRATjYODkeXaauwOZRdVkvbT4yX3zM'
      when 'C' then '8weEE8ANeLf3E9wyeb56tjz5xMLYj3IJJ9Ana'
      when 'D' then 'Z0Ooo8n7OgSmnEqRO50KFyJLr5q4ypSVVxrd0'
      when 'E' then '54XVVay8XduPMDkL1zr9u4vApdjm4Qt66KQaJ'
      when 'F' then 'v4w1xNDDrYSza3jmKX67t58775z7kyIpAzwkz'
      when 'G' then 'Dz9gyV66MXuyPmjk8VvqCZk7mNoVkKfX90eVq'
      when 'H' then 'LzpQ4Xyy6ku4VQb16Mowfyn9VdxgnPCJna5md'
      when 'I' then 'oznVqVEOMbTA0ePzrvkJIr5nD09e3gIoKg7BV'
      when 'J' then 'roAONO3dpahMjvOX836EFKZxk113M3uarB76D'
      when 'K' then 'ro9OOoV8o5h6dy34v8OjUxbZeRxQYdCrkpOvJ'
      else null end;
    v_transfer_external_id := case v_row->>2
      when 'A' then 'ZEa1mgEAeAH9N8dnY4ZJHyZeZvMEjMh8RVm16'
      when 'B' then 'aEMb64vqRATjYODkeXaauwOZRdVkvbT4yX3zM'
      when 'C' then '8weEE8ANeLf3E9wyeb56tjz5xMLYj3IJJ9Ana'
      when 'D' then 'Z0Ooo8n7OgSmnEqRO50KFyJLr5q4ypSVVxrd0'
      when 'E' then '54XVVay8XduPMDkL1zr9u4vApdjm4Qt66KQaJ'
      when 'F' then 'v4w1xNDDrYSza3jmKX67t58775z7kyIpAzwkz'
      when 'G' then 'Dz9gyV66MXuyPmjk8VvqCZk7mNoVkKfX90eVq'
      when 'H' then 'LzpQ4Xyy6ku4VQb16Mowfyn9VdxgnPCJna5md'
      when 'I' then 'oznVqVEOMbTA0ePzrvkJIr5nD09e3gIoKg7BV'
      when 'J' then 'roAONO3dpahMjvOX836EFKZxk113M3uarB76D'
      when 'K' then 'ro9OOoV8o5h6dy34v8OjUxbZeRxQYdCrkpOvJ'
      else null end;
    begin
      if v_external_id is null then raise exception 'external_id is required'; end if;
      if v_account_external_id is null then raise exception 'invalid account code'; end if;
      select a.* into strict v_account from public.accounts a
      where a.external_id=v_account_external_id and coalesce(a.is_active,true) and lower(coalesce(a.institution_name,'')) <> 'mercury';
      v_transfer_account_id := null;
      if v_transfer_external_id is not null then
        select a.id into v_transfer_account_id from public.accounts a
        where a.external_id=v_transfer_external_id and a.user_id=v_account.user_id and coalesce(a.is_active,true) and lower(coalesce(a.institution_name,'')) <> 'mercury' limit 1;
      end if;
      select cc.id into v_credit_card_id from public.credit_cards cc where cc.account_id=v_account.id limit 1;
      insert into public.transactions(user_id,team_id,account_id,credit_card_id,transfer_account_id,transaction_date,posted_at,description,merchant_name,category,transaction_type,amount,currency,is_pending,is_recurring,external_id,metadata)
      values(v_account.user_id,v_account.team_id,v_account.id,v_credit_card_id,v_transfer_account_id,(v_row->>3)::date,((v_row->>3)||'T00:00:00Z')::timestamptz,coalesce(nullif(v_row->>4,''),'Unknown transaction'),null,nullif(v_row->>5,''),coalesce(nullif(v_row->>6,''),'adjustment'),abs((v_row->>7)::numeric),'USD',false,false,v_external_id,jsonb_build_object('source','chatgpt_finances','backfill_compact',true))
      on conflict (user_id,external_id) where external_id is not null do nothing;
      if found then v_inserted:=v_inserted+1; else v_skipped:=v_skipped+1; end if;
    exception when no_data_found then
      v_rejected:=v_rejected+1;
      v_errors:=v_errors||jsonb_build_array(jsonb_build_object('external_id',v_external_id,'error','account not found, inactive, or excluded'));
    when others then
      v_rejected:=v_rejected+1;
      v_errors:=v_errors||jsonb_build_array(jsonb_build_object('external_id',v_external_id,'error',sqlerrm));
    end;
  end loop;
  return jsonb_build_object('received',v_received,'inserted',v_inserted,'skipped_existing',v_skipped,'rejected',v_rejected,'errors',v_errors);
end;
$$;


--
-- Name: bulk_upsert_finance_transactions_compact(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bulk_upsert_finance_transactions_compact(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'external_id', r->>0,
    'account_external_id', r->>1,
    'transfer_account_external_id', nullif(r->>2,''),
    'transaction_date', r->>3,
    'posted_at', nullif(r->>4,''),
    'description', coalesce(nullif(r->>5,''),'Unknown transaction'),
    'merchant_name', nullif(r->>6,''),
    'category', nullif(r->>7,''),
    'transaction_type', coalesce(nullif(r->>8,''),'adjustment'),
    'amount', (r->>9)::numeric,
    'currency', coalesce(nullif(r->>10,''),'USD'),
    'is_pending', coalesce((r->>11)::boolean,false),
    'is_recurring', false,
    'metadata', jsonb_build_object(
      'source','chatgpt_finances',
      'raw_signed_amount',(r->>12)::numeric,
      'category_detailed',nullif(r->>13,''),
      'category_confidence',nullif(r->>14,'')
    )
  )), '[]'::jsonb)
  into v
  from jsonb_array_elements(p_rows) as x(r);

  return public.bulk_upsert_finance_transactions(v);
end;
$$;


--
-- Name: can_view_card_basic_info(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_card_basic_info(card_user_id uuid, card_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 
    -- Card owner can always view
    (auth.uid() = card_user_id) OR
    -- Any team member can view basic info
    (card_team_id IS NOT NULL AND public.is_team_member(auth.uid(), card_team_id))
$$;


--
-- Name: can_view_card_financial_details(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_view_card_financial_details(card_user_id uuid, card_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT 
    -- Card owner can always view
    (auth.uid() = card_user_id) OR
    -- Team owner/admin can view team cards
    (card_team_id IS NOT NULL AND public.get_team_role(auth.uid(), card_team_id) = ANY (ARRAY['owner'::text, 'admin'::text]))
$$;


--
-- Name: card_backfill_ingest_compact(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.card_backfill_ingest_compact(p_rows jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_full jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'account_external_id', r->>0,
    'external_id', r->>1,
    'transaction_date', r->>2,
    'posted_at', nullif(r->>3,''),
    'description', coalesce(nullif(r->>4,''),'Unknown transaction'),
    'merchant_name', nullif(r->>5,''),
    'category', nullif(r->>6,''),
    'transaction_type', case
      when (r->>6) = 'transfers' and (r->>7) = 'transfers_credit_card_payment' then 'payment'
      when (r->>6) = 'transfers' then 'transfer'
      when coalesce((r->>9)::numeric,0) < 0 and (r->>6) = 'income' then 'income'
      when coalesce((r->>9)::numeric,0) < 0 then 'refund'
      when (r->>6) = 'financial' and lower(coalesce(r->>7,'')) like '%fee%' then 'fee'
      when (r->>6) = 'financial' and lower(coalesce(r->>7,'')) like '%interest%' then 'interest'
      else 'expense'
    end,
    'amount', abs(coalesce((r->>9)::numeric,0)),
    'currency', coalesce(nullif(r->>10,''),'USD'),
    'is_pending', false,
    'is_recurring', false,
    'transfer_account_external_id', nullif(r->>11,''),
    'metadata', jsonb_build_object(
      'source','chatgpt_finances',
      'raw_signed_amount', coalesce((r->>9)::numeric,0),
      'category_detailed', nullif(r->>7,''),
      'category_confidence', nullif(r->>8,'')
    )
  )), '[]'::jsonb)
  into v_full
  from jsonb_array_elements(p_rows) r;

  return public.bulk_upsert_finance_transactions(v_full);
end;
$$;


--
-- Name: cardtracker_sync_apply(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cardtracker_sync_apply(p_payload jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO 'public', 'internal'
    AS $$
  select internal.cardtracker_sync_apply(p_payload);
$$;


--
-- Name: create_team_with_owner(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_team_with_owner(team_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  new_team_id UUID;
  calling_user UUID;
BEGIN
  -- Explicit check that user is authenticated
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  INSERT INTO public.teams (name, created_by)
  VALUES (team_name, calling_user)
  RETURNING id INTO new_team_id;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (new_team_id, calling_user, 'owner');
  
  RETURN new_team_id;
END;
$$;


--
-- Name: finance_prune_pending(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_prune_pending(p_external_account_id text, p_keep_external_ids jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: finance_upsert(text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finance_upsert(p_table text, p_rows jsonb, p_conflict text DEFAULT 'external_id'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_allowed text[] := array[
    'accounts', 'transactions', 'balance_snapshots',
    'cashflow_forecast', 'cashflow_daily', 'alerts', 'credit_cards'
  ];
  v_cols text;
  v_set text;
  v_has_updated boolean;
  v_count int;
begin
  if not (p_table = any(v_allowed)) then
    raise exception 'table % is not allowed', p_table;
  end if;
  if p_conflict !~ '^[a-z_]+(\s*,\s*[a-z_]+)*$' then
    raise exception 'invalid conflict target: %', p_conflict;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('table', p_table, 'upserted', 0);
  end if;
  if not exists (
    select 1
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    where ns.nspname = 'public' and t.relname = p_table and i.indisunique
      and (
        select array_agg(a.attname::text order by a.attname::text)
        from unnest(i.indkey) as k(attnum)
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      ) = (select array_agg(trim(x) order by trim(x)) from unnest(string_to_array(p_conflict, ',')) as x)
  ) then
    raise exception 'no unique index on %(%) to support ON CONFLICT', p_table, p_conflict;
  end if;

  select string_agg(quote_ident(k), ', ') into v_cols
    from jsonb_object_keys(p_rows->0) k;
  select string_agg(format('%I = excluded.%I', k, k), ', ') into v_set
    from jsonb_object_keys(p_rows->0) k
    where k <> all (string_to_array(replace(p_conflict, ' ', ''), ','));

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = 'updated_at'
  ) into v_has_updated;
  if v_has_updated then
    v_set := coalesce(nullif(v_set, ''), '') ||
             case when nullif(v_set, '') is null then '' else ', ' end || 'updated_at = now()';
  end if;

  if nullif(v_set, '') is null then
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) ' ||
      'on conflict (%s) do nothing',
      p_table, v_cols, v_cols, p_table, p_conflict
    ) using p_rows;
  else
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1) ' ||
      'on conflict (%s) do update set %s',
      p_table, v_cols, v_cols, p_table, p_conflict, v_set
    ) using p_rows;
  end if;

  get diagnostics v_count = row_count;
  return jsonb_build_object('table', p_table, 'upserted', v_count);
end;
$_$;


--
-- Name: get_team_role(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_team_role(user_uuid uuid, check_team_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role FROM public.team_members 
  WHERE user_id = user_uuid AND team_id = check_team_id
  LIMIT 1
$$;


--
-- Name: get_user_team_ids(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_team_ids(user_uuid uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT team_id FROM public.team_members WHERE user_id = user_uuid
$$;


--
-- Name: is_team_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_team_member(user_uuid uuid, check_team_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members 
    WHERE user_id = user_uuid AND team_id = check_team_id
  )
$$;


--
-- Name: join_team_by_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_team_by_invite(code text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  found_team_id UUID;
  calling_user UUID;
BEGIN
  -- Explicit check that user is authenticated
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  SELECT id INTO found_team_id FROM public.teams WHERE invite_code = code;
  
  IF found_team_id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (found_team_id, calling_user, 'member')
  ON CONFLICT (team_id, user_id) DO NOTHING;
  
  RETURN found_team_id;
END;
$$;


--
-- Name: remap_card(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remap_card(p_external_account_id text, p_new_last_four text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_accounts_updated int := 0;
  v_cards_updated int := 0;
  v_account_last_four text;
begin
  if p_new_last_four is null or p_new_last_four !~ '^[0-9]{4,5}$' then
    raise exception 'invalid last_four (expected 4-5 digits): %', p_new_last_four;
  end if;
  if p_external_account_id is null or length(p_external_account_id) < 6 then
    raise exception 'invalid external_account_id';
  end if;

  v_account_last_four := right(p_new_last_four, 4);

  update public.accounts
    set last_four = v_account_last_four, updated_at = now()
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
    'account_last_four', v_account_last_four,
    'card_display_last_four', p_new_last_four,
    'accounts_updated', v_accounts_updated,
    'cards_updated', v_cards_updated
  );
end;
$_$;


--
-- Name: remap_external_account_id(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remap_external_account_id(p_old_external_account_id text, p_new_external_account_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_account_id uuid;
  v_existing_new_account_id uuid;
  v_accounts_updated int := 0;
  v_cards_updated int := 0;
begin
  if p_old_external_account_id is null or length(p_old_external_account_id) < 6 then
    raise exception 'invalid old external_account_id';
  end if;
  if p_new_external_account_id is null or length(p_new_external_account_id) < 6 then
    raise exception 'invalid new external_account_id';
  end if;
  if p_old_external_account_id = p_new_external_account_id then
    raise exception 'old and new external_account_id are identical';
  end if;

  select id into v_account_id
  from public.accounts
  where external_id = p_old_external_account_id
  limit 1;

  select id into v_existing_new_account_id
  from public.accounts
  where external_id = p_new_external_account_id
  limit 1;

  if v_account_id is not null then
    if v_existing_new_account_id is not null and v_existing_new_account_id <> v_account_id then
      raise exception 'new external_account_id already belongs to another account';
    end if;

    update public.accounts
      set external_id = p_new_external_account_id,
          updated_at = now()
      where id = v_account_id;
    get diagnostics v_accounts_updated = row_count;
  elsif v_existing_new_account_id is not null then
    -- Account was already remapped; use it to align the credit_cards row.
    v_account_id := v_existing_new_account_id;
  else
    raise exception 'no account found for old or new external_account_id';
  end if;

  update public.credit_cards
    set finance_external_account_id = p_new_external_account_id,
        updated_at = now()
    where account_id = v_account_id
       or finance_external_account_id = p_old_external_account_id;
  get diagnostics v_cards_updated = row_count;

  if v_cards_updated = 0 then
    raise exception 'no credit card row found for account %', v_account_id;
  end if;

  return jsonb_build_object(
    'old_external_account_id', p_old_external_account_id,
    'new_external_account_id', p_new_external_account_id,
    'account_id', v_account_id,
    'accounts_updated', v_accounts_updated,
    'cards_updated', v_cards_updated
  );
end;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    name text NOT NULL,
    institution_name text,
    account_type text NOT NULL,
    account_subtype text,
    currency text DEFAULT 'USD'::text NOT NULL,
    current_balance numeric(14,2) DEFAULT 0 NOT NULL,
    available_balance numeric(14,2),
    credit_limit numeric(14,2),
    interest_rate numeric(7,4),
    last_four text,
    is_active boolean DEFAULT true NOT NULL,
    include_in_net_worth boolean DEFAULT true NOT NULL,
    external_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT accounts_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'cash'::text, 'credit_card'::text, 'loan'::text, 'investment'::text, 'other'::text]))),
    CONSTRAINT accounts_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT accounts_last_four_check CHECK (((last_four IS NULL) OR (last_four ~ '^[0-9]{4}$'::text)))
);


--
-- Name: ad_spend_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ad_spend_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    card_id uuid NOT NULL,
    year integer NOT NULL,
    threshold integer NOT NULL,
    spent numeric(12,2) NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    account_id uuid,
    credit_card_id uuid,
    alert_type text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    title text NOT NULL,
    message text,
    trigger_value numeric(14,2),
    threshold_value numeric(14,2),
    status text DEFAULT 'active'::text NOT NULL,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alerts_alert_type_check CHECK ((alert_type = ANY (ARRAY['low_balance'::text, 'high_balance'::text, 'large_transaction'::text, 'payment_due'::text, 'statement_closing'::text, 'budget'::text, 'cashflow'::text, 'forecast'::text, 'fee'::text, 'custom'::text]))),
    CONSTRAINT alerts_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT alerts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'read'::text, 'dismissed'::text, 'resolved'::text])))
);


--
-- Name: balance_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.balance_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    account_id uuid NOT NULL,
    snapshot_date date NOT NULL,
    current_balance numeric(14,2) NOT NULL,
    available_balance numeric(14,2),
    credit_limit numeric(14,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: card_available_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_available_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    card_id uuid NOT NULL,
    available_points integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cashflow_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    cashflow_date date NOT NULL,
    inflow numeric(14,2) DEFAULT 0 NOT NULL,
    outflow numeric(14,2) DEFAULT 0 NOT NULL,
    net_cashflow numeric(14,2) GENERATED ALWAYS AS ((inflow - outflow)) STORED,
    ending_balance numeric(14,2),
    source text DEFAULT 'computed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cashflow_daily_inflow_check CHECK ((inflow >= (0)::numeric)),
    CONSTRAINT cashflow_daily_outflow_check CHECK ((outflow >= (0)::numeric))
);


--
-- Name: cashflow_forecast; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_forecast (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    forecast_date date NOT NULL,
    expected_inflow numeric(14,2) DEFAULT 0 NOT NULL,
    expected_outflow numeric(14,2) DEFAULT 0 NOT NULL,
    projected_net_cashflow numeric(14,2) GENERATED ALWAYS AS ((expected_inflow - expected_outflow)) STORED,
    projected_balance numeric(14,2),
    confidence numeric(5,4),
    model_version text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cashflow_forecast_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT cashflow_forecast_expected_inflow_check CHECK ((expected_inflow >= (0)::numeric)),
    CONSTRAINT cashflow_forecast_expected_outflow_check CHECK ((expected_outflow >= (0)::numeric))
);


--
-- Name: credit_card_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_card_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    person text NOT NULL,
    card_name text NOT NULL,
    points_redeemed integer DEFAULT 0 NOT NULL,
    redemption_date date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    card_id uuid
);


--
-- Name: credit_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    owner_name text NOT NULL,
    last_four text,
    network text,
    annual_fee numeric(10,2) DEFAULT 0,
    annual_fee_date date,
    next_fee_date date,
    credit_limit numeric(10,2) DEFAULT 0,
    current_balance numeric(10,2) DEFAULT 0,
    statement_date integer,
    due_date integer,
    notes text,
    image_url text,
    display_order integer DEFAULT 0,
    company_name text,
    payment_status text,
    total_balance numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    team_id uuid,
    account_id uuid,
    finance_external_account_id text,
    next_payment_due_date date,
    last_statement_date date,
    last_statement_balance numeric,
    minimum_payment numeric,
    last_payment_date date,
    last_payment_amount numeric,
    purchase_apr numeric,
    is_overdue boolean,
    finance_synced_at timestamp with time zone
);


--
-- Name: finance_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    name text NOT NULL,
    institution_name text,
    account_type text NOT NULL,
    account_subtype text,
    currency text DEFAULT 'USD'::text NOT NULL,
    current_balance numeric(14,2) DEFAULT 0 NOT NULL,
    available_balance numeric(14,2),
    credit_limit numeric(14,2),
    interest_rate numeric(7,4),
    last_four text,
    is_active boolean DEFAULT true NOT NULL,
    include_in_net_worth boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['checking'::text, 'savings'::text, 'cash'::text, 'credit_card'::text, 'loan'::text, 'investment'::text, 'other'::text]))),
    CONSTRAINT finance_accounts_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT finance_accounts_last_four_check CHECK (((last_four IS NULL) OR (last_four ~ '^[0-9]{4}$'::text)))
);


--
-- Name: finance_budget_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_budget_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    budget_id uuid NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    category_id uuid NOT NULL,
    planned_amount numeric(14,2) NOT NULL,
    rollover_enabled boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_budget_items_planned_amount_check CHECK ((planned_amount >= (0)::numeric))
);


--
-- Name: finance_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    name text NOT NULL,
    period_type text DEFAULT 'monthly'::text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_budgets_check CHECK ((end_date >= start_date)),
    CONSTRAINT finance_budgets_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT finance_budgets_period_type_check CHECK ((period_type = ANY (ARRAY['weekly'::text, 'monthly'::text, 'quarterly'::text, 'yearly'::text, 'custom'::text])))
);


--
-- Name: finance_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    name text NOT NULL,
    category_type text NOT NULL,
    parent_id uuid,
    icon text,
    color text,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_categories_category_type_check CHECK ((category_type = ANY (ARRAY['income'::text, 'expense'::text, 'transfer'::text])))
);


--
-- Name: finance_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    account_id uuid NOT NULL,
    category_id uuid,
    transfer_account_id uuid,
    transaction_date date NOT NULL,
    posted_at timestamp with time zone,
    description text NOT NULL,
    merchant_name text,
    transaction_type text NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_pending boolean DEFAULT false NOT NULL,
    is_recurring boolean DEFAULT false NOT NULL,
    external_id text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_transactions_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT finance_transactions_check CHECK (((transaction_type = 'transfer'::text) OR (transfer_account_id IS NULL))),
    CONSTRAINT finance_transactions_check1 CHECK ((account_id IS DISTINCT FROM transfer_account_id)),
    CONSTRAINT finance_transactions_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT finance_transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['income'::text, 'expense'::text, 'transfer'::text])))
);


--
-- Name: finance_category_spending; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.finance_category_spending WITH (security_invoker='true') AS
 SELECT t.user_id,
    t.team_id,
    (date_trunc('month'::text, (t.transaction_date)::timestamp with time zone))::date AS month,
    t.category_id,
    COALESCE(c.name, 'Uncategorized'::text) AS category_name,
    sum(t.amount) AS amount
   FROM (public.finance_transactions t
     LEFT JOIN public.finance_categories c ON ((c.id = t.category_id)))
  WHERE ((t.transaction_type = 'expense'::text) AND (NOT t.is_pending))
  GROUP BY t.user_id, t.team_id, ((date_trunc('month'::text, (t.transaction_date)::timestamp with time zone))::date), t.category_id, c.name;


--
-- Name: finance_monthly_cash_flow; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.finance_monthly_cash_flow WITH (security_invoker='true') AS
 SELECT user_id,
    team_id,
    (date_trunc('month'::text, (transaction_date)::timestamp with time zone))::date AS month,
    sum(
        CASE
            WHEN (transaction_type = 'income'::text) THEN amount
            ELSE (0)::numeric
        END) AS income,
    sum(
        CASE
            WHEN (transaction_type = 'expense'::text) THEN amount
            ELSE (0)::numeric
        END) AS expenses,
    sum(
        CASE
            WHEN (transaction_type = 'income'::text) THEN amount
            WHEN (transaction_type = 'expense'::text) THEN (- amount)
            ELSE (0)::numeric
        END) AS net_cash_flow
   FROM public.finance_transactions
  WHERE (NOT is_pending)
  GROUP BY user_id, team_id, ((date_trunc('month'::text, (transaction_date)::timestamp with time zone))::date);


--
-- Name: finance_net_worth_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_net_worth_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    snapshot_date date NOT NULL,
    total_assets numeric(14,2) DEFAULT 0 NOT NULL,
    total_liabilities numeric(14,2) DEFAULT 0 NOT NULL,
    net_worth numeric(14,2) GENERATED ALWAYS AS ((total_assets - total_liabilities)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: finance_recurring_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.finance_recurring_bills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    account_id uuid,
    category_id uuid,
    name text NOT NULL,
    merchant_name text,
    amount numeric(14,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    frequency text NOT NULL,
    interval_count integer DEFAULT 1 NOT NULL,
    next_due_date date,
    autopay boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT finance_recurring_bills_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT finance_recurring_bills_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT finance_recurring_bills_frequency_check CHECK ((frequency = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text, 'semiannual'::text, 'annual'::text, 'custom'::text]))),
    CONSTRAINT finance_recurring_bills_interval_count_check CHECK ((interval_count > 0))
);


--
-- Name: mfa_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfa_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    purpose text DEFAULT 'login'::text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plaid_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plaid_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plaid_account_id text NOT NULL,
    name text,
    official_name text,
    institution text,
    mask text,
    type text,
    subtype text,
    current_balance numeric(12,2),
    available_balance numeric(12,2),
    credit_limit numeric(12,2),
    iso_currency_code text DEFAULT 'USD'::text,
    last_statement_balance numeric(12,2),
    minimum_payment numeric(12,2),
    next_payment_due_date date,
    apr_percentage numeric(6,3),
    raw jsonb,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plaid_ingestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plaid_ingestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    accounts_upserted integer DEFAULT 0 NOT NULL,
    transactions_upserted integer DEFAULT 0 NOT NULL,
    cards_updated integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'chatgpt'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plaid_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plaid_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    item_id text NOT NULL,
    access_token text NOT NULL,
    institution_name text,
    institution_id text,
    transactions_cursor text,
    status text DEFAULT 'active'::text NOT NULL,
    last_synced_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    syncing_at timestamp with time zone
);


--
-- Name: plaid_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plaid_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plaid_transaction_id text NOT NULL,
    plaid_account_id text NOT NULL,
    date date NOT NULL,
    name text NOT NULL,
    merchant_name text,
    amount numeric(12,2) NOT NULL,
    iso_currency_code text DEFAULT 'USD'::text,
    category text,
    pending boolean DEFAULT false NOT NULL,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: points_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points_change_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    card_id uuid NOT NULL,
    old_points integer DEFAULT 0 NOT NULL,
    new_points integer NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL
);


--
-- Name: shipment_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipment_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    marketplace_id text NOT NULL,
    shipment_id text NOT NULL,
    shipment_name text,
    brand_id text,
    status text,
    destination_fc_id text,
    label_prep_type text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    amazon_created_at timestamp with time zone,
    amazon_last_updated_at timestamp with time zone,
    shipping_window_start date,
    shipping_window_end date,
    shipping_window_source text,
    inbound_plan_id text,
    inbound_shipment_id text,
    delivery_window_option_id text,
    quantity_sent integer,
    quantity_received integer,
    sku text,
    tracking_id text,
    is_partnered boolean,
    shipment_type text,
    cached_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text DEFAULT 'My Team'::text NOT NULL,
    invite_code text DEFAULT encode(extensions.gen_random_bytes(6), 'hex'::text) NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    team_id uuid,
    account_id uuid,
    credit_card_id uuid,
    transfer_account_id uuid,
    transaction_date date NOT NULL,
    posted_at timestamp with time zone,
    description text NOT NULL,
    merchant_name text,
    category text,
    transaction_type text NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_pending boolean DEFAULT false NOT NULL,
    is_recurring boolean DEFAULT false NOT NULL,
    external_id text,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transactions_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT transactions_check CHECK (((account_id IS NULL) OR (account_id IS DISTINCT FROM transfer_account_id))),
    CONSTRAINT transactions_currency_check CHECK ((char_length(currency) = 3)),
    CONSTRAINT transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['income'::text, 'expense'::text, 'transfer'::text, 'payment'::text, 'refund'::text, 'fee'::text, 'interest'::text, 'adjustment'::text])))
);


--
-- Name: trusted_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trusted_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    label text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_security; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_security (
    user_id uuid NOT NULL,
    email_mfa_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: ad_spend_alerts ad_spend_alerts_card_id_year_threshold_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_spend_alerts
    ADD CONSTRAINT ad_spend_alerts_card_id_year_threshold_key UNIQUE (card_id, year, threshold);


--
-- Name: ad_spend_alerts ad_spend_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_spend_alerts
    ADD CONSTRAINT ad_spend_alerts_pkey PRIMARY KEY (id);


--
-- Name: alerts alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);


--
-- Name: balance_snapshots balance_snapshots_account_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_snapshots
    ADD CONSTRAINT balance_snapshots_account_id_snapshot_date_key UNIQUE (account_id, snapshot_date);


--
-- Name: balance_snapshots balance_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_snapshots
    ADD CONSTRAINT balance_snapshots_pkey PRIMARY KEY (id);


--
-- Name: card_available_points card_available_points_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_available_points
    ADD CONSTRAINT card_available_points_card_id_key UNIQUE (card_id);


--
-- Name: card_available_points card_available_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_available_points
    ADD CONSTRAINT card_available_points_pkey PRIMARY KEY (id);


--
-- Name: cashflow_daily cashflow_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_daily
    ADD CONSTRAINT cashflow_daily_pkey PRIMARY KEY (id);


--
-- Name: cashflow_daily cashflow_daily_user_id_team_id_cashflow_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_daily
    ADD CONSTRAINT cashflow_daily_user_id_team_id_cashflow_date_key UNIQUE (user_id, team_id, cashflow_date);


--
-- Name: cashflow_forecast cashflow_forecast_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast
    ADD CONSTRAINT cashflow_forecast_pkey PRIMARY KEY (id);


--
-- Name: cashflow_forecast cashflow_forecast_user_id_team_id_forecast_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast
    ADD CONSTRAINT cashflow_forecast_user_id_team_id_forecast_date_key UNIQUE (user_id, team_id, forecast_date);


--
-- Name: credit_card_points credit_card_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_card_points
    ADD CONSTRAINT credit_card_points_pkey PRIMARY KEY (id);


--
-- Name: credit_cards credit_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_cards
    ADD CONSTRAINT credit_cards_pkey PRIMARY KEY (id);


--
-- Name: finance_accounts finance_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_accounts
    ADD CONSTRAINT finance_accounts_pkey PRIMARY KEY (id);


--
-- Name: finance_budget_items finance_budget_items_budget_id_category_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budget_items
    ADD CONSTRAINT finance_budget_items_budget_id_category_id_key UNIQUE (budget_id, category_id);


--
-- Name: finance_budget_items finance_budget_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budget_items
    ADD CONSTRAINT finance_budget_items_pkey PRIMARY KEY (id);


--
-- Name: finance_budgets finance_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budgets
    ADD CONSTRAINT finance_budgets_pkey PRIMARY KEY (id);


--
-- Name: finance_categories finance_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_categories
    ADD CONSTRAINT finance_categories_pkey PRIMARY KEY (id);


--
-- Name: finance_net_worth_snapshots finance_net_worth_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_net_worth_snapshots
    ADD CONSTRAINT finance_net_worth_snapshots_pkey PRIMARY KEY (id);


--
-- Name: finance_net_worth_snapshots finance_net_worth_snapshots_user_id_team_id_snapshot_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_net_worth_snapshots
    ADD CONSTRAINT finance_net_worth_snapshots_user_id_team_id_snapshot_date_key UNIQUE (user_id, team_id, snapshot_date);


--
-- Name: finance_recurring_bills finance_recurring_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_recurring_bills
    ADD CONSTRAINT finance_recurring_bills_pkey PRIMARY KEY (id);


--
-- Name: finance_transactions finance_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_pkey PRIMARY KEY (id);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: plaid_accounts plaid_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_accounts
    ADD CONSTRAINT plaid_accounts_pkey PRIMARY KEY (id);


--
-- Name: plaid_accounts plaid_accounts_user_id_plaid_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_accounts
    ADD CONSTRAINT plaid_accounts_user_id_plaid_account_id_key UNIQUE (user_id, plaid_account_id);


--
-- Name: plaid_ingestions plaid_ingestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_ingestions
    ADD CONSTRAINT plaid_ingestions_pkey PRIMARY KEY (id);


--
-- Name: plaid_items plaid_items_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_item_id_key UNIQUE (item_id);


--
-- Name: plaid_items plaid_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_items
    ADD CONSTRAINT plaid_items_pkey PRIMARY KEY (id);


--
-- Name: plaid_transactions plaid_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_transactions
    ADD CONSTRAINT plaid_transactions_pkey PRIMARY KEY (id);


--
-- Name: plaid_transactions plaid_transactions_user_id_plaid_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_transactions
    ADD CONSTRAINT plaid_transactions_user_id_plaid_transaction_id_key UNIQUE (user_id, plaid_transaction_id);


--
-- Name: points_change_log points_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_change_log
    ADD CONSTRAINT points_change_log_pkey PRIMARY KEY (id);


--
-- Name: shipment_metadata shipment_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_metadata
    ADD CONSTRAINT shipment_metadata_pkey PRIMARY KEY (id);


--
-- Name: shipment_metadata shipment_metadata_user_id_marketplace_id_shipment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipment_metadata
    ADD CONSTRAINT shipment_metadata_user_id_marketplace_id_shipment_id_key UNIQUE (user_id, marketplace_id, shipment_id);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_team_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_user_id_key UNIQUE (team_id, user_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: trusted_devices trusted_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_devices
    ADD CONSTRAINT trusted_devices_pkey PRIMARY KEY (id);


--
-- Name: user_security user_security_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_security
    ADD CONSTRAINT user_security_pkey PRIMARY KEY (user_id);


--
-- Name: accounts_external_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_external_id_uidx ON public.accounts USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: accounts_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_team_id_idx ON public.accounts USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: accounts_user_external_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_user_external_id_uidx ON public.accounts USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: accounts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);


--
-- Name: alerts_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_account_idx ON public.alerts USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: alerts_credit_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_credit_card_idx ON public.alerts USING btree (credit_card_id) WHERE (credit_card_id IS NOT NULL);


--
-- Name: alerts_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alerts_user_status_idx ON public.alerts USING btree (user_id, status, triggered_at DESC);


--
-- Name: balance_snapshots_account_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX balance_snapshots_account_date_idx ON public.balance_snapshots USING btree (account_id, snapshot_date DESC);


--
-- Name: balance_snapshots_user_account_date_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX balance_snapshots_user_account_date_uidx ON public.balance_snapshots USING btree (user_id, account_id, snapshot_date);


--
-- Name: balance_snapshots_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX balance_snapshots_user_date_idx ON public.balance_snapshots USING btree (user_id, snapshot_date DESC);


--
-- Name: cashflow_daily_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_daily_user_date_idx ON public.cashflow_daily USING btree (user_id, cashflow_date DESC);


--
-- Name: cashflow_daily_user_date_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cashflow_daily_user_date_uidx ON public.cashflow_daily USING btree (user_id, cashflow_date);


--
-- Name: cashflow_forecast_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_forecast_user_date_idx ON public.cashflow_forecast USING btree (user_id, forecast_date);


--
-- Name: credit_cards_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_cards_account_id_idx ON public.credit_cards USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: credit_cards_user_finance_external_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_cards_user_finance_external_uidx ON public.credit_cards USING btree (user_id, finance_external_account_id) WHERE (finance_external_account_id IS NOT NULL);


--
-- Name: finance_accounts_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_accounts_team_id_idx ON public.finance_accounts USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_accounts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_accounts_user_id_idx ON public.finance_accounts USING btree (user_id);


--
-- Name: finance_budget_items_budget_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budget_items_budget_idx ON public.finance_budget_items USING btree (budget_id);


--
-- Name: finance_budget_items_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budget_items_category_id_idx ON public.finance_budget_items USING btree (category_id);


--
-- Name: finance_budget_items_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budget_items_team_id_idx ON public.finance_budget_items USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_budget_items_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budget_items_user_id_idx ON public.finance_budget_items USING btree (user_id);


--
-- Name: finance_budgets_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budgets_team_id_idx ON public.finance_budgets USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_budgets_user_dates_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_budgets_user_dates_idx ON public.finance_budgets USING btree (user_id, start_date, end_date);


--
-- Name: finance_categories_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_categories_parent_id_idx ON public.finance_categories USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: finance_categories_scope_name_type_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX finance_categories_scope_name_type_uidx ON public.finance_categories USING btree (user_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name), category_type);


--
-- Name: finance_categories_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_categories_team_id_idx ON public.finance_categories USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_categories_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_categories_user_id_idx ON public.finance_categories USING btree (user_id);


--
-- Name: finance_net_worth_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_net_worth_team_id_idx ON public.finance_net_worth_snapshots USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_net_worth_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_net_worth_user_date_idx ON public.finance_net_worth_snapshots USING btree (user_id, snapshot_date DESC);


--
-- Name: finance_recurring_bills_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_recurring_bills_account_id_idx ON public.finance_recurring_bills USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: finance_recurring_bills_category_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_recurring_bills_category_id_idx ON public.finance_recurring_bills USING btree (category_id) WHERE (category_id IS NOT NULL);


--
-- Name: finance_recurring_bills_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_recurring_bills_team_id_idx ON public.finance_recurring_bills USING btree (team_id) WHERE (team_id IS NOT NULL);


--
-- Name: finance_recurring_bills_user_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_recurring_bills_user_due_idx ON public.finance_recurring_bills USING btree (user_id, next_due_date) WHERE is_active;


--
-- Name: finance_transactions_account_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_account_date_idx ON public.finance_transactions USING btree (account_id, transaction_date DESC);


--
-- Name: finance_transactions_category_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_category_date_idx ON public.finance_transactions USING btree (category_id, transaction_date DESC) WHERE (category_id IS NOT NULL);


--
-- Name: finance_transactions_external_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX finance_transactions_external_id_uidx ON public.finance_transactions USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: finance_transactions_team_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_team_date_idx ON public.finance_transactions USING btree (team_id, transaction_date DESC) WHERE (team_id IS NOT NULL);


--
-- Name: finance_transactions_transfer_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_transfer_account_idx ON public.finance_transactions USING btree (transfer_account_id) WHERE (transfer_account_id IS NOT NULL);


--
-- Name: finance_transactions_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX finance_transactions_user_date_idx ON public.finance_transactions USING btree (user_id, transaction_date DESC);


--
-- Name: idx_card_available_points_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_card_available_points_user_id ON public.card_available_points USING btree (user_id);


--
-- Name: idx_credit_card_points_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_card_points_person ON public.credit_card_points USING btree (person);


--
-- Name: idx_credit_card_points_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_card_points_user_id ON public.credit_card_points USING btree (user_id);


--
-- Name: idx_plaid_transactions_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plaid_transactions_account ON public.plaid_transactions USING btree (user_id, plaid_account_id);


--
-- Name: idx_plaid_transactions_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plaid_transactions_user_date ON public.plaid_transactions USING btree (user_id, date DESC);


--
-- Name: idx_points_change_log_changed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_points_change_log_changed_at ON public.points_change_log USING btree (changed_at DESC);


--
-- Name: idx_points_change_log_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_points_change_log_user_id ON public.points_change_log USING btree (user_id);


--
-- Name: idx_shipment_metadata_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_metadata_brand ON public.shipment_metadata USING btree (user_id, marketplace_id, brand_id);


--
-- Name: idx_shipment_metadata_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shipment_metadata_lookup ON public.shipment_metadata USING btree (user_id, marketplace_id, shipment_id);


--
-- Name: idx_teams_invite_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_teams_invite_code ON public.teams USING btree (invite_code);


--
-- Name: transactions_account_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_account_date_idx ON public.transactions USING btree (account_id, transaction_date DESC);


--
-- Name: transactions_credit_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_credit_card_idx ON public.transactions USING btree (credit_card_id) WHERE (credit_card_id IS NOT NULL);


--
-- Name: transactions_external_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_external_id_uidx ON public.transactions USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: transactions_transfer_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_transfer_account_idx ON public.transactions USING btree (transfer_account_id) WHERE (transfer_account_id IS NOT NULL);


--
-- Name: transactions_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transactions_user_date_idx ON public.transactions USING btree (user_id, transaction_date DESC);


--
-- Name: transactions_user_external_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX transactions_user_external_id_uidx ON public.transactions USING btree (user_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: trusted_devices_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trusted_devices_user_idx ON public.trusted_devices USING btree (user_id);


--
-- Name: ux_accounts_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_accounts_external_id ON public.accounts USING btree (external_id);


--
-- Name: ux_balance_snapshots_acct_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_balance_snapshots_acct_date ON public.balance_snapshots USING btree (account_id, snapshot_date);


--
-- Name: ux_cashflow_daily_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_cashflow_daily_user_date ON public.cashflow_daily USING btree (user_id, cashflow_date);


--
-- Name: ux_cashflow_forecast_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_cashflow_forecast_user_date ON public.cashflow_forecast USING btree (user_id, forecast_date);


--
-- Name: ux_credit_cards_ext_acct; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_credit_cards_ext_acct ON public.credit_cards USING btree (finance_external_account_id);


--
-- Name: ux_transactions_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_transactions_external_id ON public.transactions USING btree (external_id);


--
-- Name: accounts accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: alerts alerts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alerts_set_updated_at BEFORE UPDATE ON public.alerts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: cashflow_daily cashflow_daily_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cashflow_daily_set_updated_at BEFORE UPDATE ON public.cashflow_daily FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: cashflow_forecast cashflow_forecast_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cashflow_forecast_set_updated_at BEFORE UPDATE ON public.cashflow_forecast FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_accounts finance_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_accounts_set_updated_at BEFORE UPDATE ON public.finance_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_budget_items finance_budget_items_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_budget_items_set_updated_at BEFORE UPDATE ON public.finance_budget_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_budgets finance_budgets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_budgets_set_updated_at BEFORE UPDATE ON public.finance_budgets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_categories finance_categories_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_categories_set_updated_at BEFORE UPDATE ON public.finance_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_recurring_bills finance_recurring_bills_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_recurring_bills_set_updated_at BEFORE UPDATE ON public.finance_recurring_bills FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: finance_transactions finance_transactions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER finance_transactions_set_updated_at BEFORE UPDATE ON public.finance_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transactions transactions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transactions_set_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: transactions trg_apply_cardtracker_ad_classification; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_apply_cardtracker_ad_classification BEFORE INSERT OR UPDATE OF description, merchant_name, category, transaction_type, amount, metadata, account_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.apply_cardtracker_ad_classification();


--
-- Name: credit_cards update_credit_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_credit_cards_updated_at BEFORE UPDATE ON public.credit_cards FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plaid_accounts update_plaid_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_plaid_accounts_updated_at BEFORE UPDATE ON public.plaid_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: plaid_transactions update_plaid_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_plaid_transactions_updated_at BEFORE UPDATE ON public.plaid_transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: shipment_metadata update_shipment_metadata_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_shipment_metadata_updated_at BEFORE UPDATE ON public.shipment_metadata FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: teams update_teams_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_teams_updated_at BEFORE UPDATE ON public.teams FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ad_spend_alerts ad_spend_alerts_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ad_spend_alerts
    ADD CONSTRAINT ad_spend_alerts_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.credit_cards(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_credit_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_credit_card_id_fkey FOREIGN KEY (credit_card_id) REFERENCES public.credit_cards(id) ON DELETE CASCADE;


--
-- Name: alerts alerts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alerts
    ADD CONSTRAINT alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: balance_snapshots balance_snapshots_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_snapshots
    ADD CONSTRAINT balance_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: balance_snapshots balance_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_snapshots
    ADD CONSTRAINT balance_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: card_available_points card_available_points_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_available_points
    ADD CONSTRAINT card_available_points_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.credit_cards(id) ON DELETE CASCADE;


--
-- Name: card_available_points card_available_points_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_available_points
    ADD CONSTRAINT card_available_points_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cashflow_daily cashflow_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_daily
    ADD CONSTRAINT cashflow_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: cashflow_forecast cashflow_forecast_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_forecast
    ADD CONSTRAINT cashflow_forecast_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: credit_card_points credit_card_points_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_card_points
    ADD CONSTRAINT credit_card_points_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.credit_cards(id) ON DELETE SET NULL;


--
-- Name: credit_card_points credit_card_points_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_card_points
    ADD CONSTRAINT credit_card_points_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: credit_cards credit_cards_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_cards
    ADD CONSTRAINT credit_cards_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: credit_cards credit_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_cards
    ADD CONSTRAINT credit_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_accounts finance_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_accounts
    ADD CONSTRAINT finance_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_budget_items finance_budget_items_budget_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budget_items
    ADD CONSTRAINT finance_budget_items_budget_id_fkey FOREIGN KEY (budget_id) REFERENCES public.finance_budgets(id) ON DELETE CASCADE;


--
-- Name: finance_budget_items finance_budget_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budget_items
    ADD CONSTRAINT finance_budget_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.finance_categories(id) ON DELETE CASCADE;


--
-- Name: finance_budget_items finance_budget_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budget_items
    ADD CONSTRAINT finance_budget_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_budgets finance_budgets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_budgets
    ADD CONSTRAINT finance_budgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_categories finance_categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_categories
    ADD CONSTRAINT finance_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.finance_categories(id) ON DELETE SET NULL;


--
-- Name: finance_categories finance_categories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_categories
    ADD CONSTRAINT finance_categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_net_worth_snapshots finance_net_worth_snapshots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_net_worth_snapshots
    ADD CONSTRAINT finance_net_worth_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_recurring_bills finance_recurring_bills_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_recurring_bills
    ADD CONSTRAINT finance_recurring_bills_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.finance_accounts(id) ON DELETE SET NULL;


--
-- Name: finance_recurring_bills finance_recurring_bills_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_recurring_bills
    ADD CONSTRAINT finance_recurring_bills_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.finance_categories(id) ON DELETE SET NULL;


--
-- Name: finance_recurring_bills finance_recurring_bills_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_recurring_bills
    ADD CONSTRAINT finance_recurring_bills_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: finance_transactions finance_transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.finance_accounts(id) ON DELETE CASCADE;


--
-- Name: finance_transactions finance_transactions_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.finance_categories(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_transfer_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_transfer_account_id_fkey FOREIGN KEY (transfer_account_id) REFERENCES public.finance_accounts(id) ON DELETE SET NULL;


--
-- Name: finance_transactions finance_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.finance_transactions
    ADD CONSTRAINT finance_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_challenges
    ADD CONSTRAINT mfa_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plaid_accounts plaid_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_accounts
    ADD CONSTRAINT plaid_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plaid_ingestions plaid_ingestions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_ingestions
    ADD CONSTRAINT plaid_ingestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: plaid_transactions plaid_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plaid_transactions
    ADD CONSTRAINT plaid_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: points_change_log points_change_log_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_change_log
    ADD CONSTRAINT points_change_log_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.credit_cards(id) ON DELETE CASCADE;


--
-- Name: points_change_log points_change_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points_change_log
    ADD CONSTRAINT points_change_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: transactions transactions_credit_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_credit_card_id_fkey FOREIGN KEY (credit_card_id) REFERENCES public.credit_cards(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_transfer_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_transfer_account_id_fkey FOREIGN KEY (transfer_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: transactions transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: trusted_devices trusted_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_devices
    ADD CONSTRAINT trusted_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_security user_security_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_security
    ADD CONSTRAINT user_security_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: credit_cards Authenticated users can create cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create cards" ON public.credit_cards FOR INSERT WITH CHECK (((auth.uid() IS NOT NULL) AND (auth.uid() = user_id)));


--
-- Name: credit_cards Authenticated users can delete all cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete all cards" ON public.credit_cards FOR DELETE USING ((auth.uid() IS NOT NULL));


--
-- Name: card_available_points Authenticated users can delete available points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete available points" ON public.card_available_points FOR DELETE USING ((auth.uid() IS NOT NULL));


--
-- Name: credit_card_points Authenticated users can delete points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete points" ON public.credit_card_points FOR DELETE USING ((auth.uid() IS NOT NULL));


--
-- Name: card_available_points Authenticated users can insert available points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert available points" ON public.card_available_points FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: points_change_log Authenticated users can insert change log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert change log" ON public.points_change_log FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: credit_card_points Authenticated users can insert points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert points" ON public.credit_card_points FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: credit_cards Authenticated users can update all cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update all cards" ON public.credit_cards FOR UPDATE USING ((auth.uid() IS NOT NULL));


--
-- Name: card_available_points Authenticated users can update available points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update available points" ON public.card_available_points FOR UPDATE USING ((auth.uid() IS NOT NULL));


--
-- Name: credit_card_points Authenticated users can update points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update points" ON public.credit_card_points FOR UPDATE USING ((auth.uid() IS NOT NULL));


--
-- Name: card_available_points Authenticated users can view all available points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view all available points" ON public.card_available_points FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: credit_cards Authenticated users can view all cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view all cards" ON public.credit_cards FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: points_change_log Authenticated users can view all change log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view all change log" ON public.points_change_log FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: credit_card_points Authenticated users can view all points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view all points" ON public.credit_card_points FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: teams Team owners can delete their teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team owners can delete their teams" ON public.teams FOR DELETE USING ((public.get_team_role(auth.uid(), id) = 'owner'::text));


--
-- Name: team_members Team owners can update member roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team owners can update member roles" ON public.team_members FOR UPDATE USING ((public.get_team_role(auth.uid(), team_id) = 'owner'::text)) WITH CHECK ((public.get_team_role(auth.uid(), team_id) = 'owner'::text));


--
-- Name: teams Team owners can update their teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team owners can update their teams" ON public.teams FOR UPDATE USING ((public.get_team_role(auth.uid(), id) = 'owner'::text));


--
-- Name: team_members Team owners/admins can remove members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team owners/admins can remove members" ON public.team_members FOR DELETE USING (((public.get_team_role(auth.uid(), team_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (user_id = auth.uid())));


--
-- Name: teams Users can create teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create teams" ON public.teams FOR INSERT WITH CHECK ((auth.uid() = created_by));


--
-- Name: shipment_metadata Users can create their own shipment metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own shipment metadata" ON public.shipment_metadata FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: team_members Users can join teams via invite; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can join teams via invite" ON public.team_members FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: shipment_metadata Users can update their own shipment metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own shipment metadata" ON public.shipment_metadata FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: team_members Users can view members of their teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view members of their teams" ON public.team_members FOR SELECT USING (public.is_team_member(auth.uid(), team_id));


--
-- Name: teams Users can view teams they belong to; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view teams they belong to" ON public.teams FOR SELECT USING ((id IN ( SELECT public.get_user_team_ids(auth.uid()) AS get_user_team_ids)));


--
-- Name: plaid_ingestions Users can view their own ingestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own ingestions" ON public.plaid_ingestions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: plaid_accounts Users can view their own plaid accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own plaid accounts" ON public.plaid_accounts FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: plaid_transactions Users can view their own plaid transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own plaid transactions" ON public.plaid_transactions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: shipment_metadata Users can view their own shipment metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own shipment metadata" ON public.shipment_metadata FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_delete ON public.accounts FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: accounts accounts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_insert ON public.accounts FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: accounts accounts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_select ON public.accounts FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: accounts accounts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_update ON public.accounts FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: ad_spend_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ad_spend_alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: alerts alerts_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alerts_delete ON public.alerts FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: alerts alerts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alerts_insert ON public.alerts FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: alerts alerts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alerts_select ON public.alerts FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: alerts alerts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY alerts_update ON public.alerts FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: balance_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.balance_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: balance_snapshots balance_snapshots_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY balance_snapshots_delete ON public.balance_snapshots FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: balance_snapshots balance_snapshots_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY balance_snapshots_insert ON public.balance_snapshots FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: balance_snapshots balance_snapshots_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY balance_snapshots_select ON public.balance_snapshots FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: balance_snapshots balance_snapshots_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY balance_snapshots_update ON public.balance_snapshots FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: card_available_points; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.card_available_points ENABLE ROW LEVEL SECURITY;

--
-- Name: cashflow_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: cashflow_daily cashflow_daily_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_daily_delete ON public.cashflow_daily FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_daily cashflow_daily_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_daily_insert ON public.cashflow_daily FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_daily cashflow_daily_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_daily_select ON public.cashflow_daily FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_daily cashflow_daily_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_daily_update ON public.cashflow_daily FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_forecast; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_forecast ENABLE ROW LEVEL SECURITY;

--
-- Name: cashflow_forecast cashflow_forecast_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_forecast_delete ON public.cashflow_forecast FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_forecast cashflow_forecast_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_forecast_insert ON public.cashflow_forecast FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_forecast cashflow_forecast_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_forecast_select ON public.cashflow_forecast FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: cashflow_forecast cashflow_forecast_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cashflow_forecast_update ON public.cashflow_forecast FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: credit_card_points; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_card_points ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_accounts finance_accounts_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_accounts_delete ON public.finance_accounts FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_accounts finance_accounts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_accounts_insert ON public.finance_accounts FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_accounts finance_accounts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_accounts_select ON public.finance_accounts FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_accounts finance_accounts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_accounts_update ON public.finance_accounts FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budget_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_budget_items ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_budget_items finance_budget_items_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budget_items_delete ON public.finance_budget_items FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budget_items finance_budget_items_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budget_items_insert ON public.finance_budget_items FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budget_items finance_budget_items_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budget_items_select ON public.finance_budget_items FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budget_items finance_budget_items_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budget_items_update ON public.finance_budget_items FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budgets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_budgets finance_budgets_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budgets_delete ON public.finance_budgets FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budgets finance_budgets_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budgets_insert ON public.finance_budgets FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budgets finance_budgets_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budgets_select ON public.finance_budgets FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_budgets finance_budgets_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_budgets_update ON public.finance_budgets FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_categories finance_categories_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_categories_delete ON public.finance_categories FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_categories finance_categories_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_categories_insert ON public.finance_categories FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_categories finance_categories_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_categories_select ON public.finance_categories FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_categories finance_categories_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_categories_update ON public.finance_categories FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_net_worth_snapshots finance_net_worth_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_net_worth_delete ON public.finance_net_worth_snapshots FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_net_worth_snapshots finance_net_worth_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_net_worth_insert ON public.finance_net_worth_snapshots FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_net_worth_snapshots finance_net_worth_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_net_worth_select ON public.finance_net_worth_snapshots FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_net_worth_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_net_worth_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_net_worth_snapshots finance_net_worth_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_net_worth_update ON public.finance_net_worth_snapshots FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_recurring_bills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_recurring_bills ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_recurring_bills finance_recurring_bills_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_recurring_bills_delete ON public.finance_recurring_bills FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_recurring_bills finance_recurring_bills_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_recurring_bills_insert ON public.finance_recurring_bills FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_recurring_bills finance_recurring_bills_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_recurring_bills_select ON public.finance_recurring_bills FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_recurring_bills finance_recurring_bills_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_recurring_bills_update ON public.finance_recurring_bills FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.finance_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: finance_transactions finance_transactions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_transactions_delete ON public.finance_transactions FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_transactions finance_transactions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_transactions_insert ON public.finance_transactions FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_transactions finance_transactions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_transactions_select ON public.finance_transactions FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: finance_transactions finance_transactions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY finance_transactions_update ON public.finance_transactions FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: user_security own security row - select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own security row - select" ON public.user_security FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_security own security row - upsert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own security row - upsert" ON public.user_security USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: plaid_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plaid_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: plaid_ingestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plaid_ingestions ENABLE ROW LEVEL SECURITY;

--
-- Name: plaid_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plaid_items ENABLE ROW LEVEL SECURITY;

--
-- Name: plaid_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plaid_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: points_change_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points_change_log ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.accounts FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: alerts shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.alerts FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: balance_snapshots shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.balance_snapshots FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: card_available_points shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.card_available_points FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: cashflow_daily shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.cashflow_daily FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: cashflow_forecast shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.cashflow_forecast FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: credit_card_points shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.credit_card_points FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: credit_cards shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.credit_cards FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: points_change_log shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.points_change_log FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: transactions shared_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shared_read ON public.transactions FOR SELECT USING ((auth.uid() = ANY ('{65b9afb1-c868-4848-a49f-68cd2529ef81,fc330f10-ab87-4cd5-bd75-bcdd6b32ae6d}'::uuid[])));


--
-- Name: shipment_metadata; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shipment_metadata ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: transactions transactions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_delete ON public.transactions FOR DELETE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: transactions transactions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_insert ON public.transactions FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: transactions transactions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_select ON public.transactions FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: transactions transactions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transactions_update ON public.transactions FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR ((team_id IS NOT NULL) AND public.is_team_member(( SELECT auth.uid() AS uid), team_id)))) WITH CHECK (((( SELECT auth.uid() AS uid) = user_id) AND ((team_id IS NULL) OR public.is_team_member(( SELECT auth.uid() AS uid), team_id))));


--
-- Name: trusted_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trusted_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: user_security; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_security ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--



-- Restore standard Supabase privileges (dump was taken --no-privileges).
grant usage on schema public to anon, authenticated, service_role, postgres;
grant all on all tables in schema public to anon, authenticated, service_role, postgres;
grant all on all sequences in schema public to anon, authenticated, service_role, postgres;
grant all on all functions in schema public to anon, authenticated, service_role, postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role, postgres;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role, postgres;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role, postgres;

-- Hand-applied production fix-ups (so the Plaid sync can insert card txns).
alter table public.transactions alter column account_id drop not null;
alter table public.transactions drop constraint if exists transactions_check;
alter table public.transactions add constraint transactions_check
  check (account_id is null or account_id is distinct from transfer_account_id);
alter table public.transactions drop constraint if exists transactions_transaction_type_check;
alter table public.transactions add constraint transactions_transaction_type_check
  check (transaction_type in
    ('income','expense','transfer','payment','refund','fee','interest','adjustment'));
