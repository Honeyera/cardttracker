import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { ShieldCheck, ShieldOff, Loader2, MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { mfaIsEnabled, mfaEnrollSend, mfaEnrollConfirm, mfaDisable, mfaForgetDevices } from '@/lib/mfa';

interface SecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Manage email two-factor auth: enable (with an email confirm-code so we never
// switch it on for an address that can't actually receive codes) or disable.
export function SecurityDialog({ open, onOpenChange }: SecurityDialogProps) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otp, setOtp] = useState('');

  useEffect(() => {
    if (!open) { setChallengeId(null); setOtp(''); return; }
    setLoading(true);
    mfaIsEnabled().then(setEnabled).catch(() => setEnabled(false)).finally(() => setLoading(false));
  }, [open]);

  const startEnroll = async () => {
    setBusy(true);
    try {
      const id = await mfaEnrollSend();
      setChallengeId(id);
      setOtp('');
      toast.success('We emailed you a confirmation code.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send code');
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (code: string) => {
    if (!challengeId) return;
    setBusy(true);
    try {
      await mfaEnrollConfirm(challengeId, code);
      setEnabled(true);
      setChallengeId(null);
      toast.success('Email two-factor is now on. You\'ll enter a code at each sign-in.');
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
      await mfaDisable();
      setEnabled(false);
      toast.success('Email two-factor turned off.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disable');
    } finally {
      setBusy(false);
    }
  };

  const forgetDevices = async () => {
    setBusy(true);
    try {
      await mfaForgetDevices();
      toast.success('Trusted devices cleared — every device will need a code next sign-in.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not clear devices');
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
            Require a one-time code emailed to you each time you sign in.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
        ) : challengeId ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground text-center">
              Enter the 6-digit code we just emailed you to turn on two-factor.
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
            <button type="button" onClick={() => { setChallengeId(null); setOtp(''); }}
              className="w-full text-sm text-muted-foreground hover:text-foreground">Cancel</button>
          </div>
        ) : enabled ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 rounded-lg bg-success/10 text-success px-3 py-2 text-sm">
              <ShieldCheck className="w-4 h-4 shrink-0" /> Email two-factor is <b>on</b>. Trusted devices skip the code for 30 days.
            </div>
            <Button variant="outline" className="w-full" disabled={busy} onClick={forgetDevices}>
              <MonitorSmartphone className="w-4 h-4 mr-2" /> Forget trusted devices
            </Button>
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
              Enable email two-factor
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
