import {
  DEFAULT_INGEST_MINUTES,
  INGEST_INTERVALS,
  type IngestSettingsView,
} from '@janelle/shared';
import { supabaseAdmin } from './supabase.js';

/**
 * How often the studio looks for new mail, and whether Claude reads it.
 *
 * The scheduler used to poll every five seconds with no way to change it.
 * That is fine for a demo and wrong for a studio paying per email read, so
 * both dials live in `organizations.settings` next to the other rules.
 */
const INTERVAL_FIELD = 'ingest_interval_minutes';
const USE_AI_FIELD = 'ingest_use_ai';

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: IngestSettingsView }>();

export function invalidateIngestSettings(orgId?: string | null): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

function defaults(): IngestSettingsView {
  return {
    intervalMinutes: DEFAULT_INGEST_MINUTES,
    useAi: true,
    intervals: INGEST_INTERVALS,
  };
}

export async function readIngestSettings(orgId: string): Promise<IngestSettingsView> {
  if (!supabaseAdmin) return defaults();

  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ??
      {}) as Record<string, unknown>;

    const stored = settings[INTERVAL_FIELD];
    const value: IngestSettingsView = {
      intervalMinutes:
        typeof stored === 'number' && INGEST_INTERVALS.some((i) => i.minutes === stored)
          ? stored
          : DEFAULT_INGEST_MINUTES,
      useAi: settings[USE_AI_FIELD] !== false,
      intervals: INGEST_INTERVALS,
    };

    cache.set(orgId, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.error('[ingest] settings unreadable, using defaults:', (err as Error).message);
    return defaults();
  }
}

export async function saveIngestSettings(
  orgId: string,
  patch: { intervalMinutes?: number; useAi?: boolean },
): Promise<IngestSettingsView> {
  if (!supabaseAdmin) throw new Error('Backend not configured');

  const { data } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ??
    {}) as Record<string, unknown>;

  if (patch.intervalMinutes !== undefined) {
    if (!INGEST_INTERVALS.some((i) => i.minutes === patch.intervalMinutes)) {
      throw new Error('Unknown interval');
    }
    settings[INTERVAL_FIELD] = patch.intervalMinutes;
  }
  if (patch.useAi !== undefined) settings[USE_AI_FIELD] = patch.useAi;

  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings })
    .eq('id', orgId);
  if (error) throw new Error(error.message);

  invalidateIngestSettings(orgId);
  return readIngestSettings(orgId);
}
