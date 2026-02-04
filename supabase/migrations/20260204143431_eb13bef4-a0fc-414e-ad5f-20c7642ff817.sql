-- Add UPDATE policy for team_members table (only team owners can update member roles)
CREATE POLICY "Team owners can update member roles"
ON public.team_members FOR UPDATE
USING (public.get_team_role(auth.uid(), team_id) = 'owner')
WITH CHECK (public.get_team_role(auth.uid(), team_id) = 'owner');

-- Update create_team_with_owner function with explicit auth check
CREATE OR REPLACE FUNCTION public.create_team_with_owner(team_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  new_team_id UUID;
  calling_user UUID;
BEGIN
  -- Explicit check that user is authenticated
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  INSERT INTO public.teams (name, created_by)
  VALUES (team_name, calling_user)
  RETURNING id INTO new_team_id;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (new_team_id, calling_user, 'owner');
  
  RETURN new_team_id;
END;
$function$;

-- Update join_team_by_invite function with explicit auth check
CREATE OR REPLACE FUNCTION public.join_team_by_invite(code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  found_team_id UUID;
  calling_user UUID;
BEGIN
  -- Explicit check that user is authenticated
  calling_user := auth.uid();
  IF calling_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  SELECT id INTO found_team_id FROM public.teams WHERE invite_code = code;
  
  IF found_team_id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;
  
  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (found_team_id, calling_user, 'member')
  ON CONFLICT (team_id, user_id) DO NOTHING;
  
  RETURN found_team_id;
END;
$function$;