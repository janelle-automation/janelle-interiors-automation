import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, PageHeading, Card, Pill, usePager, Pager } from '../components/ui';
import { IconSearch, IconArrow } from '../components/icons';
import { Markdown } from '../components/Markdown';
import {
  usePromptLibrary, useRunPrompt, useCreateDraft, useProjects,
  useRenderable, useRenderBoard, uploadReference, boardImageUrl,
  type BoardReference,
} from '../lib/queries';
import type { Prompt, PromptCategory } from '@janelle/shared';

const CATS: { key: PromptCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'design', label: 'Design' },
  { key: 'procurement', label: 'Procurement / FF&E' },
  { key: 'client', label: 'Client communication' },
  { key: 'admin', label: 'Admin' },
];

// Pill has no olive; design takes the house accent, procurement the
// green that reads as "money moving", client the amber of a wait.
const catTone: Record<PromptCategory, 'brass' | 'good' | 'warn' | 'neutral'> = {
  design: 'brass',
  procurement: 'good',
  client: 'warn',
  admin: 'neutral',
};

/**
 * Inputs that take a paste, not a phrase — a design direction or a
 * project state runs to paragraphs, and a one-line box hides it.
 */
const LONG_FORM =
  /brief|direction|selection|state|notes|presentation|plan|elevation|design|hours|material|supplied|spec|inspiration|request|condition|item|option|address|terms|ship_to|memo|contact/i;

function rowsFor(key: string, label: string): number {
  return LONG_FORM.test(key) || LONG_FORM.test(label) ? 4 : 1;
}

function RunModal({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState('');
  const [copied, setCopied] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const run = useRunPrompt();
  const draft = useCreateDraft();
  // Archived jobs are finished: nothing is drafted against them.
  const { data: allProjects } = useProjects();
  const projects = allProjects.filter((p) => !p.archived);

  // Rendering: only some prompts make a picture, and only when the studio
  // has an image key. Both are answered by one call, cached for the session.
  const { data: renderable } = useRenderable();
  const board = renderable?.prompts?.[prompt.title] ?? null;
  const canRender = Boolean(renderable?.ready && board);
  const render = useRenderBoard();
  const [refs, setRefs] = useState<BoardReference[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The thumbnails and the finished board are object URLs; they leak until
  // revoked, and the modal is opened over and over while iterating.
  useEffect(() => () => {
    for (const r of refs) URL.revokeObjectURL(r.preview);
    if (boardUrl) URL.revokeObjectURL(boardUrl);
  }, [refs, boardUrl]);

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setAttachError(null);
    setUploading(true);
    try {
      const room = 14 - refs.length;
      const added = await Promise.all(
        [...files].slice(0, Math.max(0, room)).map((f, i) =>
          // Named after the slot it fills, so the prompt can tell the plan
          // from the countertop. Editable below.
          uploadReference(f, board?.references[refs.length + i] ?? 'Reference image'),
        ),
      );
      setRefs((cur) => [...cur, ...added]);
    } catch (e) {
      setAttachError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const renderBoard = () => {
    setAttachError(null);
    render.mutate(
      {
        id: prompt.id,
        variables: values,
        files: refs.map((r) => ({ token: r.token, label: r.label })),
        projectId: projectId || undefined,
      },
      {
        onSuccess: async (result) => {
          try {
            setBoardUrl(await boardImageUrl(result.token));
          } catch {
            /* the download link still works */
          }
        },
      },
    );
  };
  const disabled = prompt.variables.some((v) => v.required && !values[v.key]?.trim());
  // Before a run there is no output, so there is no second column: an
  // empty panel held half the modal open and the inputs were squeezed
  // into the other half for nothing.
  const answering =
    run.isPending || run.isError || !!run.data ||
    render.isPending || render.isError || !!render.data;

  const copyOutput = async () => {
    if (!run.data) return;
    try {
      await navigator.clipboard.writeText(run.data.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="dock-aware fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`card relative z-10 flex max-h-[88vh] w-full flex-col overflow-hidden transition-[max-width] ${
          answering ? 'max-w-5xl' : 'max-w-2xl'
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Pill tone={catTone[prompt.category]}>{prompt.category}</Pill>
              <button
                type="button"
                onClick={() => setShowTemplate((v) => !v)}
                className="focusable rounded text-[12px] text-ink-faint hover:text-ink"
              >
                {showTemplate ? 'Hide prompt' : 'View prompt'}
              </button>
            </div>
            <h2 className="mt-1.5 truncate text-[17px] font-semibold text-ink">{prompt.title}</h2>
          </div>
          <button onClick={onClose} className="focusable text-ink-faint hover:text-ink" aria-label="Close">✕</button>
        </div>

        {showTemplate && (
          <pre className="max-h-48 shrink-0 overflow-y-auto whitespace-pre-wrap border-b border-line-soft bg-sunk/50 px-5 py-3 text-[12px] leading-relaxed text-ink-soft">
            {prompt.template}
          </pre>
        )}

        {/* Once there is an answer it sits beside the inputs rather than
            below the fold; until then the form has the modal to itself. */}
        <div className={`grid min-h-0 flex-1 ${answering ? 'lg:grid-cols-2 lg:divide-x lg:divide-line-soft' : ''}`}>
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-5">
            {prompt.variables.map((v) => (
              <label key={v.key} className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {v.label}{v.required && <span className="text-crit"> *</span>}
                </span>
                <textarea
                  rows={rowsFor(v.key, v.label)}
                  value={values[v.key] ?? ''}
                  onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                  className="input w-full resize-y"
                />
              </label>
            ))}

            {board && (
              <div className="rounded-lg border border-line-soft bg-sunk/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    Reference images
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading || refs.length >= 14}
                    className="btn-secondary btn-sm"
                  >
                    {uploading ? 'Adding…' : 'Attach'}
                  </button>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                  className="hidden"
                  onChange={(e) => attach(e.target.files)}
                />

                {refs.length === 0 ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-faint">
                    {/* Named, because "attach files" tells you nothing about
                        which files actually change the result. */}
                    Attach {board.references.join(', ').toLowerCase()}. The board is drawn from these —
                    without them it invents its own.
                  </p>
                ) : (
                  <ul className="mt-2.5 space-y-2">
                    {refs.map((r, i) => (
                      <li key={r.token} className="flex items-center gap-2.5">
                        {r.mimeType.startsWith('image/') ? (
                          <img src={r.preview} alt="" className="h-9 w-9 shrink-0 rounded border border-line object-cover" />
                        ) : (
                          <span className="grid h-9 w-9 shrink-0 place-items-center rounded border border-line bg-surface text-[10px] font-semibold text-ink-faint">
                            PDF
                          </span>
                        )}
                        <select
                          value={r.label}
                          onChange={(e) =>
                            setRefs((cur) => cur.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))
                          }
                          className="input input-sm min-w-0 flex-1"
                          aria-label={`What ${r.name} is`}
                        >
                          {[...new Set([...board.references, r.label, 'Reference image'])].map((label) => (
                            <option key={label} value={label}>{label}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            URL.revokeObjectURL(r.preview);
                            setRefs((cur) => cur.filter((_, n) => n !== i));
                          }}
                          className="focusable shrink-0 rounded px-1 text-[13px] text-ink-faint hover:text-crit"
                          aria-label={`Remove ${r.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {attachError && <p className="mt-2 text-[12px] text-crit">{attachError}</p>}
              </div>
            )}

            {projects.length > 0 && (
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  Project (optional)
                </span>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input w-full">
                  <option value="">— none —</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {/* It files the run, but it also answers the run: the client,
                    the vendor contact and the PO numbers come from the project
                    rather than being left as blanks to fill in by hand. */}
                <span className="mt-1 block text-[12px] leading-relaxed text-ink-faint">
                  Picks up the client, vendor contact and existing PO numbers from the studio's records, and files
                  the run against the project.
                </span>
              </label>
            )}
          </div>

          {answering && (
            <div className="flex min-h-0 flex-col bg-sunk/20">
              {run.isError && (
                <p className="m-5 rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{(run.error as Error).message}</p>
              )}

              {render.isError && (
              <p className="m-5 rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{(render.error as Error).message}</p>
            )}

            {render.isPending && (
              <div className="grid flex-1 place-items-center px-6 py-10 text-center">
                <p className="max-w-[30ch] text-[13px] leading-relaxed text-ink-faint">
                  Drawing the board… this takes up to a minute or two.
                </p>
              </div>
            )}

            {render.data && (
              <>
                <div className="flex items-center justify-between border-b border-line-soft px-5 py-2.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brass">
                    Board · {render.data.references} reference{render.data.references === 1 ? '' : 's'}
                  </span>
                  <a
                    href={boardUrl ?? undefined}
                    download={render.data.name}
                    className="btn-secondary btn-sm"
                  >
                    Download
                  </a>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto bg-sunk/40 p-4">
                  {boardUrl ? (
                    <img src={boardUrl} alt={render.data.name} className="w-full rounded-lg border border-line" />
                  ) : (
                    <p className="text-[13px] text-ink-faint">Rendered. Use Download to open it.</p>
                  )}
                  {render.data.note && (
                    <p className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">{render.data.note}</p>
                  )}
                </div>
              </>
            )}

            {run.isPending && !run.data && (
                <div className="grid flex-1 place-items-center px-6 py-10 text-center">
                  <p className="text-[13px] text-ink-faint">Claude is working through the prompt…</p>
                </div>
              )}

              {run.data && (
                <>
                  <div className="flex items-center justify-between border-b border-line-soft px-5 py-2.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brass">Output</span>
                    <div className="flex items-center gap-2">
                      <button onClick={copyOutput} className="btn-secondary btn-sm">{copied ? 'Copied' : 'Copy'}</button>
                      <button
                        onClick={() => draft.mutate({ subject: prompt.title, body: run.data!.output })}
                        disabled={draft.isPending}
                        className="btn-secondary btn-sm"
                      >
                        {draft.isPending ? 'Saving…' : 'Save as draft'}
                      </button>
                    </div>
                  </div>
                  {/* Rendered, not printed: the answer comes back as Markdown,
                      and the raw form put "# Concept Narrative" on screen. Copy
                      still takes the Markdown, which is what pastes into Canva
                      or a doc. */}
                  <Markdown
                    text={run.data.output}
                    className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13.5px] leading-relaxed text-ink-soft"
                  />
                  {(draft.isSuccess || draft.isError) && (
                    <div className="border-t border-line-soft px-5 py-2 text-[12.5px]">
                      {draft.isSuccess && (
                        <Link to="/drafts" className="focusable text-brass-deep hover:underline">Saved to Drafts →</Link>
                      )}
                      {draft.isError && <span className="text-crit">{(draft.error as Error).message}</span>}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-4">
          <button onClick={onClose} className="focusable rounded-lg px-3.5 py-2 text-[13px] text-ink-soft hover:text-ink">
            Close
          </button>
          <button
            onClick={() => run.mutate({ id: prompt.id, variables: values, projectId: projectId || undefined })}
            disabled={disabled || run.isPending || render.isPending}
            className={canRender ? 'btn-secondary' : 'btn-primary'}
          >
            {run.isPending ? 'Running…' : run.data ? 'Run again' : 'Write it'}
          </button>
          {canRender && (
            <button
              onClick={renderBoard}
              disabled={disabled || render.isPending || run.isPending}
              className="btn-primary"
            >
              {render.isPending ? 'Drawing…' : render.data ? 'Render again' : 'Render board'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Prompts() {
  const [cat, setCat] = useState<PromptCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<Prompt | null>(null);
  const { data: prompts, isLoading } = usePromptLibrary();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return prompts.filter((p) => {
      if (cat !== 'all' && p.category !== cat) return false;
      if (!q) return true;
      return [p.title, p.description ?? '', ...p.variables.map((v) => v.label)]
        .some((f) => f.toLowerCase().includes(q));
    });
  }, [prompts, cat, query]);

  const pager = usePager(shown, 20);

  return (
    <Page>
      <PageHeading
        title="Prompt Studio"
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {CATS.map((c) => (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className={`focusable rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
                  cat === c.key
                    ? 'border-brass bg-brass font-semibold text-white'
                    : 'border-line bg-surface text-ink-soft hover:text-ink'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                className="input input-sm w-56 pl-8"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts"
                aria-label="Search prompts"
              />
            </div>
            <span className="whitespace-nowrap text-[12px] text-ink-faint">
              {shown.length === prompts.length ? `${prompts.length} prompts` : `${shown.length} of ${prompts.length}`}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[14px]">
            <colgroup>
              {/* The prompt itself takes whatever the fixed columns leave. */}
              <col />
              <col className="w-[104px]" />
              <col className="w-[268px]" />
              <col className="w-[88px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <th className="px-5 py-2.5 font-medium">Prompt</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 font-medium">Inputs</th>
                <th className="px-5 py-2.5 text-right font-medium">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
              )}
              {!isLoading && prompts.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No prompts in the library yet. Run <code className="text-ink-soft">npm run seed-prompts</code> to load the studio's set.
                  </td>
                </tr>
              )}
              {!isLoading && prompts.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No prompts match these filters.
                  </td>
                </tr>
              )}
              {pager.rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setActive(p)}
                  className="cursor-pointer align-middle transition-colors hover:bg-sunk/40"
                >
                  <td className="px-5 py-2.5">
                    {/* Title and description share a line, as the Inbox does:
                        stacked, each was truncated to half a sentence while
                        the rest of a very wide column sat empty. */}
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 text-[14px] font-medium text-ink">{p.title}</span>
                      {p.description && (
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-faint">{p.description}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill tone={catTone[p.category]}>{p.category}</Pill>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block truncate text-[12.5px] text-ink-soft" title={p.variables.map((v) => v.label).join(' · ')}>
                      {p.variables.length === 0
                        ? '—'
                        : p.variables.slice(0, 2).map((v) => v.label).join(' · ') +
                          (p.variables.length > 2 ? ` +${p.variables.length - 2}` : '')}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); setActive(p); }}
                      className="btn-secondary btn-sm"
                    >
                      Run <IconArrow width={14} height={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pager {...pager} count={pager.rows.length} noun="prompt" />
      </Card>

      {active && <RunModal prompt={active} onClose={() => setActive(null)} />}
    </Page>
  );
}
