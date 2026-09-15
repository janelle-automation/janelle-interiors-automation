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
import { AI_FEATURE_LABELS, ASSISTANT_NAME, DEFAULT_SLA } from '@janelle/shared';
import { createMessage, isAiReady } from './anthropic.js';
import { hasColumn } from '../lib/columns.js';
import { bodyColumnsReady, readStoredText } from '../lib/emailStore.js';
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

/**
 * How long one question may take before the assistant must answer with
 * what it has. Must stay under the serverless function's maxDuration (60s
 * in vercel.json): past that the platform kills the request and the person
 * gets nothing back at all.
 */
const ASSISTANT_BUDGET_MS = Number(process.env.ASSISTANT_BUDGET_MS || 40_000);

// ── Tool surface ────────────────────────────────────────────
// Read tools answer questions from real rows so the assistant cannot
// invent a status. Write tools never execute here — they come back as
// proposals a person confirms, because this is driven by voice and a
// misheard sentence must not silently reassign someone's work.

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_projects',
    description:
      "List the studio's projects with stage, client, target install date AND money: each project's budget, the total value of its purchase orders (on_order), how many POs are open, and how many spec gaps are unresolved. Use for \"what is happening with X\", \"how many projects are in production\", and for any question about cost, value, budget or which project is biggest — sort_by: 'cost' answers that directly.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional name or client to filter on (case-insensitive substring).' },
        stage: { type: 'string', description: 'Limit to one pipeline stage, e.g. "production".' },
        sort_by: {
          type: 'string',
          enum: ['cost', 'recent', 'install'],
          description: "'cost' ranks by on_order value, highest first — use this for \"highest cost project\".",
        },
        limit: { type: 'number', description: 'Return at most this many projects.' },
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
    name: 'read_email',
    description:
      "Read one stored email IN FULL — the text of what was actually written, every link in it, and every attachment parsed from it (quotes, order confirmations, with vendor and total). Use this whenever the answer depends on the wording or on a detail the summary would not carry: a link ('the Canva link', 'the Drive folder'), a measurement, a price, an address, a name, a date, or 'what exactly did X say'. Pass the id from search_email, or a search phrase to find the most recent match. Costs more than search_email, so reach for it when the summary is not enough — but DO reach for it rather than saying something was not captured.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The email id from search_email.' },
        search: { type: 'string', description: 'Instead of an id: match subject, sender or body; the newest match is read.' },
      },
    },
  },
  {
    name: 'search_documents',
    description:
      'Find parsed documents — vendor quotes, order confirmations and purchase orders pulled from Drive and from email attachments. Use for "send me the quote for X", "which documents do we have on this project", "what did the vendor quote". Returns what each document contains plus a link to open the original.',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Limit to one project by name (substring).' },
        vendor: { type: 'string', description: 'Limit to documents from one vendor (substring).' },
        type: {
          type: 'string',
          enum: ['quote', 'purchase_order', 'order_confirmation', 'other'],
        },
        search: { type: 'string', description: 'Match a PO number or vendor name.' },
      },
    },
  },
  {
    name: 'list_vendors',
    description:
      'The studio\'s suppliers: category, contact, how many purchase orders are open with each and what they are worth. Use for "who do we buy from", "which vendor has the most on order", "what is X\'s email".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Vendor name or category (substring).' },
      },
    },
  },
  {
    name: 'list_purchase_orders',
    description:
      'Purchase orders with vendor, project, amount, status and expected date. Use for "what is on order", "what is arriving this month", "how much have we committed with X", "which orders are late".',
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Limit to one vendor (substring).' },
        project: { type: 'string', description: 'Limit to one project (substring).' },
        status: {
          type: 'string',
          enum: ['open', 'all', 'draft', 'sent', 'confirmed', 'partial', 'received', 'cancelled'],
          description: "'open' means anything not received or cancelled.",
        },
        late_only: { type: 'boolean', description: 'Only orders past their expected date.' },
      },
    },
  },
  {
    name: 'list_follow_ups',
    description:
      'The follow-up queue — where the system has noticed silence and wants someone chased: vendors who have not replied, client approvals overdue, dates slipping, spec gaps, overdue tasks and escalations. Use for "what is waiting on someone", "who has gone quiet", "what needs chasing".',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'all', 'open', 'drafted', 'sent', 'dismissed', 'done'] },
        type: {
          type: 'string',
          description: 'One follow-up type, e.g. vendor_silence, client_approval_overdue, quote_overdue.',
        },
      },
    },
  },
  {
    name: 'list_drafts',
    description:
      'Reply drafts the system has written and parked in Gmail for a person to review and send. Nothing here has been sent. Use for "what is waiting for me to approve", "did we reply to X".',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match subject or recipient.' },
      },
    },
  },
  {
    name: 'list_spec_gaps',
    description:
      'Missing specification details that block an order being placed — a finish, dimension or model number with no answer. Use for "what is blocking the order", "what is still TBD".',
    input_schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Limit to one project (substring).' },
        include_resolved: { type: 'boolean', description: 'Default false — only open gaps.' },
      },
    },
  },
  {
    name: 'get_weekly_report',
    description:
      "The latest weekly report: the written summary and the figures behind it. Use for \"how was last week\", \"what did the report say\".",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_studio_rules',
    description:
      'The studio\'s own settings: how many days of vendor silence before a nudge, how long a client approval may sit, when something escalates to the principal, and which day the weekly report runs. Use for "how long do we wait before chasing".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_activity',
    description:
      'The audit trail — what the system and the team have actually done: email ingested, tasks created, roles changed, follow-ups sent. Use for "what has happened today", "who changed that", "has the system run".',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries, newest first. Default 20.' },
      },
    },
  },
  {
    name: 'get_ai_spend',
    description:
      'What the studio has spent on Claude recently, by job and in total. Use for "what is this costing", "how much have we spent on AI".',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Window in days. Default 30.' },
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
 * The words of a search phrase, for matching them one at a time.
 *
 * A phrase matched whole found nothing the moment anyone typed a full name:
 * "Brianna Johnson" appears in no column of her own email, because the
 * sender is stored as `brianna@janelleinteriors.com` and the subject is
 * about the project. Requiring every word to appear SOMEWHERE — the address
 * carrying the first name, the body the surname — finds it, while still
 * excluding rows that merely share one common word.
 *
 * Capped at four words so one rambling question cannot build a query of
 * unbounded size.
 */
function searchWords(phrase: string): string[] {
  return phrase
    .split(/\s+/)
    .map((w) => w.replace(/[%_]/g, '').trim())
    .filter((w) => w.length >= 2)
    .slice(0, 4);
}

/**
 * Apply a phrase across several columns, one word at a time.
 *
 * Each `.or()` is ANDed with the last by PostgREST, so this reads as
 * "every word appears in at least one of these columns".
 */
function matchPhrase<T>(query: T, phrase: string, columns: string[]): T {
  let q = query as unknown as { or(filter: string): unknown };
  for (const word of searchWords(phrase)) {
    q = q.or(columns.map((c) => `${c}.ilike.${ilike(word)}`).join(',')) as typeof q;
  }
  return q as unknown as T;
}

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
      let q = db
        .from('projects')
        .select('id, name, client_name, stage, status, budget, target_install, updated_at')
        .limit(60);
      if (input.search) q = q.or(`name.ilike.${ilike(String(input.search))},client_name.ilike.${ilike(String(input.search))}`);
      if (input.stage) q = q.eq('stage', String(input.stage));

      // Money lives on purchase_orders, not projects, so a question about
      // cost is unanswerable without joining them. Aggregated in one pass.
      const [projects, pos, gaps] = await Promise.all([
        rows(q, 'projects'),
        rows(db.from('purchase_orders').select('project_id, amount, status'), 'purchase orders'),
        rows(db.from('spec_gaps').select('project_id').eq('resolved', false), 'spec gaps'),
      ]);

      const CLOSED = ['received', 'cancelled'];
      const onOrder = new Map<string, number>();
      const openPos = new Map<string, number>();
      for (const o of pos as { project_id: string | null; amount: number | null; status: string }[]) {
        if (!o.project_id) continue;
        onOrder.set(o.project_id, (onOrder.get(o.project_id) ?? 0) + Number(o.amount ?? 0));
        if (!CLOSED.includes(o.status)) openPos.set(o.project_id, (openPos.get(o.project_id) ?? 0) + 1);
      }
      const gapCount = new Map<string, number>();
      for (const g of gaps as { project_id: string | null }[]) {
        if (g.project_id) gapCount.set(g.project_id, (gapCount.get(g.project_id) ?? 0) + 1);
      }

      let list = (projects as { id: string; budget: number | null; updated_at: string; target_install: string | null }[]).map(
        (p) => ({
          ...p,
          budget: p.budget,
          on_order: onOrder.get(p.id) ?? 0,
          open_pos: openPos.get(p.id) ?? 0,
          spec_gaps: gapCount.get(p.id) ?? 0,
        }),
      );

      const sort = String(input.sort_by ?? 'recent');
      if (sort === 'cost') list.sort((a, b) => b.on_order - a.on_order);
      else if (sort === 'install') {
        list.sort((a, b) => (a.target_install ?? '9999').localeCompare(b.target_install ?? '9999'));
      } else list.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

      if (input.limit) list = list.slice(0, Math.max(1, Number(input.limit)));
      return {
        note: 'All amounts are US dollars. on_order is the total value of the project\'s purchase orders; budget is the separately recorded budget figure and is often not set.',
        projects: list,
      };
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
      // Columns once 0010 is applied; until then the same data sits inside
      // extracted_json, which readStoredText knows how to unpack.
      const hasLinks = await bodyColumnsReady();
      let q = db
        .from('emails')
        .select(
          `id, subject, from_addr, to_addr, snippet, received_at, class, extracted_json,
           ${hasLinks ? 'links,' : ''} projects(name), vendors(name)`,
        )
        .order('received_at', { ascending: false, nullsFirst: false })
        .limit(40);
      if (input.klass) q = q.eq('class', String(input.klass));
      if (input.days) {
        const since = new Date(Date.now() - Number(input.days) * 86400_000).toISOString();
        q = q.gte('received_at', since);
      }
      if (input.search) {
        const cols = ['subject', 'from_addr', 'to_addr', 'snippet'];
        // The body is searchable too, wherever 0010 has it living.
        cols.push(hasLinks ? 'body_text' : 'extracted_json->>_body');
        q = matchPhrase(q, String(input.search), cols);
      }

      let list = (await rows(q, 'email')) as unknown as {
        id: string;
        subject: string | null; from_addr: string | null; snippet: string | null;
        received_at: string | null; class: string;
        extracted_json: (Record<string, unknown> & { summary?: string }) | null;
        links?: { url: string; host: string }[] | null;
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
          // So a follow-up question can ask for this exact message's body
          // instead of searching again.
          id: e.id,
          subject: e.subject,
          from: e.from_addr,
          // Links are short and are what people ask for by name. Carried
          // here so "send me the Canva link" is answered in one hop rather
          // than costing a second call to read the whole message.
          links: readStoredText(e).links.map((l) => l.url),
          received_at: e.received_at,
          type: e.class,
          project: e.projects?.name ?? null,
          vendor: e.vendors?.name ?? null,
          // The one-line summary Claude wrote at ingest time, if present.
          summary: e.extracted_json?.summary ?? e.snippet,
        })),
      };
    }

    case 'read_email': {
      const hasBody = await bodyColumnsReady();
      const fields = `id, subject, from_addr, to_addr, received_at, class, snippet, extracted_json,
                      ${hasBody ? 'body_text, links,' : ''} projects(name), vendors(name)`;

      let q = db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1);
      if (input.id) {
        q = db.from('emails').select(fields).eq('id', String(input.id)).limit(1);
      } else if (input.search) {
        const bodyCol = hasBody ? 'body_text' : 'extracted_json->>_body';
        // "What did Brianna say" means mail she SENT. Searching every column
        // at once answered it with a thread she was merely copied on, which
        // is a different message by a different person. Try the sender
        // first, and only widen when nobody by that name sent anything.
        const bySender = matchPhrase(
          db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1),
          String(input.search),
          ['from_addr'],
        );
        const { data: sent } = await bySender;
        if (sent?.length) {
          // Re-issue it: the builder above has already been awaited.
          q = matchPhrase(
            db.from('emails').select(fields).order('received_at', { ascending: false, nullsFirst: false }).limit(1),
            String(input.search),
            ['from_addr'],
          );
        } else {
          q = matchPhrase(q, String(input.search), ['subject', 'from_addr', 'to_addr', 'snippet', bodyCol]);
        }
      }

      const found = (await rows(q, 'email')) as unknown as {
        id: string; subject: string | null; from_addr: string | null; to_addr: string | null;
        received_at: string | null; class: string; snippet: string | null;
        body_text?: string | null; links?: { url: string; host: string }[] | null;
        extracted_json: (Record<string, unknown> & { summary?: string }) | null;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];

      const e = found[0];
      if (!e) return { found: false, note: 'No stored email matches that.' };

      // What arrived attached to it. Documents parsed from an attachment are
      // stored as "gmail:<messageId>:<attachmentId>", so the message's own
      // Gmail id is the join — the link was always there, nothing exposed it.
      const { data: gmailIdRow } = await db.from('emails').select('gmail_id').eq('id', e.id).maybeSingle();
      const gmailId = (gmailIdRow as { gmail_id?: string | null } | null)?.gmail_id ?? null;
      const attachments: Record<string, unknown>[] = [];
      if (gmailId) {
        const { data: attached } = await db
          .from('documents')
          .select('id, type, parsed_json, drive_file_id')
          .like('drive_file_id', `gmail:${gmailId}:%`);
        for (const row of attached ?? []) {
          const d = row as { type: string; parsed_json: Record<string, unknown> | null };
          const pj = (d.parsed_json ?? {}) as {
            vendor?: string; po_number?: string; total?: number; line_items?: unknown[];
          };
          attachments.push({
            type: d.type,
            vendor: pj.vendor ?? null,
            po_number: pj.po_number ?? null,
            total: pj.total ?? null,
            line_item_count: pj.line_items?.length ?? 0,
            // Attachments open in the thread; Gmail has no per-file URL.
            link: `https://mail.google.com/mail/u/0/#all/${gmailId}`,
          });
        }
      }

      // Older mail was ingested before bodies were kept, so say which it is
      // rather than letting the answer imply the message was empty.
      const stored = readStoredText(e);
      const body = stored.body;
      return {
        found: true,
        id: e.id,
        subject: e.subject,
        from: e.from_addr,
        to: e.to_addr,
        received_at: e.received_at,
        type: e.class,
        project: e.projects?.name ?? null,
        vendor: e.vendors?.name ?? null,
        links: stored.links.map((l) => ({ url: l.url, host: l.host })),
        attachments,
        attachment_count: attachments.length,
        // Capped: the assistant needs what was said, not a whole thread.
        body: body ? body.slice(0, 4000) : null,
        body_available: Boolean(body),
        note: body
          ? null
          : "The TEXT of this message is not stored (it was read before bodies were kept), so you CANNOT tell whether it contains a link, a price, a measurement or any particular wording. Do NOT say a link or detail is absent — you have not seen the message. Say the text has not been captured yet and that re-reading the mail from the Dashboard will capture it. Subject, summary and the attachments listed above ARE reliable; answer from those where you can.",
      };
    }

    case 'search_documents': {
      let q = db
        .from('documents')
        .select('id, type, parsed_json, confidence, created_at, drive_file_id, projects(name)')
        .order('created_at', { ascending: false })
        .limit(40);
      if (input.type) q = q.eq('type', String(input.type));

      let list = (await rows(q, 'documents')) as unknown as {
        id: string; type: string; confidence: number | null; created_at: string;
        drive_file_id: string | null;
        parsed_json: {
          vendor?: string | null; po_number?: string | null; total?: number | null;
          client?: string | null; eta?: string | null; order_date?: string | null;
          line_items?: { description: string; qty: number; unit_price: number | null }[];
        } | null;
        projects: { name: string } | null;
      }[];

      const match = (hay: string | null | undefined, needle: unknown) =>
        !needle || (hay ?? '').toLowerCase().includes(String(needle).toLowerCase());

      if (input.project) list = list.filter((d) => match(d.projects?.name, input.project));
      if (input.vendor) list = list.filter((d) => match(d.parsed_json?.vendor, input.vendor));
      if (input.search) {
        const n = String(input.search).toLowerCase();
        list = list.filter(
          (d) =>
            (d.parsed_json?.po_number ?? '').toLowerCase().includes(n) ||
            (d.parsed_json?.vendor ?? '').toLowerCase().includes(n),
        );
      }

      return {
        note: 'Amounts are US dollars. `link` opens the original file; documents that arrived as email attachments link to the Gmail message instead of a file.',
        total: list.length,
        documents: list.slice(0, 12).map((d) => {
          const ref = d.drive_file_id ?? '';
          // Drive files carry a bare file id; email attachments are stored as
          // "gmail:<messageId>:<attachmentId>" and open in the thread.
          const link = ref.startsWith('gmail:')
            ? `https://mail.google.com/mail/u/0/#all/${ref.slice(6).split(':')[0]}`
            : ref
              ? `https://drive.google.com/file/d/${ref}/view`
              : null;
          const p = d.parsed_json ?? {};
          return {
            type: d.type,
            vendor: p.vendor ?? null,
            po_number: p.po_number ?? null,
            total: p.total ?? null,
            eta: p.eta ?? null,
            project: d.projects?.name ?? null,
            source: ref.startsWith('gmail:') ? 'email attachment' : 'drive',
            parsed_at: d.created_at,
            line_item_count: p.line_items?.length ?? 0,
            link,
          };
        }),
      };
    }

    case 'list_vendors': {
      const search = typeof input.search === 'string' ? input.search : null;
      let q = db.from('vendors').select('id, name, category, contacts, notes');
      if (search) q = q.or(`name.ilike.${ilike(search)},category.ilike.${ilike(search)}`);
      const vendors = (await rows(q, 'vendors')) as unknown as {
        id: string; name: string; category: string | null;
        contacts: unknown; notes: string | null;
      }[];

      const pos = (await rows(
        db.from('purchase_orders').select('vendor_id, status, amount'),
        'purchase orders',
      )) as unknown as { vendor_id: string | null; status: string; amount: number | null }[];

      return vendors.map((v) => {
        const mine = pos.filter((p) => p.vendor_id === v.id);
        const open = mine.filter((p) => !['received', 'cancelled'].includes(p.status));
        return {
          name: v.name,
          category: v.category,
          contacts: v.contacts,
          notes: v.notes,
          open_orders: open.length,
          on_order: open.reduce((sum, p) => sum + (p.amount ?? 0), 0),
        };
      });
    }

    case 'list_purchase_orders': {
      const status = typeof input.status === 'string' ? input.status : 'open';
      const today = new Date().toISOString().slice(0, 10);

      let q = db
        .from('purchase_orders')
        .select('po_number, status, amount, eta, vendors(name), projects(name)')
        .order('eta', { ascending: true });

      if (status !== 'all' && status !== 'open') q = q.eq('status', status);
      if (status === 'open') q = q.not('status', 'in', '("received","cancelled")');

      const list = (await rows(q, 'purchase orders')) as unknown as {
        po_number: string | null; status: string; amount: number | null; eta: string | null;
        vendors: { name: string } | null; projects: { name: string } | null;
      }[];

      const vendor = typeof input.vendor === 'string' ? input.vendor.toLowerCase() : null;
      const project = typeof input.project === 'string' ? input.project.toLowerCase() : null;

      return list
        .filter((p) => !vendor || (p.vendors?.name ?? '').toLowerCase().includes(vendor))
        .filter((p) => !project || (p.projects?.name ?? '').toLowerCase().includes(project))
        .filter((p) => !input.late_only || (p.eta != null && p.eta < today))
        .map((p) => ({
          po: p.po_number,
          vendor: p.vendors?.name ?? 'Unknown vendor',
          project: p.projects?.name ?? 'Unassigned',
          amount: p.amount,
          status: p.status,
          expected: p.eta,
          late: Boolean(p.eta && p.eta < today && !['received', 'cancelled'].includes(p.status)),
        }));
    }

    case 'list_follow_ups': {
      const status = typeof input.status === 'string' ? input.status : 'pending';
      let q = db
        .from('follow_ups')
        .select('type, status, reason, target, due_date, created_at, projects(name), vendors(name)')
        .order('created_at', { ascending: true });

      if (status === 'pending') q = q.in('status', ['open', 'drafted']);
      else if (status !== 'all') q = q.eq('status', status);
      if (typeof input.type === 'string') q = q.eq('type', input.type);

      const list = (await rows(q, 'follow-ups')) as unknown as {
        type: string; status: string; reason: string | null; target: string | null;
        due_date: string | null; created_at: string;
        projects: { name: string } | null; vendors: { name: string } | null;
      }[];

      return list.map((f) => ({
        type: f.type,
        status: f.status,
        reason: f.reason,
        waiting_on: f.target,
        due_date: f.due_date,
        project: f.projects?.name ?? null,
        vendor: f.vendors?.name ?? null,
        waiting_days: Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86_400_000),
      }));
    }

    case 'list_drafts': {
      const search = typeof input.search === 'string' ? input.search : null;
      let q = db
        .from('drafts')
        .select('subject, body_preview, follow_up_id, created_at')
        .order('created_at', { ascending: false })
        .limit(25);
      if (search) q = q.ilike('subject', ilike(search));

      const list = (await rows(q, 'drafts')) as unknown as {
        subject: string | null; body_preview: string | null;
        follow_up_id: string | null; created_at: string;
      }[];

      return list.map((d) => ({
        subject: d.subject,
        // Enough to say what it is about without reading a whole email aloud.
        preview: (d.body_preview ?? '').slice(0, 200),
        raised_by_follow_up: Boolean(d.follow_up_id),
        written: d.created_at,
      }));
    }

    case 'list_spec_gaps': {
      let q = db
        .from('spec_gaps')
        .select('item, missing_fields, resolved, created_at, projects(name)')
        .order('created_at', { ascending: true });
      if (!input.include_resolved) q = q.eq('resolved', false);

      const list = (await rows(q, 'spec gaps')) as unknown as {
        item: string | null; missing_fields: unknown; resolved: boolean; created_at: string;
        projects: { name: string } | null;
      }[];

      const project = typeof input.project === 'string' ? input.project.toLowerCase() : null;
      return list
        .filter((g) => !project || (g.projects?.name ?? '').toLowerCase().includes(project))
        .map((g) => ({
          item: g.item,
          missing: g.missing_fields,
          project: g.projects?.name ?? 'Unassigned',
          resolved: g.resolved,
          open_days: Math.floor((Date.now() - new Date(g.created_at).getTime()) / 86_400_000),
        }));
    }

    case 'get_weekly_report': {
      const report = await maybeRow(
        db
          .from('reports')
          .select('week_of, narrative, generated_json, created_at')
          .order('week_of', { ascending: false })
          .limit(1)
          .maybeSingle(),
        'the weekly report',
      );
      return report
        ? (report as ToolOutput)
        : { note: 'No weekly report has been generated yet. It runs on Monday.' };
    }

    case 'get_studio_rules': {
      const org = await maybeRow(
        db.from('organizations').select('name, settings').limit(1).maybeSingle(),
        "the studio's settings",
      );
      const settings = ((org as { settings?: Record<string, unknown> } | null)?.settings ??
        {}) as Record<string, unknown>;

      // Never read the credentials back out through the assistant.
      const { anthropic_api_key_encrypted, ai_usage_token, ...safe } = settings;
      void anthropic_api_key_encrypted;
      void ai_usage_token;

      return {
        studio: (org as { name?: string } | null)?.name ?? 'The studio',
        rules: safe,
        defaults: DEFAULT_SLA,
      };
    }

    case 'get_recent_activity': {
      const limit = typeof input.limit === 'number' ? Math.min(input.limit, 50) : 20;
      const list = (await rows(
        db
          .from('activity_log')
          .select('action, entity, meta, created_at, profiles(full_name)')
          .neq('action', 'ai.usage')
          .order('created_at', { ascending: false })
          .limit(limit),
        'the activity log',
      )) as unknown as {
        action: string; entity: string | null; meta: Record<string, unknown> | null;
        created_at: string; profiles: { full_name: string | null } | null;
      }[];

      return list.map((a) => ({
        what: a.action,
        entity: a.entity,
        who: a.profiles?.full_name ?? 'The system',
        when: a.created_at,
        detail: a.meta,
      }));
    }

    case 'get_ai_spend': {
      const days = typeof input.days === 'number' ? input.days : 30;
      const since = new Date(Date.now() - Math.min(days, 365) * 86_400_000).toISOString();

      const list = (await rows(
        db
          .from('activity_log')
          .select('meta, created_at')
          .eq('action', 'ai.usage')
          .gte('created_at', since),
        'AI usage',
      )) as unknown as { meta: Record<string, unknown> | null }[];

      const byFeature = new Map<string, { calls: number; cost: number }>();
      let cost = 0;
      for (const row of list) {
        const m = (row.meta ?? {}) as { feature?: string; cost_usd?: number };
        const spend = Number(m.cost_usd ?? 0);
        cost += spend;
        const key = m.feature ?? 'unknown';
        const b = byFeature.get(key) ?? { calls: 0, cost: 0 };
        b.calls += 1;
        b.cost += spend;
        byFeature.set(key, b);
      }

      return {
        window_days: days,
        calls: list.length,
        total_usd: Number(cost.toFixed(4)),
        by_job: [...byFeature.entries()]
          .map(([feature, b]) => ({
            job: AI_FEATURE_LABELS[feature as keyof typeof AI_FEATURE_LABELS] ?? feature,
            calls: b.calls,
            usd: Number(b.cost.toFixed(4)),
          }))
          .sort((a, b) => b.usd - a.usd),
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

/**
 * A few headline numbers, read before the conversation starts.
 *
 * Without it the assistant knows only that tools exist, so "how many
 * projects do we have?" costs a tool round-trip — two Claude calls where
 * one would do. That is slow, and on a function with a hard time limit it
 * is the difference between an answer and a dropped connection. Anything
 * past these headlines still comes from the tools.
 *
 * Read with the caller's own client, so it shows only what that person is
 * allowed to see. Never throws: a snapshot that cannot be read leaves the
 * assistant asking, which is what it did before.
 */
async function studioSnapshot(ctx: AssistantContext): Promise<string> {
  const { db } = ctx;
  const today = new Date().toISOString().slice(0, 10);

  /** One `count` query, reported as null rather than thrown when it fails. */
  const count = async (build: () => PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const { count: n, error } = await build();
      return error ? null : (n ?? 0);
    } catch {
      return null;
    }
  };
  const head = (table: string) => db.from(table).select('*', { count: 'exact', head: true });

  const [projects, activeProjects, openTasks, overdueTasks, unassignedTasks, vendors, openPos, followUps, drafts, specGaps] =
    await Promise.all([
      count(() => head('projects')),
      count(() => head('projects').eq('status', 'active')),
      count(() => head('tasks').in('status', LIVE)),
      count(() => head('tasks').in('status', LIVE).lt('due_date', today)),
      count(() => head('tasks').in('status', LIVE).is('assigned_to', null)),
      count(() => head('vendors')),
      count(() => head('purchase_orders').not('status', 'in', '(received,cancelled)')),
      count(() => head('follow_ups').eq('status', 'open')),
      count(() => head('drafts')),
      count(() => head('spec_gaps').eq('resolved', false)),
    ]);

  // When the mail was last read, so "is this up to date?" needs no tool.
  let lastRead = 'no record of a run yet';
  try {
    const { data } = await db
      .from('activity_log')
      .select('created_at')
      .eq('action', 'ingest.run')
      .order('created_at', { ascending: false })
      .limit(1);
    const at = (data?.[0] as { created_at?: string } | undefined)?.created_at;
    if (at) lastRead = `${at.slice(0, 16).replace('T', ' ')} UTC`;
  } catch {
    // Leave the wording as it is rather than failing the whole answer.
  }

  const say = (n: number | null) => (n === null ? 'unknown' : String(n));

  return `Where the studio stands right now, counted before you were asked:
- Projects: ${say(projects)} in total, ${say(activeProjects)} active.
- Tasks: ${say(openTasks)} open, ${say(overdueTasks)} of them overdue and ${say(unassignedTasks)} with nobody on them.
- Vendors: ${say(vendors)}. Purchase orders still open: ${say(openPos)}.
- Follow-ups waiting: ${say(followUps)}. Reply drafts waiting to be sent: ${say(drafts)}.
- Unresolved spec gaps: ${say(specGaps)}.
- Gmail and Drive last read: ${lastRead}.

Answer "how many" and "how are we doing overall" questions straight from these numbers —
do not call a tool to count them again. Use the tools when the question needs names,
dates, amounts, or anything not listed here. A number shown as "unknown" could not be
read: say you could not check it rather than guessing.`;
}

function systemPrompt(ctx: AssistantContext, snapshot: string): string {
  return `You are ${ASSISTANT_NAME}, the operations assistant for Janelle Interiors, a small
interior design studio. When someone greets you or asks who you are, say you are ${ASSISTANT_NAME}.
You are speaking with ${ctx.name} (role: ${ctx.role ?? 'unknown'}). Today is ${new Date().toISOString().slice(0, 10)}.

You exist because the founder is the bottleneck: she is in client meetings all day and needs to know
where things stand without digging through the system, and to delegate by simply saying what she needs.

Language:
- ALWAYS reply in English, whatever language the question was asked in. The studio works in English
  and the records are in English; a reply in another language cannot be pasted into an email or read
  by the rest of the team.
- You may still understand a question asked in another language — just answer it in English.

What you can see — the whole system, through the tools:
- Projects, their stages, budgets and install dates; the spec gaps blocking them.
- Tasks: who owns what, what is overdue, what has no owner.
- Vendors and purchase orders: what is on order, from whom, for how much, and what is late.
- Follow-ups: everywhere the system has noticed silence and wants someone chased.
- Email that has been read: who sent it, what it said in full, and every link in it.
- Reply drafts waiting for a person to send.
- The team and their roles, the morning digest, the weekly report.
- The studio’s own rules (how long before chasing) and the audit trail of what has happened.
- What the studio is spending on you.
If a question touches any of that, there is a tool for it. Use it before saying you do not know.

${snapshot}

How to behave:
- You CAN look things up. When asked for anything held in the studio’s records — a project,
  a task, an order, a vendor, an email, who owns what, what is overdue — call the tools and
  answer with what they return. Never say you are unable to access the system.
- You CAN read whole emails. read_email returns the full text of a message, every link in it, and
  every attachment parsed from it. Never say you "can only see subjects, senders and snippets", or
  that you cannot extract or share a link — that was true of an earlier version of you and is false
  now. If you said anything like it earlier in THIS conversation it was wrong: ignore it, call
  read_email, and answer from the message itself.
- ALWAYS answer from the tools. Never guess a status, a date, an owner or a number. If a tool returns
  nothing, say plainly that there is no record of it.
- A tool error is NOT an empty result. If a tool reports it could not read something, say that you
  could not check and why. Never turn a failure to read into "there are none" — that is the one
  mistake that would make you untrustworthy.
- Never say something "was not parsed", "was not captured" or "is not in the system" until you have
  called read_email on the actual message. search_email returns summaries; the summary leaving
  something out does NOT mean the email did. A link, a measurement, a price, a name, a date — all of
  that lives in the body, and read_email is what reads it. Sending someone to Gmail for a detail you
  had not looked for yet is the same failure as inventing one.
- When asked for a link, give the URL itself. read_email returns every link in a message, already
  extracted — quote it exactly, never reconstruct or shorten it.
- "I could not find X" and "X is not stored" are different answers and must never be swapped. If
  read_email says a body is not stored, you have not looked at that message: say the text has not
  been captured yet and how to capture it. Claiming a link is absent from an email you could not
  read is exactly the mistake that makes you untrustworthy.
- When something is missing, name the one action that fixes it. Never ask the person to narrow the
  question down instead.
- Lead with the answer, then the reason. Name people and projects plainly.
- Answers are often spoken aloud, so keep them short — usually two or three sentences of plain
  conversational prose. No headings, no markdown, no emoji, no bold.
- Structure ONLY when the answer is genuinely a list of things — several tasks, orders, emails or
  links. Then use one short line per item, starting with "- ", and nothing else. Three or four items
  at most; say how many more there are rather than listing them all.
- A URL always goes on its own line, bare, with nothing wrapped around it — that way it can be
  copied. Say what it is on the line before.
- Never pad. No preamble, no "I checked the system and".
- End on the answer. Do NOT close with an offer or a question — no "would you like me to…",
  no "let me know if…", no "shall I…". If a further lookup would obviously help, just do it in
  the same turn instead of asking permission; reading is never something to ask about.
- If part of an answer is unavailable, give the part that IS available first and keep the caveat
  to one clause. Never lead with what you could not do.
- Flag anything a client is waiting on: that is the studio's sorest point.
- When asked to get something done, call propose_task. A proposal is NOT a completed action — say you
  have prepared it and that it needs confirming. Never say a task was created.
- If a tool refuses on permissions, say so plainly and name who can do it instead.
- All money is US dollars. Never use another currency symbol.
- When a tool gives you a document link, include the URL in your answer so the person can open the
  file. Say what the document is first, then the link.
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
  if (!(await isAiReady(ctx.orgId))) {
    throw new Error('Claude is not set up yet — add an API key in Settings.');
  }

  const proposed: ProposedAction[] = [];
  const used: string[] = [];

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user' as const, content: message },
  ];

  const system = systemPrompt(ctx, await studioSnapshot(ctx));

  // Six turns of tool use is minutes of work, and the function is killed
  // long before that — the caller then gets no response at all, not even an
  // error, which reads in the browser as "could not reach the server". So
  // the loop watches the clock as well as the turn count, keeping back the
  // time the slowest turn took so far, since a turn cannot be interrupted
  // once it has started.
  const deadline = Date.now() + ASSISTANT_BUDGET_MS;
  const timeLeft = () => deadline - Date.now();
  let slowestTurn = 0;

  for (let turn = 0; turn < 6; turn++) {
    // Out of time with tool results in hand: spend what is left on an
    // answer rather than another lookup. Dropping the tools is what forces
    // one, and it is a cheaper call than a tool turn.
    if (turn > 0 && timeLeft() <= slowestTurn) {
      return { reply: await finalAnswer(ctx, system, messages, used), proposed, used };
    }

    const startedTurn = Date.now();
    const res = await createMessage(
      { feature: 'assistant.answer', orgId: ctx.orgId, actor: ctx.userId },
      {
        max_tokens: 2048,
        system,
        tools: TOOLS,
        messages,
      },
    );
    slowestTurn = Math.max(slowestTurn, Date.now() - startedTurn);

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

/**
 * One last call with no tools, to turn whatever was looked up into an answer.
 *
 * Reached when the clock ran out mid-loop. Everything the tools returned is
 * already in `messages`, so this usually answers the question properly; it
 * only falls back to an apology if even this cannot be afforded.
 */
async function finalAnswer(
  ctx: AssistantContext,
  system: string,
  messages: Anthropic.MessageParam[],
  used: string[],
): Promise<string> {
  try {
    const res = await createMessage(
      { feature: 'assistant.answer', orgId: ctx.orgId, actor: ctx.userId },
      {
        max_tokens: 1024,
        system: `${system}

You are out of time to look anything else up. Answer now from what you already have.
If what you have is not enough, say plainly which part you could not check.`,
        messages,
      },
    );
    const reply = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (reply) return reply;
  } catch (err) {
    console.error('[assistant] final answer failed:', (err as Error).message);
  }

  return used.length
    ? 'That took longer than I have — I checked part of it but could not finish. Ask me again, or ask for one thing at a time.'
    : 'That took longer than I have. Could you ask me again, or narrow it down a little?';
}
