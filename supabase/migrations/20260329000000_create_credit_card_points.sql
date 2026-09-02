CREATE TABLE IF NOT EXISTS public.credit_card_points (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  card_name TEXT NOT NULL,
  points_redeemed INTEGER NOT NULL DEFAULT 0,
  redemption_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE public.credit_card_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own points"
  ON public.credit_card_points FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own points"
  ON public.credit_card_points FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own points"
  ON public.credit_card_points FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own points"
  ON public.credit_card_points FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_credit_card_points_user_id ON public.credit_card_points(user_id);
CREATE INDEX idx_credit_card_points_person ON public.credit_card_points(person);
