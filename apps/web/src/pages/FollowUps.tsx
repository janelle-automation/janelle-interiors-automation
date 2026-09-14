import { Link } from 'react-router-dom';
import { PageHeading, Card, Pill } from '../components/ui';
import { useFollowUps, useOps, useFollowUpStatus } from '../lib/queries';

const tone: Record<string, 'crit' | 'warn' | 'brass'> = {
  vendor_silence: 'warn',
  client_approval_overdue: 'crit',
  date_slipping: 'crit',
  spec_gap: 'brass',
  quote_overdue: 'crit',
  client_waiting: 'crit',
  task_overdue: 'warn',
  task_escalation: 'crit',
};
const label: Record<string, string> = {
  vendor_silence: 'Vendor silent',
  client_approval_overdue: 'Approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
  quote_overdue: 'Quote overdue',
  client_waiting: 'Client waiting',
  task_overdue: 'Reminder sent',
  task_escalation: 'Escalated',
};

export default function FollowUps() {
  const { data: followUps } = useFollowUps();
  const { followUps: runFollowUps } = useOps();
  const setStatus = useFollowUpStatus();

  return (
    <>
      <PageHeading
        title="Follow-up Inbox"
        sub="The nightly engine drafts each nudge here. You review, edit in Gmail, and send. Nothing is auto-sent."
        action={
          <button
            onClick={() => runFollowUps.mutate()}
            disabled={runFollowUps.isPending}
            className="btn-secondary btn-sm"
          >
            {runFollowUps.isPending ? 'Checking…' : 'Run follow-ups now'}
          </button>
        }
      />

      <Card>
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <h2 className="text-[16px] font-semibold text-ink">Awaiting your review</h2>
          <span className="text-[12px] text-ink-faint">{followUps.length} open</span>
        </div>
        <ul className="divide-y divide-line-soft">
          {followUps.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
              No open follow-ups. Run the engine to check for vendor silence, overdue approvals and slipping dates.
            </li>
          )}
          {followUps.map((f) => (
            <li key={f.id} className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3 sm:w-44">
                <Pill tone={tone[f.type]}>{label[f.type]}</Pill>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">{f.who}</div>
                <div className="text-[13px] text-ink-soft">{f.reason}</div>
                <div className="mt-0.5 text-[11px] text-ink-faint">{f.project} · quiet {f.age}</div>
              </div>
              <div className="flex items-center gap-2 self-start sm:self-auto">
                <button
                  onClick={() => setStatus.mutate({ id: f.id, status: 'done' })}
                  className="btn-primary btn-sm"
                >
                  Done
                </button>
                <button
                  onClick={() => setStatus.mutate({ id: f.id, status: 'dismissed' })}
                  className="btn-secondary btn-sm"
                >
                  Dismiss
                </button>
                <Link
                  to="/drafts"
                  className="btn-secondary btn-sm text-brass-deep"
                >
                  View draft
                </Link>
              </div>
            </li>
          ))}
        </ul>
        <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
          Nothing is auto-sent. Every message here is a draft a person approves.
        </div>
      </Card>
    </>
  );
}
