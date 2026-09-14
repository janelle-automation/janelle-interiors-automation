import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin, supabaseForToken } from '../lib/supabase.js';
import { canWith, type Action, type PermissionOverrides, type Resource, type UserRole } from '@janelle/shared';
import { loadOverrides } from '../lib/permissions.js';

/** Data attached to an authenticated request. */
export interface AuthContext {
  userId: string;
  email: string | null;
  orgId: string | null;
  role: UserRole | null;
  /** Supabase client scoped to this user (RLS-enforced). */
  db: SupabaseClient;
  /** The studio's edits to the default permission matrix, if any. */
  permissions: PermissionOverrides;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verifies the Bearer token with Supabase, loads the user's profile
 * (org + role), and attaches an RLS-scoped client to the request.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'Backend not configured',
      detail: 'Add SUPABASE_URL and keys to .env to enable data and auth.',
    });
  }

  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  // Profile carries org + role. Read via admin to avoid a policy
  // chicken-and-egg on first login.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('org_id, role')
    .eq('id', data.user.id)
    .maybeSingle();

  const orgId = profile?.org_id ?? null;

  req.auth = {
    userId: data.user.id,
    email: data.user.email ?? null,
    orgId,
    role: (profile?.role as UserRole) ?? null,
    // Non-null here: we returned 503 above when Supabase is unconfigured.
    db: supabaseForToken(token) as SupabaseClient,
    permissions: await loadOverrides(orgId),
  };

  next();
}

/**
 * Restrict a route by the shared permission matrix. Use after requireAuth.
 * Prefer this over requireRole: it keeps the API and the UI in step, since
 * both read the same table in @janelle/shared.
 */
export function requirePermission(resource: Resource, action: Action) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!canWith(req.auth?.permissions, req.auth?.role ?? null, resource, action)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        detail: `Your role (${req.auth?.role ?? 'none'}) cannot ${action} ${resource}.`,
      });
    }
    next();
  };
}

/** Restrict a route to specific roles. Use after requireAuth. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.role || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
