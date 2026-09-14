import {
  AI_FEATURE_LABELS,
  MODEL_PRICING,
  type AiUsageBucket,
  type AiUsageReport,
  type AiUsageRow,
} from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { AI_USAGE_ACTION } from './anthropic.js';

/**
 * Reads recorded Claude calls into the shape the usage page renders.
 *
 * The calls live in activity_log under the `ai.usage` action, with the
 * numbers in `meta` — no separate table, so this works on the studio's one
 * Supabase connection with nothing to migrate first.
 *
 * Runs under the service-role key on purpose: the same report is served to
 * a signed-in principal and to whoever holds the share link, and the link
 * has no session to enforce RLS against. Access is decided by the caller
 * (a token check, or requireAuth) before we get here.
 */

interface UsageMeta {
  feature?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_write_tokens?: number;
  cache_read_tokens?: number;
  cost_usd?: number;
  latency_ms?: number | null;
  ok?: boolean;
  error?: string | null;
}

interface LogRow {
  id: string;
  actor: string | null;
  created_at: string;
  meta: UsageMeta | null;
}

/** A recorded call, flattened out of the log row. */
interface Call {
  id: string;
  actor: string | null;
  created_at: string;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  ok: boolean;
  error: string | null;
}

function flatten(row: LogRow): Call {
  const m = row.meta ?? {};
  return {
    id: row.id,
    actor: row.actor,
    created_at: row.created_at,
    feature: m.feature ?? 'unknown',
    model: m.model ?? 'unknown',
    input_tokens: Number(m.input_tokens ?? 0),
    output_tokens: Number(m.output_tokens ?? 0),
    cache_write_tokens: Number(m.cache_write_tokens ?? 0),
    cache_read_tokens: Number(m.cache_read_tokens ?? 0),
    cost_usd: Number(m.cost_usd ?? 0),
    latency_ms: m.latency_ms ?? null,
    ok: m.ok !== false,
    error: m.error ?? null,
  };
}

/** Roll calls up by some key, biggest spender first. */
function bucket(
  calls: Call[],
  keyOf: (c: Call) => string,
  labelOf: (key: string) => string,
): AiUsageBucket[] {
  const map = new Map<string, AiUsageBucket>();
  for (const c of calls) {
    const key = keyOf(c);
    const b = map.get(key) ?? {
      key,
      label: labelOf(key),
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    };
    b.calls += 1;
    b.input_tokens += c.input_tokens;
    b.output_tokens += c.output_tokens;
    b.cost_usd += c.cost_usd;
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.cost_usd - a.cost_usd);
}

export async function buildUsageReport(
  orgId: string,
  windowDays: number,
): Promise<AiUsageReport> {
  if (!supabaseAdmin) throw new Error('Backend not configured');

  const days = Math.min(Math.max(Math.round(windowDays) || 30, 1), 365);
  const now = Date.now();
  const windowStart = new Date(now - days * 86_400_000);
  // Fetch twice the window in one query so the trend needs no second trip.
  const previousStart = new Date(now - days * 2 * 86_400_000);

  const [{ data: org }, { data, error }] = await Promise.all([
    supabaseAdmin.from('organizations').select('name').eq('id', orgId).maybeSingle(),
    supabaseAdmin
      .from('activity_log')
      .select('id, actor, created_at, meta')
      .eq('org_id', orgId)
      .eq('action', AI_USAGE_ACTION)
      .gte('created_at', previousStart.toISOString())
      .order('created_at', { ascending: false }),
  ]);

  if (error) throw new Error(error.message);

  const all = ((data ?? []) as LogRow[]).map(flatten);
  const current = all.filter((c) => new Date(c.created_at) >= windowStart);
  const previous = all.filter((c) => new Date(c.created_at) < windowStart);

  // Names for the people who triggered a call. The agent's own work has no
  // actor, and is by far the larger share — it gets its own bucket.
  const actorIds = [...new Set(current.map((c) => c.actor).filter((a): a is string => !!a))];
  const names = new Map<string, string>();
  if (actorIds.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email')
      .in('id', actorIds);
    for (const p of profiles ?? []) {
      const row = p as { id: string; full_name: string | null; email: string | null };
      names.set(row.id, row.full_name ?? row.email ?? 'Someone');
    }
  }

  const totals = current.reduce(
    (acc, c) => {
      acc.calls += 1;
      if (!c.ok) acc.failed += 1;
      acc.input_tokens += c.input_tokens;
      acc.output_tokens += c.output_tokens;
      acc.cache_read_tokens += c.cache_read_tokens;
      acc.cost_usd += c.cost_usd;
      if (c.latency_ms != null) {
        acc.latencySum += c.latency_ms;
        acc.latencyCount += 1;
      }
      return acc;
    },
    {
      calls: 0,
      failed: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      latencySum: 0,
      latencyCount: 0,
    },
  );

  const recent: AiUsageRow[] = current.slice(0, 30).map((c) => ({
    id: c.id,
    feature: AI_FEATURE_LABELS[c.feature as keyof typeof AI_FEATURE_LABELS] ?? c.feature,
    model: c.model,
    actor_name: c.actor ? (names.get(c.actor) ?? null) : null,
    input_tokens: c.input_tokens,
    output_tokens: c.output_tokens,
    cache_write_tokens: c.cache_write_tokens,
    cache_read_tokens: c.cache_read_tokens,
    cost_usd: c.cost_usd,
    latency_ms: c.latency_ms,
    ok: c.ok,
    error: c.error,
    created_at: c.created_at,
  }));

  return {
    org_name: (org as { name: string } | null)?.name ?? 'The studio',
    window_days: days,
    generated_at: new Date().toISOString(),
    totals: {
      calls: totals.calls,
      failed: totals.failed,
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cache_read_tokens: totals.cache_read_tokens,
      cost_usd: totals.cost_usd,
      avg_latency_ms: totals.latencyCount
        ? Math.round(totals.latencySum / totals.latencyCount)
        : null,
    },
    previous_cost_usd: previous.reduce((sum, c) => sum + c.cost_usd, 0),
    by_feature: bucket(
      current,
      (c) => c.feature,
      (key) => AI_FEATURE_LABELS[key as keyof typeof AI_FEATURE_LABELS] ?? key,
    ),
    by_model: bucket(
      current,
      (c) => c.model,
      (key) => key,
    ),
    // Days, oldest first — a chart reads left to right.
    by_day: bucket(
      current,
      (c) => c.created_at.slice(0, 10),
      (key) => key,
    ).sort((a, b) => a.key.localeCompare(b.key)),
    by_person: bucket(
      current,
      (c) => c.actor ?? 'agent',
      (key) => (key === 'agent' ? 'The agent, on its own' : (names.get(key) ?? 'Someone')),
    ),
    recent,
    unpriced_models: [
      ...new Set(current.map((c) => c.model).filter((m) => m !== 'unknown' && !MODEL_PRICING[m])),
    ],
  };
}
