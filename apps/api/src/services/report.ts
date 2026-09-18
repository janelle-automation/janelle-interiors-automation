import { supabaseAdmin } from '../lib/supabase.js';
import { generate, isAiReady } from './anthropic.js';
import { PROJECT_STAGES } from '@janelle/shared';

export interface ReportResult {
  ok: boolean;
  reason?: string;
  reportId?: string;
  weekOf?: string;
}

function mondayOf(date = new Date()): string {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Aggregate the week and write a weekly report (one per week_of). */
export async function runReport(orgId: string): Promise<ReportResult> {
  if (!supabaseAdmin) return { ok: false, reason: 'supabase_not_configured' };

  const weekOf = mondayOf();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [projects, pos, followUps, gaps] = await Promise.all([
    supabaseAdmin.from('projects').select('stage, status').eq('org_id', orgId),
    supabaseAdmin.from('purchase_orders').select('status, amount, updated_at').eq('org_id', orgId),
    supabaseAdmin.from('follow_ups').select('type, status').eq('org_id', orgId).in('status', ['open', 'drafted']),
    supabaseAdmin.from('spec_gaps').select('id').eq('org_id', orgId).eq('resolved', false),
  ]);

  const byStage = Object.fromEntries(PROJECT_STAGES.map((s) => [s, 0])) as Record<string, number>;
  // Archived jobs keep the stage they closed at; counted here they padded
  // the weekly pipeline figures with work nobody is doing.
  const liveProjects = ((projects.data ?? []) as { stage: string; status: string }[])
    .filter((p) => p.status !== 'archived');
  for (const p of liveProjects) byStage[p.stage] = (byStage[p.stage] ?? 0) + 1;

  const posThisWeek = (pos.data ?? []).filter((o) => (o as { updated_at?: string }).updated_at! >= weekAgo);
  const committed = (pos.data ?? []).reduce((s, o) => s + Number((o as { amount?: number }).amount ?? 0), 0);

  const figures = {
    week_of: weekOf,
    active_projects: (projects.data ?? []).filter((p) => (p as { status: string }).status === 'active').length,
    by_stage: byStage,
    pos_updated_this_week: posThisWeek.length,
    committed_spend: committed,
    open_follow_ups: (followUps.data ?? []).length,
    drafts_pending: (followUps.data ?? []).filter((f) => (f as { status: string }).status === 'drafted').length,
    spec_gaps: (gaps.data ?? []).length,
  };

  let narrative =
    `Week of ${weekOf}: ${figures.active_projects} active projects. ` +
    `${figures.pos_updated_this_week} purchase orders moved this week, ${figures.committed_spend.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} committed. ` +
    `${figures.open_follow_ups} follow-ups open (${figures.drafts_pending} drafts ready), ${figures.spec_gaps} spec gaps outstanding.`;

  if (await isAiReady(orgId)) {
    try {
      narrative = await generate(
        'You write a calm, one-paragraph Monday summary for an interior design studio principal. Warm, concise, concrete.',
        `Summarize the studio's week from these figures as one short paragraph:\n${JSON.stringify(figures, null, 2)}`,
        { feature: 'report.narrative', orgId },
        600,
      );
    } catch (err) {
      console.error('[report] narrative failed', (err as Error).message);
    }
  }

  const { data: row } = await supabaseAdmin
    .from('reports')
    .upsert(
      { org_id: orgId, week_of: weekOf, generated_json: figures, narrative, created_at: new Date().toISOString() },
      { onConflict: 'org_id,week_of' },
    )
    .select('id')
    .maybeSingle();

  await supabaseAdmin.from('activity_log').insert({
    org_id: orgId,
    action: 'report.generate',
    entity: 'reports',
    meta: { week_of: weekOf },
  });

  return { ok: true, reportId: row?.id, weekOf };
}
