import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { buildUsageReport } from '../services/usage.js';

export const usageRouter = Router();
usageRouter.use(requireAuth);

/** Where the share token lives on the org. */
const TOKEN_KEY = 'ai_usage_token';
const TOKEN_AT_KEY = 'ai_usage_token_created_at';

async function orgSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
}

// What the studio has spent on Claude. Readable by anyone in the org —
// reads stay open, and spend is something the whole studio should see.
usageRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });
    const days = Number(req.query.days ?? 30);
    res.json({ data: await buildUsageReport(orgId, days, Number(req.query.tz ?? 0)) });
  }),
);

// The share link. Only the principal sees or changes it: handing it out is
// handing out the studio's spending, and that is her call.
usageRouter.get(
  '/link',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const settings = await orgSettings(orgId);
    const token = typeof settings[TOKEN_KEY] === 'string' ? (settings[TOKEN_KEY] as string) : null;

    res.json({
      data: {
        token,
        path: token ? `/u/${token}` : null,
        created_at: (settings[TOKEN_AT_KEY] as string) ?? null,
      },
    });
  }),
);

/**
 * Mint a new link, replacing any existing one. 32 random bytes: long
 * enough that guessing it is not a threat model, which is what lets the
 * page skip a login entirely.
 */
usageRouter.post(
  '/link/rotate',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const token = randomBytes(32).toString('hex');
    const settings = await orgSettings(orgId);
    const createdAt = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from('organizations')
      .update({ settings: { ...settings, [TOKEN_KEY]: token, [TOKEN_AT_KEY]: createdAt } })
      .eq('id', orgId);
    if (error) throw new Error(error.message);

    // Rotating invalidates whatever was handed out before, so it belongs
    // in the audit trail next to who did it.
    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'usage.link_rotate',
      entity: 'organizations',
      entity_id: orgId,
      meta: { replaced: Boolean(settings[TOKEN_KEY]) },
    });

    res.json({ data: { token, path: `/u/${token}`, created_at: createdAt } });
  }),
);

// Turn the link off. The old URL stops working immediately.
usageRouter.delete(
  '/link',
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const settings = await orgSettings(orgId);
    delete settings[TOKEN_KEY];
    delete settings[TOKEN_AT_KEY];

    const { error } = await supabaseAdmin
      .from('organizations')
      .update({ settings })
      .eq('id', orgId);
    if (error) throw new Error(error.message);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'usage.link_revoke',
      entity: 'organizations',
      entity_id: orgId,
      meta: {},
    });

    res.json({ data: { token: null, path: null, created_at: null } });
  }),
);
