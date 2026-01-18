-- Create teams table
CREATE TABLE public.teams (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'My Team',
  invite_code TEXT NOT NULL DEFAULT encode(gen_random_bytes(6), 'hex'),
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create unique index on invite_code
CREATE UNIQUE INDEX idx_teams_invite_code ON public.teams(invite_code);

-- Create team_members table
CREATE TABLE public.team_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(team_id, user_id)
);

-- Add team_id to credit_cards (nullable for migration)
ALTER TABLE public.credit_cards 
ADD COLUMN team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE;

-- Enable RLS on new tables
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- Teams policies
CREATE POLICY "Users can view teams they belong to"
ON public.teams FOR SELECT
USING (
  id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
);

CREATE POLICY "Users can create teams"
ON public.teams FOR INSERT
WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Team owners can update their teams"
ON public.teams FOR UPDATE
USING (
  id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid() AND role = 'owner')
);

CREATE POLICY "Team owners can delete their teams"
ON public.teams FOR DELETE
USING (
  id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid() AND role = 'owner')
);

-- Team members policies
CREATE POLICY "Users can view members of their teams"
ON public.team_members FOR SELECT
USING (
  team_id IN (SELECT team_id FROM public.team_members AS tm WHERE tm.user_id = auth.uid())
);

CREATE POLICY "Users can join teams via invite"
ON public.team_members FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Team owners/admins can remove members"
ON public.team_members FOR DELETE
USING (
  team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
  OR user_id = auth.uid()
);

-- Update credit_cards policies to include team access
DROP POLICY IF EXISTS "Users can view their own cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can create their own cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can update their own cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can delete their own cards" ON public.credit_cards;

CREATE POLICY "Users can view their own or team cards"
ON public.credit_cards FOR SELECT
USING (
  auth.uid() = user_id 
  OR team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
);

CREATE POLICY "Users can create cards for their team"
ON public.credit_cards FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  AND (
    team_id IS NULL 
    OR team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
  )
);

CREATE POLICY "Users can update their own or team cards"
ON public.credit_cards FOR UPDATE
USING (
  auth.uid() = user_id 
  OR team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid())
);

CREATE POLICY "Users can delete their own or team cards"
ON public.credit_cards FOR DELETE
USING (
  auth.uid() = user_id 
  OR team_id IN (SELECT team_id FROM public.team_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);

-- Function to create team and add owner as first member
CREATE OR REPLACE FUNCTION public.create_team_with_owner(team_name TEXT)
RETURNS UUID AS $$
DECLARE
  new_team_id UUID;
BEGIN
  INSERT INTO public.teams (name, created_by)
  VALUES (team_name, auth.uid())
  RETURNING id INTO new_team_id;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (new_team_id, auth.uid(), 'owner');
  
  RETURN new_team_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function to join team by invite code
CREATE OR REPLACE FUNCTION public.join_team_by_invite(code TEXT)
RETURNS UUID AS $$
DECLARE
  found_team_id UUID;
BEGIN
  SELECT id INTO found_team_id FROM public.teams WHERE invite_code = code;
  
  IF found_team_id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (found_team_id, auth.uid(), 'member')
  ON CONFLICT (team_id, user_id) DO NOTHING;
  
  RETURN found_team_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger for updated_at on teams
CREATE TRIGGER update_teams_updated_at
BEFORE UPDATE ON public.teams
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();