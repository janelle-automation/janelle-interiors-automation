import { useMemo, useState } from 'react';
import type { PoStatus } from '@janelle/shared';
import { Card, Pill, money, shortDate } from './ui';
import { useTable, SortTh, SearchInput, FilterSelect, TableToolbar, TablePager, matches } from './table';
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
  const [vendor, setVendor] = useState('all');
  const [project, setProject] = useState('all');

  const CLOSED: PoStatus[] = ['received', 'cancelled'];
  const shown = useMemo(
    () =>
      orders.filter((o) => {
        if (status === 'open' && CLOSED.includes(o.status)) return false;
        if (status !== 'all' && status !== 'open' && o.status !== status) return false;
        if (vendor !== 'all' && o.vendor !== vendor) return false;
        if (project !== 'all' && o.project !== project) return false;
        return matches(query, o.po, o.vendor, o.project);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, query, status, vendor, project],
  );

  // Counts follow the list this panel was given, not the search box, which
  // would make them flicker as you type.
  const statusOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [{ value: 'all', label: `All statuses (${orders.length})` }];
    // "Open" is only worth offering when it narrows something: with nothing
    // received or cancelled it is the same list as "All" under another name.
    const open = orders.filter((o) => !CLOSED.includes(o.status)).length;
    if (open !== orders.length) out.push({ value: 'open', label: `Open (${open})` });
    for (const st of Object.keys(STATUS_TONE) as PoStatus[]) {
      const n = orders.filter((o) => o.status === st).length;
      if (n > 0) out.push({ value: st, label: `${label(st).replace(/^./, (c) => c.toUpperCase())} (${n})` });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders]);
  const distinct = (pick: (o: PoView) => string) =>
    [...new Set(orders.map(pick).filter((v) => v.trim() !== ''))].sort((x, y) => x.localeCompare(y));
  const vendors = useMemo(() => distinct((o) => o.vendor), [orders]); // eslint-disable-line react-hooks/exhaustive-deps
  const projects = useMemo(() => distinct((o) => o.project), [orders]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const pager = useTable(shown, {
    storageKey: 'orders',
    pageSize: 25,
    defaultSort: { key: 'amount', dir: 'desc' },
    sorters: {
      po: (o) => o.po,
      vendor: (o) => o.vendor,
      project: (o) => o.project,
      status: (o) => label(o.status),
      amount: (o) => o.amount,
      // Blanks stay at the bottom whichever way the column points (the kit's rule).
      eta: (o) => o.eta,
    },
  });
  const total = shown.reduce((sum, o) => sum + o.amount, 0);
  const filtering = Boolean(query.trim()) || status !== 'all' || vendor !== 'all' || project !== 'all';
  const clearFilters = () => {
    setQuery('');
    setStatus('all');
    setVendor('all');
    setProject('all');
  };

  return (
    <Card>
      <div className="border-b border-line-soft px-5 py-4">
        <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      </div>

      <TableToolbar
        search={<SearchInput value={query} onChange={setQuery} placeholder="Search PO, vendor or project" label="Search orders" />}
        filters={
          orders.length > 0 && (
            <>
              <FilterSelect
                label="Filter by status"
                value={status}
                onChange={(v) => setStatus(v as PoStatus | 'all' | 'open')}
                options={statusOptions}
              />
              {showVendor && vendors.length > 1 && (
                <FilterSelect
                  label="Filter by vendor"
                  value={vendor}
                  onChange={setVendor}
                  options={[{ value: 'all', label: 'All vendors' }, ...vendors.map((v) => ({ value: v, label: v }))]}
                />
              )}
              {projects.length > 1 && (
                <FilterSelect
                  label="Filter by project"
                  value={project}
                  onChange={setProject}
                  options={[{ value: 'all', label: 'All projects' }, ...projects.map((v) => ({ value: v, label: v }))]}
                />
              )}
            </>
          )
        }
        shown={shown.length}
        total={orders.length}
        noun="order"
        onClear={filtering ? clearFilters : null}
      />

      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
              {showPo && <SortTh table={pager} col="po" className="px-5 py-3 font-medium">PO</SortTh>}
              {showVendor && <SortTh table={pager} col="vendor" className="px-5 py-3 font-medium">Vendor</SortTh>}
              {showProject && <SortTh table={pager} col="project" className="px-5 py-3 font-medium">Project</SortTh>}
              <SortTh table={pager} col="status" className="px-5 py-3 font-medium">Status</SortTh>
              <SortTh table={pager} col="amount" align="right" className="px-5 py-3 font-medium">Amount</SortTh>
              {showEta && <SortTh table={pager} col="eta" align="right" className="px-5 py-3 font-medium">ETA</SortTh>}
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

      <TablePager table={pager} noun="order" />
    </Card>
  );
}
