-- Future-proof for Supabase's Oct 30 2026 change: new tables in the public
-- schema no longer auto-receive Data API grants. This migration re-establishes
-- automatic grants for FUTURE tables (via default privileges) and grants access
-- on all EXISTING tables as a safety net. Row access is still governed by RLS.

-- 1) Future tables created in this schema automatically get Data API grants.
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

-- 2) Existing tables (idempotent — matches the grants they already had).
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

-- 3) Sequences too, so inserts on future tables work through the API.
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
