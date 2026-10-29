import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ShieldCheck, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

// Mandatory authenticator-app (TOTP) enrollment. Rendered as a blocking overlay
// for any signed-in user with no verified 2FA factor — they must set it up (or
// sign out) before using the app. Same native-MFA enroll flow as SecurityDialog.
export function ForceMfaSetup({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const start = async () => {
    setBusy(true);
    try {
      // Clear any half-finished factors so enrollment is clean.
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
      toast.error(err instanceof Error ? err.message : 'Could not start 2FA setup');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (!started.current) { started.current = true; start(); } }, []);

  const confirm = async (code: string) => {
    if (!enroll) return;
    setBusy(true);
    try {
      const { data: ch, error: chErr } = await supabase.auth.mfa.challenge({ factorId: enroll.factorId });
      if (chErr) throw chErr;
      const { error } = await supabase.auth.mfa.verify({ factorId: enroll.factorId, challengeId: ch.id, code });
      if (error) throw error;
      toast.success('Two-factor is on.');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid code');
      setOtp('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg space-y-4">
        <div className="text-center space-y-1">
          <div className="mx-auto w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Set up two-factor authentication</h2>
          <p className="text-sm text-muted-foreground">
            Required to continue. Scan the code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code it shows.
          </p>
        </div>

        {!enroll ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : (
          <>
            <div className="flex justify-center">
              <img src={enroll.qr} alt="Authenticator QR code" className="w-44 h-44 rounded-lg border border-border bg-white p-2" />
            </div>
            <p className="text-xs text-muted-foreground text-center break-all">
              Can't scan? Enter this key:<br /><span className="font-mono text-foreground">{enroll.secret}</span>
            </p>
            <div className="flex justify-center">
              <InputOTP maxLength={6} value={otp} disabled={busy}
                onChange={(v) => { setOtp(v); if (v.length === 6) confirm(v); }}>
                <InputOTPGroup>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}</InputOTPGroup>
              </InputOTP>
            </div>
            <Button className="w-full" disabled={busy || otp.length !== 6} onClick={() => confirm(otp)}>
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-2" />}Confirm &amp; continue
            </Button>
          </>
        )}

        <button type="button" onClick={onSignOut}
          className="w-full flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </div>
    </div>
  );
}
