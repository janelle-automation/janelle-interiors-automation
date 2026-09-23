import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TaskStatus } from '@janelle/shared';
import { useAuth } from '../context/AuthContext';
import { useTasks } from '../lib/queries';
import { IconArrow, IconBell } from './icons';

/** Statuses that still need a person; done and cancelled are finished work. */
const LIVE: TaskStatus[] = ['open', 'in_progress', 'blocked'];

/** Rows before the modal stops listing and starts counting. */
const SHOWN = 6;

const SEEN_KEY = 'janelle.reminder.seen';

/**
 * Today where the person is, written the way a due date is.
 *
 * `toISOString().slice(0,10)` — which the board uses for its own overdue
 * tint — is UTC, and in California that rolls over at 4pm: work due today
 * would be announced as late all evening. A reminder that says the wrong
 * thing about a deadline is worse than no reminder.
 */
function todayLocal(): string {
  const d = new Date();
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
  return `due ${Math.abs(d)} days ago`;
}

/**
 * When this person last dismissed the reminder, as `<userId>|<ISO time>`.
 *
 * A date alone was enough while the reminder only announced deadlines —
 * those change once a day. Work being handed to someone does not wait for
 * midnight, so the moment is stored instead: anything assigned after it is
 * news, and the reminder may open again the same day to say so.
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

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/**
 * What this person owes today, said once when they open the studio.
 *
 * The nightly scan already emails whoever owns an overdue task, and the bell
 * already holds the follow-ups it raised — but both wait to be looked at.
 * Email is read elsewhere, and the bell is a button nobody presses without a
 * reason to think something is behind it. This is the one place the system
 * speaks first, and it says only what is this person's to do.
 *
 * Once a day per person, dismissible, and silent when nothing is due: a
 * reminder that appears when there is nothing to remind about is the thing
 * that teaches people to close it without reading.
 */
export function TaskReminder() {
  const { user, may } = useAuth();
  // The board is a page's worth of rows the shell does not otherwise need,
  // and a role the studio has closed Tasks to gets a 403 for it. Ask only
  // when there is someone to remind and the answer is theirs to see.
  if (!user || !may('tasks')) return null;
  return <Reminder userId={user.id} />;
}

function Reminder({ userId }: { userId: string }) {
  const { data: tasks, isLoading } = useTasks();
  const today = todayLocal();
  // Read once per mount, and keyed by person: a shared browser at the studio
  // must not let one person dismissing theirs silence the next person's.
  const [seenAt, setSeenAt] = useState<Date | null>(() => readSeen(userId));
  const confirmRef = useRef<HTMLAnchorElement>(null);

  const mine = useMemo(
    () => tasks.filter((t) => t.assignedTo === userId && LIVE.includes(t.status)),
    [tasks, userId],
  );

  const due = useMemo(
    () =>
      mine
        .filter((t) => t.due && t.due <= today)
        // Most overdue first — the oldest date has been waiting longest, and
        // it should not be the row that falls past the cut.
        .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '')),
    [mine, today],
  );

  /**
   * Work that became theirs since they last looked.
   *
   * Deliberately not "raised since": a task handed over is new to whoever
   * receives it, whatever day it was created. Before migration 0016 there is
   * no assignedAt, and this is simply always empty — the deadline half of
   * the reminder carries on working.
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

  const close = useCallback(() => {
    writeSeen(userId);
    setSeenAt(new Date());
  }, [userId]);

  // Two reasons to speak, on two different clocks. Deadlines are a once-a-day
  // summary — saying them again an hour later is nagging. A task landing on
  // someone is news the moment it happens, so that reopens the reminder even
  // if today's deadlines have already been dismissed.
  const dueIsNews = due.length > 0 && (seenAt === null || !sameDay(seenAt, new Date()));
  const showing = !isLoading && (dueIsNews || fresh.length > 0);

  // Escape closes it, like every other overlay the studio uses.
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing, close]);

  // Focus moves into the dialog, so a keyboard lands on the way out of it
  // rather than somewhere behind the backdrop.
  useEffect(() => {
    if (showing) confirmRef.current?.focus();
  }, [showing]);

  if (!showing) return null;

  const shownDue = dueIsNews ? due : [];
  const late = shownDue.filter((t) => t.due && t.due < today).length;
  const total = fresh.length + shownDue.length;

  // Lead with whichever is the reason it opened. A reminder that says
  // "2 tasks need you today" when what actually happened is that something
  // just landed on you has buried its own news.
  const heading =
    fresh.length > 0 && shownDue.length === 0
      ? fresh.length === 1
        ? 'A task was just assigned to you'
        : `${fresh.length} tasks were just assigned to you`
      : total === 1
        ? 'One task needs you today'
        : `${total} tasks need you today`;

  const breakdown = [
    fresh.length > 0 ? `${fresh.length} new` : null,
    late > 0 ? `${late} overdue` : null,
    shownDue.length - late > 0 ? `${shownDue.length - late} due today` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const sections = [
    { key: 'fresh', label: 'Just assigned to you', rows: fresh },
    { key: 'due', label: fresh.length > 0 ? 'Also needing you today' : '', rows: shownDue },
  ].filter((s) => s.rows.length > 0);

  return (
    // `dock-aware`: when Jenny's panel is docked on a wide screen this stops
    // at her edge instead of opening underneath her. z-50 clears the task
    // panel, which a reminder should never open behind.
    <div className="dock-aware fixed inset-0 z-50 grid place-items-center px-4">
      {/* Black, not ink: in dark mode ink is near-white, and a backdrop made
          from it washes the page grey instead of dimming it. */}
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-heading"
        className="popover relative w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
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
            aria-label="Dismiss reminder"
            className="focusable -mr-1 rounded px-1.5 text-[15px] leading-none text-ink-faint transition-colors hover:text-ink"
          >
            ✕
          </button>
        </header>

        <ul className="max-h-[340px] divide-y divide-line-soft overflow-y-auto">
          {sections.map((section) => (
            <li key={section.key}>
              {section.label && (
                <p className="bg-sunk/50 px-5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-ink-faint">
                  {section.label}
                </p>
              )}
              <ul className="divide-y divide-line-soft">
                {section.rows.slice(0, SHOWN).map((t) => {
                  const overdue = !!t.due && t.due < today;
                  // A new task is marked by being new; its date, if it even
                  // has one, is not yet the point.
                  const isNew = section.key === 'fresh';
                  return (
                    <li key={t.id}>
                      {/* Straight to the task, not to the board: ?task= opens
                          its panel, so the next click is the work rather than
                          a hunt through a column for the card just named. */}
                      <Link
                        to={`/tasks?task=${t.id}`}
                        onClick={close}
                        className="focusable flex gap-3 px-5 py-3 transition-colors hover:bg-sunk/60"
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                            isNew ? 'bg-brass' : overdue ? 'bg-crit' : 'bg-warn'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-ink">{t.title}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-ink-faint">
                            {t.project !== '—' ? `${t.project} · ` : ''}
                            {isNew ? (
                              <span className="font-semibold text-brass-deep">
                                {t.due ? `due ${dueLabel(t.due, today).replace(/^due /, '')}` : 'no due date yet'}
                              </span>
                            ) : (
                              <span className={overdue ? 'font-semibold text-crit' : 'text-warn'}>
                                {t.due ? dueLabel(t.due, today) : ''}
                              </span>
                            )}
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
                {section.rows.length > SHOWN && (
                  <li className="px-5 py-2.5 text-[12px] text-ink-faint">
                    and {section.rows.length - SHOWN} more
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between gap-3 border-t border-line-soft bg-sunk/40 px-5 py-3">
          <Link ref={confirmRef} to="/tasks" onClick={close} className="btn-primary btn-sm">
            Open my tasks <IconArrow width={14} height={14} />
          </Link>
          <button type="button" onClick={close} className="btn-ghost btn-sm">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
