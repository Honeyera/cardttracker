import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Landmark, RefreshCw, Loader2, Settings2, Trash2, AlertTriangle, Link2 } from 'lucide-react';
import { toast } from 'sonner';

interface PlaidItem {
  item_id: string;
  institution_name: string | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  created_at?: string | null;
  masks?: string[];
}

// "Connect bank" launches Plaid Link to add an institution; "Sync now" triggers
// an immediate pull; "Manage banks" lists connections and lets you remove one.
// Day-to-day syncing is automatic (daily pg_cron).
export function ConnectBank({ onSynced }: { onSynced?: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [manageOpen, setManageOpen] = useState(false);
  const [items, setItems] = useState<PlaidItem[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  // When set, the next Link success is a re-auth (update mode) of this item, not a
  // brand-new connection. A ref so the onSuccess closure always sees the latest.
  const reconnectRef = useRef<string | null>(null);

  const onSuccess = useCallback(
    async (public_token: string, metadata: any) => {
      const reconnectId = reconnectRef.current;
      reconnectRef.current = null;
      try {
        if (reconnectId) {
          // Update-mode re-auth: same item, token is valid again — just flip it
          // back to active and re-sync. No public-token exchange.
          const { data, error } = await supabase.functions.invoke('plaid-manage', {
            body: { action: 'reactivate', item_id: reconnectId },
          });
          if (error || data?.error) throw new Error(error?.message || data?.error);
          toast.success('Reconnected. Syncing…');
          await runSync();
          await loadItems();
        } else {
          const { data, error } = await supabase.functions.invoke('plaid-exchange', {
            body: { public_token, institution: metadata?.institution ?? null },
          });
          if (error || data?.error) throw new Error(error?.message || data?.error);
          toast.success(`Connected ${data.institution ?? 'bank'}. Syncing…`);
          await runSync();
        }
      } catch (e) {
        toast.error(`Could not finish: ${(e as Error).message}`);
      } finally {
        setLinkToken(null);
        setReconnecting(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // User closed Link without finishing — reset so buttons don't stay spinning.
  const onExit = useCallback(() => {
    reconnectRef.current = null;
    setLinkToken(null);
    setReconnecting(null);
  }, []);

  const { open, ready, error: linkError } = usePlaidLink({ token: linkToken ?? '', onSuccess, onExit });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  useEffect(() => {
    if (linkError) {
      toast.error(`Plaid Link error: ${linkError.message}`);
      setLinkToken(null);
    }
  }, [linkError]);

  const connect = async () => {
    setPreparing(true);
    try {
      const { data, error } = await supabase.functions.invoke('plaid-link-token', { body: {} });
      if (error || data?.error) throw new Error(error?.message || data?.error);
      setLinkToken(data.link_token);
    } catch (e) {
      toast.error(`Could not start Plaid: ${(e as Error).message}`);
    } finally {
      setPreparing(false);
    }
  };

  // Re-authenticate an existing connection in place (Plaid Link update mode) —
  // no removal, no lost history. Used for banks flagged "Needs reconnect".
  const reconnect = async (item: PlaidItem) => {
    setReconnecting(item.item_id);
    try {
      const { data, error } = await supabase.functions.invoke('plaid-link-token', { body: { item_id: item.item_id } });
      if (error || data?.error) throw new Error(error?.message || data?.error);
      reconnectRef.current = item.item_id;
      setLinkToken(data.link_token); // opens Link in update mode (via the effect)
    } catch (e) {
      toast.error(`Could not start reconnect: ${(e as Error).message}`);
      setReconnecting(null);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke('plaid-sync', { body: {} });
      if (error || data?.error) throw new Error(error?.message || data?.error);
      const txns = (data.summary ?? []).reduce((n: number, s: any) => n + (s.transactions ?? 0), 0);
      toast.success(`Synced ${data.items ?? 0} bank(s), ${txns} transactions.`);
      onSynced?.();
    } catch (e) {
      toast.error(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const loadItems = async () => {
    setItems(null);
    try {
      const { data, error } = await supabase.functions.invoke('plaid-manage', { body: { action: 'list' } });
      if (error || data?.error) throw new Error(error?.message || data?.error);
      setItems(data.items ?? []);
    } catch (e) {
      toast.error(`Could not load banks: ${(e as Error).message}`);
      setItems([]);
    }
  };

  const removeItem = async (item: PlaidItem) => {
    const label = item.institution_name ?? 'this bank';
    if (!confirm(`Remove ${label}? This disconnects it and deletes its synced accounts, cards, and transactions.`)) return;
    setRemoving(item.item_id);
    try {
      const { data, error } = await supabase.functions.invoke('plaid-manage', {
        body: { action: 'remove', item_id: item.item_id },
      });
      if (error || data?.error) throw new Error(error?.message || data?.error);
      toast.success(`Removed ${label}.`);
      await loadItems();
      onSynced?.();
    } catch (e) {
      toast.error(`Could not remove: ${(e as Error).message}`);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={connect} disabled={preparing}>
        {preparing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Landmark className="w-4 h-4 mr-1" />}
        Connect bank
      </Button>
      <Button size="sm" variant="outline" onClick={runSync} disabled={syncing}>
        {syncing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
        Sync now
      </Button>

      <Dialog open={manageOpen} onOpenChange={(o) => { setManageOpen(o); if (o) loadItems(); }}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <Settings2 className="w-4 h-4 mr-1" />
            Manage banks
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connected banks</DialogTitle>
          </DialogHeader>
          {items === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No banks connected yet. Use “Connect bank” to add one.
            </p>
          ) : (
            <div className="space-y-2">
              {items.map((it) => (
                <div key={it.item_id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{it.institution_name ?? 'Bank'}</p>
                    {it.masks && it.masks.length > 0 && (
                      <p className="text-xs text-muted-foreground truncate">Cards: {it.masks.join(', ')}</p>
                    )}
                    {it.created_at && (
                      <p className="text-xs text-muted-foreground">Added {new Date(it.created_at).toLocaleString()}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {it.status === 'needs_reauth' ? (
                        <span className="text-destructive inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Needs reconnect
                        </span>
                      ) : it.last_synced_at ? (
                        `Synced ${new Date(it.last_synced_at).toLocaleString()}`
                      ) : (
                        'Not synced yet'
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {it.status === 'needs_reauth' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reconnect(it)}
                        disabled={reconnecting === it.item_id || linkToken != null}
                      >
                        {reconnecting === it.item_id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <><Link2 className="w-4 h-4 mr-1" />Reconnect</>}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeItem(it)}
                      disabled={removing === it.item_id}
                    >
                      {removing === it.item_id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
