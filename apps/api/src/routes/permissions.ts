import { Router } from 'express';
import {
  ACTIONS,
  RESOURCES,
  USER_ROLES,
  can,
  canWith,
  isLockedPermission,
  type UserRole,
} from '@janelle/shared';
import { requireAuth, requirePermission, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { listOverrides, validateCell, writeOverride } from '../lib/permissions.js';

export const permissionsRouter = Router();
permissionsRouter.use(requireAuth);

/**
 * The principal's module, and nobody else's.
 *
 * This used to be readable by the whole org, on the reasoning that everyone
 * should be able to see the rules they work under — which is defensible, but
 * it is not what this studio wants: who may do what is the owner's business,
 * and a designer reading the full matrix learns exactly where the gaps are.
 * Hard-wired to the role rather than to a permission cell, so it cannot be
 * granted away from the one person who can grant it back.
 */
permissionsRouter.use(requireRole('principal'));

/**
 * The permission matrix as it actually stands: the default for every cell,
 * the studio's override where it has set one, and which cells are locked.
 */
permissionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const { overrides, storageReady } = await listOverrides(orgId);

    const cells = [];
    for (const role of USER_ROLES) {
      for (const resource of RESOURCES) {
        for (const action of ACTIONS) {
          const key = `${role}:${resource}:${action}`;
          cells.push({
            role,
            resource,
            action,
            default: can(role, resource, action),
            // Read the freshly stored overrides, not the cached copy on the
            // request — otherwise a change made a second ago looks undone.
            allowed: canWith(overrides, role, resource, action),
            overridden: overrides[key] !== undefined,
            locked: isLockedPermission(role, resource, action),
            updated_at: null,
          });
        }
      }
    }

    res.json({
      data: {
        cells,
        canEdit:
          storageReady && canWith(req.auth!.permissions, req.auth!.role, 'team', 'update'),
        storageReady,
      },
    });
  }),
);

/**
 * Grant or revoke one cell for one role.
 *
 * Stored in the org's settings, so it takes effect on the API's next
 * request with no migration and no second database credential.
 */
permissionsRouter.put(
  '/',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const role = String(req.body?.role ?? '') as UserRole;
    if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const cell = validateCell(req.body?.resource, req.body?.action);
    if (!cell) return res.status(400).json({ error: 'Invalid module or action' });

    const allowed = req.body?.allowed;
    if (typeof allowed !== 'boolean') {
      return res.status(400).json({ error: 'allowed must be true or false' });
    }

    // Refuse the changes that would leave the studio unable to undo them.
    if (isLockedPermission(role, cell.resource, cell.action)) {
      return res.status(400).json({
        error: 'That cannot be changed',
        detail:
          cell.action === 'read'
            ? 'Everyone in the studio can see the studio’s work — that is the point of the system.'
            : 'A principal must always be able to change people and studio rules, or nobody could grant access again.',
      });
    }

    await writeOverride(orgId, role, cell.resource, cell.action, allowed);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: allowed ? 'permission.grant' : 'permission.revoke',
      entity: 'organizations',
      entity_id: orgId,
      meta: { role, resource: cell.resource, action: cell.action },
    });

    res.json({ data: { role, resource: cell.resource, action: cell.action, allowed } });
  }),
);

/** Drop an override, putting the cell back to the studio default. */
permissionsRouter.delete(
  '/',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const role = String(req.query.role ?? '') as UserRole;
    if (!USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const cell = validateCell(req.query.resource, req.query.action);
    if (!cell) return res.status(400).json({ error: 'Invalid module or action' });

    await writeOverride(orgId, role, cell.resource, cell.action, null);

    res.json({
      data: {
        role,
        resource: cell.resource,
        action: cell.action,
        allowed: can(role, cell.resource, cell.action),
      },
    });
  }),
);
