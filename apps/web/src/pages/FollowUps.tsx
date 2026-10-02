import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page, PageHeading, Card, Pill } from '../components/ui';
import { useFollowUps, useOps, useFollowUpStatus, useSnoozeFollowUp, type FollowUpView } from '../lib/queries';
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

/**
 * How soon each kind of nudge needs a person. Lower is sooner.
 *
 * An escalation is a reminder that was already sent and ignored; an overdue
 * approval or a slipping date is a client or a delivery at risk. Those come
 * first. A client waiting or a quote going stale is next, a reminder that has
 * only just gone out is routine, and missing details (no owner, no date) are
 * housekeeping.
 */
const RANK: Record<string, number> = {
  task_escalation: 0,
  date_slipping: 1,
  client_approval_overdue: 1,
  client_waiting: 2,
  quote_overdue: 2,
  vendor_silence: 3,
  task_overdue: 3,
  spec_gap: 4,
  task_unowned: 4,
  task_no_next_step: 5,
  task_no_due_date: 5,
};
/** At or below this, a nudge is "top priority" and gets the section at the head of the page. */
const TOP_RANK = 1;

const rankOf = (f: FollowUpView) => RANK[f.type] ?? 4;
/** "today" → 0, "11 days" → 11; the age arrives as a phrase, and a sort needs a number. */
const quietDays = (f: FollowUpView) => Number(/^\d+/.exec(f.age)?.[0] ?? 0);

const NO_PROJECT = 'No project';
const projectOf = (f: FollowUpView) => (f.project && f.project !== '—' ? f.project : NO_PROJECT);

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
  const rank = rankOf(f);
  // The project is the box's heading, so the row only needs who is being chased.
  const who = f.who && f.who !== '—' ? f.who : '';

  return (
    <li
      className={`flex flex-col gap-3 border-l-[3px] px-5 py-3.5 sm:flex-row sm:items-center ${
        rank <= TOP_RANK ? 'border-crit' : rank === 2 ? 'border-warn' : 'border-transparent'
      }`}
    >
      <div className="sm:w-36">
        <Pill tone={tone[f.type]}>{label[f.type] ?? f.type}</Pill>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-ink">{f.reason}</div>
        <div className="mt-0.5 text-[12px] text-ink-faint">
          {who && <>{who} · </>}quiet {f.age}
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

/** One project and what is waiting on it, as a box of its own. */
function ProjectBox({ name, rows }: { name: string; rows: FollowUpView[] }) {
  const worst = rows.reduce((a, f) => (rankOf(f) < rankOf(a) ? f : a), rows[0]);
  const longest = Math.max(...rows.map(quietDays));
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line-soft bg-sunk/40 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <h3 className={`truncate text-[15px] font-semibold ${name === NO_PROJECT ? 'text-ink-soft' : 'text-ink'}`}>{name}</h3>
          <Pill tone={tone[worst.type]}>{label[worst.type] ?? worst.type}</Pill>
        </div>
        <p className="text-[12px] text-ink-faint">
          {rows.length} open{longest > 0 && <> · longest quiet {longest} day{longest > 1 ? 's' : ''}</>}
        </p>
      </div>
      <ul className="divide-y divide-line-soft">
        {rows.map((f) => (
          <Row key={f.id} f={f} />
        ))}
      </ul>
    </Card>
  );
}

/**
 * Nudges gathered into one box per project, most urgent box first.
 *
 * Within a box the most urgent nudge leads and, among equals, the one that has
 * been quiet longest. Between boxes: the one holding the most urgent item,
 * then the one with most waiting, and the catch-all "No project" last — work
 * that belongs to no job is the least actionable, not the most.
 */
function boxesOf(items: FollowUpView[]): [string, FollowUpView[]][] {
  const by = new Map<string, FollowUpView[]>();
  for (const f of items) {
    const key = projectOf(f);
    const list = by.get(key);
    if (list) list.push(f);
    else by.set(key, [f]);
  }
  for (const list of by.values()) list.sort((a, b) => rankOf(a) - rankOf(b) || quietDays(b) - quietDays(a));
  const best = (list: FollowUpView[]) => Math.min(...list.map(rankOf));
  return [...by.entries()].sort(
    (a, b) =>
      Number(a[0] === NO_PROJECT) - Number(b[0] === NO_PROJECT) ||
      best(a[1]) - best(b[1]) ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0]),
  );
}

function Stat({ text, value, hint, tone: t }: { text: string; value: number; hint: string; tone?: 'crit' }) {
  return (
    <div className={`rounded-lg border bg-surface px-4 py-3 ${t === 'crit' && value > 0 ? 'border-crit/40' : 'border-line-soft'}`}>
      <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{text}</p>
      <p className={`mt-1 text-[24px] font-semibold tabular-nums leading-tight ${t === 'crit' && value > 0 ? 'text-crit' : 'text-ink'}`}>{value}</p>
      <p className="mt-0.5 text-[12px] text-ink-faint">{hint}</p>
    </div>
  );
}

export default function FollowUps() {
  const { data: all } = useFollowUps();
  const { followUps: runFollowUps } = useOps();
  const [scope] = useScope();
  const { user } = useAuth();
  const [showOthers, setShowOthers] = useState(true);

  /**
   * A nudge is yours only when something says so.
   *
   * This used to run the other way — anything with no owner counted as
   * everybody's, so it stayed in "Mine" on the reasoning that work nobody
   * owns should not be work nobody sees. In practice that showed a person
   * invited this morning every silent vendor and every overdue approval in
   * the studio, none of which were theirs.
   *
   * Three ways it can be yours: the task it chases is yours, it is
   * addressed to you, or it concerns a job you run. Anything else belongs
   * to the studio and lives under "Everyone", where whoever runs the board
   * will find it.
   */
  const myEmail = (user?.email ?? '').trim().toLowerCase();
  const isMine = (f: FollowUpView) => {
    if (f.taskAssignee) return f.taskAssignee === user?.id;
    if (f.projectOwner && f.projectOwner === user?.id) return true;
    const target = (f.target ?? '').trim().toLowerCase();
    return Boolean(target) && target === myEmail;
  };

  const followUps = scope === 'mine' ? all.filter(isMine) : all;

  /**
   * Two lists, each a box per project, rather than one row per person.
   *
   * The queue used to be grouped by whoever was being chased, which put a
   * dozen escalations under a heading of "—" and scattered one job's
   * follow-ups across the page. A studio works by job, so the page does too:
   * what is most urgent first, then everything else, and in each a box that
   * says which project it is about and what is waiting on it.
   */
  const { top, others } = useMemo(() => {
    const t = followUps.filter((f) => rankOf(f) <= TOP_RANK);
    const o = followUps.filter((f) => rankOf(f) > TOP_RANK);
    return { top: boxesOf(t), others: boxesOf(o) };
  }, [followUps]);

  const topCount = top.reduce((n, [, rows]) => n + rows.length, 0);
  const otherCount = followUps.length - topCount;
  const projectCount = new Set(followUps.map(projectOf)).size;

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

      {followUps.length === 0 ? (
        <Card>
          <div className="px-5 py-12 text-center">
            <p className="text-[15px] font-semibold text-ink">You’re all caught up</p>
            <p className="mt-1 text-[13px] text-ink-soft">
              No follow-ups are waiting. New ones appear here when a vendor goes quiet, a client is left waiting or a task is overdue.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat text="Top priority" value={topCount} hint="Escalated, approval overdue, date slipping" tone="crit" />
            <Stat text="Everything else" value={otherCount} hint="Clients waiting, stale quotes, reminders" />
            <Stat text="Projects affected" value={projectCount} hint="Each has its own box below" />
          </div>

          <section aria-labelledby="top-heading">
            <div className="mb-3">
              <h2 id="top-heading" className="text-[17px] font-semibold text-ink">Top priority</h2>
              <p className="text-[13px] text-ink-soft">
                Start here: escalated tasks, overdue approvals and slipping dates, by project.
              </p>
            </div>
            {top.length === 0 ? (
              <Card>
                <p className="px-5 py-8 text-center text-[13px] text-ink-soft">Nothing urgent right now. 🎉 Everything waiting is below.</p>
              </Card>
            ) : (
              <div className="space-y-4">
                {top.map(([name, rows]) => (
                  <ProjectBox key={name} name={name} rows={rows} />
                ))}
              </div>
            )}
          </section>

          {others.length > 0 && (
            <section aria-labelledby="others-heading">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 id="others-heading" className="text-[17px] font-semibold text-ink">Everything else</h2>
                  <p className="text-[13px] text-ink-soft">{otherCount} more waiting across {others.length} project{others.length > 1 ? 's' : ''}.</p>
                </div>
                <button type="button" className="btn-ghost btn-sm" aria-expanded={showOthers} onClick={() => setShowOthers((v) => !v)}>
                  {showOthers ? 'Hide' : 'Show'}
                </button>
              </div>
              {showOthers && (
                <div className="space-y-4">
                  {others.map(([name, rows]) => (
                    <ProjectBox key={name} name={name} rows={rows} />
                  ))}
                </div>
              )}
            </section>
          )}

          <p className="text-[12.5px] text-ink-faint">Nothing is auto-sent. A snoozed nudge returns on its own.</p>
        </div>
      )}
    </Page>
  );
}
