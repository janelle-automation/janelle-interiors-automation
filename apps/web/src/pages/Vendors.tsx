import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Page, PageHeading, Card, Pill, money, usePager, Pager } from '../components/ui';
import { OrdersPanel } from '../components/OrdersPanel';
import { IconSearch, IconPlus } from '../components/icons';
import {
  useVendors, usePurchaseOrders, useCreateVendor, useVendorAbilities,
  type VendorView,
} from '../lib/queries';

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

/**
 * One vendor, as a row that opens their page.
 *
 * The whole row is the target and the name inside it is a real link, so it
 * works with a mouse, a keyboard and a screen reader alike. "View orders ›"
 * is spelled out on the right, because a row that merely looks clickable is
 * how the old page left people not knowing it was.
 */
function VendorRow({ v }: { v: VendorView }) {
  const navigate = useNavigate();
  // Website, category and contact all compete for one subtitle line. Only
  // what exists is shown — an em dash under every name told you nothing.
  const facts = [v.website ? hostOf(v.website) : '', v.category, v.email].filter(Boolean);

  return (
    <tr
      onClick={() => navigate(`/vendors/${v.id}`)}
      className="cursor-pointer text-ink-soft transition-colors hover:bg-sunk/50"
    >
      <td className="px-5 py-3">
        <Link
          to={`/vendors/${v.id}`}
          onClick={(e) => e.stopPropagation()}
          className="focusable rounded text-[14px] font-medium text-ink hover:underline"
        >
          {v.name}
        </Link>
        {facts.length > 0 && <div className="truncate text-[12px] text-ink-faint">{facts.join(' · ')}</div>}
      </td>
      <td className="whitespace-nowrap px-5 py-3 text-right">
        {v.openPOs > 0 ? <Pill tone="brass">{v.openPOs} open</Pill> : <span className="text-[12px] text-ink-faint">None open</span>}
      </td>
      <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-ink">
        {v.openValue > 0 ? money(v.openValue) : <span className="text-ink-faint">—</span>}
      </td>
      <td className="whitespace-nowrap px-5 py-3 text-right text-[12.5px] text-brass">View orders ›</td>
    </tr>
  );
}

function VendorDirectory({ canCreate }: { canCreate: boolean }) {
  const { data: vendors, isLoading } = useVendors();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => [v.name, v.category, v.website, v.email].some((f) => f.toLowerCase().includes(q)));
  }, [vendors, query]);

  // A studio that has been ingesting for a season has dozens of vendors;
  // sorting and search apply to all of them, the page only picks the slice.
  const pager = usePager(shown, 15);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">Vendors</h2>
          <p className="text-[12.5px] text-ink-soft">
            {shown.length === vendors.length ? `${vendors.length} on file` : `${shown.length} of ${vendors.length}`} · select one to see
            their orders
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              className="input input-sm w-64 pl-8"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, site or category"
              aria-label="Search vendors"
            />
          </div>
          {canCreate && (
            <button onClick={() => setAdding((v) => !v)} className="btn-primary btn-sm">
              {adding ? 'Cancel' : <><IconPlus className="h-3.5 w-3.5" /> Add vendor</>}
            </button>
          )}
        </div>
      </div>

      {adding && <AddVendor onDone={() => setAdding(false)} />}

      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
              <th className="px-5 py-3 font-medium">Vendor</th>
              <th className="px-5 py-3 text-right font-medium">Open orders</th>
              <th className="px-5 py-3 text-right font-medium">Open value</th>
              <th className="px-5 py-3"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {isLoading && <tr><td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td></tr>}
            {!isLoading && vendors.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                  No vendors yet.{canCreate && <> Use “Add vendor” above to add the first one.</>}
                </td>
              </tr>
            )}
            {!isLoading && vendors.length > 0 && shown.length === 0 && (
              <tr><td colSpan={4} className="px-5 py-10 text-center text-[13px] text-ink-faint">Nothing matches “{query}”.</td></tr>
            )}
            {pager.rows.map((v) => <VendorRow key={v.id} v={v} />)}
          </tbody>
        </table>
      </div>

      <Pager {...pager} count={pager.rows.length} noun="vendor" />
    </Card>
  );
}

export default function Vendors() {
  const { data: pos, isLoading: loadingPos } = usePurchaseOrders();
  const { data: can } = useVendorAbilities();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'orders' ? 'orders' : 'vendors';

  const tabs: { id: 'vendors' | 'orders'; text: string }[] = [
    { id: 'vendors', text: 'By vendor' },
    { id: 'orders', text: 'All orders' },
  ];

  return (
    <Page>
      <PageHeading title="Vendors & Orders" />

      <div role="tablist" aria-label="View" className="mb-5 flex gap-1 border-b border-line-soft">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={view === t.id}
            onClick={() => setParams(t.id === 'vendors' ? {} : { view: t.id })}
            className={`focusable -mb-px border-b-2 px-4 py-2.5 text-[14px] transition-colors ${
              view === t.id ? 'border-brass font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t.text}
          </button>
        ))}
      </div>

      {view === 'vendors' ? (
        <VendorDirectory canCreate={Boolean(can?.create)} />
      ) : (
        <OrdersPanel
          orders={pos}
          loading={loadingPos}
          showVendor
          title="Orders & quotes — every vendor"
          emptyText="No orders yet. They appear here when a vendor’s quote or confirmation arrives by email."
        />
      )}
    </Page>
  );
}
