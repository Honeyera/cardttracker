-- Add total_balance column to credit_cards table
ALTER TABLE public.credit_cards 
ADD COLUMN IF NOT EXISTS total_balance numeric DEFAULT 0;