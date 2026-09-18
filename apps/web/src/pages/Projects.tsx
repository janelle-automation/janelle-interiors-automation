import { Fragment, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading, Card, Pill, StageBadge, money, shortDate } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useImportHouzz, useProjects } from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS, canSupervise, type ProjectStage } from '@janelle/shared';

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

/**
 * Load the project list out of Houzz Pro.
 *
 * Houzz has no API a third party can read a studio's own projects through,
 * so the CSV that pro.houzz.com/manage/projects exports is the route. The
 * file is read here and posted as text — it never leaves for anywhere but
 * this studio's own API.
 */
function HouzzImport() {
  const importCsv = useImportHouzz();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    setMsg(null);
    const csv = await file.text();
    importCsv.mutate(csv, {
      onSuccess: (d) => {
        if (!d.ok) return setMsg({ text: d.reason ?? 'Nothing could be read from that file.', tone: 'crit' });
        const parts = [`${d.created} added`, `${d.updated} updated`];
        if (d.skipped) parts.push(`${d.skipped} skipped`);
        // Name the columns nothing was read from: a Houzz export that has
        // been renamed shows up here rather than importing silent blanks.
        const missed = d.unusedColumns.length ? ` Columns not read: ${d.unusedColumns.join(', ')}.` : '';
        setMsg({ text: `${parts.join(', ')}.${missed}`, tone: 'good' });
      },
      onError: (e) => setMsg({ text: (e as Error).message, tone: 'crit' }),
    });
    // Let the same file be chosen again after a correction.
    if (input.current) input.current.value = '';
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <button
        onClick={() => input.current?.click()}
        disabled={importCsv.isPending}
        className="btn-secondary btn-sm"
        title="Export your project list from pro.houzz.com/manage/projects, then choose the file here"
      >
        {importCsv.isPending ? 'Reading file…' : 'Import from Houzz'}
      </button>
      {msg && (
        <span className={`max-w-md text-right text-[12px] ${msg.tone === 'crit' ? 'text-crit' : 'text-ink-faint'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

export default function Projects() {
  const { data: allProjects, isLoading } = useProjects();
  const { user } = useAuth();
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Closed jobs were sitting in the middle of the list looking exactly like
  // live ones — five archived projects reading as work in hand. They are
  // still here, behind a count, and labelled when shown.
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = allProjects.filter((p) => p.archived).length;
  const projects = showArchived ? allProjects : allProjects.filter((p) => !p.archived);

  const supervisor = canSupervise(user?.role ?? null);

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
        sub="The live studio pipeline. Expand a row to see its progress, or open it for POs, spec gaps and timeline."
        action={supervisor && <HouzzImport />}
      />

      {isLoading && <div className="py-12 text-center text-[13px] font-medium text-ink-faint">Loading projects…</div>}

      {!isLoading && archivedCount > 0 && (
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={() => setShowArchived((v) => !v)} className="btn-secondary btn-sm">
            {showArchived ? 'Hide archived' : `Show ${archivedCount} archived`}
          </button>
        </div>
      )}

      {!isLoading && allProjects.length === 0 && (
        <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
          No projects yet. They appear here as the system reads project email — or export your list from
          Houzz Pro (Projects → Export) and use “Import from Houzz” above.
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
                            {p.archived && <Pill tone="neutral">Archived</Pill>}
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
