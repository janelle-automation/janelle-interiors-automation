import { useMemo, useState } from 'react';
import type { PoStatus } from '@janelle/shared';
import { Card, Pill, money, shortDate, usePager, Pager } from './ui';
import { IconSearch } from './icons';
import type { PoView } from '../lib/queries';

/**
 * Orders move draft → placed → confirmed → in production → shipped →
 * received. Anything still in flight reads as work outstanding; only a
 * delivery is settled, and a cancellation is the one state worth an alarm.
 */
export const STATUS_TONE: Record<PoStatus, 'neutral' | 'good' | 'warn' | 'crit' | 'brass'> = {
  draft: 'neutral',
  placed: 'neutral',
  confirmed: 'brass',
  in_production: 'brass',
  shipped: 'brass',
  received: 'good',
  cancelled: 'crit',
};

const label = (s: string) => s.replace(/_/g, ' ');

type SortKey = 'po' | 'vendor' | 'project' | 'status' | 'amount' | 'eta';
type Sort = { key: SortKey; dir: 'asc' | 'desc' };

function SortHeader({
  col, label: text, align, sort, onSort,
}: {
  col: SortKey; label: string; align?: 'right';
  sort: Sort;
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === col;
  return (
    <th
      className={`px-5 py-3 font-medium ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`focusable inline-flex items-center gap-1 rounded transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}
      >
        {text}
        <span className={active ? 'opacity-100' : 'opacity-40'} aria-hidden>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * A list of orders: search, status filter, sortable columns, paging and a
 * total. Used for one vendor's orders on their own page and for every order on
 * the "All orders" tab, so the two behave identically and a fix lands in both.
 *
 * `showVendor` is off on a vendor's page, where a column repeating the same
 * name down every row is noise.
 */
export function OrdersPanel({
  orders,
  loading,
  showVendor,
  title = 'Orders & quotes',
  emptyText = 'No orders yet.',
}: {
  orders: PoView[];
  loading: boolean;
  showVendor: boolean;
  title?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<PoStatus | 'all' | 'open'>('all');
  const [sort, setSort] = useState<Sort>({ key: 'amount', dir: 'desc' });

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const CLOSED: PoStatus[] = ['received', 'cancelled'];
    let rows = orders.filter((o) => {
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
  }, [orders, query, status, sort]);

  // Counts follow the list this panel was given, not the search box, which
  // would make them flicker as you type.
  const chips = useMemo(() => {
    const CLOSED: PoStatus[] = ['received', 'cancelled'];
    const out: { id: PoStatus | 'all' | 'open'; text: string; n: number }[] = [{ id: 'all', text: 'All', n: orders.length }];
    // "Open" is only worth a chip when it narrows something: with nothing
    // received or cancelled it is the same list as "All" under another name.
    const open = orders.filter((o) => !CLOSED.includes(o.status)).length;
    if (open !== orders.length) out.push({ id: 'open', text: 'Open', n: open });
    for (const st of Object.keys(STATUS_TONE) as PoStatus[]) {
      const n = orders.filter((o) => o.status === st).length;
      if (n > 0) out.push({ id: st, text: label(st), n });
    }
    return out;
  }, [orders]);

  // A column needs a quarter of the orders to have a value, not just one: with
  // 7 numbered orders in 95, a PO column was 88 rows of nothing around 7 of
  // something. Below that the value moves into the row, so it is still there
  // when it exists and takes no room when it does not.
  const share = (pick: (o: PoView) => string) =>
    orders.length ? orders.filter((o) => pick(o).trim() !== '').length / orders.length : 0;
  const showPo = share((o) => o.po) >= 0.25;
  const showProject = share((o) => o.project) >= 0.25;
  const showEta = share((o) => o.eta) >= 0.25;
  // Status and Amount always render; the others are conditional.
  const cols = 2 + Number(showVendor) + Number(showPo) + Number(showProject) + Number(showEta);

  const pager = usePager(shown, 15);
  const total = shown.reduce((sum, o) => sum + o.amount, 0);
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
        <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            className="input input-sm w-52 pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search orders"
            aria-label="Search orders"
          />
        </div>
      </div>

      {orders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-3">
          <span className="text-[12px] text-ink-faint" id="status-filter-label">Status</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="status-filter-label">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={status === c.id}
                onClick={() => setStatus(c.id)}
                className={`focusable inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
                  status === c.id
                    ? 'border-brass/40 bg-brass/15 font-medium text-ink'
                    : 'border-line text-ink-soft hover:bg-sunk/60 hover:text-ink'
                }`}
              >
                <span className="capitalize">{c.text}</span>
                <span className="tabular-nums text-ink-faint">{c.n}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
              {showPo && <SortHeader col="po" label="PO" sort={sort} onSort={onSort} />}
              {showVendor && <SortHeader col="vendor" label="Vendor" sort={sort} onSort={onSort} />}
              {showProject && <SortHeader col="project" label="Project" sort={sort} onSort={onSort} />}
              <SortHeader col="status" label="Status" sort={sort} onSort={onSort} />
              <SortHeader col="amount" label="Amount" align="right" sort={sort} onSort={onSort} />
              {showEta && <SortHeader col="eta" label="ETA" align="right" sort={sort} onSort={onSort} />}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {loading && (
              <tr><td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>
            )}
            {!loading && shown.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                  {orders.length === 0 ? emptyText : 'No orders match these filters.'}
                </td>
              </tr>
            )}
            {pager.rows.map((o) => (
              <tr key={o.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                {showPo && (
                  <td className="whitespace-nowrap px-5 py-2.5 text-[13px] font-medium text-ink">
                    {o.po || <span className="font-normal text-ink-faint">—</span>}
                  </td>
                )}
                {showVendor && (
                  <td className="px-5 py-2.5 font-medium text-ink">
                    {o.vendor || <span className="font-normal text-ink-faint">Unknown vendor</span>}
                    {!showPo && o.po && <div className="text-[11.5px] font-normal text-ink-faint">PO {o.po}</div>}
                  </td>
                )}
                {showProject && (
                  <td className="px-5 py-2.5">
                    {o.project || <span className="text-ink-faint">—</span>}
                    {!showVendor && !showPo && o.po && <div className="text-[11.5px] text-ink-faint">PO {o.po}</div>}
                  </td>
                )}
                <td className="px-5 py-2.5">
                  <Pill tone={STATUS_TONE[o.status]}>
                    <span className="capitalize">{label(o.status)}</span>
                  </Pill>
                  {!showEta && o.eta && <div className="mt-1 text-[11.5px] text-ink-faint">ETA {shortDate(o.eta)}</div>}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-ink">{money(o.amount)}</td>
                {showEta && (
                  <td className="whitespace-nowrap px-5 py-2.5 text-right tabular-nums">
                    {o.eta ? shortDate(o.eta) : <span className="text-ink-faint">—</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          {shown.length > 0 && (
            <tfoot>
              <tr className="border-t border-line text-[12.5px]">
                <td className="px-5 py-3 text-ink-faint" colSpan={cols - (showEta ? 2 : 1)}>
                  Total value of {shown.length} order{shown.length > 1 ? 's' : ''}
                  {pager.pageCount > 1 && ' (every page, not just this one)'}
                </td>
                <td className="px-5 py-3 text-right font-semibold tabular-nums text-ink">{money(total)}</td>
                {showEta && <td />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <Pager {...pager} count={pager.rows.length} noun="order" />
    </Card>
  );
}
