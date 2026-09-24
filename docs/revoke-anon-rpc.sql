-- Security tightening: these SECURITY DEFINER RPCs can write data, so remove
-- EXECUTE from the public `anon` role. Only authenticated users and the
-- service_role (ChatGPT's connector) should be able to call them.
-- Paste into Supabase SQL Editor and Run.

revoke execute on function public.finance_upsert(text, jsonb, text) from anon;
revoke execute on function public.finance_prune_pending(text, jsonb) from anon;
revoke execute on function public.remap_card(text, text) from anon;
