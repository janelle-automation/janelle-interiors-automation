import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { IconSearch } from './icons';

/**
 * One kit for every list-shaped table: search, filters, sortable headers,
 * rows per page and the pager. Pages used to grow each of these by hand, so
 * one table sorted and another did not, one searched and the next made you
 * scroll — this keeps them behaving alike.
 *
 *   const t = useTable(shown, { sorters, defaultSort: { key: 'when', dir: 'desc' }, storageKey: 'inbox' });
 *   <TableToolbar search={…} filters={…} count={…} />
 *   <SortTh table={t} col="when">When</SortTh>
 *   {t.rows.map(…)}
 *   <TablePager table={t} noun="message" />
 */

export type SortDir = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;
export interface SortState { key: string; dir: SortDir }

export const PAGE_SIZES = [10, 25, 50, 100];

function readSize(storageKey: string | undefined, fallback: number): number {
  if (!storageKey) return fallback;
  try {
    const n = Number(localStorage.getItem(`table.${storageKey}.pageSize`));
    return PAGE_SIZES.includes(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Empty values sort last whichever way the column runs: a dash at the top of
 * an ascending list is never what someone sorting by it wanted to see.
 */
function compare(a: SortValue, b: SortValue): number {
  const emptyA = a === null || a === undefined || a === '';
  const emptyB = b === null || b === undefined || b === '';
  if (emptyA || emptyB) return Number(emptyA) - Number(emptyB);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export function useTable<T>(
  items: T[],
  opts: {
    /** Column key → the value it sorts by. A column without one is not sortable. */
    sorters?: Record<string, (row: T) => SortValue>;
    defaultSort?: SortState | null;
    pageSize?: number;
    /** Remembers rows-per-page for this table, per browser. */
    storageKey?: string;
  } = {},
) {
  const { sorters = {}, defaultSort = null, storageKey } = opts;
  const [sort, setSort] = useState<SortState | null>(defaultSort);
  const [pageSize, setPageSizeState] = useState(() => readSize(storageKey, opts.pageSize ?? 25));
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    const by = sort && sorters[sort.key];
    if (!by) return items;
    const sign = sort.dir === 'asc' ? 1 : -1;
    // Index as the tiebreak keeps equal rows in the order they arrived.
    return items
      .map((row, i) => ({ row, i, v: by(row) }))
      .sort((a, b) => {
        const emptyA = a.v === null || a.v === undefined || a.v === '';
        const emptyB = b.v === null || b.v === undefined || b.v === '';
        if (emptyA !== emptyB) return emptyA ? 1 : -1;
        return sign * compare(a.v, b.v) || a.i - b.i;
      })
      .map((x) => x.row);
    // sorters is rebuilt each render by callers; the key and items decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [page, current]);
  const start = (current - 1) * pageSize;

  return {
    rows: sorted.slice(start, start + pageSize),
    /** Every row in display order — for finding which page holds a given one. */
    sorted,
    sort,
    sortable: (col: string) => Boolean(sorters[col]),
    /** First click sorts ascending (descending for numbers and dates is the caller's defaultSort), second flips. */
    toggleSort: (col: string) => {
      setSort((s) => (s?.key === col ? { key: col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: col, dir: 'asc' }));
      setPage(1);
    },
    page: current,
    setPage,
    pageCount,
    pageSize,
    setPageSize: (n: number) => {
      setPageSizeState(n);
      setPage(1);
      if (storageKey) {
        try {
          localStorage.setItem(`table.${storageKey}.pageSize`, String(n));
        } catch {
          /* private window — the choice just isn't remembered */
        }
      }
    },
    start,
    total: sorted.length,
  };
}

export type TableState = ReturnType<typeof useTable<unknown>>;

/** A header cell that sorts its column. Plain `<th>` styling when the column has no sorter. */
export function SortTh({
  table, col, children, align = 'left', className = '',
}: {
  table: Pick<TableState, 'sort' | 'sortable' | 'toggleSort'>;
  col: string;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const active = table.sort?.key === col ? table.sort.dir : null;
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  if (!table.sortable(col)) return <th className={`${alignCls} ${className}`}>{children}</th>;
  return (
    <th
      className={`${alignCls} ${className}`}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        onClick={() => table.toggleSort(col)}
        className={`focusable group inline-flex items-center gap-1 rounded uppercase tracking-[inherit] transition-colors hover:text-ink ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-ink' : ''}`}
        title={`Sort by ${typeof children === 'string' ? children.toLowerCase() : 'this column'}`}
      >
        <span>{children}</span>
        <SortArrow dir={active} />
      </button>
    </th>
  );
}

function SortArrow({ dir }: { dir: SortDir | null }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
      className={`shrink-0 transition-opacity ${dir ? 'opacity-100 text-brass' : 'opacity-0 group-hover:opacity-60'}`}
    >
      <path d="M5 1.5 L8 4.5 H2 Z" fill="currentColor" opacity={dir === 'desc' ? 0.3 : 1} />
      <path d="M5 8.5 L2 5.5 H8 Z" fill="currentColor" opacity={dir === 'asc' ? 0.3 : 1} />
    </svg>
  );
}

/** Search box with a clear button; Escape clears it too. */
export function SearchInput({
  value, onChange, placeholder = 'Search', label, className = 'w-full sm:w-72',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        className="input input-sm w-full pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="focusable absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-ink-faint hover:bg-sunk hover:text-ink"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A filter dropdown. Highlighted while it is narrowing the list, so an active filter is never missed. */
export function FilterSelect({
  value, onChange, options, label, allValue = 'all',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  allValue?: string;
}) {
  const active = value !== allValue;
  return (
    <select
      className={`input input-sm w-auto max-w-[220px] ${active ? 'border-brass/60 bg-brass/10 text-ink' : ''}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/**
 * The bar above a table: search on the left, filters beside it, and on the
 * right how many rows match — with one click to undo every filter at once.
 */
export function TableToolbar({
  search, filters, shown, total, noun = 'row', onClear, actions,
}: {
  search?: ReactNode;
  filters?: ReactNode;
  shown: number;
  total: number;
  noun?: string;
  /** Present when something is narrowing the list; clears search and filters. */
  onClear?: (() => void) | null;
  actions?: ReactNode;
}) {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-5 py-3">
      {search}
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      <div className="ml-auto flex items-center gap-3">
        {onClear && (
          <button type="button" onClick={onClear} className="focusable rounded text-[12.5px] font-medium text-brass-deep hover:underline">
            Clear filters
          </button>
        )}
        <span className="whitespace-nowrap text-[12px] tabular-nums text-ink-faint">
          {shown === total ? plural(total) : `${shown} of ${plural(total)}`}
        </span>
        {actions}
      </div>
    </div>
  );
}

/** 1 … 4 5 6 … 12 — always the ends, always the neighbours, never a wall of numbers. */
function pageWindow(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const from = Math.max(2, Math.min(page - 1, pageCount - 4));
  const to = Math.min(pageCount - 1, Math.max(page + 1, 5));
  if (from > 2) out.push('…');
  for (let i = from; i <= to; i++) out.push(i);
  if (to < pageCount - 1) out.push('…');
  out.push(pageCount);
  return out;
}

const pagerBtn =
  'focusable grid h-7 min-w-[28px] place-items-center rounded-lg px-2 text-[12.5px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-35';

/**
 * The footer under a table: rows per page, which rows are showing, and the
 * page buttons. Hidden only when the list is too short to page at any size.
 */
export function TablePager({ table, noun = 'row' }: { table: TableState; noun?: string }) {
  const { page, pageCount, setPage, start, rows, total, pageSize, setPageSize } = table;
  if (total <= PAGE_SIZES[0]) return null;
  const last = start + rows.length;
  const go = (p: number) => setPage(Math.min(pageCount, Math.max(1, p)));

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-line-soft px-5 py-2.5">
      <div className="flex items-center gap-4 text-[12px] text-ink-faint">
        <label className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            className="input input-sm h-7 w-auto py-0 pl-2 pr-7 text-[12.5px]"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <span className="tabular-nums">
          {total === 0 ? `0 ${noun}s` : `${start + 1}–${last} of ${total} ${noun}${total === 1 ? '' : 's'}`}
        </span>
      </div>
      {pageCount > 1 && (
        <nav className="flex items-center gap-0.5" aria-label="Pages">
          <button type="button" onClick={() => go(1)} disabled={page === 1} className={`${pagerBtn} text-ink-soft hover:bg-sunk hover:text-ink`} aria-label="First page">«</button>
          <button type="button" onClick={() => go(page - 1)} disabled={page === 1} className={`${pagerBtn} text-ink-soft hover:bg-sunk hover:text-ink`} aria-label="Previous page">‹</button>
          {pageWindow(page, pageCount).map((p, i) =>
            p === '…' ? (
              <span key={`gap${i}`} className="px-1 text-[12.5px] text-ink-faint">…</span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => go(p)}
                aria-current={p === page ? 'page' : undefined}
                className={`${pagerBtn} ${p === page ? 'bg-brass font-semibold text-white' : 'text-ink-soft hover:bg-sunk hover:text-ink'}`}
              >
                {p}
              </button>
            ),
          )}
          <button type="button" onClick={() => go(page + 1)} disabled={page === pageCount} className={`${pagerBtn} text-ink-soft hover:bg-sunk hover:text-ink`} aria-label="Next page">›</button>
          <button type="button" onClick={() => go(pageCount)} disabled={page === pageCount} className={`${pagerBtn} text-ink-soft hover:bg-sunk hover:text-ink`} aria-label="Last page">»</button>
        </nav>
      )}
    </div>
  );
}

/** Lower-cased haystack match across several fields — the search every table does. */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}
