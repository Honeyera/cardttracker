-- Add company_name column for card issuer/company
ALTER TABLE public.credit_cards 
ADD COLUMN company_name TEXT;