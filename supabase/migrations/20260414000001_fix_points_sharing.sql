-- ============================================================
-- Fix Points tables to be fully shared across all users
-- ============================================================

-- credit_card_points: open RLS + make user_id optional
DROP POLICY IF EXISTS "Users can view their own points" ON public.credit_card_points;
DROP POLICY IF EXISTS "Users can insert their own points" ON public.credit_card_points;
DROP POLICY IF EXISTS "Users can update their own points" ON public.credit_card_points;
DROP POLICY IF EXISTS "Users can delete their own points" ON public.credit_card_points;

CREATE POLICY "Authenticated users can view all points"
  ON public.credit_card_points FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert points"
  ON public.credit_card_points FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update points"
  ON public.credit_card_points FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete points"
  ON public.credit_card_points FOR DELETE USING (auth.uid() IS NOT NULL);

ALTER TABLE public.credit_card_points ALTER COLUMN user_id DROP NOT NULL;

-- card_available_points: open RLS, make shared per-card (not per-user), make user_id optional
DROP POLICY IF EXISTS "Users can view their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can insert their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can update their own available points" ON public.card_available_points;
DROP POLICY IF EXISTS "Users can delete their own available points" ON public.card_available_points;

CREATE POLICY "Authenticated users can view all available points"
  ON public.card_available_points FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert available points"
  ON public.card_available_points FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can update available points"
  ON public.card_available_points FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can delete available points"
  ON public.card_available_points FOR DELETE USING (auth.uid() IS NOT NULL);

ALTER TABLE public.card_available_points ALTER COLUMN user_id DROP NOT NULL;

-- Deduplicate: keep only the most recently updated record per card before changing unique key
DELETE FROM public.card_available_points
  WHERE id NOT IN (
    SELECT DISTINCT ON (card_id) id
    FROM public.card_available_points
    ORDER BY card_id, updated_at DESC
  );

ALTER TABLE public.card_available_points
  DROP CONSTRAINT card_available_points_user_id_card_id_key;
ALTER TABLE public.card_available_points
  ADD CONSTRAINT card_available_points_card_id_key UNIQUE (card_id);

-- points_change_log: open RLS + make user_id optional
DROP POLICY IF EXISTS "Users can view their own change log" ON public.points_change_log;
DROP POLICY IF EXISTS "Users can insert their own change log" ON public.points_change_log;

CREATE POLICY "Authenticated users can view all change log"
  ON public.points_change_log FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated users can insert change log"
  ON public.points_change_log FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

ALTER TABLE public.points_change_log ALTER COLUMN user_id DROP NOT NULL;
