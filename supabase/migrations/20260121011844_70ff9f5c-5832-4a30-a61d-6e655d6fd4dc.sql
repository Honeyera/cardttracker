-- Add payment_status column to credit_cards table
ALTER TABLE public.credit_cards 
ADD COLUMN payment_status TEXT DEFAULT NULL;

-- Add a comment explaining the field
COMMENT ON COLUMN public.credit_cards.payment_status IS 'Status like "Payment not required" detected from screenshots';