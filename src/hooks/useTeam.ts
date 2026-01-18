import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export interface Team {
  id: string;
  name: string;
  invite_code: string;
  created_by: string;
  created_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
  email?: string;
}

export function useTeam() {
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  const fetchTeam = useCallback(async () => {
    if (!user) {
      setTeam(null);
      setMembers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      // Get user's team membership
      const { data: membershipData, error: membershipError } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (membershipError) {
        console.error('Error fetching team membership:', membershipError);
        setLoading(false);
        return;
      }

      if (!membershipData) {
        setTeam(null);
        setMembers([]);
        setLoading(false);
        return;
      }

      // Fetch team details
      const { data: teamData, error: teamError } = await supabase
        .from('teams')
        .select('*')
        .eq('id', membershipData.team_id)
        .single();

      if (teamError) {
        console.error('Error fetching team:', teamError);
        setLoading(false);
        return;
      }

      setTeam(teamData as Team);

      // Fetch team members
      const { data: membersData, error: membersError } = await supabase
        .from('team_members')
        .select('*')
        .eq('team_id', membershipData.team_id)
        .order('joined_at', { ascending: true });

      if (membersError) {
        console.error('Error fetching members:', membersError);
      } else {
        setMembers(membersData as TeamMember[]);
      }
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  const createTeam = async (name: string): Promise<string | null> => {
    if (!user) {
      toast.error('Please sign in to create a team');
      return null;
    }

    try {
      const { data, error } = await supabase.rpc('create_team_with_owner', {
        team_name: name
      });

      if (error) {
        console.error('Error creating team:', error);
        toast.error('Failed to create team');
        return null;
      }

      toast.success('Team created successfully!');
      await fetchTeam();
      return data as string;
    } catch (err) {
      console.error('Error creating team:', err);
      toast.error('Failed to create team');
      return null;
    }
  };

  const joinTeam = async (inviteCode: string): Promise<boolean> => {
    if (!user) {
      toast.error('Please sign in to join a team');
      return false;
    }

    try {
      const { data, error } = await supabase.rpc('join_team_by_invite', {
        code: inviteCode.trim().toLowerCase()
      });

      if (error) {
        console.error('Error joining team:', error);
        if (error.message.includes('Invalid invite code')) {
          toast.error('Invalid invite code');
        } else {
          toast.error('Failed to join team');
        }
        return false;
      }

      toast.success('Successfully joined the team!');
      await fetchTeam();
      return true;
    } catch (err) {
      console.error('Error joining team:', err);
      toast.error('Failed to join team');
      return false;
    }
  };

  const leaveTeam = async (): Promise<boolean> => {
    if (!user || !team) {
      return false;
    }

    // Check if user is owner
    const userMembership = members.find(m => m.user_id === user.id);
    if (userMembership?.role === 'owner') {
      toast.error('Team owners cannot leave. Transfer ownership or delete the team.');
      return false;
    }

    try {
      const { error } = await supabase
        .from('team_members')
        .delete()
        .eq('team_id', team.id)
        .eq('user_id', user.id);

      if (error) {
        console.error('Error leaving team:', error);
        toast.error('Failed to leave team');
        return false;
      }

      toast.success('Left the team');
      setTeam(null);
      setMembers([]);
      return true;
    } catch (err) {
      console.error('Error leaving team:', err);
      toast.error('Failed to leave team');
      return false;
    }
  };

  const removeMember = async (memberId: string): Promise<boolean> => {
    if (!team) return false;

    const memberToRemove = members.find(m => m.id === memberId);
    if (memberToRemove?.role === 'owner') {
      toast.error('Cannot remove the team owner');
      return false;
    }

    try {
      const { error } = await supabase
        .from('team_members')
        .delete()
        .eq('id', memberId);

      if (error) {
        console.error('Error removing member:', error);
        toast.error('Failed to remove member');
        return false;
      }

      setMembers(prev => prev.filter(m => m.id !== memberId));
      toast.success('Member removed');
      return true;
    } catch (err) {
      console.error('Error removing member:', err);
      toast.error('Failed to remove member');
      return false;
    }
  };

  const regenerateInviteCode = async (): Promise<string | null> => {
    if (!team) return null;

    const newCode = Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    try {
      const { error } = await supabase
        .from('teams')
        .update({ invite_code: newCode })
        .eq('id', team.id);

      if (error) {
        console.error('Error regenerating invite code:', error);
        toast.error('Failed to regenerate invite code');
        return null;
      }

      setTeam(prev => prev ? { ...prev, invite_code: newCode } : null);
      toast.success('New invite code generated');
      return newCode;
    } catch (err) {
      console.error('Error regenerating invite code:', err);
      toast.error('Failed to regenerate invite code');
      return null;
    }
  };

  const userRole = user ? members.find(m => m.user_id === user.id)?.role : null;

  return {
    team,
    members,
    loading,
    userRole,
    createTeam,
    joinTeam,
    leaveTeam,
    removeMember,
    regenerateInviteCode,
    refetch: fetchTeam,
  };
}
