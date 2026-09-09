import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeading, StatTile, Card, Pill, money, shortDate } from '../components/ui';
import { IconArrow } from '../components/icons';
import { useDashboard, useFollowUps, usePurchaseOrders, useOps } from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS } from '@janelle/shared';

const followTone: Record<string, 'crit' | 'warn' | 'brass'> = {
  vendor_silence: 'warn',
  client_approval_overdue: 'crit',
  date_slipping: 'crit',
  spec_gap: 'brass',
};
const followLabel: Record<string, string> = {
  vendor_silence: 'Vendor silent',
  client_approval_overdue: 'Approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
};

function OpsBar() {
  const { ingest, followUps, report } = useOps();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit'; to?: string; linkText?: string } | null>(null);
  const busy = ingest.isPending || followUps.isPending || report.isPending;

  const ok = (text: string, to?: string, linkText?: string) => setMsg({ text, tone: 'good', to, linkText });
  const err = (e: unknown) => setMsg({ text: (e as Error).message, tone: 'crit' });

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() =>
            ingest.mutate(undefined, {
              onSuccess: (d) =>
                d.reason === 'busy'
                  ? ok('Auto-sync is already running — new mail appears within seconds.')
                  : ok(`Read ${d.emails} new email${d.emails === 1 ? '' : 's'}, ${d.documents} document${d.documents === 1 ? '' : 's'}, ${d.replies} reply draft${d.replies === 1 ? '' : 's'}.`),
              onError: err,
            })
          }
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
              ? 'Reading Gmail & Drive — this can take a minute…'
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
    { label: 'Emails read', value: summary.emailsRead, hint: 'classified & linked to projects', to: '/inbox' },
    { label: 'Documents parsed', value: summary.documentsParsed, hint: 'quotes & order confirmations', to: '/documents' },
    { label: 'Reply drafts', value: summary.draftsPending, hint: 'waiting in Gmail for review', to: '/drafts' },
  ];

  return (
    <div className="space-y-8">
      <PageHeading
        title="Dashboard"
        sub="What the studio looks like right now, and what needs a person today."
        action={<OpsBar />}
      />

      <section>
        <SectionTitle>Studio at a glance</SectionTitle>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <StatTile label="Active projects" value={summary.activeProjects} tone="neutral" hint="across all stages" />
          <StatTile label="Open POs" value={summary.openPOs} tone="brass" hint="awaiting confirm or delivery" />
          <StatTile label="Awaiting client" value={summary.awaitingClient} tone={summary.awaitingClient > 0 ? 'crit' : 'neutral'} hint="approvals overdue" />
          <StatTile label="Spec gaps" value={summary.specGaps} tone={summary.specGaps > 0 ? 'warn' : 'neutral'} hint="blocking an order" />
          <StatTile label="Installs soon" value={summary.installsSoon} tone="olive" hint="shipping or installing" />
        </div>
      </section>

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
