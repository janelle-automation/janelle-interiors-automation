import { supabase } from './supabase';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:4000';

/**
 * Thin fetch wrapper that attaches the current Supabase access token
 * so the API can enforce row-level security. Throws on non-2xx.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (body as { data: T }).data;
}

/**
 * Fetch a binary response (e.g. a PDF) with the auth token attached,
 * returning a blob. Throws with the server error message on non-2xx.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  const res = await fetch(`${BASE}/api${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.blob();
}
