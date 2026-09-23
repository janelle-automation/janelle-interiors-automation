import { Router } from 'express';
import { DEFAULT_SLA, INGEST_INTERVALS, SELECTABLE_MODELS, type SlaSettings } from '@janelle/shared';
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
import {
  clearXaiApiKey,
  looksLikeXaiKey,
  saveXaiApiKey,
  saveXaiModel,
  xaiSettingsView,
} from '../lib/aiSettings.js';
import { GROK_IMAGE_MODELS, VIDEO_MODELS } from '@janelle/shared';
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
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
settingsRouter.use(requirePermission('settings', 'read'));

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
 * The Grok account — renderings and video.
 *
 * A third provider with a third key, on the same terms as the Claude one:
 * the key is encrypted at rest, never travels back to the browser, and the
 * screen sees only its last four characters and which models are in use.
 */
settingsRouter.get(
  '/media',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    res.json({
      data: {
        ...(await xaiSettingsView(orgId)),
        imageModels: GROK_IMAGE_MODELS,
        videoModels: VIDEO_MODELS,
      },
    });
  }),
);

settingsRouter.put(
  '/media/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!looksLikeXaiKey(apiKey)) {
      return res.status(400).json({
        error: 'That does not look like an xAI API key',
        detail: 'Keys begin with xai- and come from console.x.ai.',
      });
    }

    await saveXaiApiKey(orgId, apiKey);

    // The key itself never reaches the log — the last four is enough to
    // tell afterwards which key was put in place.
    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.media_key_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { hint: apiKey.slice(-4) },
    });

    res.json({ data: { ...(await xaiSettingsView(orgId)), imageModels: GROK_IMAGE_MODELS, videoModels: VIDEO_MODELS } });
  }),
);

settingsRouter.delete(
  '/media/key',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    await clearXaiApiKey(orgId);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.media_key_cleared',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });

    res.json({ data: { ...(await xaiSettingsView(orgId)), imageModels: GROK_IMAGE_MODELS, videoModels: VIDEO_MODELS } });
  }),
);

/** Which Grok model draws stills, and which one makes clips. */
settingsRouter.put(
  '/media/model',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const kind = req.body?.kind === 'video' ? 'video' : 'image';
    const model = String(req.body?.model ?? '');
    try {
      await saveXaiModel(orgId, kind, model);
    } catch {
      return res.status(400).json({ error: 'Unknown model' });
    }

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.media_model_set',
      entity: 'organizations',
      entity_id: orgId,
      meta: { kind, model },
    });

    res.json({ data: { ...(await xaiSettingsView(orgId)), imageModels: GROK_IMAGE_MODELS, videoModels: VIDEO_MODELS } });
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

/**
 * The chasing ladder: how long the studio waits before it says something.
 *
 * Every one of these numbers was already read from the studio's settings by
 * the nightly engine, the digest and the task board — but nothing could
 * write them. Two were seeded when the organization was created and the
 * other five had never been anything but the built-in default, so "the
 * system chases too early" had no answer except changing the code.
 */
settingsRouter.get(
  '/sla',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const { data } = await supabaseAdmin!.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const stored = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Partial<SlaSettings>;
    res.json({ data: { ...DEFAULT_SLA, ...stored }, defaults: DEFAULT_SLA });
  }),
);

/** Each dial's sane range, so a typo cannot switch the engine off. */
const SLA_LIMITS: Record<keyof SlaSettings, { min: number; max: number }> = {
  quote_response_days: { min: 1, max: 30 },
  client_waiting_hours: { min: 1, max: 336 },
  vendor_silence_days: { min: 1, max: 30 },
  client_approval_days: { min: 1, max: 60 },
  escalation_days: { min: 1, max: 30 },
  task_reminder_days: { min: 0, max: 30 },
  reminder_repeat_days: { min: 1, max: 30 },
};

settingsRouter.put(
  '/sla',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const patch: Partial<SlaSettings> = {};
    for (const key of Object.keys(SLA_LIMITS) as (keyof SlaSettings)[]) {
      const raw = req.body?.[key];
      if (raw === undefined) continue;
      const value = Number(raw);
      const { min, max } = SLA_LIMITS[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        return res.status(400).json({ error: `${key} must be a whole number between ${min} and ${max}` });
      }
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change' });

    // Merged, never replaced: `settings` also holds the API key, the model
    // and the permission overrides, and writing the column whole would take
    // them with it.
    const { data } = await supabaseAdmin!.from('organizations').select('settings').eq('id', orgId).maybeSingle();
    const settings = ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
    const next = { ...settings, ...patch };

    const { error } = await supabaseAdmin!.from('organizations').update({ settings: next }).eq('id', orgId);
    if (error) throw new Error(error.message);

    await supabaseAdmin?.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'settings.sla_changed',
      entity: 'organizations',
      entity_id: orgId,
      meta: patch,
    });

    res.json({ data: { ...DEFAULT_SLA, ...(next as Partial<SlaSettings>) } });
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
