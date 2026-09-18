import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { servicesGranted } from '../lib/google.js';
import { profileColumns } from '../lib/columns.js';
import { RESOURCES, canWith } from '@janelle/shared';

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

    // What this person may actually do, with the studio's overrides already
    // applied. The client had no way to ask: it rendered every page to
    // everybody and found out on the 403. Now a module the role cannot view
    // simply is not offered.
    const role = req.auth!.role;
    const access = Object.fromEntries(
      RESOURCES.map((resource) => [
        resource,
        {
          read: canWith(req.auth!.permissions, role, resource, 'read'),
          create: canWith(req.auth!.permissions, role, resource, 'create'),
          update: canWith(req.auth!.permissions, role, resource, 'update'),
          delete: canWith(req.auth!.permissions, role, resource, 'delete'),
        },
      ]),
    );

    res.json({
      data: {
        profile,
        access,
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
