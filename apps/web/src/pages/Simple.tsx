import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading, Card, Pill, money, usePager, Pager } from '../components/ui';
import { IconSearch } from '../components/icons';
import { useEmails, useDocuments, type DocSource } from '../lib/queries';
import { apiBlob } from '../lib/api';

/** Fetch a document's original PDF and open it in a new tab. */
async function openDocument(id: string, onError: (m: string) => void) {
  const win = window.open('', '_blank'); // open synchronously to dodge popup blockers
  try {
    const blob = await apiBlob(`/documents/${id}/file`);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (win) win.close();
    onError((e as Error).message);
  }
}

const REPLYABLE = ['vendor_quote', 'order_confirmation', 'client_approval'];

const emailClassLabel: Record<string, string> = {
  vendor_quote: 'Quote',
  order_confirmation: 'Order confirm',
  client_approval: 'Client approval',
  houzz_notification: 'Houzz',
  general: 'General',
  unclassified: 'Unclassified',
};
const emailClassTone: Record<string, 'brass' | 'good' | 'warn' | 'neutral'> = {
  vendor_quote: 'brass',
  order_confirmation: 'good',
  client_approval: 'warn',
  houzz_notification: 'neutral',
  general: 'neutral',
};

/** The full timestamp behind the relative "2 days", shown on hover. */
function exactWhen(iso: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? undefined
    : d.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
}

export function Inbox() {
  const { data: emails, isLoading } = useEmails();
  const [query, setQuery] = useState('');
  const [cls, setCls] = useState<string>('all');

  // Only the classes actually present, so the filter never offers a dead option.
  const classes = useMemo(
    () => [...new Set(emails.map((m) => m.cls))].sort((a, b) =>
      (emailClassLabel[a] ?? a).localeCompare(emailClassLabel[b] ?? b)),
    [emails],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return emails.filter((m) => {
      if (cls !== 'all' && m.cls !== cls) return false;
      if (!q) return true;
      return [m.subject, m.snippet, m.fromName, m.fromEmail, m.project, m.vendor]
        .some((f) => f.toLowerCase().includes(q));
    });
  }, [emails, query, cls]);

  // A column nothing fills is left out entirely rather than drawn as a stack
  // of em dashes — measured over all mail so the shape holds while filtering.
  const showProject = emails.some((m) => m.project !== '');
  const showVendor = emails.some((m) => m.vendor !== '');
  const cols = 4 + Number(showProject) + Number(showVendor);

  // A studio mailbox runs to hundreds of messages; the table shows a
  // screenful, and the filters above decide what is being paged through.
  const pager = usePager(shown, 25);

  return (
    <>
      <PageHeading
        title="Inbox Intelligence"
        sub="Project mail, classified and linked to the right project and vendor."
      />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              className="input input-sm w-64 pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subject, sender or project"
              aria-label="Search mail"
            />
          </div>
          <div className="flex items-center gap-3">
            <select
              className="input input-sm"
              value={cls}
              onChange={(e) => setCls(e.target.value)}
              aria-label="Filter by classification"
            >
              <option value="all">All mail</option>
              {classes.map((c) => (
                <option key={c} value={c}>{emailClassLabel[c] ?? c}</option>
              ))}
            </select>
            <span className="text-[12px] text-ink-faint">
              {shown.length === emails.length ? `${emails.length} read` : `${shown.length} of ${emails.length}`}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[14px]">
            <colgroup>
              <col className="w-[108px]" />
              <col className="w-[168px]" />
              {/* Subject takes every pixel the fixed columns do not: the old
                  layout stacked subject, snippet and sender in a narrow middle
                  band and left the right third of the row empty. */}
              <col />
              {showProject && <col className="w-[150px]" />}
              {showVendor && <col className="w-[150px]" />}
              <col className="w-[84px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <th className="px-5 py-2.5 font-medium">Type</th>
                <th className="px-3 py-2.5 font-medium">From</th>
                <th className="px-3 py-2.5 font-medium">Subject</th>
                {showProject && <th className="px-3 py-2.5 font-medium">Project</th>}
                {showVendor && <th className="px-3 py-2.5 font-medium">Vendor</th>}
                <th className="px-5 py-2.5 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
              )}
              {!isLoading && emails.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No mail read yet. Run “Read Gmail &amp; Drive” from the Dashboard.
                  </td>
                </tr>
              )}
              {!isLoading && emails.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No mail matches these filters.
                  </td>
                </tr>
              )}
              {pager.rows.map((m) => (
                <tr key={m.id} className="align-middle transition-colors hover:bg-sunk/40">
                  <td className="px-5 py-2.5">
                    <Pill tone={emailClassTone[m.cls] ?? 'neutral'}>{emailClassLabel[m.cls] ?? m.cls}</Pill>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block truncate text-[13px] text-ink" title={m.fromEmail || undefined}>
                      {m.fromName || m.fromEmail || '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {/* Subject and snippet share one line so the width is spent
                        on content instead of on a third row of text. */}
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 max-w-[60%] truncate text-[13.5px] font-medium text-ink">
                        {m.subject}
                      </span>
                      {m.snippet && (
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-faint">{m.snippet}</span>
                      )}
                      {REPLYABLE.includes(m.cls) && (
                        <Link
                          to="/drafts"
                          className="focusable shrink-0 rounded text-[12px] font-semibold text-brass-deep hover:underline"
                          title="A reply is waiting in Drafts"
                        >
                          ✎ drafted
                        </Link>
                      )}
                    </div>
                  </td>
                  {showProject && (
                    <td className="px-3 py-2.5">
                      <span className="block truncate text-[13px] text-ink-soft">{m.project || '—'}</span>
                    </td>
                  )}
                  {showVendor && (
                    <td className="px-3 py-2.5">
                      <span className="block truncate text-[13px] text-ink-soft">{m.vendor || '—'}</span>
                    </td>
                  )}
                  <td className="px-5 py-2.5 text-right text-[12px] text-ink-faint" title={exactWhen(m.receivedAt)}>
                    {m.when}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pager {...pager} count={pager.rows.length} noun="message" />
      </Card>
    </>
  );
}

const docTypeLabel: Record<string, string> = {
  quote: 'Quote',
  order_confirmation: 'Order confirmation',
  purchase_order: 'Purchase order',
  other: 'Other',
};

function sharedWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit',
  });
}

function SharedBy({ source }: { source: DocSource | null }) {
  if (!source) return <span className="text-ink-faint">—</span>;
  if (source.kind === 'drive') {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-olive/10 text-olive" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M8.5 3h7l6 10.5-3.5 6.5h-12L2.5 13.5 8.5 3Z" /><path d="M8.5 3l6 10.5M2.5 13.5h12" /></svg>
        </span>
        <span className="leading-tight">
          <span className="block text-[13.5px] font-medium text-ink">Google Drive</span>
          <span className="block text-[11.5px] text-ink-faint">picked up from the shared folder</span>
        </span>
      </span>
    );
  }
  const initial = (source.fromName || source.fromEmail || '?').slice(0, 1).toUpperCase();
  const showEmail = source.fromEmail && source.fromEmail !== source.fromName;
  return (
    <span className="inline-flex max-w-[260px] items-center gap-2" title={source.subject ? `Email: ${source.subject}` : undefined}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brass/10 text-[12px] font-bold text-brass-deep" aria-hidden="true">
        {initial}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[13.5px] font-medium text-ink">{source.fromName || source.fromEmail || 'Unknown sender'}</span>
        {showEmail && <span className="block truncate text-[11.5px] text-ink-faint">{source.fromEmail}</span>}
        {!showEmail && source.subject && <span className="block truncate text-[11.5px] text-ink-faint">{source.subject}</span>}
      </span>
    </span>
  );
}

export function Documents() {
  const { data: docs, isLoading } = useDocuments();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');

  // Only the types actually parsed, so the filter never offers a dead option.
  const types = useMemo(
    () => [...new Set(docs.map((d) => d.type))].sort((a, b) =>
      (docTypeLabel[a] ?? a).localeCompare(docTypeLabel[b] ?? b)),
    [docs],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (type !== 'all' && d.type !== type) return false;
      if (!q) return true;
      return [
        d.vendor, d.project, docTypeLabel[d.type] ?? d.type,
        d.source?.fromName ?? '', d.source?.fromEmail ?? '', d.source?.subject ?? '',
      ].some((f) => f.toLowerCase().includes(q));
    });
  }, [docs, query, type]);

  // Same rule as the Inbox: a column nothing fills is left out rather than
  // drawn as a stack of em dashes. Measured over every document, not the
  // filtered set, so columns do not appear and vanish as you type.
  const showVendor = docs.some((d) => d.vendor !== '');
  const showProject = docs.some((d) => d.project !== '');
  // Type, Shared by, Received, Total, Confidence and File always render.
  const cols = 6 + Number(showVendor) + Number(showProject);

  const pager = usePager(shown, 25);

  return (
    <>
      <PageHeading
        title="Document Intelligence"
        sub="PDF quotes and order confirmations, parsed into structured records. Each row shows who shared the file and when it arrived."
      />
      {error && (
        <div className="mb-4 rounded-lg bg-crit/10 px-4 py-2.5 text-[13px] text-crit">{error}</div>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              className="input input-sm w-64 pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search vendor, project or sender"
              aria-label="Search documents"
            />
          </div>
          <div className="flex items-center gap-3">
            <select
              className="input input-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Filter by document type"
            >
              <option value="all">All documents</option>
              {types.map((t) => (
                <option key={t} value={t}>{docTypeLabel[t] ?? t}</option>
              ))}
            </select>
            <span className="text-[12px] text-ink-faint">
              {shown.length === docs.length ? `${docs.length} parsed` : `${shown.length} of ${docs.length}`}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <th className="px-5 py-3 font-semibold">Type</th>
                {showVendor && <th className="px-5 py-3 font-semibold">Vendor</th>}
                {showProject && <th className="px-5 py-3 font-semibold">Project</th>}
                <th className="px-5 py-3 font-semibold">Shared by</th>
                <th className="px-5 py-3 font-semibold">Received</th>
                <th className="px-5 py-3 text-right font-semibold">Total</th>
                <th className="px-5 py-3 text-right font-semibold">Confidence</th>
                <th className="px-5 py-3 text-right font-semibold">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
              )}
              {!isLoading && docs.length === 0 && (
                <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">No documents parsed yet.</td></tr>
              )}
              {!isLoading && docs.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No documents match these filters.
                  </td>
                </tr>
              )}
              {pager.rows.map((d) => (
                <tr key={d.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                  <td className="px-5 py-3"><Pill tone="brass">{docTypeLabel[d.type] ?? d.type}</Pill></td>
                  {showVendor && <td className="px-5 py-3 font-medium text-ink">{d.vendor || '—'}</td>}
                  {showProject && <td className="px-5 py-3">{d.project || '—'}</td>}
                  <td className="px-5 py-3"><SharedBy source={d.source} /></td>
                  <td className="px-5 py-3 whitespace-nowrap" title={exactWhen(d.createdAt)}>
                    {d.source?.kind === 'gmail' ? (
                      <span className="leading-tight">
                        <span className="block text-[13px] text-ink">{sharedWhen(d.source.sharedAt)}</span>
                        <span className="block text-[11.5px] text-ink-faint">via email · parsed {d.when}</span>
                      </span>
                    ) : (
                      <span className="leading-tight">
                        <span className="block text-[13px] text-ink">{d.when === 'today' ? 'Today' : d.when}</span>
                        <span className="block text-[11.5px] text-ink-faint">parsed</span>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-ink">{money(d.total)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{Math.round(d.confidence * 100)}%</td>
                  <td className="px-5 py-3 text-right">
                    <button
                      onClick={() => { setError(null); openDocument(d.id, setError); }}
                      className="btn-secondary btn-sm text-brass-deep"
                    >
                      View PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pager {...pager} count={pager.rows.length} noun="document" />
      </Card>
    </>
  );
}
