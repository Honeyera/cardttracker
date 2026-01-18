-- Add display_order column for card ordering
ALTER TABLE public.credit_cards 
ADD COLUMN display_order INTEGER DEFAULT 0;

-- Set initial order based on created_at
WITH ordered_cards AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at) as rn
  FROM public.credit_cards
)
UPDATE public.credit_cards 
SET display_order = ordered_cards.rn
FROM ordered_cards 
WHERE credit_cards.id = ordered_cards.id;