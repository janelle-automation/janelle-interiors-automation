import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DASHBOARD_CARD_LABELS,
  DASHBOARD_CARD_LINKS,
  ROLE_LABELS,
  type DashboardCardKey,
} from '@janelle/shared';
import { PageHeading, StatTile, Card, Pill, money, shortDate } from '../components/ui';
import { IconArrow } from '../components/icons';
import {
  useDashboard, useFollowUps, usePurchaseOrders, useOps,
  useLatestDigest, useRunDigest, type IngestProgress,
} from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS } from '@janelle/shared';

const followTone: Record<string, 'crit' | 'warn' | 'brass'> = {
  vendor_silence: 'warn',
  client_approval_overdue: 'crit',
  date_slipping: 'crit',
  spec_gap: 'brass',
  quote_overdue: 'crit',
  client_waiting: 'crit',
  task_overdue: 'warn',
  task_escalation: 'crit',
  task_unowned: 'warn',
  task_no_next_step: 'brass',
  task_no_due_date: 'brass',
};
const followLabel: Record<string, string> = {
  vendor_silence: 'Vendor silent',
  client_approval_overdue: 'Approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
  quote_overdue: 'Quote overdue',
  client_waiting: 'Client waiting',
  task_overdue: 'Reminder sent',
  task_escalation: 'Escalated',
  task_unowned: 'No owner',
  task_no_next_step: 'No next step',
  task_no_due_date: 'No due date',
};

function OpsBar() {
  const { ingest, followUps, report } = useOps();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit'; to?: string; linkText?: string } | null>(null);
  // Reading runs in several passes; this is the running total between them.
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const busy = ingest.isPending || followUps.isPending || report.isPending;

  const ok = (text: string, to?: string, linkText?: string) => setMsg({ text, tone: 'good', to, linkText });
  const err = (e: unknown) => setMsg({ text: (e as Error).message, tone: 'crit' });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => {
            setProgress(null);
            ingest.mutate(setProgress, {
              onSuccess: (d) => {
                setProgress(null);
                if (d.reason === 'busy') {
                  return ok('Auto-sync is already running — new mail appears within seconds.');
                }
                // Not a fault in the system: the stored Google grant no
                // longer matches the credentials, so only a reconnect fixes it.
                if (d.reason === 'google_auth_failed') {
                  return err(new Error('Google refused the connection — reconnect Gmail and Drive in Settings.'));
                }
                if (d.reason === 'no_source_user') {
                  return err(new Error('No Google account is connected yet — connect Gmail and Drive in Settings.'));
                }
                if (d.reason === 'anthropic_not_configured') {
                  return err(new Error('Claude is not set up — add an API key in Settings.'));
                }
                const read = `Read ${d.emails} new email${d.emails === 1 ? '' : 's'}, ${d.documents} document${d.documents === 1 ? '' : 's'}, ${d.replies} reply draft${d.replies === 1 ? '' : 's'}.`;
                // Everything read so far is saved either way — the run just
                // stopped early, on its time budget or on a dropped request.
                if (d.interrupted) return ok(`${read} The connection dropped before it finished — press again to carry on.`);
                return ok(d.done === false ? `${read} More is still waiting — press again to carry on.` : read);
              },
              onError: (e) => {
                setProgress(null);
                err(e);
              },
            });
          }}
        >
          {ingest.isPending ? 'Reading…' : 'Read Gmail & Drive'}
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            followUps.mutate(undefined, {
              onSuccess: (d) =>
                d.raised > 0
                  ? ok(`Raised ${d.raised} follow-up${d.raised === 1 ? '' : 's'}, ${d.drafted} draft${d.drafted === 1 ? '' : 's'}.`, '/follow-ups', 'Open inbox →')
                  : ok('Nothing needs following up right now — no overdue vendors, approvals or spec gaps.'),
              onError: err,
            })
          }
        >
          {followUps.isPending ? 'Checking…' : 'Run follow-ups'}
        </button>
        <button
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            report.mutate(undefined, {
              onSuccess: (d) => navigate(`/reports?generated=${encodeURIComponent(d.weekOf)}`),
              onError: err,
            })
          }
        >
          {report.isPending ? 'Writing…' : 'Generate report'}
        </button>
      </div>
      {(busy || msg) && (
        <div className={`text-[12.5px] ${busy ? 'text-ink-faint' : msg?.tone === 'crit' ? 'text-crit' : 'text-good'}`}>
          {busy ? (
            ingest.isPending
              ? progress
                ? `Reading Gmail & Drive — ${progress.emails} email${progress.emails === 1 ? '' : 's'}, ${progress.documents} document${progress.documents === 1 ? '' : 's'} so far…`
                : 'Reading Gmail & Drive — this can take a few minutes…'
              : followUps.isPending
                ? 'Checking for follow-ups…'
                : 'Writing the report…'
          ) : (
            <>
              {msg?.text}
              {msg?.to && (
                <Link to={msg.to} className="focusable ml-2 font-semibold text-brass-deep hover:underline">{msg.linkText}</Link>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[15px] font-semibold text-ink">{children}</h2>;
}

/**
 * The morning briefing. Sits at the top of the dashboard because the
 * founder's stated need is to know what is wrong without going looking.
 */
function MorningDigest() {
  const { data: digest, isLoading } = useLatestDigest();
  const run = useRunDigest();

  const f = digest?.figures;
  const escalations = digest?.escalations ?? [];
  const stale = digest ? digest.digest_date !== new Date().toISOString().slice(0, 10) : false;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>This morning</SectionTitle>
        <button onClick={() => run.mutate()} disabled={run.isPending} className="btn-secondary btn-sm">
          {run.isPending ? 'Building…' : 'Rebuild'}
        </button>
      </div>

      <Card>
        {isLoading && (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">Loading…</div>
        )}

        {!isLoading && !digest && (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">
            No digest yet. It runs every morning at 7:05 — or build one now.
          </div>
        )}

        {!isLoading && digest && (
          <>
            <div className="border-b border-line-soft px-5 py-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {shortDate(digest.digest_date)}
                {stale && ' · from an earlier day'}
              </div>
              <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink">
                {digest.narrative ?? 'No summary available.'}
              </p>
            </div>

            {escalations.length > 0 && (
              <div className="border-b border-line-soft bg-crit/5 px-5 py-4">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-crit">
                  Needs you
                </div>
                <ul className="space-y-1.5">
                  {escalations.map((r) => (
                    <li key={r.id} className="text-[13px] text-ink-soft">
                      <span className="font-medium text-ink">{r.title}</span>
                      {' · '}{r.owner}{' · '}{r.project}
                      {r.status === 'blocked' && ' · blocked'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {f && (
              <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-4">
                {[
                  { label: 'Overdue', value: f.overdue.length, bad: f.overdue.length > 0 },
                  { label: 'Quote SLA missed', value: f.quote_breaches.length, bad: f.quote_breaches.length > 0 },
                  { label: 'Client waiting', value: f.client_waiting.length, bad: f.client_waiting.length > 0 },
                  { label: 'Unassigned', value: f.unassigned.length, bad: f.unassigned.length > 0 },
                ].map((s) => (
                  <div key={s.label} className="bg-surface px-5 py-3">
                    <div className={`text-[20px] font-bold tabular-nums ${s.bad ? 'text-crit' : 'text-ink'}`}>
                      {s.value}
                    </div>
                    <div className="text-[11.5px] text-ink-faint">{s.label}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {run.isError && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-crit">
            {(run.error as Error).message}
          </div>
        )}
      </Card>
    </section>
  );
}

/**
 * Which cards are alarming depends on the card, not on the number: three
 * active projects is fine, three overdue tasks is not.
 */
const URGENT: Partial<Record<DashboardCardKey, 'crit' | 'warn'>> = {
  escalations: 'crit',
  myOverdueTasks: 'crit',
  awaitingClient: 'crit',
  unassignedTasks: 'warn',
  tasksWithoutNextStep: 'warn',
  specGaps: 'warn',
};

const CARD_HINTS: Partial<Record<DashboardCardKey, string>> = {
  myOpenTasks: 'assigned to you',
  myOverdueTasks: 'past their due date',
  unassignedTasks: 'nobody owns these yet',
  tasksWithoutNextStep: 'no next action named',
  openFollowUps: 'waiting on someone',
  awaitingClient: 'approvals overdue',
  draftsPending: 'waiting in Gmail for review',
  specGaps: 'blocking an order',
  openPOs: 'awaiting confirm or delivery',
  activeProjects: 'across all stages',
  installsSoon: 'shipping or installing',
  emailsRead: 'classified & linked',
  documentsParsed: 'quotes & confirmations',
  escalations: 'overdue and escalated to you',
};

function RoleCard({ cardKey, value }: { cardKey: DashboardCardKey; value: number }) {
  const tone = value > 0 ? (URGENT[cardKey] ?? 'neutral') : 'neutral';
  return (
    <Link to={DASHBOARD_CARD_LINKS[cardKey]} className="focusable block h-full rounded-xl">
      <StatTile
        label={DASHBOARD_CARD_LABELS[cardKey]}
        value={value}
        tone={tone}
        hint={CARD_HINTS[cardKey]}
      />
    </Link>
  );
}

/**
 * A seat nobody holds silently swallows work: routing falls back to the
 * role, and if that is empty too the task lands unassigned. The studio is
 * still waiting on its own roster, so this stays visible until it is filled.
 */
function VacantSeats({ seats }: { seats: { seat: string; label: string; role: string }[] }) {
  if (seats.length === 0) return null;
  return (
    <Card className="border-warn/40 p-5">
      <div className="text-[13px] font-semibold text-ink">
        {seats.length} seat{seats.length === 1 ? '' : 's'} with nobody in {seats.length === 1 ? 'it' : 'them'}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">
        Work routed to {seats.length === 1 ? 'this seat' : 'these seats'} falls back to the role, and
        lands unassigned when that is empty too.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {seats.map((s) => (
          <Pill key={s.seat} tone="warn">{s.label}</Pill>
        ))}
      </div>
      <Link to="/team" className="mt-3 inline-block text-[12.5px] font-medium text-brass hover:underline">
        Add someone to a seat →
      </Link>
    </Card>
  );
}

function CardHeader({ title, to, linkText }: { title: string; to?: string; linkText?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {to && (
        <Link to={to} className="focusable inline-flex items-center gap-1 text-[13px] font-semibold text-brass-deep hover:underline">
          {linkText} <IconArrow width={14} height={14} />
        </Link>
      )}
    </div>
  );
}

export default function Dashboard() {
  const summary = useDashboard().data!;
  const { data: followUps } = useFollowUps();
  const { data: pos } = usePurchaseOrders();

  const stageCounts = PROJECT_STAGES.map((s) => ({ stage: s, count: summary.byStage[s] ?? 0 }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));
  const topFollowUps = followUps.slice(0, 5);
  const recentPos = pos.slice(0, 5);

  const intel = [
    { label: 'Emails read', value: summary.figures.emailsRead, hint: 'classified & linked to projects', to: '/inbox' },
    { label: 'Documents parsed', value: summary.figures.documentsParsed, hint: 'quotes & order confirmations', to: '/documents' },
    { label: 'Reply drafts', value: summary.figures.draftsPending, hint: 'waiting in Gmail for review', to: '/drafts' },
  ];

  return (
    <div className="space-y-8">
      <PageHeading
        title="Dashboard"
        sub="What the studio looks like right now, and what needs a person today."
        action={<OpsBar />}
      />

      <MorningDigest />

      <section>
        <SectionTitle>
          {summary.role ? `${ROLE_LABELS[summary.role]} · your board` : 'Studio at a glance'}
        </SectionTitle>
        {summary.focus && (
          <p className="-mt-1 mb-4 text-[13px] text-ink-soft">{summary.focus}</p>
        )}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {summary.cards.map((key) => (
            <RoleCard key={key} cardKey={key} value={summary.figures[key] ?? 0} />
          ))}
        </div>
      </section>

      <VacantSeats seats={summary.vacantSeats} />

      <section>
        <SectionTitle>
          Intelligence layer <span className="font-normal text-ink-faint">· from Gmail &amp; Drive</span>
        </SectionTitle>
        <Card>
          <div className="grid divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {intel.map((i) => (
              <Link key={i.label} to={i.to} className="focusable group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-sunk/60">
                <div>
                  <div className="text-[12.5px] font-medium text-ink-soft">{i.label}</div>
                  <div className="mt-1 text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">{i.value}</div>
                  <div className="mt-1.5 text-[12px] text-ink-faint">{i.hint}</div>
                </div>
                <IconArrow className="text-ink-faint transition-colors group-hover:text-brass-deep" width={16} height={16} />
              </Link>
            ))}
          </div>
        </Card>
      </section>

      <section className="grid items-start gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Needs you today" to="/follow-ups" linkText="Follow-up inbox" />
          <ul className="divide-y divide-line-soft">
            {topFollowUps.length === 0 && (
              <li className="flex flex-col items-center px-5 py-10 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-good/10 text-good">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </span>
                <div className="mt-3 text-[14px] font-semibold text-ink">All clear</div>
                <div className="mt-1 max-w-xs text-[13px] text-ink-soft">No overdue vendors, approvals or spec gaps right now.</div>
              </li>
            )}
            {topFollowUps.map((f) => (
              <li key={f.id} className="flex items-start gap-4 px-5 py-3.5">
                <Pill tone={followTone[f.type]}>{followLabel[f.type]}</Pill>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink">{f.who}</div>
                  <div className="truncate text-[13px] text-ink-soft">{f.reason}</div>
                </div>
                <div className="whitespace-nowrap text-right">
                  <div className="text-[12.5px] font-medium text-ink-soft">{f.age}</div>
                  <div className="text-[11.5px] text-ink-faint">{f.project}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t border-line-soft bg-sunk/40 px-5 py-2.5 text-[12px] text-ink-faint">
            Each of these becomes a Gmail draft you review and send — nothing is auto-sent.
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Pipeline" to="/projects" linkText="All projects" />
          <div className="space-y-2.5 px-5 py-4">
            {stageCounts.map(({ stage, count }) => (
              <div key={stage} className="flex items-center gap-3">
                <span className="w-[86px] text-[12.5px] font-medium text-ink-soft">{STAGE_LABELS[stage]}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunk">
                  <div className="h-full rounded-full bg-brass" style={{ width: `${(count / maxCount) * 100}%` }} />
                </div>
                <span className={`w-5 text-right text-[12.5px] font-semibold tabular-nums ${count > 0 ? 'text-ink' : 'text-ink-faint'}`}>
                  {count}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader title="Recent purchase orders" to="/vendors" linkText="All vendors & POs" />
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  <th className="px-5 py-2.5 font-semibold">PO</th>
                  <th className="px-5 py-2.5 font-semibold">Vendor</th>
                  <th className="px-5 py-2.5 font-semibold">Project</th>
                  <th className="px-5 py-2.5 font-semibold">Status</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Amount</th>
                  <th className="px-5 py-2.5 text-right font-semibold">ETA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {recentPos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-[13px] text-ink-faint">No purchase orders yet.</td>
                  </tr>
                )}
                {recentPos.map((o) => (
                  <tr key={o.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                    <td className="px-5 py-3 font-semibold text-ink">{o.po}</td>
                    <td className="px-5 py-3 font-medium text-ink">{o.vendor}</td>
                    <td className="px-5 py-3">{o.project}</td>
                    <td className="px-5 py-3">
                      <Pill tone={o.status === 'received' ? 'good' : o.status === 'shipped' ? 'brass' : 'neutral'}>
                        {o.status.replace('_', ' ')}
                      </Pill>
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums text-ink">{money(o.amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{shortDate(o.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
