-- Fix card_available_points to be shared per-card across all users

-- Drop old per-user RLS policies (handle both possible names)
DROP POLICY IF EXISTS "Users can view their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can insert their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can update their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can delete their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Authenticated users can view all available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Authenticated users can insert available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Authenticated users can update available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Authenticated users can delete available points" ON public.card_available_points;

CREATE POLICY "Authenticated users can view all available points"
  ON public.card_available_points FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert available points"
  ON public.card_available_points FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update available points"
  ON public.card_available_points FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete available points"
  ON public.card_available_points FOR DELETE USING (auth.uid() IS NOT NULL);

-- Make user_id optional
ALTER TABLE public.card_available_points ALTER COLUMN user_id DROP NOT NULL;

-- Deduplicate before changing unique constraint
DELETE FROM public.card_available_points
  WHERE id NOT IN (
    SELECT DISTINCT ON (card_id) id
    FROM public.card_available_points
    ORDER BY card_id, updated_at DESC
  );

-- Change unique constraint from (user_id, card_id) to just (card_id)
ALTER TABLE public.card_available_points
  DROP CONSTRAINT IF EXISTS card_available_points_user_id_card_id_key;
ALTER TABLE public.card_available_points
  DROP CONSTRAINT IF EXISTS card_available_points_card_id_key;
ALTER TABLE public.card_available_points
  ADD CONSTRAINT card_available_points_card_id_key UNIQUE (card_id);

-- Fix points_change_log sharing
DROP POLICY IF EXISTS "Users can view their own change log" ON public.points_change_log;
DROP POLICY IF EXISTS "Users can insert their own change log" ON public.points_change_log;
DROP POLICY IF EXISTS "Authenticated users can view all change log" ON public.points_change_log;
DROP POLICY IF EXISTS "Authenticated users can insert change log" ON public.points_change_log;

CREATE POLICY "Authenticated users can view all change log"
  ON public.points_change_log FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert change log"
  ON public.points_change_log FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

ALTER TABLE public.points_change_log ALTER COLUMN user_id DROP NOT NULL;

-- Fix credit_card_points user_id (make nullable so any user can insert)
ALTER TABLE public.credit_card_points ALTER COLUMN user_id DROP NOT NULL;
