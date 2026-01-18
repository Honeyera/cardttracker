import { useState } from 'react';
import { useTeam } from '@/hooks/useTeam';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Users, Copy, RefreshCw, UserMinus, LogOut, Plus, UserPlus, Crown, Shield, User, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export function TeamManagement() {
  const { team, members, loading, userRole, createTeam, joinTeam, leaveTeam, removeMember, regenerateInviteCode } = useTeam();
  const { user } = useAuth();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isJoinOpen, setIsJoinOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    
    setSubmitting(true);
    const result = await createTeam(teamName.trim());
    setSubmitting(false);
    
    if (result) {
      setTeamName('');
      setIsCreateOpen(false);
    }
  };

  const handleJoinTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    
    setSubmitting(true);
    const success = await joinTeam(inviteCode.trim());
    setSubmitting(false);
    
    if (success) {
      setInviteCode('');
      setIsJoinOpen(false);
    }
  };

  const copyInviteCode = () => {
    if (team?.invite_code) {
      navigator.clipboard.writeText(team.invite_code);
      toast.success('Invite code copied to clipboard');
    }
  };

  const handleRegenerateCode = async () => {
    await regenerateInviteCode();
  };

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner': return <Crown className="w-4 h-4 text-yellow-500" />;
      case 'admin': return <Shield className="w-4 h-4 text-blue-500" />;
      default: return <User className="w-4 h-4 text-muted-foreground" />;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // User is not in a team - show create/join options
  if (!team) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Team Portal
          </CardTitle>
          <CardDescription>
            Create a team or join an existing one to share cards with others
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button variant="default">
                <Plus className="w-4 h-4 mr-2" />
                Create Team
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create a Team</DialogTitle>
                <DialogDescription>
                  Create a new team and invite others to join using a link
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateTeam} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="teamName">Team Name</Label>
                  <Input
                    id="teamName"
                    placeholder="My Household"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Create Team
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={isJoinOpen} onOpenChange={setIsJoinOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <UserPlus className="w-4 h-4 mr-2" />
                Join Team
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Join a Team</DialogTitle>
                <DialogDescription>
                  Enter the invite code shared with you to join a team
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleJoinTeam} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="inviteCode">Invite Code</Label>
                  <Input
                    id="inviteCode"
                    placeholder="abc123def456"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Join Team
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    );
  }

  // User is in a team - show team management
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="w-5 h-5" />
          {team.name}
        </CardTitle>
        <CardDescription>
          {members.length} member{members.length !== 1 ? 's' : ''} in this team
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Invite Section - only for owners/admins */}
        {(userRole === 'owner' || userRole === 'admin') && (
          <div className="p-4 rounded-lg bg-muted/50 space-y-2">
            <Label className="text-sm font-medium">Invite Code</Label>
            <div className="flex gap-2">
              <Input
                value={team.invite_code}
                readOnly
                className="font-mono"
              />
              <Button variant="outline" size="icon" onClick={copyInviteCode} title="Copy code">
                <Copy className="w-4 h-4" />
              </Button>
              {userRole === 'owner' && (
                <Button variant="outline" size="icon" onClick={handleRegenerateCode} title="Generate new code">
                  <RefreshCw className="w-4 h-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Share this code with others to let them join your team
            </p>
          </div>
        )}

        {/* Members List */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Members</Label>
          <div className="space-y-2">
            {members.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/30"
              >
                <div className="flex items-center gap-3">
                  {getRoleIcon(member.role)}
                  <div>
                    <p className="text-sm font-medium">
                      {member.user_id === user?.id ? 'You' : `User ${member.user_id.slice(0, 8)}...`}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">{member.role}</p>
                  </div>
                </div>
                {(userRole === 'owner' || userRole === 'admin') && 
                 member.user_id !== user?.id && 
                 member.role !== 'owner' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeMember(member.id)}
                    title="Remove member"
                  >
                    <UserMinus className="w-4 h-4 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Leave Team - only for non-owners */}
        {userRole !== 'owner' && (
          <Button variant="outline" className="w-full" onClick={leaveTeam}>
            <LogOut className="w-4 h-4 mr-2" />
            Leave Team
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
