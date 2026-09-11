import { useState } from 'react';
import {
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  canSupervise,
  type TaskKind,
  type TaskStatus,
} from '@janelle/shared';
import { PageHeading, Card, Pill, shortDate } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useBackfillTasks, useTasks, useTeam, useUpdateTask } from '../lib/queries';

const tone: Record<TaskKind, 'crit' | 'warn' | 'brass' | 'neutral'> = {
  quote_request: 'brass',
  order_followup: 'warn',
  client_approval: 'crit',
  spec_review: 'brass',
  scheduling: 'warn',
  admin: 'neutral',
};

/** Statuses a row can still be moved to; done/cancelled drop out of the list filter. */
const OPEN_STATUSES: TaskStatus[] = ['open', 'in_progress', 'blocked'];

export default function Tasks() {
  const { data: tasks, isLoading } = useTasks();
  const { data: team } = useTeam();
  const update = useUpdateTask();
  const backfill = useBackfillTasks();
  const { user } = useAuth();
  const [showDone, setShowDone] = useState(false);

  const supervisor = canSupervise(user?.role ?? null);
  const visible = showDone ? tasks : tasks.filter((t) => OPEN_STATUSES.includes(t.status));

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
            <button onClick={() => setShowDone((v) => !v)} className="btn-secondary btn-sm">
              {showDone ? 'Hide closed' : 'Show closed'}
            </button>
          </div>
        }
      />
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
          Tasks are assigned by role. When nobody holds the role, the task waits here unassigned.
        </div>
      </Card>
    </>
  );
}
