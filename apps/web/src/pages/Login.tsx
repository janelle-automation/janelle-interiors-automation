import { useState, type CSSProperties, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { SIGNED_OUT_REASON } from '../lib/api';
import { PasswordInput } from '../components/ui';

/* ── Timing helpers ──────────────────────────────────────────── */
const fadeIn = (delay: number, dur = 0.7): CSSProperties => ({
  opacity: 0,
  animation: `logo-fade ${dur}s ease ${delay}s forwards`,
});

/* ── Google icon ─────────────────────────────────────────────── */
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66 2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

/* ── Animated left panel content ─────────────────────────────── */
function LogoDecor() {
  /*
    The SVG at /logo-animated.svg is the original Janelle Interiors logo
    with SMIL handwriting-reveal animations built in. It plays automatically
    when loaded as an <img>. Total animation: ~7s.
    Text fades in after the SVG animation completes.
  */
  return (
    <div className="flex flex-col items-center gap-7">

      {/* Animated logo SVG — plays on load, no JS needed */}
      <div className="login-logo flex w-full justify-center">
        <img
          src="/logo-animated.svg"
          alt="Janelle Interiors"
          className="w-full"
          style={{
            maxWidth: 400,
            /*
              Pipeline:
              1. invert(1)       → white bg becomes black, dark lines become bright
              2. brightness(0.72) → dim so sepia has mid-tones to work with
              3. sepia(1)         → warm the bright lines toward cream/gold
              4. saturate(4)      → push toward vivid brass
              5. hue-rotate(8deg) → shift to the amber/gold hue
              Then mix-blend-mode:screen makes the now-black background
              disappear against the dark page, leaving only the gold lines.
            */
            /*
              invert(1)   → white bg becomes pure #000, dark logo lines become bright
              sepia(1)    → sepia of pure black = still pure black (bg stays transparent-ready)
                            sepia of bright lines → warm cream/gold
              saturate(3) → push the gold lines toward vivid brass
              hue-rotate  → shift into amber register
              screen      → pure black bg screens with any colour = that colour (transparent)
                            gold lines screen with dark page = gold visible
            */
            mixBlendMode: 'screen',
          }}
          draggable={false}
        />
      </div>

      {/* Divider + tagline */}
      <div className="flex flex-col items-center gap-4" style={fadeIn(7.8)}>
        <div style={{
          height: 1, width: 56,
          background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.22), transparent)',
        }} />
        <p style={{
          maxWidth: 230, textAlign: 'center',
          fontSize: 12, lineHeight: 1.75,
          color: 'rgba(255,255,255,0.28)',
        }}>
          Every detail, every deadline, every delivery&nbsp;&mdash;<br />
          handled with the precision your studio deserves.
        </p>
      </div>
    </div>
  );
}

/* ── Login page ──────────────────────────────────────────────── */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    try {
      const reason = sessionStorage.getItem(SIGNED_OUT_REASON);
      sessionStorage.removeItem(SIGNED_OUT_REASON);
      return reason;
    } catch { return null; }
  });
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err) {
      const message = (err as Error).message;
      setError(/banned/i.test(message)
        ? 'This account has been disabled. Ask the studio admin to turn it back on.'
        : message);
    } finally { setBusy(false); }
  };

  const forgot = async () => {
    if (!supabase) return;
    const address = email.trim();
    if (!address) { setError('Enter your email address first, then press this again.'); return; }
    setBusy(true); setError(null);
    try {
      await supabase.auth.resetPasswordForEmail(address, { redirectTo: window.location.origin });
      setSent(true);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
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
    <div className="min-h-screen lg:grid lg:grid-cols-[3fr_2fr] bg-[var(--color-nav)]">

      {/* ── Left panel — hex + JI draw animation ── */}
      <div className="relative hidden lg:flex flex-col items-center justify-center overflow-hidden px-16 py-12">

        {/* Subtle dot-grid texture */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(rgba(210,175,105,0.06) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />

        {/* Breathing glow behind the hex */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ animation: 'logo-pulse 6s ease-in-out 2.5s infinite' }}
        >
          <div style={{
            width: 440, height: 440,
            borderRadius: '50%',
            background: 'radial-gradient(ellipse, rgba(185,140,75,0.11) 0%, transparent 65%)',
          }} />
        </div>

        {/* Main animated content — centred both axes */}
        <div className="relative z-10 flex w-full flex-col items-center">
          <LogoDecor />
        </div>

        {/* Bottom studio mark */}
        <div
          className="absolute bottom-7 left-0 right-0 flex justify-center"
          style={fadeIn(8.2, 0.8)}
        >
          <span style={{
            fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.28em',
            color: 'rgba(255,255,255,0.14)',
          }}>
            JANELLE INTERIORS&nbsp;&middot;&nbsp;STUDIO OS
          </span>
        </div>
      </div>

      {/* ── Right panel — sign-in form ── */}
      <div className="flex min-h-screen flex-col items-center justify-center border-l border-white/[0.055] bg-black/20 px-8 py-12">
        <div className="w-full max-w-[300px]">
          <div className="mb-6">
            <h1 className="text-[20px] font-semibold text-white/85">Welcome back</h1>
            <p className="mt-1 text-[13px] text-white/35">Sign in to your studio workspace.</p>
          </div>

          <form onSubmit={submit} className="space-y-3">
            <input
              className="input w-full"
              type="email"
              required
              placeholder="you@studio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <PasswordInput
              required
              minLength={6}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />

            {error && (
              <p className="rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{error}</p>
            )}
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
              className="focusable w-full rounded-lg py-1 text-[12.5px] font-medium text-white/28 transition-colors hover:text-white/60"
            >
              Forgot your password?
            </button>
          </form>

          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1 bg-white/8" />
            <span className="text-[12px] text-white/20">or</span>
            <span className="h-px flex-1 bg-white/8" />
          </div>

          <button
            onClick={google}
            className="btn-secondary flex w-full items-center justify-center gap-2.5"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <p className="mt-5 text-[11.5px] leading-relaxed text-white/18">
            The system reads Gmail and Drive and creates drafts &mdash; it never sends on your
            behalf. Access is scoped and revocable.
          </p>
        </div>
      </div>
    </div>
  );
}
