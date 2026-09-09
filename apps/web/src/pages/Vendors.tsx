import { PageHeading, Card, Pill, money, shortDate } from '../components/ui';
import { useVendors, usePurchaseOrders } from '../lib/queries';

export default function Vendors() {
  const { data: vendors } = useVendors();
  const { data: pos } = usePurchaseOrders();
  return (
    <>
      <PageHeading
        title="Vendors & Purchase Orders"
        sub="The vendor directory and every PO — auto-populated from parsed quotes and confirmations."
      />

      <div className="grid gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <div className="border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">Vendors</h2>
          </div>
          <ul className="divide-y divide-line-soft">
            {vendors.length === 0 && (
              <li className="px-5 py-8 text-center text-[13px] text-ink-faint">No vendors yet.</li>
            )}
            {vendors.map((v) => (
              <li key={v.id} className="flex items-center justify-between px-5 py-4">
                <div>
                  <div className="text-[14px] font-medium text-ink">{v.name}</div>
                  <div className="text-[11px] uppercase tracking-wide text-ink-faint">{v.category}</div>
                </div>
                <div className="text-right">
                  {v.openPOs > 0 ? (
                    <Pill tone="brass">{v.openPOs} open PO{v.openPOs > 1 ? 's' : ''}</Pill>
                  ) : (
                    <Pill>none open</Pill>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-3">
          <div className="border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">Purchase orders</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  <th className="px-5 py-3 font-medium">PO</th>
                  <th className="px-5 py-3 font-medium">Vendor</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Amount</th>
                  <th className="px-5 py-3 text-right font-medium">ETA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {pos.length === 0 && (
                  <tr><td colSpan={5} className="px-5 py-8 text-center text-[13px] text-ink-faint">No purchase orders yet.</td></tr>
                )}
                {pos.map((o) => (
                  <tr key={o.id} className="text-ink-soft">
                    <td className="px-5 py-3 text-[13px] text-ink">{o.po}</td>
                    <td className="px-5 py-3">{o.vendor}</td>
                    <td className="px-5 py-3">
                      <Pill tone={o.status === 'received' ? 'good' : o.status === 'shipped' ? 'brass' : 'neutral'}>
                        {o.status.replace('_', ' ')}
                      </Pill>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">{money(o.amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{shortDate(o.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
