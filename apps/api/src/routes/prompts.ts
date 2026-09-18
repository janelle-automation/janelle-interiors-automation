import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { isAiReady, isTimeoutError } from '../services/anthropic.js';
import { missingInputs, fillTemplate, runLibraryPrompt } from '../services/promptRunner.js';
import { BOARD_PROMPTS, boardPrompt, isRenderable } from '../services/boards.js';
import { ImagesNotConfigured, isImageReady, renderImage, type ImageReference } from '../services/images.js';
import { openFileGrant, sealFileGrant, UPLOAD_GRANT_TTL_MS } from '../lib/fileTokens.js';
import { readUpload, storeUpload, type UploadType } from '../lib/uploads.js';

export const promptsRouter = Router();
promptsRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
promptsRouter.use(requirePermission('prompts', 'read'));

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
      .select('id, title, category, template, variables')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    const values = (req.body?.variables ?? {}) as Record<string, string>;
    const missing = missingInputs(prompt.variables, values);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required inputs: ${missing.join(', ')}` });
    }

    // Same path Jenny takes, so the Studio and the chat produce the same
    // work from the same prompt.
    try {
      const output = await runLibraryPrompt(db, prompt, values, {
        orgId,
        userId,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : null,
      });
      res.json({ data: { output } });
    } catch (err) {
      // A timeout reaching the screen as "Server error" sent people looking
      // for a broken prompt. It is the clock, and it is worth saying so.
      if (isTimeoutError(err)) {
        return res.status(504).json({
          error: 'That one took longer than the time limit. Try again, or give it less to work through in one run.',
        });
      }
      throw err;
    }
  }),
);

/**
 * Which prompts make a picture, and what to attach to each.
 *
 * The Studio asks before it offers a Render button: a finish schedule is a
 * document, and a button that renders one would be a photograph of a
 * spreadsheet.
 */
promptsRouter.get('/renderable', async (req, res) => {
  res.json({
    data: {
      ready: await isImageReady(req.auth!.orgId),
      prompts: Object.fromEntries(
        Object.entries(BOARD_PROMPTS).map(([title, b]) => [
          title,
          { label: b.label, references: b.references },
        ]),
      ),
    },
  });
});

/**
 * Render a board.
 *
 * The same prompt the Studio runs for words, aimed at an image model
 * instead — with whatever the person attached going in as reference
 * pictures, because "match the approved template" is only enforceable when
 * the template is one of them.
 */
promptsRouter.post(
  '/:id/render',
  requirePermission('prompts', 'update'),
  asyncHandler(async (req, res) => {
    const { db, userId, orgId } = req.auth!;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    if (!(await isImageReady(orgId))) {
      return res.status(503).json({ error: new ImagesNotConfigured().message });
    }

    const { data: prompt, error } = await db
      .from('prompts')
      .select('id, title, category, template, variables')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!prompt) return res.status(404).json({ error: 'Prompt not found' });

    if (!isRenderable(prompt.title)) {
      return res.status(400).json({
        error: `"${prompt.title}" produces a document, not a board. Run it instead.`,
      });
    }

    const values = (req.body?.variables ?? {}) as Record<string, string>;
    const missing = missingInputs(prompt.variables, values);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required inputs: ${missing.join(', ')}` });
    }

    // Attachments arrive as the same sealed grants Jenny uses, so a file is
    // never addressed by a path the browser could have made up.
    const references: ImageReference[] = [];
    for (const raw of (Array.isArray(req.body?.files) ? req.body.files : []).slice(0, 14)) {
      const token = (raw as { token?: unknown })?.token;
      const label = typeof (raw as { label?: unknown })?.label === 'string'
        ? String((raw as { label: string }).label).slice(0, 80)
        : undefined;
      if (typeof token !== 'string') continue;
      const opened = openFileGrant(token, orgId);
      if (!opened.ok || opened.grant.source !== 'upload') continue;
      const bytes = await readUpload(opened.grant.path);
      if (bytes) references.push({ mimeType: opened.grant.mimeType, bytes, label });
    }

    const filled = fillTemplate(prompt.template, values);
    const instruction = boardPrompt(prompt.title, filled);
    if (!instruction) return res.status(400).json({ error: 'That prompt cannot be rendered.' });

    let render;
    try {
      render = await renderImage(instruction, references, {
        feature: 'image.render',
        orgId,
        actor: userId,
        entity: 'prompts',
        entityId: prompt.id,
      });
    } catch (err) {
      // Rendering fails for reasons a person can act on — no key, a blocked
      // request, the clock — so the message goes through rather than being
      // flattened to "Server error".
      return res.status(502).json({ error: (err as Error).message });
    }

    const name = `${BOARD_PROMPTS[prompt.title].label} — ${new Date().toISOString().slice(0, 10)}.png`;
    const { path } = await storeUpload({
      orgId,
      userId,
      name,
      mimeType: render.mimeType as UploadType,
      bytes: render.bytes,
    });

    // `prompt_runs` has nowhere to put a picture, and adding a column needs
    // DDL this project cannot run yet. The path rides in the input JSON,
    // which keeps the board findable from the run that made it.
    await db.from('prompt_runs').insert({
      org_id: orgId,
      prompt_id: prompt.id,
      project_id: typeof req.body?.projectId === 'string' ? req.body.projectId : null,
      user_id: userId,
      input: { ...values, board_path: path, board_model: render.model },
      output: render.note ?? `Rendered ${name}`,
    });

    res.json({
      data: {
        // A grant rather than a URL: the bucket is private, and the browser
        // fetches it through the same file endpoint every attachment uses.
        token: sealFileGrant(
          { source: 'upload', orgId, path, mimeType: render.mimeType, name, size: render.bytes.length },
          UPLOAD_GRANT_TTL_MS,
        ),
        name,
        mimeType: render.mimeType,
        model: render.model,
        note: render.note,
        references: references.length,
      },
    });
  }),
);
