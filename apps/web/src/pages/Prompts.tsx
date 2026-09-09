import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading, Card } from '../components/ui';
import { IconPrompt, IconArrow } from '../components/icons';
import { usePromptLibrary, useRunPrompt, useCreateDraft, useProjects } from '../lib/queries';
import type { Prompt, PromptCategory } from '@janelle/shared';

const CATS: { key: PromptCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'design', label: 'Design' },
  { key: 'procurement', label: 'Procurement / FF&E' },
  { key: 'client', label: 'Client communication' },
  { key: 'admin', label: 'Admin' },
];

const catTone: Record<PromptCategory, string> = {
  design: 'text-olive',
  procurement: 'text-brass-deep',
  client: 'text-warn',
  admin: 'text-ink-soft',
};

function RunModal({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState('');
  const [copied, setCopied] = useState(false);
  const run = useRunPrompt();
  const draft = useCreateDraft();
  const { data: projects } = useProjects();
  const disabled = prompt.variables.some((v) => v.required && !values[v.key]?.trim());

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
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <div>
            <div className="text-[12px] font-semibold text-brass-deep">{prompt.category}</div>
            <h2 className="text-[16px] font-semibold text-ink">{prompt.title}</h2>
          </div>
          <button onClick={onClose} className="focusable text-ink-faint hover:text-ink" aria-label="Close">✕</button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {prompt.variables.map((v) => (
            <label key={v.key} className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-faint">
                {v.label}{v.required && <span className="text-crit"> *</span>}
              </span>
              <textarea
                rows={v.key === 'items' || v.key === 'options' || v.key === 'notes' ? 3 : 1}
                value={values[v.key] ?? ''}
                onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
                className="input resize-y"
              />
            </label>
          ))}

          {projects.length > 0 && (
            <label className="block">
              <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-faint">Save to project (optional)</span>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="input"
              >
                <option value="">— none —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}

          {run.isError && (
            <p className="rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{(run.error as Error).message}</p>
          )}
          {run.data && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-brass">Output</div>
              <div className="whitespace-pre-wrap rounded-lg border border-line bg-sunk/60 px-4 py-3 text-[14px] leading-relaxed text-ink">
                {run.data.output}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button onClick={copyOutput} className="btn-secondary btn-sm">
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  onClick={() => draft.mutate({ subject: prompt.title, body: run.data!.output })}
                  disabled={draft.isPending}
                  className="btn-secondary btn-sm"
                >
                  {draft.isPending ? 'Saving…' : 'Save as draft'}
                </button>
                {draft.isSuccess && (
                  <Link to="/drafts" className="focusable text-[12.5px] text-brass-deep hover:underline">
                    Saved to Drafts →
                  </Link>
                )}
                {draft.isError && <span className="text-[12px] text-crit">{(draft.error as Error).message}</span>}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-4">
          <button onClick={onClose} className="focusable rounded-lg px-3.5 py-2 text-[13px] text-ink-soft hover:text-ink">
            Close
          </button>
          <button
            onClick={() => run.mutate({ id: prompt.id, variables: values, projectId: projectId || undefined })}
            disabled={disabled || run.isPending}
            className="btn-primary"
          >
            {run.isPending ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Prompts() {
  const [cat, setCat] = useState<PromptCategory | 'all'>('all');
  const [active, setActive] = useState<Prompt | null>(null);
  const { data: prompts } = usePromptLibrary();
  const shown = prompts.filter((p) => cat === 'all' || p.category === cat);

  return (
    <>
      <PageHeading
        title="Prompt Studio"
        sub="Prompts built from the studio's own work, run in-app on real project context — powered by Claude."
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {CATS.map((c) => (
          <button
            key={c.key}
            onClick={() => setCat(c.key)}
            className={`focusable rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
              cat === c.key ? 'border-brass bg-brass font-semibold text-white' : 'border-line bg-surface text-ink-soft hover:text-ink'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((p) => (
          <Card key={p.id} className="group flex flex-col p-5 transition-transform hover:-translate-y-0.5">
            <div className="flex items-center justify-between">
              <IconPrompt className="text-brass" />
              <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${catTone[p.category]}`}>{p.category}</span>
            </div>
            <h3 className="mt-3 text-[17px] font-semibold text-ink">{p.title}</h3>
            <p className="mt-1.5 flex-1 text-[13.5px] leading-relaxed text-ink-soft">{p.description}</p>
            <button
              onClick={() => setActive(p)}
              className="btn-secondary btn-sm mt-4 self-start"
            >
              Run in Studio <IconArrow width={14} height={14} />
            </button>
          </Card>
        ))}
      </div>

      {active && <RunModal prompt={active} onClose={() => setActive(null)} />}
    </>
  );
}
