import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { buildUsageReport } from '../services/usage.js';

/**
 * The AI usage report, readable by anyone holding the link and by nobody
 * else. No Supabase session is involved — the token in the query string IS
 * the credential, which is the whole point: the studio can show what the
 * agent costs to someone who has no account.
 *
 * Deliberately narrow: one read-only report, no other data, no writes, and
 * the token can be rotated or revoked from Settings at any time.
 */
export const publicUsageRouter = Router();

/**
 * A slow lane for a public endpoint. The token is 64 hex characters, so
 * guessing is not a real threat — this is here to stop a found link from
 * being used to hammer the database.
 *
 * In-memory, so it is per-instance: on a serverless host each cold start
 * begins with an empty map. Good enough for a studio-sized audience; if
 * this ever needs to be strict it belongs in the edge layer.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now > entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.resetAt) hits.delete(key);
}, WINDOW_MS).unref?.();

publicUsageRouter.get(
  '/ai-usage',
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const token = String(req.query.t ?? '');
    // Check the shape before touching the database: a malformed token is
    // never valid, and this keeps junk traffic off the query.
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return res.status(404).json({ error: 'No report here' });
    }

    if (rateLimited(req.ip ?? 'unknown')) {
      return res.status(429).json({ error: 'Too many requests — try again shortly' });
    }

    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('settings->>ai_usage_token', token)
      .maybeSingle();

    if (error) throw new Error(error.message);
    // A revoked or rotated link is indistinguishable from a wrong one.
    if (!data) return res.status(404).json({ error: 'No report here' });

    const days = Number(req.query.days ?? 30);
    // The reader's own offset, so "today" is their today — a shared link is
    // often opened somewhere other than the studio.
    const report = await buildUsageReport((data as { id: string }).id, days, Number(req.query.tz ?? 0));

    // Shared links get read by people, not caches; and a stale spend figure
    // is worse than a slow one.
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.json({ data: report });
  }),
);
