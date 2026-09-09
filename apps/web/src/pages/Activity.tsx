import { PageHeading, Card } from '../components/ui';
import { useActivity } from '../lib/queries';

const actionLabel: Record<string, string> = {
  'ingest.run': 'Read Gmail & Drive',
  'followups.run': 'Ran follow-up engine',
  'report.generate': 'Generated weekly report',
  'draft.create': 'Created a Gmail draft',
};

export default function Activity() {
  const { data: rows } = useActivity();
  return (
    <>
      <PageHeading
        eyebrow="Trust · Transparency"
        title="Audit Log"
        sub="A record of everything the system read, extracted and drafted."
      />
      <Card>
        <ol className="divide-y divide-line-soft">
          {rows.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">No activity recorded yet.</li>
          )}
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-4 px-5 py-3.5">
              <span className="h-2 w-2 shrink-0 rounded-full bg-brass" />
              <div className="min-w-0 flex-1">
                <span className="text-[14px] font-medium text-ink">{actionLabel[r.action] ?? r.action}</span>
                {r.detail && <span className="ml-2 text-[13px] text-ink-soft">{r.detail}</span>}
              </div>
              <span className="whitespace-nowrap text-[11px] text-ink-faint">{r.when}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
