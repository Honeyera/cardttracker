-- Add a user-editable display name override for credit cards.
--
-- Why: the dashboard's card rename feature writes credit_cards.display_name.
-- Plaid sync keeps overwriting credit_cards.name on every sync
-- (plaid-sync upserts name = official_name/name), so a plain rename would be
-- reverted. display_name is never touched by sync, so the override sticks.
-- The frontend shows COALESCE(display_name, name).
--
-- Run once in the PERSONAL Supabase project (cihandjyoojthqjfqarf) SQL editor.

alter table public.credit_cards
  add column if not exists display_name text;
