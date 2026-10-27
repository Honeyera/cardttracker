import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ShieldCheck, ShieldOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface SecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Authenticator-app (TOTP) two-factor, via Supabase's native MFA.
// Enroll: scan a QR with Google Authenticator / Authy / 1Password, then confirm
// a code. At each sign-in the app steps the session up to AAL2 with a fresh code.
export function SecurityDialog({ open, onOpenChange }: SecurityDialogProps) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  // During enrollment we hold the new factor id + the QR/secret to display.
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [otp, setOtp] = useState('');

  const refresh = async () => {
    setLoading(true);
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      setEnabled((data?.totp ?? []).some((f) => f.status === 'verified'));
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) { setEnroll(null); setOtp(''); return; }
    refresh();
  }, [open]);

  const startEnroll = async () => {
    setBusy(true);
    try {
      // Clear any half-finished (unverified) factors so re-enrolling is clean.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: `Authenticator ${Date.now()}`,
        issuer: 'Personal Finance Tracker (cards.vowideas.com)',
      });
      if (error) throw error;
      setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setOtp('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start enrollment');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (code: string) => {
    if (!enroll) return;
    setBusy(true);
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enroll.factorId });
      if (chErr) throw chErr;
      const { error } = await supabase.auth.mfa.verify({ factorId: enroll.factorId, challengeId: ch.id, code });
      if (error) throw error;
      setEnabled(true);
      setEnroll(null);
      toast.success('Authenticator two-factor is on. You\'ll enter a code at each sign-in.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid code');
      setOtp('');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of data?.all ?? []) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      setEnabled(false);
      toast.success('Authenticator two-factor turned off.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" /> Two-Factor Authentication
          </DialogTitle>
          <DialogDescription>
            Require a code from your authenticator app each time you sign in.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : enroll ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground text-center">
              Scan this with Google Authenticator, Authy, or 1Password, then enter the 6-digit code it shows.
            </p>
            <div className="flex justify-center">
              <img src={enroll.qr} alt="Authenticator QR code" className="w-44 h-44 rounded-lg border border-border bg-white p-2" />
            </div>
            <p className="text-xs text-muted-foreground text-center break-all">
              Can't scan? Enter this key manually:<br /><span className="font-mono text-foreground">{enroll.secret}</span>
            </p>
            <div className="flex justify-center">
              <InputOTP maxLength={6} value={otp} disabled={busy}
                onChange={(v) => { setOtp(v); if (v.length === 6) confirmEnroll(v); }}>
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
                </InputOTPGroup>
              </InputOTP>
            </div>
            <Button className="w-full" disabled={busy || otp.length !== 6} onClick={() => confirmEnroll(otp)}>
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-2" />} Confirm &amp; Enable
            </Button>
            <button type="button" onClick={() => { setEnroll(null); setOtp(''); }}
              className="w-full text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        ) : enabled ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 rounded-lg bg-success/10 text-success px-3 py-2 text-sm">
              <ShieldCheck className="w-4 h-4 shrink-0" /> Authenticator two-factor is <b>on</b>.
            </div>
            <Button variant="outline" className="w-full text-destructive hover:text-destructive"
              disabled={busy} onClick={disable}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldOff className="w-4 h-4 mr-2" />}
              Turn off two-factor
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              <ShieldOff className="w-4 h-4 shrink-0" /> Two-factor is off. Your account is protected by password only.
            </div>
            <Button className="w-full" disabled={busy} onClick={startEnroll}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
              Set up authenticator app
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
