import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { SIGNED_OUT_REASON } from '../lib/api';
import { PasswordInput } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // Shown once: why the app signed them out, when it was not their choice.
  const [error, setError] = useState<string | null>(() => {
    try {
      const reason = sessionStorage.getItem(SIGNED_OUT_REASON);
      sessionStorage.removeItem(SIGNED_OUT_REASON);
      return reason;
    } catch {
      return null;
    }
  });
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      const message = (err as Error).message;
      // Supabase's words for an account switched off in Team & roles.
      setError(/banned/i.test(message) ? 'This account has been disabled. Ask the studio admin to turn it back on.' : message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Send the reset link.
   *
   * The answer is the same whether or not the address has an account here.
   * Saying "no such user" would turn this box into a way of discovering who
   * the studio employs, and the person who genuinely mistyped their address
   * is helped just as well by being told to check their mail.
   */
  const forgot = async () => {
    if (!supabase) return;
    const address = email.trim();
    if (!address) {
      setError('Enter your email address first, then press this again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await supabase.auth.resetPasswordForEmail(address, { redirectTo: window.location.origin });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    if (!supabase) return;
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brass text-xl font-bold text-white">J</div>
          <div>
            <div className="text-[16px] font-semibold text-ink">Janelle Interiors</div>
            <div className="text-[12px] text-ink-faint">Workflow System</div>
          </div>
        </div>

        <div className="card p-7">
          <h1 className="text-[20px] font-bold text-ink">Sign in</h1>
          <p className="mb-5 mt-1 text-[13px] text-ink-soft">Use your studio email and password.</p>

          <form onSubmit={submit} className="space-y-3">
            <input className="input" type="email" required placeholder="you@studio.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            <PasswordInput required minLength={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

            {error && <p className="rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{error}</p>}
            {sent && (
              <p className="rounded-lg bg-good/10 px-3 py-2 text-[12.5px] text-good">
                If that address has an account, a reset link is on its way. It expires in an hour.
              </p>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? 'Please wait…' : 'Sign in'}
            </button>

            <button
              type="button"
              onClick={forgot}
              disabled={busy}
              className="focusable w-full rounded-lg py-1 text-[12.5px] font-medium text-ink-soft hover:text-ink"
            >
              Forgot your password?
            </button>
          </form>

          <div className="my-4 flex items-center gap-3 text-ink-faint">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[12px]">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <button onClick={google} className="btn-secondary w-full">
            Continue with Google
          </button>

          <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">
            The system reads Gmail and Drive and creates drafts — it never sends on your behalf. Access is scoped and revocable.
          </p>
        </div>
      </div>
    </div>
  );
}
