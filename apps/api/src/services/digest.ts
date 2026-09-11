import { DEFAULT_SLA, TASK_KIND_LABELS, type SlaSettings, type TaskKind } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { anthropic, generate } from './anthropic.js';

export interface DigestResult {
  ok: boolean;
  reason?: string;
  digestId?: string;
  date?: string;
  overdue?: number;
  escalations?: number;
}

/** Statuses that mean the work is still outstanding. */
const LIVE = ['open', 'in_progress', 'blocked'];

const todayIso = () => new Date().toISOString().slice(0, 10);
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

interface DigestRow {
  id: string;
  title: string;
  kind: TaskKind;
  status: string;
  owner: string;
  project: string;
  age_days: number;
  due_date: string | null;
}

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
}

/**
 * Build the morning digest for one org: what is overdue, who owns it, and
 * what genuinely needs the principal. Written to `digests` (one per day) so
 * the studio can read it without hunting through the app.
 *
 * Nothing is emailed. The digest is stored and surfaced in-app; sending is
 * a separate, human-initiated step.
 */
export async function runDigest(orgId: string): Promise<DigestResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured' };

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  const sla: SlaSettings = { ...DEFAULT_SLA, ...((org?.settings ?? {}) as Partial<SlaSettings>) };

  const [tasksRes, followUpsRes, profilesRes] = await Promise.all([
    supabaseAdmin
      .from('tasks')
      .select('id, title, kind, status, due_date, created_at, assigned_to, projects(name), profiles(full_name)')
      .eq('org_id', orgId)
      .in('status', LIVE),
    supabaseAdmin
      .from('follow_ups')
      .select('id, type, reason, created_at')
      .eq('org_id', orgId)
      .in('status', ['open', 'drafted']),
    supabaseAdmin.from('profiles').select('id, full_name, role').eq('org_id', orgId),
  ]);

  type RawTask = {
    id: string; title: string; kind: TaskKind; status: string;
    due_date: string | null; created_at: string; assigned_to: string | null;
    projects: { name: string } | null; profiles: { full_name: string | null } | null;
  };
  const tasks = (tasksRes.data ?? []) as unknown as RawTask[];

  const toRow = (t: RawTask): DigestRow => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    owner: t.profiles?.full_name ?? (t.assigned_to ? 'Assigned' : 'Unassigned'),
    project: t.projects?.name ?? '—',
    age_days: ageDays(t.created_at),
    due_date: t.due_date,
  });

  const today = todayIso();

  // Past its due date, or blocked — the things that will slip today.
  const overdue = tasks.filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked').map(toRow);

  // Nobody owns these, so nobody is doing them. The quietest failure mode.
  const unassigned = tasks.filter((t) => !t.assigned_to).map(toRow);

  // Quote requests past the studio's own SLA — the client is waiting.
  const quoteBreaches = tasks
    .filter((t) => t.kind === 'quote_request' && ageDays(t.created_at) >= sla.quote_response_days)
    .map(toRow);

  // Clients left hanging past the response window.
  const clientWaiting = tasks
    .filter((t) => t.kind === 'client_approval' && t.created_at < hoursAgoIso(sla.client_waiting_hours))
    .map(toRow);

  // What the principal is asked to look at: overdue past the escalation
  // window, or blocked. Deliberately narrow — escalating everything is
  // the same as escalating nothing.
  const escalations = overdue.filter(
    (r) =>
      r.status === 'blocked' ||
      (r.due_date !== null && ageDays(`${r.due_date}T00:00:00.000Z`) >= sla.escalation_days),
  );

  // Workload by person, so the weekly pulse has something concrete behind it.
  const byOwner: Record<string, number> = {};
  for (const t of tasks) {
    const name = t.profiles?.full_name ?? (t.assigned_to ? 'Assigned' : 'Unassigned');
    byOwner[name] = (byOwner[name] ?? 0) + 1;
  }

  const figures = {
    date: today,
    open_tasks: tasks.length,
    overdue,
    unassigned,
    quote_breaches: quoteBreaches,
    client_waiting: clientWaiting,
    by_owner: byOwner,
    open_follow_ups: (followUpsRes.data ?? []).length,
    team_size: (profilesRes.data ?? []).length,
    sla,
  };

  const narrative = await writeNarrative(figures, escalations);

  const { data, error } = await supabaseAdmin
    .from('digests')
    .upsert(
      {
        org_id: orgId,
        digest_date: today,
        figures,
        narrative,
        escalations,
      },
      { onConflict: 'org_id,digest_date' },
    )
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'digest.run',
    entity: 'digests',
    entity_id: data?.id ?? null,
    meta: { overdue: overdue.length, escalations: escalations.length, open_tasks: tasks.length },
  });

  return {
    ok: true,
    digestId: data?.id,
    date: today,
    overdue: overdue.length,
    escalations: escalations.length,
  };
}

/** A short, plain summary a busy principal can read on a phone. */
async function writeNarrative(
  figures: Record<string, unknown>,
  escalations: DigestRow[],
): Promise<string> {
  const overdue = figures.overdue as DigestRow[];
  const unassigned = figures.unassigned as DigestRow[];
  const quotes = figures.quote_breaches as DigestRow[];

  // Deterministic fallback, also used when nothing is wrong — no reason to
  // spend a model call to say "all clear".
  const plain = () => {
    if (!overdue.length && !unassigned.length && !quotes.length) {
      return `Nothing overdue this morning. ${figures.open_tasks} task(s) open.`;
    }
    const bits: string[] = [];
    if (overdue.length) bits.push(`${overdue.length} overdue`);
    if (quotes.length) bits.push(`${quotes.length} quote(s) past the ${(figures.sla as SlaSettings).quote_response_days}-day mark`);
    if (unassigned.length) bits.push(`${unassigned.length} unassigned`);
    return `${bits.join(', ')}. ${escalations.length} item(s) need you.`;
  };

  if (!anthropic) return plain();
  if (!overdue.length && !unassigned.length && !quotes.length) return plain();

  const lines = [
    `Open tasks: ${figures.open_tasks}`,
    `Overdue: ${overdue.map((r) => `${r.title} (${r.owner}, ${r.project}, ${r.age_days}d)`).join('; ') || 'none'}`,
    `Quote SLA breaches: ${quotes.map((r) => `${r.title} (${r.owner}, ${r.age_days}d)`).join('; ') || 'none'}`,
    `Unassigned: ${unassigned.map((r) => `${r.title} (${TASK_KIND_LABELS[r.kind]})`).join('; ') || 'none'}`,
    `Needs you: ${escalations.map((r) => `${r.title} (${r.owner})`).join('; ') || 'none'}`,
    `Workload: ${Object.entries(figures.by_owner as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  ].join('\n');

  try {
    return await generate(
      `You write the morning briefing for the founder of a small interior design studio who is
stretched thin and reads this on her phone between appointments.

Rules:
- At most 120 words. No greeting, no sign-off, no headings.
- Lead with the single thing that will hurt most today if ignored.
- Name people and projects plainly. Say who owes what.
- Flag anything a client is waiting on — that is the studio's sorest point.
- Be matter-of-fact, never alarmed, never chirpy. No emoji. No praise.
- If something needs her personally, say so in one clear sentence at the end.`,
      lines,
      600,
    );
  } catch {
    // A model hiccup must never cost the studio its morning digest.
    return plain();
  }
}
