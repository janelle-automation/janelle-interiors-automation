import { supabaseAdmin } from './supabase.js';

/**
 * How far the studio's mail has been read, stored next to the other rules
 * in `organizations.settings`.
 *
 * Until this existed the reader asked Gmail for `newer_than:3d` and took the
 * first 25 results. Gmail answers newest-first, so on a day with more than
 * 25 messages the newest were read and the rest drifted backwards; once they
 * passed three days old they were never listed again, and the `gmail_id`
 * dedupe meant nothing ever went back for them. A quiet, permanent hole —
 * and any outage longer than three days left one the same way.
 *
 * A watermark closes it: the reader asks for everything since the last
 * message it finished, pages until Gmail has no more to give, and works
 * oldest-first so it can never leave an older message behind while reading
 * a newer one. Nothing ages out, because the window ends where the reading
 * stopped rather than a fixed number of days ago.
 */
/**
 * One watermark per mailbox, keyed by whose it is.
 *
 * It was a single value on the organization, which was right while one
 * shared mailbox fed the studio. With members connecting their own Google,
 * a shared mark would have meant the first mailbox read each night moved it
 * forward and every other mailbox silently skipped everything up to that
 * point — the exact hole the watermark was introduced to close.
 */
const CURSORS_FIELD = 'ingest_cursors';

/** The pre-0018 single value, still honoured so nothing is re-read. */
const CURSOR_FIELD = 'ingest_cursor';

/** What a studio reading its mail for the first time sweeps up. */
const BACKFILL_DAYS = 30;

/**
 * Re-listed on every pass, because two clocks are involved.
 *
 * Gmail's `after:` takes whole seconds and its notion of "now" is not this
 * process's. Overlapping by a few minutes costs nothing — anything already
 * stored is dropped by the gmail_id check without a Claude call — and it
 * means a message delivered while a pass was running is not stranded
 * between that pass's listing and the next pass's window.
 */
const OVERLAP_MS = 10 * 60_000;

export interface IngestWindow {
  /** Read everything delivered at or after this moment. */
  since: Date;
  /** No cursor stored yet — this pass is the backfill. */
  firstRun: boolean;
}

async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}

function cursorFor(settings: Record<string, unknown>, userId: string): string | null {
  const map = settings[CURSORS_FIELD];
  if (map && typeof map === 'object') {
    const mine = (map as Record<string, unknown>)[userId];
    if (typeof mine === 'string') return mine;
  }
  return null;
}

export async function readIngestWindow(orgId: string, userId: string): Promise<IngestWindow> {
  try {
    const settings = await readSettings(orgId);
    // The old single value stands in for whoever has not been read since
    // 0018, so upgrading does not re-read a month of already-stored mail.
    const stored = cursorFor(settings, userId) ?? settings[CURSOR_FIELD];
    const at = typeof stored === 'string' ? Date.parse(stored) : NaN;
    if (Number.isNaN(at)) {
      return { since: new Date(Date.now() - BACKFILL_DAYS * 86_400_000), firstRun: true };
    }
    return { since: new Date(at - OVERLAP_MS), firstRun: false };
  } catch (err) {
    // A studio whose settings cannot be read should still get its mail. The
    // short window is the safe direction to fail: it re-reads rather than
    // skips, and everything it re-reads is deduped for free.
    console.error('[ingest] cursor unreadable, falling back to a short window:', (err as Error).message);
    return { since: new Date(Date.now() - 2 * 86_400_000), firstRun: false };
  }
}

/**
 * Move the watermark up. Only ever called when a pass read everything Gmail
 * offered: stopping half way and advancing anyway is exactly the hole this
 * replaced, so an interrupted pass leaves the mark where it was and the next
 * one picks the same listing up again.
 */
export async function advanceIngestCursor(
  orgId: string,
  userId: string,
  through: Date = new Date(),
): Promise<void> {
  if (!supabaseAdmin) return;
  try {
    const settings = await readSettings(orgId);
    const map = (settings[CURSORS_FIELD] && typeof settings[CURSORS_FIELD] === 'object'
      ? { ...(settings[CURSORS_FIELD] as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    map[userId] = through.toISOString();
    settings[CURSORS_FIELD] = map;
    await supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  } catch (err) {
    // Losing the write costs a re-read next pass, never a missed message.
    console.error('[ingest] could not advance the cursor:', (err as Error).message);
  }
}

/** Gmail's `after:` operator, which takes whole seconds. */
export function gmailAfter(since: Date): string {
  return `after:${Math.floor(since.getTime() / 1000)}`;
}
