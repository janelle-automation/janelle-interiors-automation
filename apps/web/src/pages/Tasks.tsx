import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  canManageTasks,
  type FollowUpType,
  type TaskKind,
  type TaskStatus,
} from '@janelle/shared';
import { Page, PageHeading, Card, Pill, shortDate } from '../components/ui';
import { ScopeToggle, useScope } from '../components/ScopeToggle';
import { IconBoard, IconEye, IconEyeOff, IconList, IconMailScan } from '../components/icons';
import { useAuth } from '../context/AuthContext';
import {
  daysEarly, useAddSubtask, useBackfillTasks, useDeleteTask, useTaskDetail, useTasks, useTeam, useUpdateTask,
  type TaskView, type TeamMember,
} from '../lib/queries';

const tone: Record<TaskKind, 'crit' | 'warn' | 'brass' | 'neutral'> = {
  quote_request: 'brass',
  order_followup: 'warn',
  client_approval: 'crit',
  spec_review: 'brass',
  scheduling: 'warn',
  admin: 'neutral',
};

/**
 * The kind, as a dot rather than a filled badge.
 *
 * Every card carried a coloured pill for its kind, so a column of them was a
 * column of loud blocks and nothing stood out — least of all the one word
 * that should, which is "Overdue". A dot and a quiet label carry the same
 * information and give the alert somewhere to be loud against.
 *
 * `spec_review` takes olive rather than the brass its pill uses: beside
 * `quote_request` two identical greens said "these are the same kind".
 */
const KIND_DOT: Record<TaskKind, string> = {
  quote_request: 'bg-brass',
  order_followup: 'bg-warn',
  client_approval: 'bg-crit',
  spec_review: 'bg-olive',
  scheduling: 'bg-warn',
  admin: 'bg-ink-faint',
};

/** The accent each board column is headed with. */
const COLUMN_DOT: Partial<Record<TaskStatus, string>> = {
  open: 'bg-ink-faint',
  in_progress: 'bg-brass',
  blocked: 'bg-crit',
  done: 'bg-good',
};

/** Replaces the platform's own select arrow, which cannot be themed. */
function Chevron({ className = '' }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** A quiet marker on the card — not an alert, just a fact worth seeing. */
function Tag({ children, title, tone: t }: { children: ReactNode; title?: string; tone: 'crit' | 'good' | 'neutral' }) {
  const tones = {
    crit: 'bg-crit/15 text-crit',
    good: 'bg-good/15 text-good',
    neutral: 'bg-sunk text-ink-faint',
  };
  return (
    <span
      title={title}
      className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em] ${tones[t]}`}
    >
      {children}
    </span>
  );
}

/** Labels for the nudges raised against a task, in its history. */
const HISTORY_LABELS: Partial<Record<FollowUpType, string>> = {
  task_overdue: 'Owner reminded',
  task_escalation: 'Escalated to the principal',
  task_unowned: 'Chased for an owner',
  task_no_next_step: 'Chased for a next step',
  task_no_due_date: 'Chased for a due date',
};

/** "2 days early", "on its due date", "1 day late" — how finished work met its date. */
function finishedLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'on its due date';
  const n = Math.abs(days);
  return `${n} day${n === 1 ? '' : 's'} ${days > 0 ? 'early' : 'late'}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[13.5px] text-ink">{children}</dd>
    </div>
  );
}

/**
 * Everything behind one task.
 *
 * The board answers "where is this"; the card cannot answer "what is it,
 * where did it come from, and what has happened since" without becoming
 * unreadable. So the card stays a summary and the detail lives here — one
 * request, opened by clicking the card.
 */
function TaskPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, isError, error } = useTaskDetail(id);
  const addSubtask = useAddSubtask(id);
  const [draft, setDraft] = useState('');

  // Escape closes it, like every other overlay the studio uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const t = data?.task;
  const finishedAt = t?.status === 'done' ? t.completed_at ?? t.updated_at : null;
  const finished = finishedLabel(daysEarly(t?.due_date ?? null, finishedAt ?? null));
  const done = (data?.subtasks ?? []).filter((s) => s.status === 'done').length;
  const total = data?.subtasks.length ?? 0;

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    addSubtask.mutate(title, { onSuccess: () => setDraft('') });
  };

  return (
    // `dock-aware`: when Jenny's panel is docked on a wide screen, this stops
    // at her edge instead of sliding underneath her.
    <div className="dock-aware fixed inset-0 z-40 flex justify-end">
      {/* Black, not ink: in dark mode ink is near-white, and a backdrop made
          from it washed the page grey instead of dimming it. */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden
      />
      {/* bg-surface, not bg-canvas — "canvas" is not a colour in this theme,
          so the panel rendered with no background and the board showed
          through its text. */}
      <aside
        role="dialog"
        aria-label="Task detail"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-line bg-surface shadow-pop"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            {t && (
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Pill tone={tone[t.kind]}>{TASK_KIND_LABELS[t.kind]}</Pill>
                <Pill tone="neutral">{TASK_STATUS_LABELS[t.status]}</Pill>
              </div>
            )}
            <h2 className="text-[16px] font-semibold leading-snug text-ink">
              {t?.title ?? 'Task'}
            </h2>
          </div>
          <button onClick={onClose} className="btn-secondary btn-sm shrink-0">
            Close
          </button>
        </header>

        {isLoading && <p className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</p>}
        {isError && <p className="px-5 py-10 text-center text-[13px] text-crit">{(error as Error).message}</p>}

        {t && (
          <div className="flex flex-col gap-6 px-5 py-5">
            {t.detail && <p className="text-[13.5px] leading-relaxed text-ink-soft">{t.detail}</p>}

            <dl className="grid grid-cols-2 gap-4">
              <Field label="Owner">
                {t.profiles?.full_name ?? (t.assigned_to ? 'Assigned' : <span className="text-warn">Unassigned</span>)}
              </Field>
              <Field label="Due">
                {t.due_date ? shortDate(t.due_date) : <span className="text-warn">No due date</span>}
              </Field>
              <Field label="Project">{t.projects?.name ?? t.vendors?.name ?? '—'}</Field>
              <Field label="Raised">{shortDate(t.created_at)}</Field>
            </dl>

            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                Next step
              </h3>
              {t.next_step ? (
                <p className="text-[13.5px] text-ink">{t.next_step}</p>
              ) : (
                <p className="text-[13px] text-warn">
                  None written down — the studio&rsquo;s SOP asks for one on every task.
                </p>
              )}
            </div>

            {/* Where it came from. The first question anyone asks of a task
                raised by a machine is which email produced it. */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                From this email
              </h3>
              {data?.email ? (
                <div className="rounded-lg border border-line-soft bg-surface p-3">
                  <p className="text-[13.5px] font-medium text-ink">{data.email.subject ?? '(no subject)'}</p>
                  <p className="mt-0.5 text-[12px] text-ink-faint">
                    {data.email.from_addr ?? 'unknown sender'}
                    {data.email.received_at && <> · {shortDate(data.email.received_at)}</>}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
                    {data.email.extracted_json?.summary ?? data.email.snippet ?? ''}
                  </p>
                  <Link
                    to={`/inbox?open=${data.email.id}`}
                    className="focusable mt-2 inline-block text-[12.5px] font-semibold text-brass-deep hover:underline"
                  >
                    Open in Inbox →
                  </Link>
                </div>
              ) : (
                <p className="text-[13px] text-ink-faint">
                  Added by hand — there is no email behind this one.
                </p>
              )}
            </section>

            {/* Subtasks: the steps the one-line title actually stands for. */}
            <section>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  Subtasks
                </h3>
                {total > 0 && (
                  <span className="text-[11.5px] text-ink-faint">{done} of {total} done</span>
                )}
              </div>

              {total > 0 && (
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-sunk">
                  <div
                    className="h-full rounded-full bg-brass transition-[width]"
                    style={{ width: `${Math.round((done / total) * 100)}%` }}
                  />
                </div>
              )}

              <ul className="flex flex-col gap-1.5">
                {data?.subtasks.map((sub) => (
                  <li
                    key={sub.id}
                    className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface px-3 py-2 text-[13px]"
                  >
                    <span className={sub.status === 'done' ? 'text-ink-faint line-through' : 'text-ink'}>
                      {sub.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[11.5px] text-ink-faint">
                      {sub.profiles?.full_name ?? 'Unassigned'}
                      {sub.due_date && <> · {shortDate(sub.due_date)}</>}
                    </span>
                  </li>
                ))}
              </ul>

              {data?.subtasksAvailable === false ? (
                <p className="mt-2 text-[12.5px] text-ink-faint">
                  Subtasks need migration 0009 applied before they can be added.
                </p>
              ) : (
                <div className="mt-2 flex gap-2">
                  <input
                    className="input"
                    placeholder="Add a step…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submit();
                    }}
                  />
                  <button
                    onClick={submit}
                    disabled={!draft.trim() || addSubtask.isPending}
                    className="btn-secondary btn-sm shrink-0"
                  >
                    {addSubtask.isPending ? 'Adding…' : 'Add'}
                  </button>
                </div>
              )}
              {addSubtask.isError && (
                <p className="mt-2 text-[12.5px] text-crit">{(addSubtask.error as Error).message}</p>
              )}
            </section>

            {/* What has happened since. Reminders and escalations are the
                system acting on its own, so they are worth showing plainly. */}
            <section>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                Progress
              </h3>
              <ol className="flex flex-col gap-2 border-l border-line-soft pl-4">
                <li className="relative text-[13px] text-ink-soft">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-brass" />
                  Raised from email · {shortDate(t.created_at)}
                </li>
                {(data?.history ?? []).map((h) => (
                  <li key={h.id} className="relative text-[13px] text-ink-soft">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-warn" />
                    {HISTORY_LABELS[h.type] ?? h.type} · {shortDate(h.created_at)}
                    {h.reason && <span className="block text-[12px] text-ink-faint">{h.reason}</span>}
                  </li>
                ))}
                {t.status === 'done' && (
                  <li className="relative text-[13px] text-ink-soft">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-good" />
                    {t.completion_note ? 'Closed automatically' : 'Closed'}
                    {finishedAt && <> · {shortDate(finishedAt)}</>}
                    {finished && <> · {finished}</>}
                    {/* The system's reason, in full: which email, and the words
                        in it that finished the work. Dragging the card back
                        out of Done reopens it and clears this. */}
                    {t.completion_note && (
                      <span className="block text-[12px] text-ink-faint">{t.completion_note}</span>
                    )}
                  </li>
                )}
              </ol>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * The board.
 *
 * A list is the right shape for "what do I owe" and the wrong one for
 * "where is everything" — the studio reads the second question far more
 * often, and a flat list made a task with no owner look exactly like one in
 * progress. Columns are the task's own statuses, so moving a card IS the
 * status change: no form, no dropdown, one drag.
 *
 * Drag and drop is the browser's own, deliberately. A board is the kind of
 * screen that invites a library, and the HTML drag events cover it in about
 * twenty lines; every card is also reachable without a mouse through the
 * same status dropdown the list view uses.
 */
const BOARD_COLUMNS: { status: TaskStatus; hint: string }[] = [
  { status: 'open', hint: 'Not started' },
  { status: 'in_progress', hint: 'Being worked on' },
  { status: 'blocked', hint: 'Waiting on something' },
  { status: 'done', hint: 'Finished' },
];

function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brass/15 text-[9.5px] font-bold text-brass-deep"
      title={name}
    >
      {letters || '?'}
    </span>
  );
}

const BoardCard = memo(function BoardCard({
  t,
  mayEdit,
  team,
  onDragStart,
  onAssign,
  onDue,
  onOpen,
  onDelete,
}: {
  t: TaskView;
  mayEdit: boolean;
  team: TeamMember[];
  onDragStart: (id: string) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
  /** Absent when this role may not delete tasks. */
  onDelete?: (t: TaskView) => void;
}) {
  const unowned = !t.assignedTo;
  return (
    <li
      draggable={mayEdit}
      onDragStart={(e) => {
        onDragStart(t.id);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload on the transfer.
        e.dataTransfer.setData('text/plain', t.id);
      }}
      onClick={() => onOpen(t.id)}
      className={`board-card group relative overflow-hidden rounded-xl border bg-surface p-3.5 ${
        mayEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${t.overdue ? 'border-crit/35' : 'border-line-soft hover:border-line'}`}
    >
      {/* A bar down the edge rather than a red box around everything. The
          full border fought the card's own outline and made a late task look
          broken; an edge marker is read just as fast and stays legible when
          three of them sit in a column together. */}
      {t.overdue && <span className="absolute inset-y-0 left-0 w-[3px] bg-crit" aria-hidden="true" />}

      <div className="mb-2 flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[t.kind]}`} aria-hidden="true" />
          <span className="truncate text-[10px] font-bold uppercase tracking-[0.07em] text-ink-faint">
            {TASK_KIND_LABELS[t.kind]}
          </span>
        </span>
        {t.overdue && <Tag tone="crit">Overdue</Tag>}
        {/* The system moved this one here on its own. Said on the card, not
            only in the panel, so a close nobody expected is noticed. */}
        {t.closedNote && (
          <Tag tone="good" title={t.closedNote}>
            Auto-closed
          </Tag>
        )}
        {/* The board says these are raised from email. A card that was not
            is the exception, and worth being able to see at a glance rather
            than having to open it. */}
        {!t.fromEmail && !t.closedNote && (
          <Tag tone="neutral" title="Added by hand, not raised from email">
            By hand
          </Tag>
        )}

        {onDelete && (
          <button
            type="button"
            aria-label={`Delete "${t.title}"`}
            title="Delete this task"
            className="focusable ml-auto shrink-0 rounded px-1 text-[13px] leading-none text-ink-faint opacity-0 transition-opacity hover:text-crit focus:opacity-100 group-hover:opacity-100"
            draggable={false}
            onDragStart={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(t);
            }}
          >
            ✕
          </button>
        )}
      </div>

      <p className="text-[13.5px] font-semibold leading-snug tracking-[-0.005em] text-ink">{t.title}</p>

      {/* The SOP wants one next step on every task; showing the gap on the
          card is what makes it get filled in. Finished work has no next
          step to chase, so a Done card says when it was finished instead. */}
      {t.status === 'done' ? (
        t.completedAt && (
          <p className="mt-1.5 text-[12px] text-ink-soft">
            Done {shortDate(t.completedAt)}
            {finishedLabel(t.daysEarly) && (
              <span className={t.daysEarly !== null && t.daysEarly < 0 ? 'text-warn' : 'text-good'}>
                {' '}· {finishedLabel(t.daysEarly)}
              </span>
            )}
          </p>
        )
      ) : t.nextStep ? (
        <p className="mt-1.5 text-[12px] text-ink-soft">
          <span className="text-ink-faint">Next:</span> {t.nextStep}
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] text-warn">No next step</p>
      )}

      {t.project !== '—' && (
        <p className="mt-2 truncate text-[11.5px] text-ink-faint">{t.project}</p>
      )}

      {/* Owner and date are changed here rather than on another screen: the
          board is where the gaps are visible, so it is where they get
          filled. Inputs swallow the drag so picking a date is not a drag.
          A hairline separates what the card SAYS from what it can DO. */}
      <div
        className="mt-3 flex items-center gap-1 border-t border-line-soft pt-2"
        draggable={false}
        onDragStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {mayEdit ? (
          <span className="relative min-w-0 flex-1">
            <select
              className="control-quiet pr-5"
              value={t.assignedTo ?? ''}
              aria-label={`Who owns "${t.title}"`}
              onChange={(e) => onAssign(t.id, e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name ?? m.email ?? 'Teammate'}
                </option>
              ))}
            </select>
            <Chevron className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          </span>
        ) : unowned ? (
          <span className="min-w-0 flex-1 px-1.5 text-[11.5px] font-semibold text-warn">Unassigned</span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[11.5px] text-ink-soft">
            <Initials name={t.assignee} />
            <span className="truncate">{t.assignee}</span>
          </span>
        )}

        {mayEdit ? (
          <input
            type="date"
            className={`control-quiet w-auto shrink-0 tabular-nums ${t.overdue ? 'font-semibold text-crit' : ''}`}
            value={t.due ?? ''}
            aria-label={`Due date for "${t.title}"`}
            onChange={(e) => onDue(t.id, e.target.value || null)}
          />
        ) : (
          <span
            className={`shrink-0 px-1.5 text-[11.5px] tabular-nums ${
              t.overdue ? 'font-semibold text-crit' : 'text-ink-faint'
            }`}
          >
            {t.due ? shortDate(t.due) : 'No due date'}
          </span>
        )}
      </div>
    </li>
  );
});

function Board({
  tasks,
  team,
  mayEdit,
  onMove,
  onAssign,
  onDue,
  onOpen,
  onDelete,
}: {
  tasks: TaskView[];
  team: TeamMember[];
  mayEdit: (assignedTo: string | null) => boolean;
  onMove: (id: string, status: TaskStatus) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
  onDelete?: (t: TaskView) => void;
}) {
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);

  // `dragover` fires many times a second per column. Setting state on every
  // one of them re-rendered the whole board continuously, which is what made
  // a drag feel heavy — so only a genuine change is written.
  const enter = useCallback((status: TaskStatus) => {
    setOver((current) => (current === status ? current : status));
  }, []);

  // `dragleave` also fires when the pointer crosses from the column onto a
  // card INSIDE it. Leaving for a descendant is not leaving, and treating it
  // as one made the highlight strobe on and off under the cursor.
  const leave = useCallback((e: React.DragEvent, status: TaskStatus) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setOver((current) => (current === status ? null : current));
  }, []);

  const startDrag = useCallback((id: string) => {
    dragged.current = id;
  }, []);

  const drop = (status: TaskStatus) => {
    const id = dragged.current;
    dragged.current = null;
    setOver(null);
    if (!id) return;
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status || !mayEdit(task.assignedTo)) return;
    onMove(id, status);
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col.status);
        return (
          <section
            key={col.status}
            onDragOver={(e) => {
              // preventDefault on every event is what marks this a drop
              // target; the state write is separately guarded above.
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              enter(col.status);
            }}
            onDragLeave={(e) => leave(e, col.status)}
            onDrop={(e) => {
              e.preventDefault();
              drop(col.status);
            }}
            className={`rounded-2xl border p-3 transition-colors ${
              over === col.status ? 'border-brass bg-brass/5' : 'border-line-soft bg-sunk/40'
            }`}
          >
            <header className="mb-3 flex items-center gap-2 px-1">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${COLUMN_DOT[col.status] ?? 'bg-ink-faint'}`}
                aria-hidden="true"
              />
              <h3 className="text-[12px] font-bold uppercase tracking-[0.06em] text-ink-soft">
                {TASK_STATUS_LABELS[col.status]}
              </h3>
              <span className="ml-auto grid h-5 min-w-[20px] place-items-center rounded-full bg-sunk px-1.5 text-[11px] font-semibold tabular-nums text-ink-soft">
                {items.length}
              </span>
            </header>

            <ul className="flex flex-col gap-2.5">
              {items.map((t) => (
                <BoardCard
                  key={t.id}
                  t={t}
                  mayEdit={mayEdit(t.assignedTo)}
                  team={team}
                  onDragStart={startDrag}
                  onAssign={onAssign}
                  onDue={onDue}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
              {items.length === 0 && (
                <li className="rounded-xl border border-dashed border-line/70 px-3 py-7 text-center text-[11.5px] text-ink-faint">
                  {col.hint}
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Statuses a row can still be moved to; done/cancelled drop out of the list filter. */
const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked'];

/**
 * What a scan found, said once it has finished.
 *
 * The button used to fall silent at the end: it read the inbox, raised
 * nothing or something, and gave no sign which. Pressed on a test email
 * that did not warrant a task, that silence was indistinguishable from the
 * scan not working at all.
 */
function ScanResult({
  result,
  error,
}: {
  result?: { ok: boolean; reason?: string; scanned: number; created: number; remaining: number } | undefined;
  error: Error | null;
}) {
  if (error) return <span className="text-[11.5px] text-crit">{error.message}</span>;
  if (!result) return null;
  if (!result.ok) return <span className="text-[11.5px] text-crit">{result.reason ?? 'The scan could not run.'}</span>;

  const read =
    result.scanned === 0
      ? 'No new email to read — everything has been checked.'
      : `Read ${result.scanned} email${result.scanned === 1 ? '' : 's'}: ${
          result.created === 0 ? 'none needed a task' : `${result.created} new task${result.created === 1 ? '' : 's'}`
        }.`;
  return (
    <span className="text-[11.5px] text-ink-faint">
      {read}
      {result.remaining > 0 ? ` ${result.remaining} more to go.` : ''}
    </span>
  );
}

type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'next7' | 'none' | 'range';

const DUE_OPTIONS: { v: DueFilter; label: string }[] = [
  { v: 'any', label: 'Any due date' },
  { v: 'overdue', label: 'Overdue' },
  { v: 'today', label: 'Due today' },
  { v: 'week', label: 'Due this week' },
  { v: 'next7', label: 'Due in the next 7 days' },
  { v: 'none', label: 'No due date' },
  { v: 'range', label: 'Date range…' },
];

interface TaskFilters {
  /** '' everyone, 'unassigned', or a teammate's id. */
  person: string;
  /** Empty means every status. */
  statuses: TaskStatus[];
  due: DueFilter;
  from: string;
  to: string;
}

const NO_FILTERS: TaskFilters = { person: '', statuses: [], due: 'any', from: '', to: '' };

/** How many filters are switched on — the number on the button. */
function activeFilterCount(f: TaskFilters): number {
  return (f.person ? 1 : 0) + (f.statuses.length ? 1 : 0) + (f.due !== 'any' ? 1 : 0);
}

/** A local calendar date as YYYY-MM-DD — what `due_date` is stored as. */
function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether a task's due date falls in the chosen window. Dates compare as text. */
function dueMatches(t: TaskView, f: TaskFilters): boolean {
  const due = t.due ? t.due.slice(0, 10) : null;
  const now = new Date();
  const today = isoDay(now);
  switch (f.due) {
    case 'any':
      return true;
    case 'none':
      return !due;
    case 'overdue':
      return Boolean(due && due < today && t.status !== 'done');
    case 'today':
      return due === today;
    case 'week': {
      // Monday to Sunday of the current week.
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return Boolean(due && due >= isoDay(monday) && due <= isoDay(sunday));
    }
    case 'next7': {
      const end = new Date(now);
      end.setDate(now.getDate() + 7);
      return Boolean(due && due >= today && due <= isoDay(end));
    }
    case 'range':
      if (!due) return !f.from && !f.to;
      return (!f.from || due >= f.from) && (!f.to || due <= f.to);
  }
}

function IconFilter(p: { width?: number; height?: number }) {
  return (
    <svg width={p.width ?? 16} height={p.height ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z" />
    </svg>
  );
}

/**
 * Whose work, in what state, and when it is due — in a drop-down beside the
 * other board controls rather than a bar across the page.
 *
 * The Mine/All toggle answers "mine or the studio's"; this answers what a
 * coordinator asks in the morning: what is Joanna carrying, what is
 * blocked, what falls due this week, what slipped.
 */
function TaskFilterMenu({
  filters, onChange, team, shown, total,
}: {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  team: TeamMember[];
  shown: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<TaskFilters>) => onChange({ ...filters, ...patch });
  const toggleStatus = (s: TaskStatus) =>
    set({ statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] });

  // Closed by a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = 'mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint';
  const field = 'input h-8 w-full py-0 text-[12.5px]';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={count ? `Filters (${count} on)` : 'Filter tasks'}
        title={count ? `${shown} of ${total} tasks shown` : 'Filter by person, status or due date'}
        className={`focusable relative grid h-8 w-8 place-items-center rounded-lg border transition-colors ${
          count || open
            ? 'border-brass bg-brass/10 text-brass-deep'
            : 'border-line bg-surface text-ink-soft hover:border-ink-faint hover:text-ink'
        }`}
      >
        <IconFilter />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brass px-1 text-[9.5px] font-bold leading-none text-white ring-2 ring-surface">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter tasks"
          className="popover absolute right-0 top-full z-40 mt-1.5 w-[300px] overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5">
            <span className="text-[13px] font-semibold text-ink">Filters</span>
            <span className="text-[11.5px] text-ink-faint">{count ? `${shown} of ${total}` : `${total} tasks`}</span>
          </div>

          <div className="space-y-3.5 px-4 py-3.5">
            <div>
              <label className={label} htmlFor="filter-person">Person</label>
              <select
                id="filter-person"
                className={`${field} ${filters.person ? 'border-brass' : ''}`}
                value={filters.person}
                onChange={(e) => set({ person: e.target.value })}
              >
                <option value="">Everyone</option>
                <option value="unassigned">Unassigned</option>
                {team.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name ?? m.email ?? 'Teammate'}</option>
                ))}
              </select>
            </div>

            <div>
              <span className={label}>Status</span>
              <div className="flex flex-wrap gap-1.5">
                {TASK_STATUSES.map((s) => {
                  const on = filters.statuses.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleStatus(s)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                        on ? 'border-brass bg-brass/15 text-ink' : 'border-line text-ink-soft hover:border-ink-faint hover:text-ink'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${COLUMN_DOT[s] ?? 'bg-ink-faint'}`} aria-hidden="true" />
                      {TASK_STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className={label} htmlFor="filter-due">Due</label>
              <select
                id="filter-due"
                className={`${field} ${filters.due !== 'any' ? 'border-brass' : ''}`}
                value={filters.due}
                onChange={(e) => set({ due: e.target.value as DueFilter })}
              >
                {DUE_OPTIONS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
              {filters.due === 'range' && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    aria-label="Due from"
                    className={field}
                    value={filters.from}
                    max={filters.to || undefined}
                    onChange={(e) => set({ from: e.target.value })}
                  />
                  <input
                    type="date"
                    aria-label="Due to"
                    className={field}
                    value={filters.to}
                    min={filters.from || undefined}
                    onChange={(e) => set({ to: e.target.value })}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-line-soft bg-sunk/40 px-4 py-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!count}
              onClick={() => onChange(NO_FILTERS)}
            >
              Clear all
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Tasks() {
  const { data: tasks, isLoading } = useTasks();
  const { data: team } = useTeam();
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const backfill = useBackfillTasks();
  const { user, may } = useAuth();
  const [showDone, setShowDone] = useState(false);
  // Which task's detail panel is open, if any.
  //
  // Seeded from ?task=, so a task named in an answer, a digest or a link
  // someone pasted opens on the task itself rather than on the board with
  // the reader left to find it.
  const [openTask, setOpenTask] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('task'),
  );

  // Drop the parameter once it has been used: it has done its job, and
  // leaving it in the URL would re-open the panel on every later close.
  useEffect(() => {
    if (!openTask) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('task')) return;
    url.searchParams.delete('task');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [openTask]);

  // The board answers "where is everything", the list "what do I owe".
  // Remembered per browser so the studio is not re-choosing every visit.
  const [view, setView] = useState<'board' | 'list'>(() => {
    try {
      return localStorage.getItem('tasks.view') === 'list' ? 'list' : 'board';
    } catch {
      return 'board';
    }
  });

  const chooseView = (next: 'board' | 'list') => {
    setView(next);
    try {
      localStorage.setItem('tasks.view', next);
    } catch {
      // A private window refuses storage; the choice just will not stick.
    }
  };

  // Whoever runs the board, by role or by seat — see canManageTasks.
  const supervisor = canManageTasks(user?.role ?? null, user?.seat ?? null);

  // Mine first. The board opened on the whole studio, so the answer to
  // "what do I owe" was to read every column and pick your own cards out.
  // Unassigned work stays visible in "Mine": it is nobody's yet, and
  // claiming it is exactly what the board is for.
  const [scope] = useScope();
  const isMine = (t: TaskView) => t.assignedTo === user?.id || !t.assignedTo;

  // Remembered for the tab, so opening a task and coming back keeps them.
  const [filters, setFilters] = useState<TaskFilters>(() => {
    try {
      const saved = sessionStorage.getItem('tasks.filters');
      const parsed = saved ? { ...NO_FILTERS, ...(JSON.parse(saved) as Partial<TaskFilters>) } : NO_FILTERS;
      return { ...parsed, statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [] };
    } catch {
      return NO_FILTERS;
    }
  });
  const changeFilters = (next: TaskFilters) => {
    setFilters(next);
    try {
      sessionStorage.setItem('tasks.filters', JSON.stringify(next));
    } catch {
      // Private window: the filters just will not survive a reload.
    }
  };

  // Choosing a person is a question about the whole studio, so it looks
  // past Mine — "show me Joanna's work" should not come back empty because
  // the toggle was left on Mine.
  const byPerson = (t: TaskView) =>
    !filters.person ||
    (filters.person === 'unassigned' ? !t.assignedTo : t.assignedTo === filters.person);
  const base = filters.person ? tasks : scope === 'mine' ? tasks.filter(isMine) : tasks;
  const byStatus = (t: TaskView) => !filters.statuses.length || filters.statuses.includes(t.status);
  const scoped = base.filter((t) => byPerson(t) && byStatus(t) && dueMatches(t, filters));
  const unfilteredCount = base.length;
  const filtering = activeFilterCount(filters) > 0;
  const mineCount = tasks.filter((t) => isMine(t) && OPEN_STATUSES.includes(t.status)).length;
  const allCount = tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length;

  const visible =
    showDone || filters.statuses.includes('done') ? scoped : scoped.filter((t) => OPEN_STATUSES.includes(t.status));

  // The board always shows its Done column — that is what a board is for, and
  // "Hide closed" was written for the list. Only the most recently FINISHED
  // work, so a year of it does not bury the columns that still need a person.
  // Ordered by when it was finished, not when it was raised: a task from last
  // month closed this morning used to fall outside the twelve and vanish from
  // the board instead of landing in Done.
  const DONE_ON_BOARD = 12;
  const finishedAt = (t: TaskView) => (t.completedAt ? Date.parse(t.completedAt) : 0);
  const boardTasks = [
    ...scoped.filter((t) => OPEN_STATUSES.includes(t.status)),
    ...scoped
      .filter((t) => t.status === 'done')
      .sort((a, b) => finishedAt(b) - finishedAt(a))
      .slice(0, DONE_ON_BOARD),
  ];

  /** Anyone can work their own queue or claim an unowned task; only a
   *  supervisor can move work between other people. */
  const mayEdit = (assignedTo: string | null) =>
    supervisor || !assignedTo || assignedTo === user?.id;

  /**
   * Removing a task for good is the studio's decision, not a teammate's —
   * the server holds the same rule, this only decides whether to offer it.
   * Confirmed first: there is no undo, and the card sits under the cursor
   * during a drag.
   */
  const mayDelete = may('tasks', 'delete');
  const onDelete = (t: TaskView) => {
    if (!window.confirm(`Delete "${t.title}"? This cannot be undone.`)) return;
    remove.mutate(t.id);
  };

  return (
    <Page>
      <PageHeading
        title="Tasks"
        action={
          <div className="flex items-center gap-2">
            <ScopeToggle mine={mineCount} all={allCount} />
            <TaskFilterMenu
              filters={filters}
              onChange={changeFilters}
              team={team}
              shown={view === 'board' ? boardTasks.length : visible.length}
              total={unfilteredCount}
            />
            {supervisor && (
              <button
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending}
                aria-label="Scan email already in the system for tasks"
                title={
                  backfill.isPending
                    ? 'Reading email…'
                    : backfill.data && backfill.data.remaining > 0
                      ? `Keep reading — ${backfill.data.remaining} left`
                      : 'Scan email already in the system for tasks'
                }
                className="focusable relative grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-50"
              >
                <IconMailScan width={16} height={16} className={backfill.isPending ? 'animate-pulse' : ''} />
                {/* How much is left is the one thing the icon cannot say,
                    and the reason to press it a second time. */}
                {!backfill.isPending && !!backfill.data?.remaining && (
                  <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brass px-1 text-[9.5px] font-bold leading-none text-white ring-2 ring-surface">
                    {backfill.data.remaining > 99 ? '99+' : backfill.data.remaining}
                  </span>
                )}
              </button>
            )}

            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="How to show the tasks">
              {([
                { v: 'board' as const, label: 'Board', Icon: IconBoard },
                { v: 'list' as const, label: 'List', Icon: IconList },
              ]).map(({ v, label, Icon }) => (
                <button
                  key={v}
                  onClick={() => chooseView(v)}
                  aria-pressed={view === v}
                  aria-label={label}
                  title={label}
                  className={`focusable grid h-7 w-7 place-items-center rounded-md transition-colors ${
                    view === v ? 'bg-brass text-white' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <Icon width={15} height={15} />
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowDone((v) => !v)}
              aria-pressed={showDone}
              aria-label={showDone ? 'Hide closed tasks' : 'Show closed tasks'}
              title={showDone ? 'Hide closed tasks' : 'Show closed tasks'}
              className={`focusable grid h-8 w-8 place-items-center rounded-lg border transition-colors ${
                showDone
                  ? 'border-brass bg-brass/10 text-brass-deep'
                  : 'border-line bg-surface text-ink-soft hover:border-ink-faint hover:text-ink'
              }`}
            >
              {/* The icon is the ACTION, not the state — matching the label
                  beside it, which already reads "Hide closed tasks" when
                  they are showing. An eye means "click to reveal". */}
              {showDone ? <IconEyeOff width={16} height={16} /> : <IconEye width={16} height={16} />}
            </button>
          </div>
        }
      />

      {(backfill.data || backfill.error) && (
        <div className="-mt-2">
          <ScanResult result={backfill.data} error={backfill.error as Error | null} />
        </div>
      )}


      {view === 'board' && (
        <>
          {isLoading && (
            <div className="py-12 text-center text-[13px] text-ink-faint">Loading…</div>
          )}
          {/* Only a studio with no tasks at all gets the empty-state box.
              Filtered down to nothing, the board keeps its columns — the
              layout should not jump because a filter came back empty. */}
          {!isLoading && boardTasks.length === 0 && !filtering && (
            <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
              No tasks yet. They appear here as the system reads email and spots work that needs doing.
            </div>
          )}
          {!isLoading && boardTasks.length === 0 && filtering && (
            <div className="flex items-center gap-2 text-[12.5px] text-ink-soft">
              <span>No tasks match these filters.</span>
              <button type="button" className="font-medium text-brass hover:underline" onClick={() => changeFilters(NO_FILTERS)}>
                Clear filters
              </button>
            </div>
          )}
          {!isLoading && (boardTasks.length > 0 || filtering) && (
            <Board
              tasks={boardTasks}
              team={team}
              mayEdit={mayEdit}
              onMove={(id, status) => update.mutate({ id, status })}
              onAssign={(id, assigned_to) => update.mutate({ id, assigned_to })}
              onDue={(id, due_date) => update.mutate({ id, due_date })}
              onOpen={setOpenTask}
              onDelete={mayDelete ? onDelete : undefined}
            />
          )}
          {update.isError && (
            <div className="mt-4 text-[12.5px] text-crit">{(update.error as Error).message}</div>
          )}
        </>
      )}

      {view === 'list' && (
      <Card>
        <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
          <h2 className="text-[16px] font-semibold text-ink">
            {showDone ? 'All tasks' : 'Open work'}
          </h2>
          <span className="text-[12px] text-ink-faint">{visible.length} shown</span>
        </div>
        <ul className="divide-y divide-line-soft">
          {isLoading && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</li>
          )}
          {!isLoading && visible.length === 0 && (
            <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
              {filtering
                ? 'No tasks match these filters.'
                : 'No open tasks. They appear here as the system reads email and spots work that needs doing.'}
            </li>
          )}
          {visible.map((t) => (
            <li key={t.id} className="flex flex-col gap-3 px-5 py-5 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3 sm:w-40">
                <Pill tone={tone[t.kind]}>{TASK_KIND_LABELS[t.kind]}</Pill>
              </div>

              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">{t.title}</div>
                {t.detail && <div className="text-[13px] text-ink-soft">{t.detail}</div>}
                <div className="mt-0.5 text-[11px] text-ink-faint">
                  {t.project} · raised {t.age}
                  {t.due && <> · due {shortDate(t.due)}</>}
                  {t.status === 'done' && t.completedAt ? (
                    <>
                      {' '}· done {shortDate(t.completedAt)}
                      {finishedLabel(t.daysEarly) && <>, {finishedLabel(t.daysEarly)}</>}
                      {t.closedNote && <span title={t.closedNote}> · closed automatically</span>}
                    </>
                  ) : (
                    t.status !== 'open' && <> · {TASK_STATUS_LABELS[t.status]}</>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 self-start sm:self-auto">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                    t.assignedTo ? 'bg-brass/10 text-brass-deep' : 'bg-sunk text-ink-faint'
                  }`}
                  title={t.assignee}
                >
                  {t.assignedTo ? t.assignee.slice(0, 1).toUpperCase() : '?'}
                </span>

                {supervisor ? (
                  <select
                    className="input"
                    value={t.assignedTo ?? ''}
                    onChange={(e) => update.mutate({ id: t.id, assigned_to: e.target.value || null })}
                  >
                    <option value="">Unassigned</option>
                    {team.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name ?? m.email ?? 'Teammate'}
                      </option>
                    ))}
                  </select>
                ) : !t.assignedTo ? (
                  <button
                    onClick={() => update.mutate({ id: t.id, assigned_to: user?.id ?? null })}
                    className="btn-secondary btn-sm"
                  >
                    Claim
                  </button>
                ) : (
                  <span className="text-[12.5px] text-ink-faint">{t.assignee}</span>
                )}

                <select
                  className="input"
                  value={t.status}
                  disabled={!mayEdit(t.assignedTo)}
                  title={mayEdit(t.assignedTo) ? undefined : "Only a principal or coordinator can change someone else's task"}
                  onChange={(e) => update.mutate({ id: t.id, status: e.target.value as TaskStatus })}
                >
                  {TASK_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {TASK_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
        {backfill.isSuccess && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-soft">
            {backfill.data.created > 0
              ? `Raised ${backfill.data.created} task(s) from ${backfill.data.scanned} email(s).`
              : `Read ${backfill.data.scanned} email(s); none needed a task.`}
          </div>
        )}
        {backfill.isError && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-crit">
            {(backfill.error as Error).message}
          </div>
        )}
        {update.isError && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-crit">
            {(update.error as Error).message}
          </div>
        )}
        <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
          Tasks are assigned by role, then by seat, and finally to whoever runs the board — so
          work is only left unassigned when there is nobody at all to take it.
        </div>
      </Card>
      )}

      {openTask && <TaskPanel id={openTask} onClose={() => setOpenTask(null)} />}
    </Page>
  );
}
