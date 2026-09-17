import { useMemo, useState } from 'react';
import type { PoStatus } from '@janelle/shared';
import { PageHeading, Card, Pill, money, shortDate, usePager, Pager } from '../components/ui';
import { IconSearch, IconPlus } from '../components/icons';
import {
  useVendors, usePurchaseOrders, useCreateVendor, useVendorAbilities,
  type PoView, type VendorView,
} from '../lib/queries';

/**
 * Orders move draft → placed → confirmed → in production → shipped →
 * received. Anything still in flight reads as work outstanding; only a
 * delivery is settled, and a cancellation is the one state worth an alarm.
 */
const STATUS_TONE: Record<PoStatus, 'neutral' | 'good' | 'warn' | 'crit' | 'brass'> = {
  draft: 'neutral',
  placed: 'neutral',
  confirmed: 'brass',
  in_production: 'brass',
  shipped: 'brass',
  received: 'good',
  cancelled: 'crit',
};

const label = (s: string) => s.replace(/_/g, ' ');

/** "https://www.houzz.com/pro" → "houzz.com/pro", which is what a person reads. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

// ── Add vendor ──────────────────────────────────────────────

/**
 * Inline rather than a modal, matching "Add person" on Team & roles: the new
 * row appears directly under the form that made it, and nothing covers the
 * directory you are checking against while you type.
 */
function AddVendor({ onDone }: { onDone: () => void }) {
  const add = useCreateVendor();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          {
            name: name.trim(), website: website.trim(), email: email.trim(),
            phone: phone.trim(), contact_name: '', category: category.trim(), notes: notes.trim(),
          },
          {
            onSuccess: () => {
              setName(''); setWebsite(''); setEmail(''); setPhone(''); setCategory(''); setNotes('');
              onDone();
            },
          },
        );
      }}
      className="border-b border-line-soft bg-sunk/30 px-5 py-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Name</span>
          <input
            className="input w-full" required autoFocus value={name}
            onChange={(e) => setName(e.target.value)} placeholder="Houzz"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Website</span>
          <input
            className="input w-full" value={website}
            onChange={(e) => setWebsite(e.target.value)} placeholder="houzz.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Email</span>
          <input
            className="input w-full" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="orders@houzz.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Phone</span>
          <input
            className="input w-full" value={phone}
            onChange={(e) => setPhone(e.target.value)} placeholder="(650) 246-9662"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Category</span>
          <input
            className="input w-full" value={category}
            onChange={(e) => setCategory(e.target.value)} placeholder="Furnishings"
          />
        </label>
        <label className="sm:col-span-2">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Notes</span>
          <input
            className="input w-full" value={notes}
            onChange={(e) => setNotes(e.target.value)} placeholder="Trade account 4471 · net 30"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className="btn-primary btn-sm" disabled={add.isPending || name.trim().length < 2}>
          {add.isPending ? 'Adding…' : 'Add vendor'}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={onDone}>Cancel</button>
      </div>

      {add.isError && <p className="mt-2 text-[12.5px] text-crit">{(add.error as Error).message}</p>}
    </form>
  );
}

// ── Vendor directory ────────────────────────────────────────

function VendorRow({
  v, selected, onSelect,
}: { v: VendorView; selected: boolean; onSelect: () => void }) {
  // Website, category and contact all compete for one subtitle line. Only
  // what exists is shown — the old list printed an em dash under every name
  // whether or not there was anything missing.
  const facts = [v.website ? hostOf(v.website) : '', v.category, v.email].filter(Boolean);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`focusable flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors ${
          selected ? 'bg-brass/10' : 'hover:bg-sunk/50'
        }`}
      >
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-medium text-ink">{v.name}</div>
          {facts.length > 0 && (
            <div className="truncate text-[11.5px] text-ink-faint">{facts.join(' · ')}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {v.openValue > 0 && (
            <span className="tabular-nums text-[12px] text-ink-soft">{money(v.openValue)}</span>
          )}
          {v.openPOs > 0 ? (
            <Pill tone="brass">{v.openPOs} open</Pill>
          ) : (
            <span className="text-[11.5px] text-ink-faint">—</span>
          )}
        </div>
      </button>
    </li>
  );
}

// ── Purchase orders ─────────────────────────────────────────

type SortKey = 'po' | 'vendor' | 'project' | 'status' | 'amount' | 'eta';

function SortHeader({
  col, label: text, align, sort, onSort,
}: {
  col: SortKey; label: string; align?: 'right';
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === col;
  return (
    <th className={`px-5 py-3 font-medium ${align === 'right' ? 'text-right' : ''}`}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`focusable inline-flex items-center gap-1 rounded transition-colors hover:text-ink ${
          active ? 'text-ink' : ''
        }`}
      >
        {text}
        <span className={active ? 'opacity-100' : 'opacity-0'} aria-hidden>
          {sort.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

export default function Vendors() {
  const { data: vendors, isLoading: loadingVendors } = useVendors();
  const { data: pos, isLoading: loadingPos } = usePurchaseOrders();
  const { data: can } = useVendorAbilities();

  const [adding, setAdding] = useState(false);
  const [vendorQuery, setVendorQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [poQuery, setPoQuery] = useState('');
  const [status, setStatus] = useState<PoStatus | 'all' | 'open'>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'amount', dir: 'desc' });

  const shownVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) =>
      [v.name, v.category, v.website, v.email].some((f) => f.toLowerCase().includes(q)),
    );
  }, [vendors, vendorQuery]);

  const selectedVendor = vendors.find((v) => v.id === selected) ?? null;

  const shownPos = useMemo(() => {
    const q = poQuery.trim().toLowerCase();
    const CLOSED: PoStatus[] = ['received', 'cancelled'];
    let rows = pos.filter((o) => {
      if (selected && o.vendorId !== selected) return false;
      if (status === 'open' && CLOSED.includes(o.status)) return false;
      if (status !== 'all' && status !== 'open' && o.status !== status) return false;
      if (q && ![o.po, o.vendor, o.project].some((f) => f.toLowerCase().includes(q))) return false;
      return true;
    });

    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      if (sort.key === 'amount') return (a.amount - b.amount) * dir;
      // A missing date is not "the earliest" — blanks stay at the bottom
      // whichever way the column is pointing, or they bury the real ETAs.
      if (sort.key === 'eta') {
        if (!a.eta !== !b.eta) return a.eta ? -1 : 1;
        return a.eta.localeCompare(b.eta) * dir;
      }
      return String(a[sort.key]).localeCompare(String(b[sort.key])) * dir;
    });
    return rows;
  }, [pos, poQuery, selected, status, sort]);

  // Columns the data cannot fill are left out rather than printed as a wall
  // of em dashes: nothing in this studio sets po_number or project on an
  // ingested order yet, and five columns of "—" told you nothing.
  //
  // Measured over every order, not the filtered set — deriving it from
  // `shownPos` made columns appear and vanish as you typed in the search box.
  const has = (pick: (o: PoView) => string) => pos.some((o) => pick(o).trim() !== '');
  const showPo = has((o) => o.po);
  const showProject = has((o) => o.project);
  const showEta = has((o) => o.eta);
  // Vendor, Status and Amount always render; the other three are conditional.
  const cols = 3 + Number(showPo) + Number(showProject) + Number(showEta);

  // Both panels page: the directory is a long list of names, and a
  // studio that has been ingesting for a season has more orders than
  // fit on a screen. Sorting and filtering apply to everything, the
  // page only decides which slice is drawn.
  const vendorPager = usePager(shownVendors, 12);
  const poPager = usePager(shownPos, 15);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const total = shownPos.reduce((sum, o) => sum + o.amount, 0);

  return (
    <>
      <PageHeading
        title="Vendors & Purchase Orders"
        sub="The vendor directory and every PO — auto-populated from parsed quotes and confirmations."
        action={
          can?.create ? (
            <button onClick={() => setAdding((v) => !v)} className="btn-primary btn-sm">
              {adding ? 'Cancel' : <><IconPlus className="h-3.5 w-3.5" /> Add vendor</>}
            </button>
          ) : undefined
        }
      />

      <div className="grid items-start gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">Vendors</h2>
            <span className="shrink-0 text-[12px] text-ink-faint">
              {shownVendors.length === vendors.length
                ? `${vendors.length} on file`
                : `${shownVendors.length} of ${vendors.length}`}
            </span>
          </div>

          {adding && <AddVendor onDone={() => setAdding(false)} />}

          <div className="border-b border-line-soft px-5 py-3">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                className="input input-sm w-full pl-8"
                value={vendorQuery}
                onChange={(e) => setVendorQuery(e.target.value)}
                placeholder="Search name, site or category"
                aria-label="Search vendors"
              />
            </div>
            {selectedVendor && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="focusable mt-2 rounded text-[12px] text-brass hover:underline"
              >
                Showing orders for {selectedVendor.name} — clear
              </button>
            )}
          </div>

          <ul className="divide-y divide-line-soft">
            {loadingVendors && (
              <li className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</li>
            )}
            {!loadingVendors && vendors.length === 0 && (
              <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
                No vendors yet.
                {can?.create && <> Add the first one above.</>}
              </li>
            )}
            {!loadingVendors && vendors.length > 0 && shownVendors.length === 0 && (
              <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
                Nothing matches “{vendorQuery}”.
              </li>
            )}
            {vendorPager.rows.map((v) => (
              <VendorRow
                key={v.id}
                v={v}
                selected={v.id === selected}
                onSelect={() => setSelected((cur) => (cur === v.id ? null : v.id))}
              />
            ))}
          </ul>

          <Pager {...vendorPager} count={vendorPager.rows.length} noun="vendor" />
        </Card>

        <Card className="lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">
              Purchase orders
              {selectedVendor && <span className="font-normal text-ink-faint"> · {selectedVendor.name}</span>}
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
                <input
                  className="input input-sm w-44 pl-8"
                  value={poQuery}
                  onChange={(e) => setPoQuery(e.target.value)}
                  placeholder="Search orders"
                  aria-label="Search purchase orders"
                />
              </div>
              <select
                className="input input-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value as PoStatus | 'all' | 'open')}
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="open">Open only</option>
                {(Object.keys(STATUS_TONE) as PoStatus[]).map((s) => (
                  <option key={s} value={s}>{label(s)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  {showPo && <SortHeader col="po" label="PO" sort={sort} onSort={onSort} />}
                  <SortHeader col="vendor" label="Vendor" sort={sort} onSort={onSort} />
                  {showProject && <SortHeader col="project" label="Project" sort={sort} onSort={onSort} />}
                  <SortHeader col="status" label="Status" sort={sort} onSort={onSort} />
                  <SortHeader col="amount" label="Amount" align="right" sort={sort} onSort={onSort} />
                  {showEta && <SortHeader col="eta" label="ETA" align="right" sort={sort} onSort={onSort} />}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {loadingPos && (
                  <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
                )}
                {!loadingPos && shownPos.length === 0 && (
                  <tr>
                    <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                      {pos.length === 0 ? 'No purchase orders yet.' : 'No orders match these filters.'}
                    </td>
                  </tr>
                )}
                {poPager.rows.map((o) => (
                  <tr key={o.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                    {showPo && <td className="px-5 py-2.5 text-[13px] font-medium text-ink">{o.po || '—'}</td>}
                    <td className="px-5 py-2.5 font-medium text-ink">{o.vendor || '—'}</td>
                    {showProject && <td className="px-5 py-2.5">{o.project || '—'}</td>}
                    <td className="px-5 py-2.5">
                      <Pill tone={STATUS_TONE[o.status]}>{label(o.status)}</Pill>
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-ink">{money(o.amount)}</td>
                    {showEta && <td className="px-5 py-2.5 text-right tabular-nums">{shortDate(o.eta)}</td>}
                  </tr>
                ))}
              </tbody>
              {shownPos.length > 0 && (
                <tfoot>
                  <tr className="border-t border-line text-[12.5px]">
                    <td className="px-5 py-3 text-ink-faint" colSpan={cols - (showEta ? 2 : 1)}>
                      {shownPos.length} order{shownPos.length > 1 ? 's' : ''}
                      {poPager.pageCount > 1 && ' · all pages'}
                    </td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums text-ink">{money(total)}</td>
                    {showEta && <td />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <Pager {...poPager} count={poPager.rows.length} noun="order" />
        </Card>
      </div>
    </>
  );
}
