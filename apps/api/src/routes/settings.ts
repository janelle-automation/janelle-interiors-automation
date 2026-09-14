import { Router } from 'express';
import { INGEST_INTERVALS, SELECTABLE_MODELS } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  aiSettingsView,
  clearApiKey,
  looksLikeAnthropicKey,
  saveApiKey,
  saveModel,
} from '../lib/aiSettings.js';
import { readIngestSettings, saveIngestSettings } from '../lib/ingestSettings.js';

/**
 * Studio settings that used to require a deploy.
 *
 * Principal only, and the API key never travels back to the browser — the
 * screen sees whether one is set, where it came from, and its last four
 * characters. Everything here is enforced by requirePermission, so a
 * revoked "Studio settings" grant closes this off like any other module.
 */
export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/ai',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: { ...(await aiSettingsView(orgId)), models: SELECTABLE_MODELS } });
  }),
);

/**
 * How often email is read, and whether Claude reads it.
 *
 * These are the two dials that move the bill: how often the studio looks,
 * and whether it thinks about what it finds.
 */
settingsRouter.get(
  '/ingest',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({ data: await readIngestSettings(orgId) });
  }),
);

settingsRouter.put(
  '/ingest',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: { intervalMinutes?: number; useAi?: boolean } = {};

    if (req.body?.intervalMinutes !== undefined) {
      const minutes = Number(req.body.intervalMinutes);
      if (!INGEST_INTERVALS.some((i) => i.minutes === minutes)) {
        return res.status(400).json({ error: 'Unknown interval' });
      }
      patch.intervalMinutes = minutes;
    }

    if (req.body?.useAi !== undefined) {
      if (typeof req.body.useAi !== 'boolean') {
        return res.status(400).json({ error: 'useAi must be true or false' });
      }
      patch.useAi = req.body.useAi;
    }

    const updated = await saveIngestSettings(orgId, patch);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ingest_changed',
      entity: 'organizations',
      entity_id: orgId,
      meta: patch,
    });

    res.json({ data: updated });
  }),
);

/** Store a new key. Replaces whatever was there. */
settingsRouter.put(
  '/ai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!apiKey) return res.status(400).json({ error: 'Paste a key first' });

    // Catch a mistyped or truncated key here rather than on the next email.
    if (!looksLikeAnthropicKey(apiKey)) {
      return res.status(400).json({
        error: 'That does not look like an Anthropic API key',
        detail: 'Keys begin with sk-ant- and come from console.anthropic.com.',
      });
    }

    await saveApiKey(orgId, apiKey);

    // The key itself must never reach the log; the last four is enough to
    // tell afterwards which key was put in place.
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_key_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { hint: apiKey.slice(-4) },
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);

/** Remove the studio's key, falling back to the environment if it has one. */
settingsRouter.delete(
  '/ai/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    await clearApiKey(orgId);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_key_cleared',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);

/** Choose the model every feature uses. */
settingsRouter.put(
  '/ai/model',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const model = String(req.body?.model ?? '');
    if (!SELECTABLE_MODELS.some((m) => m.id === model)) {
      return res.status(400).json({ error: 'Unknown model' });
    }

    await saveModel(orgId, model);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.ai_model_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { model },
    });

    res.json({ data: await aiSettingsView(orgId) });
  }),
);
