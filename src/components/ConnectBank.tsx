import { useCallback, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Landmark, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

// "Connect bank" launches Plaid Link to add an institution; "Sync now" triggers
// an immediate pull. Day-to-day syncing is automatic (daily pg_cron) — these are
// for onboarding a bank and for an on-demand refresh.
export function ConnectBank({ onSynced }: { onSynced?: () => void }) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const onSuccess = useCallback(
    async (public_token: string, metadata: any) => {
      try {
        const { data, error } = await supabase.functions.invoke('plaid-exchange', {
          body: { public_token, institution: metadata?.institution ?? null },
        });
        if (error || data?.error) throw new Error(error?.message || data?.error);
        toast.success(`Connected ${data.institution ?? 'bank'}. Syncing…`);
        await runSync();
      } catch (e) {
        toast.error(`Could not save connection: ${(e as Error).message}`);
      } finally {
        setLinkToken(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const { open, ready } = usePlaidLink({ token: linkToken ?? '', onSuccess });

  // Open Link as soon as we have a token and the SDK is ready.
  if (linkToken && ready) open();

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
    </div>
  );
}
