-- Add card_id to credit_card_points for precise card lookup
ALTER TABLE public.credit_card_points
  ADD COLUMN card_id UUID REFERENCES public.credit_cards(id) ON DELETE SET NULL;
