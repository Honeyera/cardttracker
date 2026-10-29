import { useCallback, useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { useFinanceData } from '@/hooks/useFinanceData';
import { toast } from 'sonner';
import { Loader2, UserPlus, Trash2, ChevronLeft } from 'lucide-react';

type Grant = { id: string; account_id: string | null; credit_card_id: string | null };
type AdminUser = {
  id: string; email: string; created_at: string;
  last_sign_in_at: string | null; mfaEnrolled: boolean | null; grants: Grant[];
};

// Owner-only screen: create view-only logins and pick which accounts/cards each
// one can see. All actions go through the owner-gated `admin-users` edge function
// (which enforces access server-side); the per-account rules are enforced by RLS.
export function UsersAccessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { accounts, cards } = useFinanceData();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const [selAcct, setSelAcct] = useState<Set<string>>(new Set());
  const [selCard, setSelCard] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('admin-users', { body });
    if (error) throw new Error((data as { error?: string })?.error || error.message);
    if ((data as { error?: string })?.error) throw new Error((data as { error?: string }).error);
    return data as Record<string, unknown>;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await call({ action: 'list' });
      setUsers((d.users as AdminUser[]) ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { if (open) { setEditing(null); refresh(); } }, [open, refresh]);

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
    setSet(n);
  };

  const startEdit = (u: AdminUser) => {
    setSelAcct(new Set(u.grants.filter((g) => g.account_id).map((g) => g.account_id!)));
    setSelCard(new Set(u.grants.filter((g) => g.credit_card_id).map((g) => g.credit_card_id!)));
    setEditing(u);
  };

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast.error('Enter a valid email'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    setAdding(true);
    try {
      await call({ action: 'create', email: email.trim(), password });
      toast.success('User created — now give them an account via “Access”.');
      setEmail(''); setPassword('');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setAdding(false);
    }
  };

  const removeUser = async (u: AdminUser) => {
    if (!confirm(`Remove ${u.email}? They lose their login and all access.`)) return;
    try {
      await call({ action: 'delete', userId: u.id });
      toast.success('User removed');
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove user');
    }
  };

  const saveGrants = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await call({ action: 'setGrants', userId: editing.id, accountIds: [...selAcct], cardIds: [...selCard] });
      toast.success('Access updated');
      await refresh();
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update access');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {!editing ? (
          <>
            <DialogHeader>
              <DialogTitle>Users &amp; Access</DialogTitle>
              <DialogDescription>Add view-only users and choose which accounts &amp; cards each one can see.</DialogDescription>
            </DialogHeader>

            <div className="space-y-2 max-h-72 overflow-y-auto -mx-1 px-1">
              {loading ? (
                <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
              ) : users.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No additional users yet.</p>
              ) : users.map((u) => (
                <div key={u.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{u.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {u.grants.length} {u.grants.length === 1 ? 'account/card' : 'accounts/cards'}
                      {u.mfaEnrolled === true ? ' · 2FA on' : u.mfaEnrolled === false ? ' · 2FA not set' : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => startEdit(u)}>Access</Button>
                    <Button size="sm" variant="ghost" onClick={() => removeUser(u)} aria-label="Remove user">
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={addUser} className="border-t border-border pt-3 space-y-2">
              <p className="text-sm font-medium flex items-center gap-2"><UserPlus className="w-4 h-4" />Add a user</p>
              <div className="grid grid-cols-2 gap-2">
                <Input type="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <Input type="text" placeholder="temp password (8+)" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" size="sm" disabled={adding} className="w-full">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create user'}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                They sign in with this email + password, set up their authenticator-app 2FA, then see only the accounts you grant. Give them access next via “Access”.
              </p>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <button type="button" onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground" aria-label="Back">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="truncate">Access for {editing.email}</span>
              </DialogTitle>
              <DialogDescription>Tick the accounts and cards this user may view. Everything else stays hidden.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 max-h-80 overflow-y-auto -mx-1 px-1">
              <div>
                <p className="text-xs uppercase tracking-wide font-semibold text-muted-foreground mb-1">Accounts</p>
                {accounts.length === 0 ? <p className="text-sm text-muted-foreground">No accounts.</p> : accounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-1.5 cursor-pointer">
                    <Checkbox checked={selAcct.has(a.id)} onCheckedChange={() => toggle(selAcct, setSelAcct, a.id)} />
                    <span className="text-sm">{a.name}{a.lastFour ? ` ••${a.lastFour}` : ''}</span>
                  </label>
                ))}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide font-semibold text-muted-foreground mb-1">Credit cards</p>
                {cards.length === 0 ? <p className="text-sm text-muted-foreground">No cards.</p> : cards.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 py-1.5 cursor-pointer">
                    <Checkbox checked={selCard.has(c.id)} onCheckedChange={() => toggle(selCard, setSelCard, c.id)} />
                    <span className="text-sm">{c.name}{c.lastFour ? ` ••${c.lastFour}` : ''}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
              <Button size="sm" onClick={saveGrants} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save access'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
