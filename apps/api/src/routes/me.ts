import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { servicesGranted } from '../lib/google.js';
import { profileColumns } from '../lib/columns.js';

export const meRouter = Router();

// Current user's profile + org + Google connection status.
meRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { db, userId } = req.auth!;

    const [{ data: profile }, { data: integration }] = await Promise.all([
      db.from('profiles').select(await profileColumns('id, org_id, full_name, email, role, avatar_url')).eq('id', userId).maybeSingle(),
      db.from('integrations').select('status, connected_at, scopes').eq('user_id', userId).eq('provider', 'google').maybeSingle(),
    ]);

    const connected = integration?.status === 'connected';
    const services = connected ? servicesGranted(integration?.scopes) : { gmail: false, drive: false };

    res.json({
      data: {
        profile,
        google: {
          status: integration?.status ?? 'disconnected',
          connected_at: integration?.connected_at ?? null,
          scopes: integration?.scopes ?? '',
          services,
        },
      },
    });
  }),
);
