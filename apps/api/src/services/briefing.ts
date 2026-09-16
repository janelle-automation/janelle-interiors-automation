import {
  ASSISTANT_NAME,
  canManageTasks,
  canSupervise,
  type AssistantAnswer,
  type AssistantItem,
} from '@janelle/shared';
import { purchaseOrderRow, taskRow, type AssistantContext } from './assistant.js';

/**
 * The briefing Jenny opens with: what needs THIS person, today.
 *
 * A personal assistant does not wait to be asked what is on fire. So when
 * someone opens her, the first thing on screen is theirs — their overdue
 * work, what is due today, and whatever their seat exists to catch — before
 * they have typed a word.
 *
 * Built straight from the database with no model call. It is shown on every
 * first open of the day, and a briefing that took eight seconds and cost a
 * Claude call each time would be one nobody waited for. It is also exactly
 * the kind of answer that must never be paraphrased: counts and dates.
 *
 * Everything runs on the caller's own client, so it counts only what row-level
 * security lets them see.
 */

const LIVE = ['open', 'in_progress', 'blocked'];

/** How many rows of one kind the briefing shows before counting the rest. */
const SHOW = { overdue: 5, dueToday: 3, latePos: 4 };

type Db = AssistantContext['db'];

/** A count query that reports null rather than throwing — a briefing degrades, it does not fail. */
async function count(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count: n, error } = await build();
    return error ? 0 : (n ?? 0);
  } catch {
    return 0;
  }
}

async function rowsOf<T>(build: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await build();
    return error || !Array.isArray(data) ? [] : (data as T[]);
  } catch {
    return [];
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const spoken = (n: number) => NUMBER_WORDS[n] ?? String(n);

function greeting(hour: number | null): string {
  if (hour === null) return 'Hello';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const daysLate = (isoDay: string) =>
  Math.max(1, Math.floor((Date.now() - new Date(`${isoDay}T12:00:00Z`).getTime()) / 86400_000));

/** A line that stands for a count and opens the screen that holds the rows. */
function summaryRow(kind: AssistantItem['kind'], title: string, tone: AssistantItem['tone']): AssistantItem {
  return { kind, title, tone };
}

interface BriefingOptions {
  /** The person's local hour, 0–23, for the greeting. The server does not know their timezone. */
  hour?: number | null;
}

export async function buildBriefing(ctx: AssistantContext, opts: BriefingOptions = {}): Promise<AssistantAnswer> {
  const { db, userId, role } = ctx;
  const seat = ctx.seat ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const first = ctx.name.split(/[\s@]/)[0] || ctx.name;

  // What each seat exists to catch. The rest of the studio's troubles belong
  // to someone else, and a briefing that lists everything is a dashboard.
  const runsBoard = canManageTasks(role, seat);
  const supervises = canSupervise(role);
  const watchesOrders = role === 'procurement' || role === 'coordinator';
  const watchesSpecs = role === 'designer';
  const chasesHygiene = runsBoard || seat === 'pm_support';

  const head = (table: string) => (db as Db).from(table).select('*', { count: 'exact', head: true });

  type TaskRowData = {
    id: string; title: string; status: string; due_date: string | null;
    projects: { name: string } | null;
  };
  type PoRowData = {
    id: string; po_number: string | null; status: string; amount: number | null; eta: string | null;
    vendors: { name: string } | null; projects: { name: string } | null;
  };

  const [mine, unowned, noNextStep, drafts, escalations, clientsWaiting, latePos, specGaps] = await Promise.all([
    rowsOf<TaskRowData>(() =>
      db
        .from('tasks')
        .select('id, title, status, due_date, projects(name)')
        .eq('assigned_to', userId)
        .in('status', LIVE)
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(60),
    ),
    runsBoard ? count(() => head('tasks').in('status', LIVE).is('assigned_to', null)) : Promise.resolve(0),
    chasesHygiene
      ? rowsOf<{ next_step: string | null }>(() => db.from('tasks').select('next_step').in('status', LIVE)).then(
          (r) => r.filter((t) => !(t.next_step ?? '').trim()).length,
        )
      : Promise.resolve(0),
    supervises ? count(() => head('drafts')) : Promise.resolve(0),
    supervises
      ? count(() => head('follow_ups').eq('type', 'task_escalation').in('status', ['open', 'drafted']))
      : Promise.resolve(0),
    role === 'principal'
      ? count(() =>
          head('follow_ups').in('type', ['client_approval_overdue', 'client_waiting']).in('status', ['open', 'drafted']),
        )
      : Promise.resolve(0),
    watchesOrders
      ? rowsOf<PoRowData>(() =>
          db
            .from('purchase_orders')
            .select('id, po_number, status, amount, eta, vendors(name), projects(name)')
            .lt('eta', today)
            .not('status', 'in', '("received","cancelled")')
            .order('eta', { ascending: true })
            .limit(20),
        )
      : Promise.resolve([] as PoRowData[]),
    watchesSpecs ? count(() => head('spec_gaps').eq('resolved', false)) : Promise.resolve(0),
  ]);

  const overdue = mine.filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked');
  const dueToday = mine.filter((t) => t.due_date === today && t.status !== 'blocked');

  // Every one of these is theirs, so an Owner column would repeat their own
  // name down the whole list.
  const asTask = (t: TaskRowData) => {
    const row = taskRow({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: ctx.name, project: t.projects?.name ?? null });
    return { ...row, fields: row.fields?.filter((f) => f.label !== 'Owner') };
  };

  const items: AssistantItem[] = [
    ...overdue.slice(0, SHOW.overdue).map(asTask),
    ...dueToday.slice(0, SHOW.dueToday).map((t) => ({ ...asTask(t), meta: 'due today', tone: 'warn' as const })),
    ...latePos.slice(0, SHOW.latePos).map((p) =>
      purchaseOrderRow({
        id: p.id,
        po: p.po_number,
        vendor: p.vendors?.name ?? 'Unknown vendor',
        project: p.projects?.name ?? 'Unassigned',
        amount: p.amount,
        expected: p.eta,
        status: p.status,
        late: true,
      }),
    ),
  ];

  // Counts that stand for a whole screen. Worst first: people waiting on
  // the studio, then work that has stalled, then the routine.
  if (clientsWaiting) items.push(summaryRow('follow_up', `${plural(clientsWaiting, 'client is', 'clients are')} waiting on the studio`, 'crit'));
  if (escalations) items.push(summaryRow('follow_up', `${plural(escalations, 'escalation', 'escalations')} to look at`, 'crit'));
  if (unowned) items.push(summaryRow('task', `${plural(unowned, 'task has', 'tasks have')} nobody on ${unowned === 1 ? 'it' : 'them'}`, 'warn'));
  if (noNextStep) items.push(summaryRow('task', `${plural(noNextStep, 'task is', 'tasks are')} missing a next step`, 'neutral'));
  if (specGaps) items.push(summaryRow('project', `${plural(specGaps, 'spec gap is', 'spec gaps are')} still open`, 'warn'));
  if (drafts) items.push(summaryRow('draft', `${plural(drafts, 'draft is', 'drafts are')} ready to review and send`, 'neutral'));

  const hidden =
    Math.max(0, overdue.length - SHOW.overdue) +
    Math.max(0, dueToday.length - SHOW.dueToday) +
    Math.max(0, latePos.length - SHOW.latePos);

  // "Things", counted as a person would: each late task is one, each
  // count row is one — five drafts waiting is one thing to go and do.
  const things = overdue.length + dueToday.length + latePos.length + items.filter((i) => !i.id).length;
  const hello = `${greeting(opts.hour ?? null)}, ${first}.`;

  let lead: string;
  let speech: string;
  if (things === 0) {
    lead = `${hello} Nothing needs you right now.`;
    speech = `${hello} Nothing needs you right now.`;
  } else {
    const worst = overdue[0];
    const lateBy = worst?.due_date && worst.due_date < today ? `, ${plural(daysLate(worst.due_date), 'day', 'days')} late` : '';
    const pressing = worst
      ? ` The most pressing is “${worst.title}”${worst.status === 'blocked' ? ', which is blocked' : lateBy}.`
      : latePos[0]
        ? ` The most pressing is ${latePos[0].po_number ?? 'an order'} from ${latePos[0].vendors?.name ?? 'a vendor'}, past its delivery date.`
        : '';
    lead = `${hello} ${spoken(things)} ${things === 1 ? 'thing needs' : 'things need'} you today.${pressing}`;
    speech = lead.replace(/[“”]/g, '');
  }

  const suggestions: string[] = [];
  if (overdue.length || dueToday.length) suggestions.push('What should I tackle first?');
  if (role === 'principal') suggestions.push('What are clients waiting on?');
  if (supervises) suggestions.push("Read me this morning's digest");
  if (watchesOrders) suggestions.push('Which orders are late, and who do I chase?');
  if (watchesSpecs) suggestions.push('Which spec gaps are blocking orders?');
  if (chasesHygiene && noNextStep) suggestions.push('Which tasks are missing a next step?');
  suggestions.push("What's on my plate this week?");

  return {
    lead,
    items,
    more: hidden,
    caveat: null,
    speech,
    sources: ['your tasks', ...(latePos.length ? ['purchase orders'] : []), ...(drafts ? ['drafts'] : [])],
    suggestions: [...new Set(suggestions)].slice(0, 3),
  };
}

/** Said when there is no studio to brief on — before setup, or signed in without a profile. */
export function emptyBriefing(name: string, hour: number | null): AssistantAnswer {
  const first = name.split(/[\s@]/)[0] || name;
  const lead = `${greeting(hour)}, ${first}. I'm ${ASSISTANT_NAME} — ask me about any project, task, order or email.`;
  return { lead, items: [], more: 0, caveat: null, speech: lead, sources: [], suggestions: ['List our projects', 'What is overdue?'] };
}
