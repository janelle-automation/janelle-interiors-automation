import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading, Card, StageBadge, money, shortDate } from '../components/ui';
import { useProjects } from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS, type ProjectStage } from '@janelle/shared';

function StageTrack({ stage }: { stage: ProjectStage }) {
  const idx = PROJECT_STAGES.indexOf(stage);
  return (
    <div className="flex items-end gap-1 overflow-x-auto">
      {PROJECT_STAGES.map((s, i) => {
        const reached = i <= idx;
        const current = i === idx;
        return (
          <div key={s} className="flex min-w-[58px] flex-1 flex-col items-center gap-1.5">
            <div className={`h-1.5 w-full rounded-full ${reached ? 'bg-brass' : 'bg-sunk'}`} />
            <span className={`whitespace-nowrap text-[11px] font-medium ${current ? 'font-semibold text-brass-deep' : reached ? 'text-ink-soft' : 'text-ink-faint'}`}>
              {STAGE_LABELS[s]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export default function Projects() {
  const { data: projects, isLoading } = useProjects();
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <>
      <PageHeading
        title="Projects"
        sub="Every project across the studio pipeline. Expand a row to see its progress, or open it for POs, spec gaps and timeline."
      />

      {isLoading && <div className="py-12 text-center text-[13px] font-medium text-ink-faint">Loading projects…</div>}
      {!isLoading && projects.length === 0 && (
        <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
          No projects yet. They appear here as the system reads project email, or after a Houzz CSV import.
        </div>
      )}
      {!isLoading && projects.length > 0 && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  <th className="px-5 py-3 font-medium">Project</th>
                  <th className="px-5 py-3 font-medium">Client</th>
                  <th className="px-5 py-3 font-medium">Stage</th>
                  <th className="px-5 py-3 text-right font-medium">Budget</th>
                  <th className="px-5 py-3 text-right font-medium">On order</th>
                  <th className="px-5 py-3 text-right font-medium">Open POs</th>
                  <th className="px-5 py-3 text-right font-medium">Spec gaps</th>
                  <th className="px-5 py-3 text-right font-medium">Target install</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {projects.map((p) => {
                  const isOpen = open.has(p.id);
                  return (
                    <Fragment key={p.id}>
                      <tr
                        onClick={() => toggle(p.id)}
                        className="cursor-pointer text-ink-soft transition-colors hover:bg-surface/60"
                      >
                        <td className="px-5 py-3 font-medium text-ink">
                          <span className="inline-flex items-center gap-2">
                            <span className="text-ink-faint"><Chevron open={isOpen} /></span>
                            {p.name}
                          </span>
                        </td>
                        <td className="px-5 py-3">{p.client}</td>
                        <td className="px-5 py-3"><StageBadge stage={p.stage} /></td>
                        {/* money() renders an em dash for null, so an unset
                            budget reads as "not set" rather than "$0". */}
                        <td className="px-5 py-3 text-right tabular-nums text-ink">{money(p.budget)}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-ink">
                          {p.committed > 0 ? money(p.committed) : '—'}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{p.openPOs || '—'}</td>
                        <td className={`px-5 py-3 text-right tabular-nums ${p.specGaps > 0 ? 'font-semibold text-warn' : ''}`}>
                          {p.specGaps || '—'}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{shortDate(p.install)}</td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-sunk/40">
                          <td colSpan={8} className="px-5 py-5">
                            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Progress · auto-updated from email</div>
                            <StageTrack stage={p.stage} />
                            <div className="mt-4">
                              <Link
                                to={`/projects/${p.id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="btn-primary btn-sm"
                              >
                                Open full project — POs, spec gaps & timeline →
                              </Link>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
