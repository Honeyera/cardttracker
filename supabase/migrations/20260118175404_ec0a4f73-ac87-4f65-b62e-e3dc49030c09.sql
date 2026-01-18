-- Create security definer function to check team membership
CREATE OR REPLACE FUNCTION public.get_user_team_ids(user_uuid UUID)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT team_id FROM public.team_members WHERE user_id = user_uuid
$$;

-- Create function to check if user is member of a specific team
CREATE OR REPLACE FUNCTION public.is_team_member(user_uuid UUID, check_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.team_members 
    WHERE user_id = user_uuid AND team_id = check_team_id
  )
$$;

-- Create function to get user's role in a team
CREATE OR REPLACE FUNCTION public.get_team_role(user_uuid UUID, check_team_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.team_members 
  WHERE user_id = user_uuid AND team_id = check_team_id
  LIMIT 1
$$;

-- Drop old problematic policies
DROP POLICY IF EXISTS "Users can view teams they belong to" ON public.teams;
DROP POLICY IF EXISTS "Team owners can update their teams" ON public.teams;
DROP POLICY IF EXISTS "Team owners can delete their teams" ON public.teams;
DROP POLICY IF EXISTS "Users can view members of their teams" ON public.team_members;
DROP POLICY IF EXISTS "Team owners/admins can remove members" ON public.team_members;
DROP POLICY IF EXISTS "Users can view their own or team cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can create cards for their team" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can update their own or team cards" ON public.credit_cards;
DROP POLICY IF EXISTS "Users can delete their own or team cards" ON public.credit_cards;

-- Recreate teams policies using security definer functions
CREATE POLICY "Users can view teams they belong to"
ON public.teams FOR SELECT
USING (id IN (SELECT public.get_user_team_ids(auth.uid())));

CREATE POLICY "Team owners can update their teams"
ON public.teams FOR UPDATE
USING (public.get_team_role(auth.uid(), id) = 'owner');

CREATE POLICY "Team owners can delete their teams"
ON public.teams FOR DELETE
USING (public.get_team_role(auth.uid(), id) = 'owner');

-- Recreate team_members policies using security definer functions
CREATE POLICY "Users can view members of their teams"
ON public.team_members FOR SELECT
USING (public.is_team_member(auth.uid(), team_id));

CREATE POLICY "Team owners/admins can remove members"
ON public.team_members FOR DELETE
USING (
  public.get_team_role(auth.uid(), team_id) IN ('owner', 'admin')
  OR user_id = auth.uid()
);

-- Recreate credit_cards policies using security definer functions
CREATE POLICY "Users can view their own or team cards"
ON public.credit_cards FOR SELECT
USING (
  auth.uid() = user_id 
  OR (team_id IS NOT NULL AND public.is_team_member(auth.uid(), team_id))
);

CREATE POLICY "Users can create cards for their team"
ON public.credit_cards FOR INSERT
WITH CHECK (
  auth.uid() = user_id
  AND (
    team_id IS NULL 
    OR public.is_team_member(auth.uid(), team_id)
  )
);

CREATE POLICY "Users can update their own or team cards"
ON public.credit_cards FOR UPDATE
USING (
  auth.uid() = user_id 
  OR (team_id IS NOT NULL AND public.is_team_member(auth.uid(), team_id))
);

CREATE POLICY "Users can delete their own or team cards"
ON public.credit_cards FOR DELETE
USING (
  auth.uid() = user_id 
  OR (team_id IS NOT NULL AND public.get_team_role(auth.uid(), team_id) IN ('owner', 'admin'))
);