CREATE TABLE IF NOT EXISTS public.card_available_points (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES public.credit_cards(id) ON DELETE CASCADE,
  available_points INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  UNIQUE(user_id, card_id)
);

ALTER TABLE public.card_available_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own available points"
  ON public.card_available_points FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own available points"
  ON public.card_available_points FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own available points"
  ON public.card_available_points FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own available points"
  ON public.card_available_points FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_card_available_points_user_id ON public.card_available_points(user_id);
