import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Page, PageHeading, Card, StageBadge, Pill, money, shortDate } from '../components/ui';
import { IconArrow } from '../components/icons';
import { useProject, useUpdateProject } from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS, type ProjectStage } from '@janelle/shared';

const inputCls = 'input';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

const emailEventLabel: Record<string, string> = {
  vendor_quote: 'Vendor quote received',
  order_confirmation: 'Order confirmed',
  client_approval: 'Client approval',
  houzz_notification: 'Houzz notification',
  general: 'Email',
  unclassified: 'Email',
};
const docEventLabel: Record<string, string> = {
  quote: 'Quote parsed',
  order_confirmation: 'Order confirmation parsed',
  purchase_order: 'Purchase order parsed',
  other: 'Document parsed',
};
const eventTone: Record<string, string> = { email: 'bg-olive', doc: 'bg-brass', po: 'bg-good' };

export default function ProjectDetail() {
  const { id } = useParams();
  const { data, isLoading, isError } = useProject(id);
  const update = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ client_name: '', location: '', budget: '', target_install: '', stage: 'lead' as ProjectStage, notes: '' });

  useEffect(() => {
    if (data?.project) {
      const p = data.project;
      setForm({
        client_name: p.client_name ?? '',
        location: p.location ?? '',
        budget: p.budget != null ? String(p.budget) : '',
        target_install: p.target_install ?? '',
        stage: p.stage,
        notes: p.notes ?? '',
      });
    }
  }, [data?.project]);

  if (isLoading) {
    return <div className="py-16 text-center text-[13px] font-medium text-ink-faint">Loading…</div>;
  }
  if (isError || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-[15px] text-ink-soft">Project not found.</p>
        <Link to="/projects" className="focusable mt-3 inline-block text-[12px] uppercase tracking-wide text-brass-deep hover:underline">← All projects</Link>
      </div>
    );
  }

  const p = data.project;
  const pos = data.purchase_orders;
  const gaps = data.spec_gaps;
  const stageIndex = PROJECT_STAGES.indexOf(p.stage);

  // Build a chronological progress timeline from emails, documents and POs.
  type Ev = { at: number; iso: string; kind: 'email' | 'doc' | 'po'; title: string; sub: string };
  const events: Ev[] = [];
  for (const e of data.emails) {
    events.push({ at: e.received_at ? Date.parse(e.received_at) : 0, iso: e.received_at ?? '', kind: 'email', title: emailEventLabel[e.class] ?? 'Email', sub: e.subject ?? '' });
  }
  for (const d of data.documents) {
    events.push({ at: Date.parse(d.created_at), iso: d.created_at, kind: 'doc', title: docEventLabel[d.type] ?? 'Document parsed', sub: d.parsed_json?.vendor ?? '' });
  }
  for (const o of pos) {
    const iso = (o as { order_date?: string | null; created_at?: string }).order_date || (o as { created_at?: string }).created_at || '';
    events.push({ at: iso ? Date.parse(iso) : 0, iso, kind: 'po', title: `Purchase order${o.po_number ? ' ' + o.po_number : ''}`, sub: o.amount ? money(o.amount) : '' });
  }
  events.sort((a, b) => b.at - a.at);

  return (
    <Page>
      <Link to="/projects" className="focusable inline-flex items-center gap-1.5 text-[13px] font-semibold text-brass-deep hover:underline">
        <IconArrow width={14} height={14} className="rotate-180" /> All projects
      </Link>
      <PageHeading
        // Client and town read as one line — "Ojai Valley Inn & Spa · Ojai, CA"
        // — because a dozen of these projects share a client and the town is
        // what tells them apart at a glance.
        eyebrow={[p.client_name, p.location].filter(Boolean).join(' · ') || '—'}
        title={p.name}
        action={
          <div className="flex items-center gap-3">
            {/* What the studio's own project sheet calls this, when it came
                from there. Shown next to the stage rather than instead of it:
                the two are different vocabularies, and until someone sets a
                real stage this is the more truthful of the two. */}
            {p.sheet_status && (
              <span className="rounded-md bg-ink/5 px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                Sheet: {p.sheet_status}
              </span>
            )}
            <StageBadge stage={p.stage} />
            <button
              onClick={() => setEditing((e) => !e)}
              className="btn-secondary btn-sm"
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
          </div>
        }
      />

      {editing && (
        <Card className="p-6">
          <h2 className="mb-4 text-[16px] font-semibold text-ink">Edit project</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client">
              <input className={inputCls} value={form.client_name} onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))} placeholder="Client name" />
            </Field>
            <Field label="Location">
              <input className={inputCls} value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Ojai, CA" />
            </Field>
            <Field label="Budget (USD)">
              <input className={inputCls} type="number" value={form.budget} onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))} placeholder="e.g. 120000" />
            </Field>
            <Field label="Target install">
              <input className={inputCls} type="date" value={form.target_install} onChange={(e) => setForm((f) => ({ ...f, target_install: e.target.value }))} />
            </Field>
            <Field label="Stage">
              <select className={inputCls} value={form.stage} onChange={(e) => setForm((f) => ({ ...f, stage: e.target.value as ProjectStage }))}>
                {PROJECT_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Notes">
                <textarea className={inputCls} rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </Field>
            </div>
          </div>
          {update.isError && <p className="mt-3 text-[12.5px] text-crit">{(update.error as Error).message}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="focusable rounded-lg px-4 py-2 text-[13px] text-ink-soft hover:text-ink">Cancel</button>
            <button
              disabled={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: p.id, patch: { client_name: form.client_name, location: form.location, budget: form.budget, target_install: form.target_install, stage: form.stage, notes: form.notes } },
                  { onSuccess: () => setEditing(false) },
                )
              }
              className="btn-primary"
            >
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card className="p-4"><div className="text-[12px] font-medium text-ink-soft">Budget</div><div className="mt-1 text-xl text-ink tabular-nums">{money(p.budget)}</div></Card>
        <Card className="p-4"><div className="text-[12px] font-medium text-ink-soft">Target install</div><div className="mt-1 text-xl text-ink">{shortDate(p.target_install)}</div></Card>
        <Card className="p-4"><div className="text-[12px] font-medium text-ink-soft">Purchase orders</div><div className="mt-1 text-xl text-ink tabular-nums">{pos.length}</div></Card>
        <Card className="p-4"><div className="text-[12px] font-medium text-ink-soft">Spec gaps</div><div className="mt-1 text-xl text-ink tabular-nums">{gaps.length}</div></Card>
      </div>

      {/* Stage progress tracker */}
      <Card className="p-5">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Progress · auto-updated from email</div>
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {PROJECT_STAGES.map((s, i) => {
            const done = i < stageIndex;
            const current = i === stageIndex;
            return (
              <div key={s} className="flex min-w-0 flex-1 items-center gap-1">
                <div className="flex min-w-[64px] flex-1 flex-col items-center gap-1.5">
                  <div className={`h-1.5 w-full rounded-full ${done || current ? 'bg-brass' : 'bg-sunk'}`} />
                  <span className={`whitespace-nowrap text-[11px] font-medium ${current ? 'text-brass-deep font-semibold' : done ? 'text-ink-soft' : 'text-ink-faint'}`}>
                    {STAGE_LABELS[s]}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="border-b border-line-soft px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">Purchase orders</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  <th className="px-5 py-3 font-medium">Vendor</th><th className="px-5 py-3 font-medium">PO</th>
                  <th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 text-right font-medium">Items</th>
                  <th className="px-5 py-3 text-right font-medium">Amount</th><th className="px-5 py-3 text-right font-medium">ETA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {pos.length === 0 && <tr><td colSpan={6} className="px-5 py-8 text-center text-[13px] text-ink-faint">No purchase orders yet.</td></tr>}
                {pos.map((o) => (
                  <tr key={o.id} className="text-ink-soft">
                    <td className="px-5 py-3 text-[13px] font-medium text-ink">{o.vendors?.name ?? '—'}</td>
                    {/* Most of these orders came out of a vendor quote, which
                        carries no PO number — the studio assigns one when it
                        raises the order. Saying so beats another dash. */}
                    <td className="px-5 py-3 text-[13px] text-ink">
                      {o.po_number ?? <span className="text-ink-faint">not yet numbered</span>}
                    </td>
                    <td className="px-5 py-3"><Pill tone={o.status === 'received' ? 'good' : o.status === 'shipped' ? 'brass' : 'neutral'}>{o.status.replace('_', ' ')}</Pill></td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink-soft">{o.line_items?.length || '—'}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">{money(o.amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{shortDate(o.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="border-b border-line-soft px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">Spec gaps</h2></div>
          <ul className="divide-y divide-line-soft">
            {gaps.length === 0 && <li className="px-5 py-8 text-center text-[13px] text-ink-faint">Nothing blocking an order.</li>}
            {gaps.map((g) => (
              <li key={g.id} className="px-5 py-4">
                <div className="text-[14px] font-medium text-ink">{g.item}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {g.missing_fields.map((m) => <span key={m} className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">missing: {m}</span>)}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Progress timeline */}
      <Card>
        <div className="border-b border-line-soft px-5 py-4"><h2 className="text-[16px] font-semibold text-ink">Timeline</h2></div>
        {events.length === 0 ? (
          <div className="px-5 py-8 text-center text-[13px] text-ink-faint">No activity yet — events appear here as email and documents come in.</div>
        ) : (
          <ol className="px-5 py-4">
            {events.map((ev, i) => (
              <li key={i} className="relative flex gap-4 pb-5 last:pb-0">
                <div className="flex flex-col items-center">
                  <span className={`mt-1 h-2.5 w-2.5 rounded-full ${eventTone[ev.kind]}`} />
                  {i < events.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] font-medium text-ink">{ev.title}</span>
                    <span className="whitespace-nowrap text-[11px] text-ink-faint">{ev.iso ? shortDate(ev.iso) : '—'}</span>
                  </div>
                  {ev.sub && <div className="truncate text-[13px] text-ink-soft">{ev.sub}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {p.notes && <Card className="p-5"><div className="text-[12px] font-medium text-ink-soft">Notes</div><p className="mt-2 text-[14px] text-ink-soft">{p.notes}</p></Card>}
    </Page>
  );
}
