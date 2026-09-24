-- Security tightening: these SECURITY DEFINER RPCs can write data, so they must
-- not be callable with the public anon key. Postgres grants EXECUTE to PUBLIC by
-- default on function creation (and anon inherits PUBLIC), so we revoke from
-- PUBLIC (and anon) and grant back only to authenticated + service_role.
-- Paste into Supabase SQL Editor and Run.

revoke execute on function public.finance_upsert(text, jsonb, text) from public, anon;
revoke execute on function public.finance_prune_pending(text, jsonb) from public, anon;
revoke execute on function public.remap_card(text, text) from public, anon;

grant execute on function public.finance_upsert(text, jsonb, text) to authenticated, service_role;
grant execute on function public.finance_prune_pending(text, jsonb) to authenticated, service_role;
grant execute on function public.remap_card(text, text) to authenticated, service_role;
