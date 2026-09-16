import { decrypt, encrypt } from './crypto.js';

/**
 * Download grants for files the assistant hands over.
 *
 * When Jenny finds an attachment or a Drive file, the browser needs a way to
 * fetch it. The obvious one — send the Gmail message id and attachment id,
 * or the Drive file id, and let an endpoint fetch whatever it is given — is
 * a hole: every download runs on the principal's Google account, so anyone
 * signed in could compose ids for mail and files they were never shown.
 *
 * So the server mints a grant instead, at the moment it shows the file to
 * someone allowed to see it. The grant is encrypted with AES-256-GCM, which
 * also authenticates it: it cannot be read, edited, or made up without the
 * key. It is bound to the organisation and it expires, and the download
 * endpoint trusts it and nothing else.
 */

/** Long enough for a conversation, short enough that a leaked link goes stale. */
const GRANT_TTL_MS = 12 * 60 * 60_000;

/**
 * A file someone uploaded stays theirs to reopen from a past conversation.
 * It is not the studio's mail or Drive, reachable by anyone with the key's
 * reach — it is their own file, stored for this — so the grant lasts longer.
 */
export const UPLOAD_GRANT_TTL_MS = 30 * 24 * 60 * 60_000;

export type FileGrant = (
  | {
      source: 'gmail';
      orgId: string;
      messageId: string;
      attachmentId: string;
      name: string;
      mimeType: string;
    }
  | {
      source: 'drive';
      orgId: string;
      fileId: string;
      /** The file's type in Drive — decides whether it must be exported. */
      mimeType: string;
      name: string;
    }
  | {
      /** Attached to a question by the person asking it. */
      source: 'upload';
      orgId: string;
      /** Where the bytes are, in the uploads bucket. */
      path: string;
      mimeType: string;
      name: string;
      size: number;
    }
) & {
  /**
   * Only these pages of a PDF (1-based). Set when Jenny shows the pages an
   * answer came from: a three-page cut of a forty-page design deck is small
   * enough to reach the browser, where the whole deck often is not.
   */
  pages?: number[];
};

interface Sealed {
  g: FileGrant;
  /** Expiry, epoch ms. */
  x: number;
}

/**
 * Encrypted output is base64 joined with dots, and base64 carries `+`, `/`
 * and `=` — all of which mean something in a URL. Swapped for the url-safe
 * alphabet so the grant survives a query string without escaping.
 */
const toUrlSafe = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+/g, '');

function fromUrlSafe(s: string): string {
  return s
    .split('.')
    .map((part) => {
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      return b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    })
    .join('.');
}

export function sealFileGrant(grant: FileGrant, ttlMs = GRANT_TTL_MS): string {
  const sealed: Sealed = { g: grant, x: Date.now() + ttlMs };
  return toUrlSafe(encrypt(JSON.stringify(sealed)));
}

/**
 * The grant a token carries, or the reason it cannot be honoured.
 *
 * Every failure to decrypt reads as `invalid`: a tampered token, a token
 * from another deployment's key and plain garbage are all the same answer
 * to the person holding one, and telling them apart helps nobody but an
 * attacker.
 */
export function openFileGrant(
  token: string,
  orgId: string | null,
): { ok: true; grant: FileGrant } | { ok: false; reason: 'invalid' | 'expired' | 'wrong_org' } {
  let sealed: Sealed;
  try {
    sealed = JSON.parse(decrypt(fromUrlSafe(token))) as Sealed;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!sealed?.g || typeof sealed.x !== 'number') return { ok: false, reason: 'invalid' };
  if (Date.now() > sealed.x) return { ok: false, reason: 'expired' };
  if (!orgId || sealed.g.orgId !== orgId) return { ok: false, reason: 'wrong_org' };
  return { ok: true, grant: sealed.g };
}

/**
 * The most a download may be.
 *
 * A Vercel function cannot return a body larger than 4.5 MB, and past that
 * the person gets a platform error instead of their file. Kept a little
 * under, and only on Vercel — a self-hosted API has no such ceiling, and
 * Gmail's own limit is 25 MB.
 */
export const MAX_RELAY_BYTES = process.env.VERCEL ? 4_300_000 : 25 * 1024 * 1024;
