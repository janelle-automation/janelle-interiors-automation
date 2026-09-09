import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeading, Card, Pill, money } from '../components/ui';
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

export function Inbox() {
  const { data: emails } = useEmails();
  return (
    <>
      <PageHeading
        title="Inbox Intelligence"
        sub="Project mail, classified and linked to the right project and vendor."
      />
      <Card>
        <ul className="divide-y divide-line-soft">
          {emails.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
              No mail read yet. Run “Read Gmail &amp; Drive” from the Dashboard.
            </li>
          )}
          {emails.map((m) => (
            <li key={m.id} className="flex items-start gap-4 px-5 py-4">
              <div className="w-28 shrink-0">
                <Pill tone={emailClassTone[m.cls] ?? 'neutral'}>{emailClassLabel[m.cls] ?? m.cls}</Pill>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-ink">{m.subject}</div>
                <div className="truncate text-[13px] text-ink-soft">{m.snippet}</div>
                <div className="mt-0.5 text-[11px] text-ink-faint">{m.from}</div>
              </div>
              <div className="whitespace-nowrap text-right">
                <div className="text-[12px] text-ink-soft">{m.project}</div>
                <div className="text-[11px] text-ink-faint">{m.when}</div>
                {REPLYABLE.includes(m.cls) && (
                  <Link
                    to="/drafts"
                    className="focusable mt-1 inline-flex items-center gap-1 text-[13px] font-semibold text-brass-deep hover:underline"
                  >
                    ✎ reply drafted
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
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
  const { data: docs } = useDocuments();
  const [error, setError] = useState<string | null>(null);
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
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                <th className="px-5 py-3 font-semibold">Type</th>
                <th className="px-5 py-3 font-semibold">Vendor</th>
                <th className="px-5 py-3 font-semibold">Project</th>
                <th className="px-5 py-3 font-semibold">Shared by</th>
                <th className="px-5 py-3 font-semibold">Received</th>
                <th className="px-5 py-3 text-right font-semibold">Total</th>
                <th className="px-5 py-3 text-right font-semibold">Confidence</th>
                <th className="px-5 py-3 text-right font-semibold">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {docs.length === 0 && (
                <tr><td colSpan={8} className="px-5 py-10 text-center text-[13px] text-ink-faint">No documents parsed yet.</td></tr>
              )}
              {docs.map((d) => (
                <tr key={d.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                  <td className="px-5 py-3"><Pill tone="brass">{docTypeLabel[d.type] ?? d.type}</Pill></td>
                  <td className="px-5 py-3 font-medium text-ink">{d.vendor}</td>
                  <td className="px-5 py-3">{d.project}</td>
                  <td className="px-5 py-3"><SharedBy source={d.source} /></td>
                  <td className="px-5 py-3 whitespace-nowrap">
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
      </Card>
    </>
  );
}
