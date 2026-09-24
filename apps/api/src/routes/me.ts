import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { servicesGranted } from '../lib/google.js';
import { profileColumns } from '../lib/columns.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { RESOURCES, canWith } from '@janelle/shared';

export const meRouter = Router();

// Current user's profile + org + Google connection status.
meRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { db, userId } = req.auth!;

    // The connection is read as the server, scoped to the verified user id,
    // and a failed read is reported as `unknown` — never as `disconnected`.
    // The web app locks the screen behind "Connect Gmail & Drive" on
    // `disconnected`, and it asks on every session refresh (hourly, and when
    // a sleeping laptop wakes), so one dropped read used to send people
    // through Google consent again with a grant that was working fine.
    const [{ data: profile }, { data: integration, error: integrationError }] = await Promise.all([
      db.from('profiles').select(await profileColumns('id, org_id, full_name, email, role, avatar_url')).eq('id', userId).maybeSingle(),
      (supabaseAdmin ?? db).from('integrations').select('status, connected_at, scopes').eq('user_id', userId).eq('provider', 'google').maybeSingle(),
    ]);
    if (integrationError) console.error('[me] google status unreadable:', integrationError.message);

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
          status: integrationError ? 'unknown' : integration?.status ?? 'disconnected',
          connected_at: integration?.connected_at ?? null,
          scopes: integration?.scopes ?? '',
          services,
        },
      },
    });
  }),
);
