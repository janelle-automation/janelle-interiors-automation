import { Link, useParams } from 'react-router-dom';
import { Page, PageHeading, Card, Pill, money } from '../components/ui';
import { OrdersPanel } from '../components/OrdersPanel';
import { useVendors, usePurchaseOrders } from '../lib/queries';

/** "https://www.houzz.com/pro" → "houzz.com/pro", which is what a person reads. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
  } catch {
    return url;
  }
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface px-4 py-3">
      <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular-nums leading-tight text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-[12px] text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * One vendor and every order with them.
 *
 * The orders used to share a screen with the directory, filtered by clicking a
 * name — which nothing on the page said, and which left the vendor's own
 * details nowhere. A vendor now has an address of its own: who they are, what
 * is outstanding with them, and the full list of orders, with the whole page
 * to read it in.
 */
export default function VendorDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: vendors, isLoading: loadingVendors } = useVendors();
  const { data: pos, isLoading: loadingPos } = usePurchaseOrders();

  const vendor = vendors.find((v) => v.id === id) ?? null;
  const orders = pos.filter((o) => o.vendorId === id);
  const allValue = orders.reduce((sum, o) => sum + o.amount, 0);

  const back = (
    <Link to="/vendors" className="focusable mb-3 inline-flex items-center gap-1 rounded text-[13px] text-brass hover:underline">
      <span aria-hidden>←</span> All vendors
    </Link>
  );

  if (loadingVendors) {
    return (
      <Page>
        {back}
        <p className="text-[13px] text-ink-faint">Loading…</p>
      </Page>
    );
  }

  if (!vendor) {
    return (
      <Page>
        {back}
        <Card>
          <div className="px-5 py-10 text-center">
            <p className="text-[15px] font-semibold text-ink">We couldn’t find that vendor</p>
            <p className="mt-1 text-[13px] text-ink-soft">It may have been removed or merged with another. Pick one from the list.</p>
            <Link to="/vendors" className="btn-primary btn-sm mt-4 inline-flex">Back to all vendors</Link>
          </div>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      {back}
      <PageHeading title={vendor.name} />

      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-ink-soft">
        {vendor.category && <Pill tone="neutral">{vendor.category}</Pill>}
        {vendor.website && (
          <a href={vendor.website} target="_blank" rel="noreferrer" className="focusable rounded text-brass hover:underline">
            {hostOf(vendor.website)} ↗
          </a>
        )}
        {vendor.email && (
          <a href={`mailto:${vendor.email}`} className="focusable rounded text-brass hover:underline">
            {vendor.email}
          </a>
        )}
        {!vendor.category && !vendor.website && !vendor.email && (
          <span className="text-ink-faint">No contact details on file yet — they fill in from this vendor’s emails.</span>
        )}
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open orders" value={String(vendor.openPOs)} hint={vendor.openPOs ? 'Not yet received or cancelled' : 'Nothing outstanding'} />
        <Stat label="Open value" value={money(vendor.openValue)} />
        <Stat label="All orders" value={String(orders.length)} />
        <Stat label="Total value" value={money(allValue)} hint="Across every order" />
      </div>

      <OrdersPanel
        orders={orders}
        loading={loadingPos}
        showVendor={false}
        title={`Orders with ${vendor.name}`}
        emptyText={`No orders with ${vendor.name} yet. They appear here when a quote or confirmation arrives by email.`}
      />
    </Page>
  );
}
