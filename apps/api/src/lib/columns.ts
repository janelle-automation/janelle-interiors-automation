import { supabaseAdmin } from './supabase.js';

/**
 * Whether a column that a migration adds is present yet.
 *
 * Deploying and migrating are separate acts, and this studio's connection
 * string has to be pasted in by hand before any migration can run at all —
 * so new code routinely reaches production against an older schema.
 * Selecting a column Postgres does not have is a hard error, and
 * `requireAuth` reads the profile on EVERY request: one unguarded `seat`
 * there would take the whole API down until somebody ran the migration.
 *
 * Probed once per column and remembered. Anything depending on a column
 * that is not there yet degrades to how the system behaved before it
 * existed, rather than failing.
 *
 * Covers seats (`profiles.seat`, 0008), subtasks
 * (`tasks.parent_task_id`, 0009) and task completion
 * (`tasks.completed_at`, 0015; `tasks.completed_by`, 0032).
 */
/**
 * How long a "not there yet" is believed.
 *
 * A yes is permanent: nothing in this app drops a column, so once a probe
 * has seen one it can stop asking forever. A no is not — it is a statement
 * about the schema as it was a moment ago, and the whole point of the
 * deploy-then-migrate split this file exists for is that the schema
 * changes underneath a process that is already running.
 *
 * Caching the no forever is what made every migration need a restart to be
 * noticed: 0033 was applied, the API had already probed `task_comments`
 * while it did not exist, and the panel went on saying "needs migration
 * 0033 applied" to someone who had just applied it. `forgetColumns` was
 * written for this and nothing ever called it.
 *
 * A minute is the trade: one wasted probe per minute per absent column, on
 * features that are switched off anyway, against a migration taking effect
 * on its own.
 */
const MISS_TTL_MS = 60_000;

const known = new Map<string, { yes: boolean; at: number }>();
const probes = new Map<string, Promise<boolean>>();

async function ask(table: string, column: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { error } = await supabaseAdmin.from(table).select(column).limit(1);
    // Postgres reports an unknown column as 42703; PostgREST wraps it in a
    // message naming the column. Anything else (a network blip, RLS) is not
    // evidence the column is missing, so it is not cached as a no.
    if (!error) return true;
    // A table a migration has not created yet is the same answer as a column
    // it has not added: the feature is not there. Reported differently —
    // 42P01 from Postgres, PGRST205 from PostgREST's schema cache — and
    // without this the probe fell through to the throw below and logged an
    // error on the way to the same `false`.
    const missing =
      error.code === '42703' ||
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      new RegExp(`column .*${column}.* does not exist`, 'i').test(error.message) ||
      new RegExp(`relation .*${table}.* does not exist`, 'i').test(error.message);
    if (missing) return false;
    throw new Error(error.message);
  } catch (err) {
    console.error(`[columns] could not check for ${table}.${column}:`, (err as Error).message);
    // Assume absent: the cost of being wrong that way is a feature sitting
    // idle, rather than every request failing.
    return false;
  }
}

/** Whether a column a later migration adds is present yet. Probed once. */
export async function hasColumn(table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`;
  const seen = known.get(key);
  if (seen && (seen.yes || Date.now() - seen.at < MISS_TTL_MS)) return seen.yes;

  // Share one probe between concurrent callers rather than firing several.
  let probe = probes.get(key);
  if (!probe) {
    probe = ask(table, column).then((result) => {
      known.set(key, { yes: result, at: Date.now() });
      probes.delete(key);
      return result;
    });
    probes.set(key, probe);
  }
  return probe;
}

export function hasSeatColumn(): Promise<boolean> {
  return hasColumn('profiles', 'seat');
}

/** Whether subtasks exist yet — migration 0009. */
export function hasSubtasks(): Promise<boolean> {
  return hasColumn('tasks', 'parent_task_id');
}

/** Whether tasks record when they were finished, and why — migration 0015. */
export function hasTaskCompletion(): Promise<boolean> {
  return hasColumn('tasks', 'completed_at');
}

/**
 * Whether a task can be commented on — migration 0033. Probes the table,
 * not a column: before 0033 neither exists.
 */
export function hasTaskComments(): Promise<boolean> {
  return hasColumn('task_comments', 'id');
}

/** Whether tasks record who closed them — migration 0032. */
export function hasTaskCompletedBy(): Promise<boolean> {
  return hasColumn('tasks', 'completed_by');
}

/** Whether tasks record when their current owner got them — migration 0016. */
export function hasTaskAssignment(): Promise<boolean> {
  return hasColumn('tasks', 'assigned_at');
}

/** Whether tasks carry a category (Design, FF&E…) — migration 0026. */
export function hasTaskCategory(): Promise<boolean> {
  return hasColumn('tasks', 'category');
}

/** Whether mail can belong to one person rather than the studio — 0018. */
export function hasEmailOwner(): Promise<boolean> {
  return hasColumn('emails', 'owner_id');
}

/** Whether a draft can belong to one person rather than the studio — 0018. */
export function hasDraftOwner(): Promise<boolean> {
  return hasColumn('drafts', 'owner_id');
}

/** Whether mail records the sender's own Message-ID — migration 0019. */
export function hasMessageId(): Promise<boolean> {
  return hasColumn('emails', 'message_id');
}

/** Whether a follow-up can be put down for a few days — migration 0017. */
export function hasFollowUpSnooze(): Promise<boolean> {
  return hasColumn('follow_ups', 'snoozed_until');
}

/** Whether a draft records the real Gmail message behind it — migration 0025. */
export function hasDraftGmailMessage(): Promise<boolean> {
  return hasColumn('drafts', 'gmail_message_id');
}

/**
 * The profile columns to select, with `seat` only when it exists.
 * `base` is everything the caller needs regardless.
 */
export async function profileColumns(base: string): Promise<string> {
  return (await hasSeatColumn()) ? `${base}, seat` : base;
}

/**
 * Forget every answer, including the permanent yeses.
 *
 * The TTL above already lets a migration be noticed on its own within the
 * minute; this is for a test that needs it to happen now.
 */
export function forgetColumns(): void {
  known.clear();
  probes.clear();
}
