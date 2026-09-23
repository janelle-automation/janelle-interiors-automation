import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, PageHeading, Card, Pill } from '../components/ui';
import { useFollowUps, useOps, useFollowUpStatus, useSnoozeFollowUp, useTeam, type FollowUpView } from '../lib/queries';
import { ScopeToggle, useScope } from '../components/ScopeToggle';
import { useAuth } from '../context/AuthContext';

const tone: Record<string, 'crit' | 'warn' | 'brass'> = {
  vendor_silence: 'warn',
  client_approval_overdue: 'crit',
  date_slipping: 'crit',
  spec_gap: 'brass',
  quote_overdue: 'crit',
  client_waiting: 'crit',
  task_overdue: 'warn',
  task_escalation: 'crit',
  task_unowned: 'warn',
  task_no_next_step: 'brass',
  task_no_due_date: 'brass',
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
  task_unowned: 'No owner',
  task_no_next_step: 'No next step',
  task_no_due_date: 'No due date',
};

/** The choices offered for putting a nudge down, in the words people use. */
const SNOOZE = [
  { days: 3, label: '3 days' },
  { days: 7, label: 'A week' },
  { days: 14, label: 'Two weeks' },
];

function SnoozeMenu({ onPick, busy }: { onPick: (days: number) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-secondary btn-sm"
      >
        Snooze
      </button>
      {open && (
        <>
          {/* Clicking anywhere else puts the menu away, without a listener
              on the document that would fight the button's own click. */}
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <span
            role="menu"
            className="popover absolute right-0 top-full z-20 mt-1 flex w-36 flex-col overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop"
          >
            {SNOOZE.map((s) => (
              <button
                key={s.days}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(s.days);
                }}
                className="focusable px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-sunk"
              >
                {s.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

function Row({ f }: { f: FollowUpView }) {
  const setStatus = useFollowUpStatus();
  const snooze = useSnoozeFollowUp();
  const busy = setStatus.isPending || snooze.isPending;

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="sm:w-40">
        <Pill tone={tone[f.type]}>{label[f.type]}</Pill>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink-soft">{f.reason}</div>
        <div className="mt-0.5 text-[11px] text-ink-faint">
          {f.project} · quiet {f.age}
        </div>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <button
          onClick={() => setStatus.mutate({ id: f.id, status: 'done' })}
          disabled={busy}
          className="btn-primary btn-sm"
        >
          Done
        </button>
        <SnoozeMenu busy={busy} onPick={(days) => snooze.mutate({ id: f.id, days })} />
        <button
          onClick={() => setStatus.mutate({ id: f.id, status: 'dismissed' })}
          disabled={busy}
          className="btn-ghost btn-sm"
        >
          Dismiss
        </button>
        <Link to="/drafts" className="btn-secondary btn-sm text-brass-deep">
          Draft
        </Link>
      </div>
    </li>
  );
}

export default function FollowUps() {
  const { data: all } = useFollowUps();
  const { followUps: runFollowUps } = useOps();
  const [scope] = useScope();
  const { user } = useAuth();
  const { data: team } = useTeam();

  // Which addresses belong to a person here, so a nudge aimed at a vendor
  // can be told apart from one aimed at a colleague.
  const teamAddresses = useMemo(
    () => new Set(team.map((m) => (m.email ?? '').trim().toLowerCase()).filter(Boolean)),
    [team],
  );

  /**
   * A nudge is somebody else's only when it demonstrably is.
   *
   * The internal types are addressed to a teammate, and the rest chase a
   * task somebody owns. Everything left — a silent vendor, an approval
   * nobody has picked up — belongs to no one in particular, and hiding it
   * from "Mine" would mean the work nobody owns is the work nobody sees.
   * Same rule as the task board, where unassigned cards stay in view.
   */
  const myEmail = (user?.email ?? '').trim().toLowerCase();
  const isMine = (f: FollowUpView) => {
    if (f.taskAssignee) return f.taskAssignee === user?.id;
    const target = (f.target ?? '').trim().toLowerCase();
    if (!target) return true;
    if (target === myEmail) return true;
    // Addressed to another person here: theirs. Addressed to a vendor or a
    // client: nobody's, so it stays.
    return !teamAddresses.has(target);
  };

  const followUps = scope === 'mine' ? all.filter(isMine) : all;

  /**
   * One card per person being chased, not one row per nudge.
   *
   * The queue listed every nudge separately, so a vendor who was silent on
   * three orders appeared three times in a row — and the studio had to read
   * all three to work out it was one conversation with one person. Grouping
   * says the true shape of the work: five names to chase, not fourteen rows
   * to get through.
   */
  const groups = useMemo(() => {
    const by = new Map<string, FollowUpView[]>();
    for (const f of followUps) {
      const list = by.get(f.who);
      if (list) list.push(f);
      else by.set(f.who, [f]);
    }
    // Whoever has the most waiting on them comes first: that is where a
    // single message clears the most.
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [followUps]);

  return (
    <Page>
      <PageHeading
        title="Follow-up Inbox"
        action={
          <div className="flex items-center gap-2">
            <ScopeToggle mine={all.filter(isMine).length} all={all.length} />
            <button
              onClick={() => runFollowUps.mutate()}
              disabled={runFollowUps.isPending}
              className="btn-secondary btn-sm"
            >
              {runFollowUps.isPending ? 'Checking…' : 'Run follow-ups now'}
            </button>
          </div>
        }
      />

      <Card>
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <h2 className="text-[16px] font-semibold text-ink">Awaiting your review</h2>
          <span className="text-[12px] text-ink-faint">
            {followUps.length} open · {groups.length} {groups.length === 1 ? 'person' : 'people'}
          </span>
        </div>

        {groups.length === 0 && (
          <p className="px-5 py-10 text-center text-[13px] text-ink-faint">
            No open follow-ups.
          </p>
        )}

        <ul className="divide-y divide-line">
          {groups.map(([who, rows]) => (
            <li key={who}>
              <div className="flex items-center justify-between gap-3 bg-sunk/40 px-5 py-2.5">
                <span className="truncate text-[13.5px] font-semibold text-ink">{who}</span>
                <span className="shrink-0 text-[11.5px] text-ink-faint">
                  {rows.length} open
                </span>
              </div>
              <ul className="divide-y divide-line-soft">
                {rows.map((f) => (
                  <Row key={f.id} f={f} />
                ))}
              </ul>
            </li>
          ))}
        </ul>

        <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
          Nothing is auto-sent. A snoozed nudge returns on its own.
        </div>
      </Card>
    </Page>
  );
}
