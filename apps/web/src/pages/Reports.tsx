import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Page, PageHeading, Card, money } from '../components/ui';
import { useReports, useOps } from '../lib/queries';

function generatedAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const SECTIONS = [
  ['Pipeline movement', 'Projects that changed stage, and the count now in each.'],
  ['Procurement', 'POs placed, confirmed, shipped and received; committed spend.'],
  ['Overdue vendor follow-ups', 'Who is silent, and for how long.'],
  ['Awaiting client', 'Approvals outstanding and their age.'],
  ['At-risk dates', 'Slipping deliveries and installs; installs coming up next week.'],
  ['Spec gaps', 'Items still missing information before they can be ordered.'],
  ['Drafts pending review', 'Follow-ups waiting to be sent.'],
  ['Budget snapshot', 'Committed vs. remaining, where budget data exists.'],
];

export default function Reports() {
  const { data: reports, refetch } = useReports();
  const { report } = useOps();
  const latest = reports?.[0];
  const figures = (latest?.generated_json ?? {}) as Record<string, number>;
  const location = useLocation();
  const navigate = useNavigate();
  const [flash, setFlash] = useState<string | null>(null);

  // Arriving from the Dashboard's "Generate report" button.
  useEffect(() => {
    const week = new URLSearchParams(location.search).get('generated');
    if (week) {
      setFlash(`Report for the week of ${week} was just regenerated.`);
      refetch();
      navigate('/reports', { replace: true });
    }
  }, [location.search, navigate, refetch]);

  return (
    <Page>
      <PageHeading
        title="Weekly Report"
        action={
          <button
            onClick={() =>
              report.mutate(undefined, {
                onSuccess: (d) => setFlash(`Report for the week of ${d.weekOf} was just regenerated.`),
                onError: (e) => setFlash(`Couldn't generate the report: ${(e as Error).message}`),
              })
            }
            disabled={report.isPending}
            className="btn-primary btn-sm"
          >
            {report.isPending ? 'Writing…' : latest ? 'Regenerate now' : 'Generate now'}
          </button>
        }
      />

      {report.isPending && (
        <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13.5px] text-ink-soft">
          Writing this week's report — reading the pipeline, purchase orders and follow-ups. This takes a few seconds.
        </div>
      )}
      {flash && !report.isPending && (
        <div className={`mb-4 flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-[13.5px] ${flash.startsWith("Couldn't") ? 'border-crit/30 bg-crit/10 text-crit' : 'border-good/30 bg-good/10 text-good'}`}>
          <span>{flash}</span>
          <button onClick={() => setFlash(null)} className="focusable text-[12px] font-semibold opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {latest ? (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-brass-deep">Week of {latest.week_of}</div>
            <div className="text-[12px] text-ink-faint">Generated {generatedAt(latest.created_at)}</div>
          </div>
          <p className="mt-3 max-w-3xl text-[1.2rem] leading-snug text-ink">{latest.narrative}</p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Active projects', figures.active_projects],
              ['POs this week', figures.pos_updated_this_week],
              ['Committed', figures.committed_spend != null ? money(figures.committed_spend) : '—'],
              ['Open follow-ups', figures.open_follow_ups],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg bg-sunk px-4 py-3">
                <div className="text-[12px] font-medium text-ink-faint">{k}</div>
                <div className="mt-1 text-xl text-ink tabular-nums">{v ?? '—'}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-6">
          <div className="text-[12px] font-semibold text-brass-deep">Preview outline</div>
          <p className="mt-3 max-w-2xl text-[1.35rem] leading-snug text-ink">
            A calm, one-page summary of the studio's week, written by the intelligence layer and delivered in-app with an optional emailed copy.
          </p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map(([title, desc], i) => (
          <Card key={title} className="flex gap-4 p-5">
            <span className="text-[13px] text-brass">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-[13.5px] text-ink-soft">{desc}</p>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}
