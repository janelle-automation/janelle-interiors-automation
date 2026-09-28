import { supabaseAdmin } from './supabase.js';

/**
 * Take a studio's turn at a scheduled job, or learn it is not due yet.
 *
 * Hosted, a job is called by an outside clock (Supabase pg_cron) at a fixed
 * pace, while each studio chooses its own interval — and a serverless
 * function remembers nothing between calls. So the last start is kept in
 * `organizations.settings[field]`, and taken with a compare-and-set: two
 * calls landing on different instances cannot both run the same studio.
 *
 * `everyMs` is shortened by a little slack, so a clock that fires a few
 * seconds early does not push a studio back a whole interval.
 */
export async function claimCronSlot(orgId: string, field: string, everyMs: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  const settings = { ...((data as { settings: Record<string, unknown> | null } | null)?.settings ?? {}) };
  const last = typeof settings[field] === 'string' ? (settings[field] as string) : null;
  const slack = Math.min(20_000, everyMs / 4);
  if (last && Date.now() - Date.parse(last) < everyMs - slack) return false;

  settings[field] = new Date().toISOString();
  const update = supabaseAdmin.from('organizations').update({ settings }).eq('id', orgId);
  const { data: rows, error } = await (last
    ? update.eq(`settings->>${field}`, last)
    : update.is(`settings->${field}`, null)
  ).select('id');
  if (error) {
    console.error(`[cron] ${field} claim failed:`, error.message);
    return false;
  }
  return (rows?.length ?? 0) > 0;
}
