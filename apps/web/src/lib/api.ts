import { supabase } from './supabase';

/**
 * Where the API lives.
 *
 * In a deployed build the API is served from the same origin (Vercel routes
 * /api/* to the serverless function), so an empty base gives same-origin
 * requests and no CORS. Set VITE_API_BASE_URL to override — for example when
 * the API is hosted separately.
 */
const BASE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (import.meta.env.PROD ? '' : 'http://localhost:4055')
).replace(/\/+$/, '');

/**
 * The request never reached the API, or its answer never came back.
 *
 * `fetch` throws a bare `TypeError: Failed to fetch` for every one of these
 * — offline, connection reset, a long request dropped in transit — which
 * reads on screen as though the server rejected the work. It did not: the
 * server may well have finished it. Callers that can safely ask again test
 * for this and retry rather than reporting failure.
 */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super('Could not reach the server — check your connection and try again.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * Thin fetch wrapper that attaches the current Supabase access token
 * so the API can enforce row-level security. Throws on non-2xx, and
 * throws NetworkError when there was no response at all.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { ...init, headers });
  } catch (err) {
    throw new NetworkError(err);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (body as { data: T }).data;
}

/**
 * POST and read the reply as newline-delimited JSON events, as they arrive.
 *
 * For work that reports progress before it finishes. Every line is handed
 * to `onEvent`; the promise settles when the stream ends. A non-2xx status
 * throws with the server's message, like `api()`; no response at all throws
 * NetworkError; an abort throws the browser's AbortError, which callers
 * treat as the person changing their mind rather than as a failure.
 */
export async function apiStream(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' });
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(err);
  }

  if (!res.ok) {
    const failure = await res.json().catch(() => ({}));
    throw new Error((failure as { error?: string }).error ?? `Request failed (${res.status})`);
  }

  // A browser without streamable bodies still gets every event, at the end.
  if (!res.body) {
    for (const raw of (await res.text()).split('\n')) {
      if (raw.trim()) onEvent(JSON.parse(raw));
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      // Only whole lines are parsed; a line split across two chunks waits
      // for the rest of itself.
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const raw = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (raw) onEvent(JSON.parse(raw));
      }
      if (done) break;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    // The connection dropped mid-answer: the server may have finished, but
    // nothing more is coming, which to the person is the same as unreachable.
    if (err instanceof TypeError) throw new NetworkError(err);
    throw err;
  }
  if (buffered.trim()) onEvent(JSON.parse(buffered));
}

/**
 * Fetch an endpoint that deliberately has no session: the token in the URL
 * is the credential. Used by the shared AI usage report, which is opened by
 * people who have no account here.
 */
export async function publicApi<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
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

/**
 * Send a file as the raw request body, and read back the usual `{ data }`.
 *
 * Raw rather than JSON or a form: base64 makes a file a third larger, and a
 * serverless request body has a hard size cap that a PDF reaches quickly.
 */
export async function apiUpload<T>(path: string, file: Blob, signal?: AbortSignal): Promise<T> {
  const headers = new Headers({ 'Content-Type': file.type || 'application/octet-stream' });
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, { method: 'POST', headers, body: file, signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 413 && !(body as { error?: string }).error) throw new Error('That file is too large.');
    throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
  }
  return (body as { data: T }).data;
}
