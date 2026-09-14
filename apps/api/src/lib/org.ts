import { supabaseAdmin } from './supabase.js';

/**
 * The studio, when nobody is signed in.
 *
 * The background services — ingestion, follow-ups, the digest, the weekly
 * report — run on a schedule with no request and no session, so they have
 * no organization to hand anything. This is a single-studio install, so
 * resolve it once and keep it.
 *
 * With more than one organization present, guessing would attribute a
 * studio's spend or credentials to the wrong one, so it returns null and
 * callers fall back to the environment.
 */
let cached: string | null = null;

export async function resolveOrgId(given?: string | null): Promise<string | null> {
  if (given) return given;
  if (cached) return cached;
  if (!supabaseAdmin) return null;

  const { data } = await supabaseAdmin.from('organizations').select('id').limit(2);
  if (data?.length === 1) cached = (data[0] as { id: string }).id;
  return cached;
}
