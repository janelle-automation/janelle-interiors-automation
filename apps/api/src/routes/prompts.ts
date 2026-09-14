import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { generate, isAiReady } from '../services/anthropic.js';
import type { PromptVariable } from '@janelle/shared';

export const promptsRouter = Router();
promptsRouter.use(requireAuth);

// The prompt library, grouped by category on the client.
promptsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('prompts')
      .select('id, title, category, description, template, variables')
      .order('category');
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);

// Run a prompt against Claude, filling {{variables}} from the request.
promptsRouter.post(
  '/:id/run',
  requirePermission('prompts', 'update'),
  asyncHandler(async (req, res) => {
    const { db, userId, orgId } = req.auth!;

    if (!(await isAiReady(orgId))) {
      return res.status(503).json({ error: 'Claude is not set up yet — add an API key in Settings.' });
    }

    const { data: prompt, error } = await db
      .from('prompts')
      .select('id, title, template, variables')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    const values = (req.body?.variables ?? {}) as Record<string, string>;
    const vars = (prompt.variables ?? []) as PromptVariable[];
    const missing = vars.filter((v) => v.required && !values[v.key]).map((v) => v.label);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required inputs: ${missing.join(', ')}` });
    }

    const filled = String(prompt.template).replace(/\{\{(\w+)\}\}/g, (_m, key) => values[key] ?? '');
    const output = await generate(
      'You are an assistant for an interior design studio. Write in a warm, precise, professional studio voice. Return only the requested content.',
      filled,
      { feature: 'prompt.run', orgId, actor: userId, entity: 'prompts', entityId: prompt.id },
    );

    await db.from('prompt_runs').insert({
      org_id: orgId,
      prompt_id: prompt.id,
      project_id: typeof req.body?.projectId === 'string' ? req.body.projectId : null,
      user_id: userId,
      input: values,
      output,
    });

    res.json({ data: { output } });
  }),
);
