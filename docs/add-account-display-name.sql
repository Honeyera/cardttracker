-- Add a user-editable display name override for bank accounts.
--
-- Why: the dashboard's account rename feature writes accounts.display_name.
-- Plaid sync keeps overwriting accounts.name on every sync
-- (plaid-sync upserts name = official_name/name), so a plain rename would be
-- reverted. display_name is never touched by sync, so the override sticks.
-- The frontend shows COALESCE(display_name, hardcoded override, name).
-- (Mirrors docs/add-card-display-name.sql for credit_cards.)
--
-- Run once in the PERSONAL Supabase project (cihandjyoojthqjfqarf) SQL editor.

alter table public.accounts
  add column if not exists display_name text;
