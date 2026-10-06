import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { canSupervise, type TaskStatus } from '@janelle/shared';
import { useAuth } from '../context/AuthContext';
import { useTasks, type TaskView } from '../lib/queries';
import { IconArrow, IconBell, IconChevronRight, IconPeople, IconPerson } from './icons';

/** Statuses that still need a person; done and cancelled are finished work. */
const LIVE: TaskStatus[] = ['open', 'in_progress', 'blocked'];

/** Rows a group lists before it stops listing and starts counting. */
const SHOWN = 8;

const SEEN_KEY = 'janelle.reminder.seen';

/**
 * The studio is in Ojai, California, and the reminder is meant to land at
 * midday there — not at noon wherever a teammate's laptop happens to think
 * it is. Anchored to Pacific time via Intl rather than a fixed UTC offset,
 * so it stays correct across the PST/PDT change.
 */
const PACIFIC_TZ = 'America/Los_Angeles';
const MIDDAY_HOUR = 12;

/**
 * Pacific's current offset from UTC, in minutes — negative, e.g. -420 in
 * summer (PDT), -480 in winter (PST).
 *
 * Read by asking Intl for Pacific's own wall-clock digits at `d`, then
 * comparing that reading (taken as if it were itself UTC) to `d`'s real UTC
 * instant. The difference is the offset, worked out from what Pacific time
 * actually is today rather than assumed from a lookup table.
 */
function pacificOffsetMinutes(d: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TZ,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  );
  return Math.round((asIfUtc - d.getTime()) / 60_000);
}

/** The Pacific calendar date ("YYYY-MM-DD") and hour (0–23) `d` falls on. */
function pacificParts(d: Date): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TZ,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The instant a given Pacific calendar date turns to the given Pacific hour. */
function pacificWallToInstant(date: string, hour: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  return new Date(naive - pacificOffsetMinutes(new Date(naive)) * 60_000);
}

/**
 * Today where the person is, written the way a due date is.
 *
 * `toISOString().slice(0,10)` — which the board uses for its own overdue
 * tint — is UTC, and in California that rolls over at 4pm: work due today
 * would be announced as late all evening. A reminder that says the wrong
 * thing about a deadline is worse than no reminder.
 */
function todayLocal(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** Whole calendar days from `due` to `today` — 0 today, negative once late. */
function dayDiff(due: string, today: string): number {
  const [ay, am, ad] = due.split('-').map(Number);
  const [by, bm, bd] = today.split('-').map(Number);
  if (!ay || !am || !ad || !by || !bm || !bd) return 0;
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}

function dueLabel(due: string, today: string): string {
  const d = dayDiff(due, today);
  if (d === 0) return 'due today';
  if (d === -1) return 'due yesterday';
  if (d < 0) return `due ${Math.abs(d)} days ago`;
  if (d === 1) return 'due tomorrow';
  return `due in ${d} days`;
}

/**
 * The reminder speaks once a day, at midday Pacific, for whatever is still
 * pending. The slot is the most recent midday to have passed, and a
 * dismissal only covers the slot it happened in.
 */
function slotStart(now: Date): Date {
  const { date, hour } = pacificParts(now);
  if (hour >= MIDDAY_HOUR) return pacificWallToInstant(date, MIDDAY_HOUR);
  // Still before today's midday: the slot in effect is yesterday's,
  // computed from today's Y-M-D without drifting through the browser's own
  // time zone.
  const [y, m, d] = date.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
  const yesterdayDate = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`;
  return pacificWallToInstant(yesterdayDate, MIDDAY_HOUR);
}

function msToNextSlot(now: Date): number {
  const { date, hour } = pacificParts(now);
  if (hour < MIDDAY_HOUR) return pacificWallToInstant(date, MIDDAY_HOUR).getTime() - now.getTime();
  // Tomorrow's Pacific date, computed from today's without drifting through
  // the browser's own time zone: a plain UTC day-add on the Y-M-D parts.
  const [y, m, d] = date.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const tomorrowDate = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
  return pacificWallToInstant(tomorrowDate, MIDDAY_HOUR).getTime() - now.getTime();
}

/**
 * When this person last dismissed the reminder, as `<userId>|<ISO time>`.
 *
 * The moment rather than the date: work handed to someone is news whenever
 * it happens, and the 5pm reminder needs to know which half of the day a
 * dismissal belongs to.
 */
function readSeen(userId: string): Date | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return null;
    const [who, at] = raw.split('|');
    if (who !== userId) return null;
    const ms = Date.parse(at ?? '');
    return Number.isNaN(ms) ? null : new Date(ms);
  } catch {
    return null;
  }
}

function writeSeen(userId: string) {
  try {
    localStorage.setItem(SEEN_KEY, `${userId}|${new Date().toISOString()}`);
  } catch {
    // A private window refuses storage; the reminder just asks again on the
    // next load rather than staying dismissed.
  }
}

/** Oldest deadline first, undated last: the longest-waiting is never the one cut off. */
function byDue(a: TaskView, b: TaskView): number {
  if (!a.due) return b.due ? 1 : 0;
  if (!b.due) return -1;
  return a.due.localeCompare(b.due);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/**
 * What is pending, said first — without waiting to be looked for.
 *
 * Everyone gets their own open work, grouped by how late it is. Supervisors
 * also get the whole studio, one collapsible group per person, because
 * chasing other people's overdue and unassigned tasks is their job.
 *
 * It opens by itself at midday Pacific while something is overdue or due
 * today, and whenever a task lands on someone. Dismissed, it collapses to a
 * tab on the right edge rather than vanishing, so the list is one click away
 * for the rest of the day. Silent when nothing is pending: a reminder with
 * nothing to say teaches people to close it without reading.
 */
export function TaskReminder() {
  const { user, may } = useAuth();
  // The board is a page's worth of rows the shell does not otherwise need,
  // and a role the studio has closed Tasks to gets a 403 for it. Ask only
  // when there is someone to remind and the answer is theirs to see.
  if (!user || !may('tasks')) return null;
  return <Reminder userId={user.id} admin={canSupervise(user.role)} />;
}

type View = 'mine' | 'all';

function Reminder({ userId, admin }: { userId: string; admin: boolean }) {
  const { data: tasks, isLoading } = useTasks();
  const [now, setNow] = useState(() => new Date());
  const today = todayLocal(now);
  // Read once per mount, and keyed by person: a shared browser at the studio
  // must not let one person dismissing theirs silence the next person's.
  const [seenAt, setSeenAt] = useState<Date | null>(() => readSeen(userId));
  const [manualOpen, setManualOpen] = useState(false);
  const [view, setView] = useState<View>(admin ? 'all' : 'mine');
  const panelRef = useRef<HTMLDivElement>(null);

  // A tab left open all morning still gets its midday reminder: wake at the
  // next slot boundary and let everything below recompute.
  useEffect(() => {
    const id = window.setTimeout(() => setNow(new Date()), msToNextSlot(now) + 1000);
    return () => window.clearTimeout(id);
  }, [now]);

  const live = useMemo(() => tasks.filter((t) => LIVE.includes(t.status)), [tasks]);
  const mine = useMemo(() => live.filter((t) => t.assignedTo === userId), [live, userId]);
  const scope = admin ? live : mine;

  /** Overdue or due today — what the reminder opens itself for. */
  const pressing = useMemo(() => scope.filter((t) => t.due && t.due <= today), [scope, today]);

  /**
   * Work that became theirs since they last looked.
   *
   * Deliberately not "raised since": a task handed over is new to whoever
   * receives it, whatever day it was created.
   */
  const fresh = useMemo(
    () =>
      seenAt === null
        ? []
        : mine
            .filter((t) => t.assignedAt && Date.parse(t.assignedAt) > seenAt.getTime())
            .sort((a, b) => Date.parse(b.assignedAt!) - Date.parse(a.assignedAt!)),
    [mine, seenAt],
  );

  const middayOrLater = pacificParts(now).hour >= MIDDAY_HOUR;
  const pressingIsNews = pressing.length > 0 && (seenAt === null || seenAt < slotStart(now));
  const autoOpen = !isLoading && (pressingIsNews || fresh.length > 0);
  const open = autoOpen || manualOpen;

  const close = useCallback(() => {
    writeSeen(userId);
    setSeenAt(new Date());
    setManualOpen(false);
  }, [userId]);

  // Escape closes it, like every other overlay the studio uses.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Focus moves into the panel, so a keyboard lands inside it rather than
  // somewhere behind the backdrop.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (isLoading || scope.length === 0) return null;

  const late = pressing.filter((t) => t.due! < today).length;
  const dueToday = pressing.length - late;

  if (!open) {
    return (
      <>
        {/* Mobile: small round pill centred vertically on the right edge —
            sits in the scrollable content zone, away from both the composer
            at the bottom and the header at the top */}
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          aria-label={`Show pending tasks (${pressing.length} overdue or due today)`}
          className="focusable fixed right-0 top-1/2 z-40 -translate-y-1/2 flex-col items-center gap-1 rounded-l-lg border border-r-0 border-line bg-surface px-1.5 py-2.5 text-ink-soft shadow-pop transition-colors hover:text-ink sm:hidden"
        >
          <IconBell width={16} height={16} />
          {pressing.length > 0 && (
            <span
              className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-[10px] font-bold text-white ${
                late > 0 ? 'bg-crit' : 'bg-warn'
              }`}
            >
              {pressing.length > 99 ? '99+' : pressing.length}
            </span>
          )}
        </button>

        {/* Desktop: vertical side tab centred in the viewport */}
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          aria-label={`Show pending tasks (${pressing.length} overdue or due today)`}
          className="dock-aware focusable fixed right-0 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-line bg-surface px-2 py-3 text-ink-soft shadow-pop transition-colors hover:text-ink sm:flex"
        >
          <IconBell width={17} height={17} />
          {pressing.length > 0 && (
            <span
              className={`grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold text-white ${
                late > 0 ? 'bg-crit' : 'bg-warn'
              }`}
            >
              {pressing.length}
            </span>
          )}
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] [writing-mode:vertical-rl]">
            Pending
          </span>
        </button>
      </>
    );
  }

  const heading =
    fresh.length > 0 && !pressingIsNews
      ? fresh.length === 1
        ? 'A task was just assigned to you'
        : `${fresh.length} tasks were just assigned to you`
      : middayOrLater
        ? 'Midday check-in'
        : 'Pending tasks';

  const breakdown = [
    admin && view === 'all' ? 'Whole studio' : null,
    late > 0 ? `${late} overdue` : null,
    dueToday > 0 ? `${dueToday} due today` : null,
    `${scope.length} pending`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      {/* Black, not ink: in dark mode ink is near-white, and a backdrop made
          from it washes the page grey instead of dimming it. */}
      <div className="dock-aware fixed inset-0 z-40 bg-black/30" onClick={close} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-heading"
        className="assistant-drawer dock-aware fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-pop outline-none sm:w-[420px]"
      >
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brass/10 text-brass-deep">
            <IconBell width={18} height={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="reminder-heading" className="text-[15.5px] font-semibold leading-snug text-ink">
              {heading}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">{breakdown}</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Hide pending tasks"
            className="focusable -mr-1 rounded px-1.5 text-[15px] leading-none text-ink-faint transition-colors hover:text-ink"
          >
            ✕
          </button>
        </header>

        {admin && (
          <div className="flex gap-1 border-b border-line-soft px-5 py-2" role="tablist">
            {(
              [
                ['all', 'Everyone', IconPeople],
                ['mine', 'Mine', IconPerson],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                onClick={() => setView(key)}
                className={`focusable flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                  view === key ? 'bg-sunk text-ink' : 'text-ink-soft hover:text-ink'
                }`}
              >
                <Icon width={14} height={14} /> {label}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {admin && view === 'all' ? (
            <EveryoneView tasks={live} userId={userId} today={today} onPick={close} />
          ) : (
            <MineView tasks={mine} fresh={fresh} today={today} onPick={close} />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-sunk/40 px-5 py-3">
          <Link to="/tasks" onClick={close} className="btn-primary btn-sm">
            Open task board <IconArrow width={14} height={14} />
          </Link>
          <button type="button" onClick={close} className="btn-ghost btn-sm">
            Hide
          </button>
        </div>
      </div>
    </>
  );
}

// ── The two views ───────────────────────────────────────────

function MineView({
  tasks,
  fresh,
  today,
  onPick,
}: {
  tasks: TaskView[];
  fresh: TaskView[];
  today: string;
  onPick: () => void;
}) {
  const freshIds = new Set(fresh.map((t) => t.id));
  const rest = tasks.filter((t) => !freshIds.has(t.id)).sort(byDue);
  const groups = [
    { key: 'fresh', label: 'Just assigned to you', rows: fresh, open: true },
    { key: 'late', label: 'Overdue', rows: rest.filter((t) => t.due && t.due < today), open: true },
    { key: 'today', label: 'Due today', rows: rest.filter((t) => t.due === today), open: true },
    { key: 'soon', label: 'Coming up', rows: rest.filter((t) => t.due && t.due > today), open: false },
    { key: 'undated', label: 'No due date', rows: rest.filter((t) => !t.due), open: false },
  ].filter((g) => g.rows.length > 0);

  if (!groups.length) {
    return <p className="px-5 py-8 text-center text-[13px] text-ink-faint">Nothing pending for you. Nice.</p>;
  }
  return (
    <ul className="divide-y divide-line-soft">
      {groups.map((g) => (
        <Group key={g.key} defaultOpen={g.open} header={<SectionHeader label={g.label} count={g.rows.length} />}>
          <TaskRows rows={g.rows} today={today} fresh={g.key === 'fresh'} onPick={onPick} />
        </Group>
      ))}
    </ul>
  );
}

function EveryoneView({
  tasks,
  userId,
  today,
  onPick,
}: {
  tasks: TaskView[];
  userId: string;
  today: string;
  onPick: () => void;
}) {
  const people = useMemo(() => {
    const map = new Map<string, { key: string; name: string; rows: TaskView[] }>();
    for (const t of tasks) {
      const key = t.assignedTo ?? 'unassigned';
      const name = !t.assignedTo ? 'Unassigned' : t.assignedTo === userId ? `${t.assignee} (you)` : t.assignee;
      const entry = map.get(key) ?? { key, name, rows: [] };
      entry.rows.push(t);
      map.set(key, entry);
    }
    return [...map.values()]
      .map((p) => {
        const rows = p.rows.sort(byDue);
        const late = rows.filter((t) => t.due && t.due < today).length;
        const dueToday = rows.filter((t) => t.due === today).length;
        return { ...p, rows, late, dueToday };
      })
      // Nobody owns unassigned work, so it leads; then whoever is furthest behind.
      .sort(
        (a, b) =>
          Number(b.key === 'unassigned') - Number(a.key === 'unassigned') ||
          b.late - a.late ||
          b.dueToday - a.dueToday ||
          b.rows.length - a.rows.length,
      );
  }, [tasks, userId, today]);

  return (
    <ul className="divide-y divide-line-soft">
      {people.map((p) => (
        <Group
          key={p.key}
          defaultOpen={false}
          header={
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                  p.key === 'unassigned' ? 'bg-sunk text-ink-faint' : 'bg-brass/10 text-brass-deep'
                }`}
                aria-hidden
              >
                {p.key === 'unassigned' ? '?' : initials(p.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{p.name}</span>
              {p.late > 0 && (
                <span className="shrink-0 rounded-full bg-crit/10 px-2 py-0.5 text-[11px] font-semibold text-crit">
                  {p.late} overdue
                </span>
              )}
              {p.dueToday > 0 && (
                <span className="shrink-0 rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn">
                  {p.dueToday} today
                </span>
              )}
              <span className="shrink-0 text-[12px] tabular-nums text-ink-faint">{p.rows.length}</span>
            </span>
          }
        >
          <TaskRows rows={p.rows} today={today} onPick={onPick} />
        </Group>
      ))}
    </ul>
  );
}

// ── Pieces ──────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <span className="flex flex-1 items-center justify-between">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-ink-soft">{label}</span>
      <span className="text-[12px] tabular-nums text-ink-faint">{count}</span>
    </span>
  );
}

function Group({
  header,
  defaultOpen,
  children,
}: {
  header: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="focusable flex w-full items-center gap-2 px-5 py-2.5 text-left transition-colors hover:bg-sunk/60"
      >
        <IconChevronRight
          width={14}
          height={14}
          className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {header}
      </button>
      {open && children}
    </li>
  );
}

function TaskRows({
  rows,
  today,
  fresh = false,
  onPick,
}: {
  rows: TaskView[];
  today: string;
  fresh?: boolean;
  onPick: () => void;
}) {
  return (
    <ul className="divide-y divide-line-soft border-t border-line-soft bg-sunk/20">
      {rows.slice(0, SHOWN).map((t) => {
        const overdue = !!t.due && t.due < today;
        const isToday = t.due === today;
        return (
          <li key={t.id}>
            {/* Straight to the task, not to the board: ?task= opens its
                panel, so the next click is the work rather than a hunt. */}
            <Link
              to={`/tasks?task=${t.id}`}
              onClick={onPick}
              className="focusable flex gap-3 py-2.5 pl-11 pr-5 transition-colors hover:bg-sunk/60"
            >
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  fresh ? 'bg-brass' : overdue ? 'bg-crit' : isToday ? 'bg-warn' : 'bg-line'
                }`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{t.title}</span>
                <span className="mt-0.5 block truncate text-[12px] text-ink-faint">
                  {t.project !== '—' ? `${t.project} · ` : ''}
                  <span
                    className={
                      overdue ? 'font-semibold text-crit' : isToday ? 'text-warn' : fresh ? 'text-brass-deep' : ''
                    }
                  >
                    {t.due ? dueLabel(t.due, today) : 'no due date'}
                  </span>
                  {t.status === 'blocked' && <span className="font-semibold text-crit"> · blocked</span>}
                </span>
                {t.nextStep && (
                  <span className="mt-0.5 block truncate text-[12px] text-ink-soft">
                    <span className="text-ink-faint">Next:</span> {t.nextStep}
                  </span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
      {rows.length > SHOWN && (
        <li className="py-2 pl-11 pr-5 text-[12px] text-ink-faint">
          and {rows.length - SHOWN} more on the{' '}
          <Link to="/tasks" onClick={onPick} className="font-medium text-ink-soft underline">
            task board
          </Link>
        </li>
      )}
    </ul>
  );
}
