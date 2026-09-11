import { Router } from 'express';
import { TASK_KINDS, TASK_KIND_ROLE, canSupervise, type TaskKind } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { ask, type AssistantTurn } from '../services/assistant.js';

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

// Ask the assistant a question. Read-only: any write it decides on comes
// back as a proposal for the person to confirm.
assistantRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message is too long' });

    const raw = Array.isArray(req.body?.history) ? req.body.history : [];
    const history: AssistantTurn[] = raw
      .filter((t: unknown) => {
        const x = t as { role?: string; content?: string };
        return (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string';
      })
      .slice(-8);

    const result = await ask(message, history, {
      db: req.auth!.db,
      userId: req.auth!.userId,
      orgId: req.auth!.orgId,
      role: req.auth!.role,
      name: req.auth!.email ?? 'a teammate',
    });
    res.json({ data: result });
  }),
);

// Commit a proposal the person confirmed. Kept separate from /ask so a
// misheard sentence can never write on its own.
assistantRouter.post(
  '/confirm',
  requirePermission('tasks', 'create'),
  asyncHandler(async (req, res) => {
    const input = (req.body?.input ?? {}) as Record<string, unknown>;
    const title = String(input.title ?? '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const kind = (TASK_KINDS.includes(input.kind as TaskKind) ? input.kind : 'admin') as TaskKind;

    // Resolve the named assignee, honouring the same supervisor rule the
    // task routes enforce.
    let assignedTo: string | null = null;
    if (input.assignee_name) {
      if (!canSupervise(req.auth!.role)) {
        return res.status(403).json({ error: 'Only a principal or coordinator can assign work to others' });
      }
      const { data: people } = await req.auth!.db
        .from('profiles')
        .select('id, full_name')
        .ilike('full_name', `%${String(input.assignee_name).replace(/[%_]/g, '')}%`)
        .limit(1);
      assignedTo = (people?.[0] as { id: string } | undefined)?.id ?? null;
    }

    let projectId: string | null = null;
    if (input.project) {
      const { data: projects } = await req.auth!.db
        .from('projects')
        .select('id')
        .ilike('name', `%${String(input.project).replace(/[%_]/g, '')}%`)
        .limit(1);
      projectId = (projects?.[0] as { id: string } | undefined)?.id ?? null;
    }

    const { data, error } = await req.auth!.db
      .from('tasks')
      .insert({
        org_id: req.auth!.orgId,
        title: title.slice(0, 200),
        detail: input.detail ? String(input.detail) : null,
        kind,
        assigned_to: assignedTo,
        assigned_role: TASK_KIND_ROLE[kind],
        project_id: projectId,
        due_date: input.due_date || null,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);

    await req.auth!.db.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: 'assistant.task_create',
      entity: 'tasks',
      entity_id: data?.id ?? null,
      meta: { title, kind, assigned: Boolean(assignedTo) },
    });

    res.json({ data: { id: data?.id } });
  }),
);
