import { supabase } from './supabase';
import { api } from './api';

/**
 * Signing in as a teammate, and back again.
 *
 * The admin's own session is set aside here before the switch, then put back
 * by `endImpersonation`. Kept in localStorage — where supabase-js keeps the
 * live session anyway, so nothing new is exposed — so every open tab agrees
 * about whose account this is and shows the banner.
 */
const KEY = 'janelle.impersonator';

export interface Impersonation {
  /** The admin's own session, to return to. */
  access_token: string;
  refresh_token: string;
  adminName: string;
  /** Who is being viewed as. */
  asName: string;
  asEmail: string;
}

export function readImpersonation(): Impersonation | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Impersonation) : null;
  } catch {
    return null;
  }
}

export function clearImpersonation(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export async function startImpersonation(memberId: string, adminName: string): Promise<void> {
  if (!supabase) throw new Error('Sign-in is not configured.');
  const { data } = await supabase.auth.getSession();
  const own = data.session;
  if (!own) throw new Error('You are not signed in.');

  const issued = await api<{ token_hash: string; email: string; name: string }>(`/team/${memberId}/impersonate`, {
    method: 'POST',
    body: '{}',
  });

  const saved: Impersonation = {
    access_token: own.access_token,
    refresh_token: own.refresh_token,
    adminName,
    asName: issued.name,
    asEmail: issued.email,
  };
  localStorage.setItem(KEY, JSON.stringify(saved));

  const { error } = await supabase.auth.verifyOtp({ token_hash: issued.token_hash, type: 'magiclink' });
  if (error) {
    clearImpersonation();
    await supabase.auth.setSession({ access_token: own.access_token, refresh_token: own.refresh_token });
    throw new Error(error.message);
  }

  // A full reload rather than a re-render: every cached query belongs to the
  // admin, and none of it may show under the other person's name.
  window.location.assign('/');
}

export async function endImpersonation(): Promise<void> {
  const saved = readImpersonation();
  clearImpersonation();
  if (!supabase) return;
  if (saved) {
    const { error } = await supabase.auth.setSession({
      access_token: saved.access_token,
      refresh_token: saved.refresh_token,
    });
    // The admin's session expired meanwhile: sign out cleanly rather than
    // stay in the teammate's account.
    if (error) {
      await supabase.auth.signOut();
      window.location.assign('/');
      return;
    }
  } else {
    await supabase.auth.signOut();
  }
  window.location.assign('/team');
}
