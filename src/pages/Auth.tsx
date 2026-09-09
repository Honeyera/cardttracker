import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Wallet, Mail, Lock, Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { mfaLogin, mfaVerify } from '@/lib/mfa';
import { z } from 'zod';

const authSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const Auth = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  // Email-2FA step: once a code has been mailed, we hold the challenge id and
  // the entered password (needed again to mint the session on verify).
  const [mfaChallenge, setMfaChallenge] = useState<{ challengeId: string; password: string } | null>(null);
  const [otp, setOtp] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const { signIn, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user && !authLoading) {
      navigate('/');
    }
  }, [user, authLoading, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate input
    const result = authSchema.safeParse({ email, password });
    if (!result.success) {
      const errors = result.error.errors;
      toast.error(errors[0].message);
      return;
    }

    setLoading(true);

    try {
      const result = await mfaLogin(email, password);
      if (result.status === 'mfa_required') {
        setMfaChallenge({ challengeId: result.challengeId, password });
        setOtp('');
        toast.success('We emailed you a 6-digit sign-in code.');
      } else if (result.status === 'authenticated') {
        // No 2FA for this user — apply the session the function returned.
        await supabase.auth.setSession(result.session);
        toast.success('Welcome back!');
        navigate('/');
      } else {
        // Bootstrap: the mfa function isn't deployed yet — sign in directly.
        const { error } = await signIn(email, password);
        if (error) throw error;
        toast.success('Welcome back!');
        navigate('/');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign in failed';
      toast.error(msg.includes('Invalid login credentials') ? 'Invalid email or password' : msg);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (code: string) => {
    if (!mfaChallenge) return;
    setVerifying(true);
    try {
      const session = await mfaVerify(email, mfaChallenge.password, mfaChallenge.challengeId, code, rememberDevice);
      await supabase.auth.setSession(session);
      toast.success('Welcome back!');
      navigate('/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid code');
      setOtp('');
    } finally {
      setVerifying(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mx-auto mb-4">
            <Wallet className="w-6 h-6 text-primary-foreground" />
          </div>
          <CardTitle className="text-2xl">CardTrack</CardTitle>
          <CardDescription>
            Sign in to your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          {mfaChallenge ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center text-center gap-2">
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Enter the 6-digit code we sent to<br /><span className="font-medium text-foreground">{email}</span>
                </p>
              </div>
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={otp}
                  onChange={(v) => {
                    setOtp(v);
                    if (v.length === 6) handleVerifyOtp(v);
                  }}
                  disabled={verifying}
                >
                  <InputOTPGroup>
                    {[0, 1, 2, 3, 4, 5].map((i) => <InputOTPSlot key={i} index={i} />)}
                  </InputOTPGroup>
                </InputOTP>
              </div>
              <label className="flex items-center justify-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <input type="checkbox" className="rounded border-input"
                  checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} disabled={verifying} />
                Trust this device for 30 days
              </label>
              <Button className="w-full" disabled={verifying || otp.length !== 6} onClick={() => handleVerifyOtp(otp)}>
                {verifying && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                Verify &amp; Sign In
              </Button>
              <div className="text-center">
                <button type="button" onClick={() => { setMfaChallenge(null); setOtp(''); }}
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  <ArrowLeft className="w-3 h-3" /> Back to sign in
                </button>
              </div>
            </div>
          ) : showForgotPassword ? (
            <div className="space-y-4">
              <form onSubmit={async (e) => {
                e.preventDefault();
                if (!email) { toast.error('Please enter your email'); return; }
                setResetLoading(true);
                const { error } = await supabase.auth.resetPasswordForEmail(email, {
                  redirectTo: `${window.location.origin}/reset-password`,
                });
                setResetLoading(false);
                if (error) { toast.error(error.message); }
                else { toast.success('Password reset email sent! Check your inbox.'); setShowForgotPassword(false); }
              }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="reset-email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input id="reset-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="pl-10" required />
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={resetLoading}>
                  {resetLoading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                  Send Reset Link
                </Button>
              </form>
              <div className="text-center text-sm">
                <button type="button" onClick={() => setShowForgotPassword(false)} className="text-primary hover:underline font-medium">
                  Back to Sign In
                </button>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input id="email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="pl-10" required />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input id="password" type="password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} className="pl-10" required />
                  </div>
                </div>
                <div className="text-right">
                  <button type="button" onClick={() => setShowForgotPassword(true)} className="text-sm text-primary hover:underline">
                    Forgot password?
                  </button>
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                  Sign In
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Auth;
