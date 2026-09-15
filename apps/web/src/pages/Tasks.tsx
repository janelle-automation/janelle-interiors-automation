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
import { PageHeading, Card, Pill, shortDate } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import {
  useAddSubtask, useBackfillTasks, useTaskDetail, useTasks, useTeam, useUpdateTask,
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

/** Labels for the nudges raised against a task, in its history. */
const HISTORY_LABELS: Partial<Record<FollowUpType, string>> = {
  task_overdue: 'Owner reminded',
  task_escalation: 'Escalated to the principal',
  task_unowned: 'Chased for an owner',
  task_no_next_step: 'Chased for a next step',
  task_no_due_date: 'Chased for a due date',
};

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
  const done = (data?.subtasks ?? []).filter((s) => s.status === 'done').length;
  const total = data?.subtasks.length ?? 0;

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    addSubtask.mutate(title, { onSuccess: () => setDraft('') });
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-ink/40"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Task detail"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-line bg-canvas shadow-xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line-soft bg-canvas px-5 py-4">
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
                    Closed{t.updated_at && <> · {shortDate(t.updated_at)}</>}
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
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brass/15 text-[10.5px] font-bold text-brass-deep"
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
}: {
  t: TaskView;
  mayEdit: boolean;
  team: TeamMember[];
  onDragStart: (id: string) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
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
      className={`rounded-lg border bg-surface p-3 ${mayEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${
        t.overdue ? 'border-crit/50' : 'border-line-soft'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <Pill tone={tone[t.kind]}>{TASK_KIND_LABELS[t.kind]}</Pill>
        {t.overdue && <Pill tone="crit">Overdue</Pill>}
      </div>

      <p className="text-[13.5px] font-medium leading-snug text-ink">{t.title}</p>

      {/* The SOP wants one next step on every task; showing the gap on the
          card is what makes it get filled in. */}
      {t.nextStep ? (
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
          filled. Inputs swallow the drag so picking a date is not a drag. */}
      <div
        className="mt-2.5 flex flex-wrap items-center gap-2"
        draggable={false}
        onDragStart={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {mayEdit ? (
          <select
            className="input input-sm min-w-0 flex-1"
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
        ) : unowned ? (
          <span className="text-[11.5px] font-semibold text-warn">Unassigned</span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
            <Initials name={t.assignee} />
            {t.assignee}
          </span>
        )}

        {mayEdit ? (
          <input
            type="date"
            className={`input input-sm ${t.overdue ? 'text-crit' : ''}`}
            value={t.due ?? ''}
            aria-label={`Due date for "${t.title}"`}
            onChange={(e) => onDue(t.id, e.target.value || null)}
          />
        ) : (
          <span className={`text-[11.5px] ${t.overdue ? 'font-semibold text-crit' : 'text-ink-faint'}`}>
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
}: {
  tasks: TaskView[];
  team: TeamMember[];
  mayEdit: (assignedTo: string | null) => boolean;
  onMove: (id: string, status: TaskStatus) => void;
  onAssign: (id: string, assignedTo: string | null) => void;
  onDue: (id: string, due: string | null) => void;
  onOpen: (id: string) => void;
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
            className={`rounded-xl border p-3 transition-colors ${
              over === col.status ? 'border-brass bg-brass/5' : 'border-line-soft bg-sunk/30'
            }`}
          >
            <header className="mb-3 flex items-baseline justify-between px-1">
              <h3 className="text-[13px] font-semibold text-ink">{TASK_STATUS_LABELS[col.status]}</h3>
              <span className="text-[11.5px] text-ink-faint">{items.length}</span>
            </header>

            <ul className="flex flex-col gap-2">
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
                />
              ))}
              {items.length === 0 && (
                <li className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[12px] text-ink-faint">
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

export default function Tasks() {
  const { data: tasks, isLoading } = useTasks();
  const { data: team } = useTeam();
  const update = useUpdateTask();
  const backfill = useBackfillTasks();
  const { user } = useAuth();
  const [showDone, setShowDone] = useState(false);
  // Which task's detail panel is open, if any.
  const [openTask, setOpenTask] = useState<string | null>(null);

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
  const visible = showDone ? tasks : tasks.filter((t) => OPEN_STATUSES.includes(t.status));

  // The board always shows its Done column — that is what a board is for, and
  // "Hide closed" was written for the list. Only the newest finished work,
  // so a year of it does not bury the columns that still need a person.
  const DONE_ON_BOARD = 12;
  const boardTasks = [
    ...tasks.filter((t) => OPEN_STATUSES.includes(t.status)),
    ...tasks.filter((t) => t.status === 'done').slice(0, DONE_ON_BOARD),
  ];

  /** Anyone can work their own queue or claim an unowned task; only a
   *  supervisor can move work between other people. */
  const mayEdit = (assignedTo: string | null) =>
    supervisor || !assignedTo || assignedTo === user?.id;

  return (
    <>
      <PageHeading
        title="Tasks"
        sub="Raised automatically from email and assigned by role. Reassign or close anything here — nothing is sent to anyone."
        action={
          <div className="flex items-center gap-2">
            {supervisor && (
              <button
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending}
                className="btn-secondary btn-sm"
                title="Raise tasks from email already in the system"
              >
                {backfill.isPending ? 'Reading email…' : 'Scan existing email'}
              </button>
            )}
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(['board', 'list'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => chooseView(v)}
                  aria-pressed={view === v}
                  className={`focusable px-3 py-1.5 text-[12.5px] font-medium capitalize ${
                    view === v ? 'bg-brass text-white' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            <button onClick={() => setShowDone((v) => !v)} className="btn-secondary btn-sm">
              {showDone ? 'Hide closed' : 'Show closed'}
            </button>
          </div>
        }
      />

      {view === 'board' && (
        <>
          {isLoading && (
            <div className="py-12 text-center text-[13px] text-ink-faint">Loading…</div>
          )}
          {!isLoading && boardTasks.length === 0 && (
            <div className="rounded-xl border border-dashed border-line py-14 text-center text-[14px] text-ink-soft">
              No tasks yet. They appear here as the system reads email and spots work that needs doing.
            </div>
          )}
          {!isLoading && boardTasks.length > 0 && (
            <Board
              tasks={boardTasks}
              team={team}
              mayEdit={mayEdit}
              onMove={(id, status) => update.mutate({ id, status })}
              onAssign={(id, assigned_to) => update.mutate({ id, assigned_to })}
              onDue={(id, due_date) => update.mutate({ id, due_date })}
              onOpen={setOpenTask}
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
              No open tasks. They appear here as the system reads email and spots work that needs doing.
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
                  {t.status !== 'open' && <> · {TASK_STATUS_LABELS[t.status]}</>}
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
    </>
  );
}
