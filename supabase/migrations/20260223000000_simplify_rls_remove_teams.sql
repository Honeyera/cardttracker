-- Remove team-based credit_cards policies
DROP POLICY IF EXISTS "Users can view their own or team cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can create cards for their team" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can update their own cards or team cards as owner/admin" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can delete their own or team cards" ON public.credit_cards;

-- Simple authenticated-user policies
CREATE POLICY "Authenticated users can view all cards"
  ON public.credit_cards FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can create cards"
  ON public.credit_cards FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

CREATE POLICY "Authenticated users can update all cards"
  ON public.credit_cards FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete all cards"
  ON public.credit_cards FOR DELETE
  USING (auth.uid() IS NOT NULL);
