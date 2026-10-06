import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { createMessage } from '../services/anthropic.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

type TurnRole = 'user' | 'assistant';
interface Turn {
  role: TurnRole;
  content: string;
}

/**
 * Gather a brief context snapshot for the audit assistant.
 *
 * Pulls recent tasks and activity-log entries. Kept lean so the system
 * prompt stays inside the token budget and the call is fast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildAuditContext(db: any, orgId: string): Promise<string> {
  const [tasksRes, activityRes] = await Promise.all([
    db
      .from('tasks')
      .select('title, status, due_date, created_at, category, profiles(full_name)')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(60),
    db
      .from('activity_log')
      .select('action, entity, meta, created_at, profiles(full_name)')
      .eq('org_id', orgId)
      .neq('action', 'ai.usage')
      .order('created_at', { ascending: false })
      .limit(40),
  ]);

  const tasks = (tasksRes.data ?? []) as {
    title: string;
    status: string;
    due_date: string | null;
    created_at: string;
    category: string | null;
    profiles: { full_name: string | null } | null;
  }[];

  const activity = (activityRes.data ?? []) as {
    action: string;
    entity: string;
    meta: Record<string, unknown> | null;
    created_at: string;
    profiles: { full_name: string | null } | null;
  }[];

  const taskLines = tasks
    .map((t) => {
      const due = t.due_date ? ` due ${t.due_date.slice(0, 10)}` : '';
      const name = (t.profiles as { full_name?: string | null } | null)?.full_name;
      const who = name ? ` [${name}]` : '';
      return `- ${t.status.toUpperCase()}${due}${who}: ${t.title}${t.category ? ` (${t.category})` : ''}`;
    })
    .join('\n');

  const activityLines = activity
    .map((a) => {
      const who = (a.profiles as { full_name?: string | null } | null)?.full_name ?? 'system';
      const when = a.created_at.slice(0, 16).replace('T', ' ');
      const subject = (a.meta as { subject?: string } | null)?.subject ?? (a.meta as { title?: string } | null)?.title ?? '';
      return `- [${when}] ${who} → ${a.action} ${a.entity}${subject ? `: ${subject}` : ''}`;
    })
    .join('\n');

  return `## Recent Tasks (latest 60)\n${taskLines || '(none)'}\n\n## Activity Log (latest 40)\n${activityLines || '(none)'}`;
}

/**
 * Conversational AI audit assistant.
 *
 * POST /api/audit/chat
 * Body: { message: string; history?: { role: 'user'|'assistant'; content: string }[] }
 * Response: { data: { answer: string } }
 */
auditRouter.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required.' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message too long.' });

    const raw = Array.isArray(req.body?.history) ? req.body.history : [];
    const history: Turn[] = raw
      .filter((t: unknown) => {
        const x = t as { role?: string; content?: string };
        return (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string';
      })
      .slice(-6)
      .map((t: { role: string; content: string }) => ({ role: t.role as TurnRole, content: t.content }));

    const { db, orgId } = req.auth!;

    const context = orgId ? await buildAuditContext(db, orgId) : '(no studio data — not linked to an org)';

    const systemPrompt = `You are the Janelle Interiors AI Audit Assistant. Your job is to answer questions about the studio's project updates, task status, team activity, and workflows.

You have access to a live snapshot of the studio's data below. Answer questions clearly and concisely. When listing tasks or activities, be specific. If something is not in the data, say so rather than guessing.

Today's date: ${new Date().toISOString().slice(0, 10)}

${context}`;

    const messages: { role: TurnRole; content: string }[] = [
      ...history,
      { role: 'user', content: message },
    ];

    const result = await createMessage(
      { feature: 'audit.chat', orgId, actor: req.auth!.userId },
      {
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      },
    );

    const answer = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n')
      .trim();

    res.json({ data: { answer } });
  }),
);
