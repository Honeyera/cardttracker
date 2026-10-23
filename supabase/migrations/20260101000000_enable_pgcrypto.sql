-- Fresh Supabase projects don't have pgcrypto enabled; later migrations call
-- gen_random_bytes() unqualified, so install it into public where it's always
-- visible regardless of the migration runner's search_path.
create extension if not exists pgcrypto with schema public;
