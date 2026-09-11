import type Anthropic from '@anthropic-ai/sdk';
import {
  TASK_KINDS,
  TASK_KIND_LABELS,
  TASK_KIND_ROLE,
  can,
  canSupervise,
  type TaskKind,
  type UserRole,
} from '@janelle/shared';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anthropic } from './anthropic.js';
import { env } from '../env.js';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProposedAction {
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}

export interface AssistantResult {
  reply: string;
  /** Writes the assistant wants to make, awaiting the person's confirmation. */
  proposed: ProposedAction[];
  /** Tools actually consulted, so the UI can show its working. */
  used: string[];
}

export interface AssistantContext {
  db: SupabaseClient;
  userId: string;
  orgId: string | null;
  role: UserRole | null;
  name: string;
}

const LIVE = ['open', 'in_progress', 'blocked'];

// ── Tool surface ────────────────────────────────────────────
// Read tools answer questions from real rows so the assistant cannot
// invent a status. Write tools never execute here — they come back as
// proposals a person confirms, because this is driven by voice and a
// misheard sentence must not silently reassign someone's work.

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description:
      'List the studio\'s projects with their stage, client and target install date. Use for "what is happening with X" or "how many projects are in production".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional name or client to filter on (case-insensitive substring).' },
      },
    },
  },
  {
    name: 'list_tasks',
    description:
      'List work items. Use to answer who owes what, what is overdue, and what someone is working on.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['live', 'all', 'open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        assignee_name: { type: 'string', description: 'Filter to one person by name (substring).' },
        project: { type: 'string', description: 'Filter to one project by name (substring).' },
        kind: { type: 'string', enum: [...TASK_KINDS] },
        overdue_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_project_status',
    description:
      'Everything about one project at once: stage, open POs, open tasks, spec gaps and recent email. Use when asked for progress on a named project.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project or client name (substring).' } },
      required: ['name'],
    },
  },
  {
    name: 'list_team',
    description: 'The people in the studio and their roles, with how many live tasks each is carrying.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_today',
    description:
      "This morning's digest: what is overdue, what breached the quote SLA, what is unassigned, and what needs the principal.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_email',
    description:
      'Read the email the system has ingested. Use for "check the emails", "what came in from X", "how many quotes arrived", or anything about the inbox. Returns the most recent matching messages plus a breakdown by type.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match against subject, sender or snippet.' },
        project: { type: 'string', description: 'Limit to one project by name (substring).' },
        klass: {
          type: 'string',
          enum: ['vendor_quote', 'order_confirmation', 'client_approval', 'houzz_notification', 'general', 'unclassified'],
          description: 'Limit to one kind of email.',
        },
        days: { type: 'number', description: 'Only messages received in the last N days.' },
      },
    },
  },
  {
    name: 'propose_task',
    description:
      'Propose creating a new task. Does NOT create it — the person confirms first. Use when the user asks for something to be done or delegated.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Imperative, names the counterparty. Max 80 chars.' },
        detail: { type: 'string' },
        kind: { type: 'string', enum: [...TASK_KINDS] },
        assignee_name: { type: 'string', description: 'Who should own it. Omit to assign by role.' },
        project: { type: 'string' },
        due_date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
      },
      required: ['title', 'kind'],
    },
  },
];

// ── Tool implementations ────────────────────────────────────

type ToolOutput = Record<string, unknown> | Record<string, unknown>[];

const ilike = (s: string) => `%${s.replace(/[%_]/g, '')}%`;

/**
 * Unwrap a Supabase result, turning a database error into something the
 * model must report rather than silently read as "no records".
 *
 * This matters more than it looks: a missing table or a denied policy
 * returns no rows, and without this the assistant answers "there are no
 * open tasks" with total confidence. Saying "I could not read the tasks"
 * is the difference between a tool that can be trusted and one that
 * cannot.
 */
class ToolDataError extends Error {}

async function rows<T = Record<string, unknown>>(
  q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new ToolDataError(`Could not read ${what}: ${error.message}`);
  return data ?? [];
}

async function maybeRow<T = Record<string, unknown>>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  what: string,
): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw new ToolDataError(`Could not read ${what}: ${error.message}`);
  return data;
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: AssistantContext,
  proposed: ProposedAction[],
): Promise<ToolOutput> {
  const { db } = ctx;

  switch (name) {
    case 'list_projects': {
      let q = db.from('projects').select('id, name, client_name, stage, status, target_install').limit(50);
      if (input.search) q = q.or(`name.ilike.${ilike(String(input.search))},client_name.ilike.${ilike(String(input.search))}`);
      return (await rows(q, 'projects')) as ToolOutput;
    }

    case 'list_tasks': {
      let q = db
        .from('tasks')
        .select('id, title, kind, status, due_date, created_at, projects(name), profiles(full_name)')
        .order('created_at', { ascending: false })
        .limit(60);
      const status = String(input.status ?? 'live');
      if (status === 'live') q = q.in('status', LIVE);
      else if (status !== 'all') q = q.eq('status', status);
      if (input.kind) q = q.eq('kind', String(input.kind));
      if (input.overdue_only) q = q.lt('due_date', new Date().toISOString().slice(0, 10));

      let list = (await rows(q, 'tasks')) as unknown as {
        title: string; kind: string; status: string; due_date: string | null;
        projects: { name: string } | null; profiles: { full_name: string | null } | null;
      }[];
      // Name filters are applied here rather than in SQL: the joins are
      // nested, and the row counts are small enough that it does not matter.
      if (input.assignee_name) {
        const needle = String(input.assignee_name).toLowerCase();
        list = list.filter((r) => (r.profiles?.full_name ?? '').toLowerCase().includes(needle));
      }
      if (input.project) {
        const needle = String(input.project).toLowerCase();
        list = list.filter((r) => (r.projects?.name ?? '').toLowerCase().includes(needle));
      }
      return list.map((r) => ({
        title: r.title,
        kind: r.kind,
        status: r.status,
        due_date: r.due_date,
        owner: r.profiles?.full_name ?? 'Unassigned',
        project: r.projects?.name ?? null,
      }));
    }

    case 'get_project_status': {
      const needle = ilike(String(input.name ?? ''));
      const projects = await rows(
        db
          .from('projects')
          .select('id, name, client_name, stage, status, budget, target_install, notes')
          .or(`name.ilike.${needle},client_name.ilike.${needle}`)
          .limit(1),
        'projects',
      );
      const project = projects[0] as { id: string } | undefined;
      if (!project) return { found: false, note: 'No project matched that name.' };

      const [pos, tasks, gaps, emails] = await Promise.all([
        rows(db.from('purchase_orders').select('po_number, status, amount, eta').eq('project_id', project.id), 'purchase orders'),
        rows(db.from('tasks').select('title, kind, status, due_date, profiles(full_name)').eq('project_id', project.id).in('status', LIVE), 'tasks'),
        rows(db.from('spec_gaps').select('item').eq('project_id', project.id).eq('resolved', false), 'spec gaps'),
        rows(db.from('emails').select('subject, from_addr, received_at, class').eq('project_id', project.id).order('received_at', { ascending: false }).limit(5), 'email'),
      ]);
      return {
        found: true,
        project: projects[0],
        purchase_orders: pos,
        open_tasks: tasks.map((t) => {
          const r = t as unknown as { title: string; kind: string; status: string; due_date: string | null; profiles: { full_name: string | null } | null };
          return { title: r.title, kind: r.kind, status: r.status, due_date: r.due_date, owner: r.profiles?.full_name ?? 'Unassigned' };
        }),
        spec_gaps: gaps.map((g) => (g as { item: string }).item),
        recent_email: emails,
      };
    }

    case 'list_team': {
      const [people, tasks] = await Promise.all([
        rows(db.from('profiles').select('id, full_name, role'), 'the team'),
        rows(db.from('tasks').select('assigned_to').in('status', LIVE), 'tasks'),
      ]);
      const load = new Map<string, number>();
      for (const t of tasks) {
        const id = (t as { assigned_to: string | null }).assigned_to;
        if (id) load.set(id, (load.get(id) ?? 0) + 1);
      }
      return people.map((p) => {
        const r = p as { id: string; full_name: string | null; role: string };
        return { name: r.full_name ?? 'Unnamed', role: r.role, live_tasks: load.get(r.id) ?? 0 };
      });
    }

    case 'get_today': {
      const digest = await maybeRow(
        db
          .from('digests')
          .select('digest_date, narrative, figures, escalations')
          .order('digest_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        "today's digest",
      );
      if (digest) return digest as ToolOutput;

      // No digest yet (it runs at 07:05). Rather than a dead end, compute
      // the same picture live so "give me the brief" still works.
      const live = (await rows(
        db.from('tasks').select('title, kind, status, due_date, assigned_to, profiles(full_name)').in('status', LIVE),
        'tasks',
      )) as unknown as {
        title: string; kind: string; status: string; due_date: string | null;
        assigned_to: string | null; profiles: { full_name: string | null } | null;
      }[];
      const today = new Date().toISOString().slice(0, 10);
      return {
        note: 'No digest has been generated yet; this is computed live from the same data.',
        open_tasks: live.length,
        overdue: live
          .filter((t) => (t.due_date && t.due_date < today) || t.status === 'blocked')
          .map((t) => ({ title: t.title, owner: t.profiles?.full_name ?? 'Unassigned', status: t.status, due_date: t.due_date })),
        unassigned: live.filter((t) => !t.assigned_to).map((t) => ({ title: t.title, kind: t.kind })),
      };
    }

    case 'search_email': {
      let q = db
        .from('emails')
        .select('subject, from_addr, to_addr, snippet, received_at, class, extracted_json, projects(name), vendors(name)')
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(40);
      if (input.klass) q = q.eq('class', String(input.klass));
      if (input.days) {
        const since = new Date(Date.now() - Number(input.days) * 86400_000).toISOString();
        q = q.gte('received_at', since);
      }
      if (input.search) {
        const n = ilike(String(input.search));
        q = q.or(`subject.ilike.${n},from_addr.ilike.${n},snippet.ilike.${n}`);
      }

      let list = (await rows(q, 'email')) as unknown as {
        subject: string | null; from_addr: string | null; snippet: string | null;
        received_at: string | null; class: string;
        extracted_json: { summary?: string } | null;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];
      if (input.project) {
        const needle = String(input.project).toLowerCase();
        list = list.filter((r) => (r.projects?.name ?? '').toLowerCase().includes(needle));
      }

      const by_type: Record<string, number> = {};
      for (const e of list) by_type[e.class] = (by_type[e.class] ?? 0) + 1;

      return {
        total: list.length,
        by_type,
        messages: list.slice(0, 15).map((e) => ({
          subject: e.subject,
          from: e.from_addr,
          received_at: e.received_at,
          type: e.class,
          project: e.projects?.name ?? null,
          vendor: e.vendors?.name ?? null,
          // The one-line summary Claude wrote at ingest time, if present.
          summary: e.extracted_json?.summary ?? e.snippet,
        })),
      };
    }

    case 'propose_task': {
      if (!can(ctx.role, 'tasks', 'create')) {
        return { refused: true, reason: 'Your role cannot create tasks.' };
      }
      const kind = (TASK_KINDS.includes(input.kind as TaskKind) ? input.kind : 'admin') as TaskKind;
      const wantsOther = Boolean(input.assignee_name);
      if (wantsOther && !canSupervise(ctx.role)) {
        return { refused: true, reason: 'Only a principal or coordinator can assign work to other people.' };
      }
      const summary = `Create "${input.title}" (${TASK_KIND_LABELS[kind]})${
        input.assignee_name ? ` for ${input.assignee_name}` : ` — routed to ${TASK_KIND_ROLE[kind]}`
      }${input.due_date ? `, due ${input.due_date}` : ''}`;
      proposed.push({ tool: 'propose_task', summary, input: { ...input, kind } });
      return { proposed: true, summary, note: 'Awaiting the user\'s confirmation. Do not claim it is done.' };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── The loop ────────────────────────────────────────────────

function systemPrompt(ctx: AssistantContext): string {
  return `You are the operations assistant for Janelle Interiors, a small interior design studio.
You are speaking with ${ctx.name} (role: ${ctx.role ?? 'unknown'}). Today is ${new Date().toISOString().slice(0, 10)}.

You exist because the founder is the bottleneck: she is in client meetings all day and needs to know
where things stand without digging through the system, and to delegate by simply saying what she needs.

Language:
- Reply in the SAME language the person wrote or spoke in. If they write in Spanish, answer in Spanish;
  Hindi, answer in Hindi; and so on. Match their language even when they switch mid-conversation.
- Keep names of people, projects, vendors and PO numbers exactly as they appear in the data — never
  translate or transliterate them.
- The data itself is in English. Translate the surrounding explanation, not the record.

How to behave:
- ALWAYS answer from the tools. Never guess a status, a date, an owner or a number. If a tool returns
  nothing, say plainly that there is no record of it.
- A tool error is NOT an empty result. If a tool reports it could not read something, say that you
  could not check and why. Never turn a failure to read into "there are none" — that is the one
  mistake that would make you untrustworthy.
- Answers are spoken aloud as often as read. Keep them short and conversational — usually two or three
  sentences. No headings, no bullet lists, no markdown, no emoji.
- Lead with the answer, then the reason. Name people and projects plainly.
- Flag anything a client is waiting on: that is the studio's sorest point.
- When asked to get something done, call propose_task. A proposal is NOT a completed action — say you
  have prepared it and that it needs confirming. Never say a task was created.
- If a tool refuses on permissions, say so plainly and name who can do it instead.
- All money is US dollars. Never use another currency symbol.
- If you genuinely cannot tell, say so. Do not fill the gap with something plausible.`;
}

/**
 * Answer one question about the studio, consulting real data. Runs a
 * bounded tool loop; writes come back as proposals rather than actions.
 */
export async function ask(
  message: string,
  history: AssistantTurn[],
  ctx: AssistantContext,
): Promise<AssistantResult> {
  if (!anthropic) throw new Error('Claude API not configured (set ANTHROPIC_API_KEY).');

  const proposed: ProposedAction[] = [];
  const used: string[] = [];

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message },
  ];

  // Bounded so a confused model cannot spend the studio's budget in a loop.
  for (let turn = 0; turn < 6; turn++) {
    const res = await anthropic.messages.create({
      model: env.anthropic.model,
      max_tokens: 2048,
      system: systemPrompt(ctx),
      tools: TOOLS,
      messages,
    });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    if (toolUses.length === 0 || res.stop_reason !== 'tool_use') {
      const reply = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply, proposed, used };
    }

    messages.push({ role: 'assistant', content: res.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      used.push(tu.name);
      try {
        const out = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>, ctx, proposed);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      } catch (err) {
        const msg =
          err instanceof ToolDataError
            ? `${err.message}. Tell the user you could not check this — do NOT say there are none.`
            : `Error: ${(err as Error).message}`;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true });
      }
    }
    // All results go back in ONE user message, or Claude learns to stop
    // making parallel tool calls.
    messages.push({ role: 'user', content: results });
  }

  return {
    reply: "I couldn't work that out — could you ask it a different way?",
    proposed,
    used,
  };
}
