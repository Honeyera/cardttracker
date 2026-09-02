CREATE TABLE IF NOT EXISTS public.points_change_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES public.credit_cards(id) ON DELETE CASCADE,
  old_points INTEGER NOT NULL DEFAULT 0,
  new_points INTEGER NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);

ALTER TABLE public.points_change_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own change log"
  ON public.points_change_log FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own change log"
  ON public.points_change_log FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_points_change_log_user_id ON public.points_change_log(user_id);
CREATE INDEX idx_points_change_log_changed_at ON public.points_change_log(changed_at DESC);
