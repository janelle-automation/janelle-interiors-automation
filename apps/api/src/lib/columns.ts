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
 * (`tasks.completed_at`, 0015).
 */
const known = new Map<string, boolean>();
const probes = new Map<string, Promise<boolean>>();

async function ask(table: string, column: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { error } = await supabaseAdmin.from(table).select(column).limit(1);
    // Postgres reports an unknown column as 42703; PostgREST wraps it in a
    // message naming the column. Anything else (a network blip, RLS) is not
    // evidence the column is missing, so it is not cached as a no.
    if (!error) return true;
    const missing =
      error.code === '42703' ||
      new RegExp(`column .*${column}.* does not exist`, 'i').test(error.message);
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
  const answer = known.get(key);
  if (answer !== undefined) return answer;

  // Share one probe between concurrent callers rather than firing several.
  let probe = probes.get(key);
  if (!probe) {
    probe = ask(table, column).then((result) => {
      known.set(key, result);
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

/** Whether tasks record when their current owner got them — migration 0016. */
export function hasTaskAssignment(): Promise<boolean> {
  return hasColumn('tasks', 'assigned_at');
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

/**
 * The profile columns to select, with `seat` only when it exists.
 * `base` is everything the caller needs regardless.
 */
export async function profileColumns(base: string): Promise<string> {
  return (await hasSeatColumn()) ? `${base}, seat` : base;
}

/** Let a test or a freshly applied migration be noticed without a restart. */
export function forgetColumns(): void {
  known.clear();
  probes.clear();
}
