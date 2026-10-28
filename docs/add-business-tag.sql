-- Allow a third tag value, "business", so transactions can be classified
-- Personal / Property / Business (for the VOWIDEAS business view).
-- Run once in the PERSONAL Supabase project (cihandjyoojthqjfqarf).

alter table public.merchant_tags drop constraint if exists merchant_tags_tag_check;
alter table public.merchant_tags
  add constraint merchant_tags_tag_check check (tag in ('personal', 'property', 'business'));
