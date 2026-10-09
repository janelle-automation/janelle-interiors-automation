import type { Session } from '@supabase/supabase-js';
import { report } from './api';

/**
 * The sign-in screen's own audit trail.
 *
 * Supabase records successful sign-ins and nothing else, in a schema this
 * API cannot read. So when somebody says "I could not get in with Google",
 * there is no row anywhere saying what they were told. These two functions
 * are what put one there.
 *
 * Everything here is fire-and-forget. Nothing it does may delay or block a
 * sign-in, and nothing it fails at may be shown to the person signing in.
 */

export type LoginMethod = 'password' | 'google' | 'recovery' | 'invite';
/**
 * This browser's own public address.
 *
 * The API resolves a sign-in's location from the address it observes on
 * the connection, which is the right way round — it watched the request
 * arrive. But it only works where the API is reached across the internet.
 * Run the app locally, or put it behind a proxy that does not forward the
 * caller, and every sign-in is recorded as loopback with no location at
 * all.
 *
 * So the browser offers what it knows. The API prefers its own
 * observation and falls back to this, marking the row as client-reported
 * when it does.
 *
 * Asked once per tab. Short timeout, failure is silence: a sign-in must
 * never wait on this, and never fail because of it.
 */
const PUBLIC_IP_CACHE = 'janelle.publicIp';

async function publicIp(): Promise<string | undefined> {
  try {
    const cached = sessionStorage.getItem(PUBLIC_IP_CACHE);
    if (cached) return cached || undefined;
  } catch {
    /* storage blocked — just ask again */
  }

  try {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 1500);
    const res = await fetch('https://ipwho.is/?fields=ip,success', { signal: control.signal });
    clearTimeout(timer);
    const body = (await res.json()) as { ip?: string; success?: boolean };
    const ip = body?.success && typeof body.ip === 'string' ? body.ip : undefined;
    try {
      // The empty string is cached too, so a tab that cannot reach the
      // service does not retry on every sign-in attempt.
      sessionStorage.setItem(PUBLIC_IP_CACHE, ip ?? '');
    } catch {
      /* nothing depends on caching it */
    }
    return ip;
  } catch {
    return undefined;
  }
}


/** A sign-in that did not happen, and what the person was told. */
export function recordFailure(method: LoginMethod, reason: string, email?: string | null): void {
  void publicIp().then((clientIp) =>
    report('/login-history/event', {
      method,
      outcome: 'failure',
      reason,
      email: email?.trim() || undefined,
      clientIp,
    }),
  );
}

/**
 * Which button was pressed, as best the browser can tell.
 *
 * Only a fallback. The API reads the `amr` claim out of the signed access
 * token, which is the authoritative answer and cannot be fabricated; this
 * is what it falls back to if that claim is ever missing.
 *
 * `app_metadata.provider` was the original guess and is simply wrong for
 * this: it says how the ACCOUNT was created, not how the SESSION began, so
 * an account first made with a password reported "password" for every
 * Google sign-in it ever did. What the browser does know for certain is
 * which button the person pressed, so that is what it remembers.
 */
const GOOGLE_ATTEMPT = 'janelle.googleAttempt';

/** Pressed Continue with Google — remembered across the round trip. */
export function markGoogleAttempt(): void {
  try {
    sessionStorage.setItem(GOOGLE_ATTEMPT, String(Date.now()));
  } catch {
    /* storage blocked — the token's amr claim still covers this */
  }
}

function methodGuess(session: Session): LoginMethod {
  try {
    const marked = Number(sessionStorage.getItem(GOOGLE_ATTEMPT));
    sessionStorage.removeItem(GOOGLE_ATTEMPT);
    // Ten minutes: long enough for a consent screen and an account
    // chooser, short enough that an abandoned attempt cannot mislabel a
    // password sign-in later in the same tab.
    if (marked && Date.now() - marked < 10 * 60_000) return 'google';
  } catch {
    /* fall through to the weaker signal */
  }
  return session.user.app_metadata?.provider === 'google' ? 'google' : 'password';
}

/**
 * Where the last recorded sign-in is remembered, so a page reload is not
 * filed as a second one.
 */
const LAST_RECORDED = 'janelle.lastSignInRecorded';

/**
 * A sign-in that worked.
 *
 * Keyed on Supabase's own `last_sign_in_at` rather than on the auth event:
 * supabase-js fires SIGNED_IN on a restored session as well as on a fresh
 * one, so listening to the event alone files a row every time a tab is
 * opened. The timestamp only moves when a sign-in actually happened.
 */
export function recordSignIn(session: Session | null): void {
  if (!session?.user) return;

  const at = session.user.last_sign_in_at ?? '';
  if (!at) return;
  try {
    if (localStorage.getItem(LAST_RECORDED) === `${session.user.id}:${at}`) return;
    localStorage.setItem(LAST_RECORDED, `${session.user.id}:${at}`);
  } catch {
    // Storage blocked. Better a duplicate row than none at all, so this
    // falls through and reports.
  }

  const method = methodGuess(session);

  void publicIp().then((clientIp) =>
    report('/login-history/event', { method, outcome: 'success', email: session.user.email, clientIp }),
  );
}

/**
 * A failure Google handed back, read off the URL.
 *
 * An OAuth round trip that goes wrong does not come back as a rejected
 * promise — the browser has left the page by then. It comes back as a
 * redirect carrying `error` and `error_description`, in the hash for an
 * implicit flow and in the query string for PKCE. Either way the person
 * lands on a sign-in screen that looks exactly as it did before they
 * pressed the button, which is why this was so hard to diagnose.
 *
 * Returns the message to show, having already filed the row. The
 * parameters are stripped from the URL so a reload does not report it
 * twice or leave the error on screen for ever.
 */
export function readOAuthError(): string | null {
  let error: string | null = null;
  let description: string | null = null;
  let code: string | null = null;

  try {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(window.location.search);
    error = hash.get('error') ?? query.get('error');
    description = hash.get('error_description') ?? query.get('error_description');
    code = hash.get('error_code') ?? query.get('error_code');
  } catch {
    return null;
  }

  if (!error) return null;

  // Google and Supabase both send these URL-encoded with plus signs.
  const detail = (description ?? '').replace(/\+/g, ' ').trim();
  const message = detail || `Google sign-in failed (${code ?? error}).`;

  recordFailure('google', code ? `${code}: ${message}` : message);

  // Clear it from the address bar, keeping whatever path they are on.
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch {
    /* nothing depends on this working */
  }

  return message;
}

/**
 * A device, in the few words a person reading the history needs.
 *
 * Not a user-agent parser — those are a library and a losing battle. It
 * names the browser and the platform, which is all that "was that her
 * phone or her laptop" takes to answer, and falls back to the raw string
 * rather than to nothing.
 */
export function describeDevice(ua: string | null): string {
  if (!ua) return '—';

  // Order matters: Edge and Opera both claim to be Chrome, and Chrome
  // claims to be Safari.
  const browser =
    /\bEdg\//.test(ua) ? 'Edge' :
    /\bOPR\/|\bOpera\b/.test(ua) ? 'Opera' :
    /\bFirefox\//.test(ua) ? 'Firefox' :
    /\bChrome\//.test(ua) ? 'Chrome' :
    /\bSafari\//.test(ua) ? 'Safari' :
    null;

  const platform =
    /\biPhone\b/.test(ua) ? 'iPhone' :
    /\biPad\b/.test(ua) ? 'iPad' :
    /\bAndroid\b/.test(ua) ? 'Android' :
    /\bWindows\b/.test(ua) ? 'Windows' :
    /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'Mac' :
    /\bLinux\b/.test(ua) ? 'Linux' :
    null;

  if (browser && platform) return `${browser} · ${platform}`;
  return browser ?? platform ?? ua.slice(0, 40);
}
