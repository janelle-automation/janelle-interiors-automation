import {
  ACTIONS,
  RESOURCES,
  isLockedPermission,
  permissionKey,
  type Action,
  type PermissionOverrides,
  type Resource,
  type RolePermissionRow,
  type UserRole,
} from '@janelle/shared';
import { supabaseAdmin } from './supabase.js';

/**
 * The studio's overrides on top of the default permission matrix.
 *
 * Stored in `organizations.settings.role_permissions` — a JSON map keyed
 * `role:resource:action` — rather than in a table of its own. That is a
 * deliberate choice: the studio has exactly one database connection, the
 * Supabase one, and a table would need DDL and a second credential
 * (SUPABASE_DB_URL) before the screen could work at all. Settings already
 * exists and is writable with the key we have, so access rules are
 * editable the moment the app runs.
 *
 * The matrix is small and bounded — 5 roles x 15 modules x 4 actions, and
 * only the changed cells are stored — so a JSON map costs nothing next to
 * a row per cell.
 */
const SETTINGS_KEY = 'role_permissions';

/**
 * Read on every authenticated request, so it is cached briefly: a change
 * takes effect within seconds, and a busy minute does not turn into a
 * hundred identical queries. Loaded with the service-role key because the
 * answer is needed *before* we know whether this caller may read anything.
 */
const TTL_MS = 15_000;

interface CacheEntry {
  loadedAt: number;
  overrides: PermissionOverrides;
}

const cache = new Map<string, CacheEntry>();

export function invalidatePermissions(orgId: string): void {
  cache.delete(orgId);
}

/** Only real cells, only booleans — settings is free-form JSON. */
function sanitize(raw: unknown): PermissionOverrides {
  const out: PermissionOverrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'boolean') continue;
    const [role, resource, action] = key.split(':');
    if (!RESOURCES.includes(resource as Resource)) continue;
    if (!ACTIONS.includes(action as Action)) continue;
    if (!role) continue;
    // A locked cell can never be overridden, however it got in there.
    if (isLockedPermission(role as UserRole, resource as Resource, action as Action)) continue;
    out[key] = value;
  }
  return out;
}

/** The org's settings blob, as stored. */
export async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  if (!supabaseAdmin) return {};
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('settings')
    .eq('id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
}

export async function loadOverrides(orgId: string | null): Promise<PermissionOverrides> {
  if (!orgId || !supabaseAdmin) return {};

  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.overrides;

  try {
    const settings = await readSettings(orgId);
    const overrides = sanitize(settings[SETTINGS_KEY]);
    cache.set(orgId, { loadedAt: Date.now(), overrides });
    return overrides;
  } catch (err) {
    // Never let a settings read failure deny everything — fall back to the
    // defaults, which is exactly how the studio behaved before overrides.
    console.error('[permissions] falling back to defaults:', (err as Error).message);
    return {};
  }
}

export interface OverrideSnapshot {
  overrides: PermissionOverrides;
  rows: RolePermissionRow[];
  /** False only when Supabase itself is unreachable. */
  storageReady: boolean;
}

/** Every stored override for an org, for the Permissions screen. */
export async function listOverrides(orgId: string): Promise<OverrideSnapshot> {
  if (!supabaseAdmin) return { overrides: {}, rows: [], storageReady: false };
  try {
    const settings = await readSettings(orgId);
    const overrides = sanitize(settings[SETTINGS_KEY]);
    const rows: RolePermissionRow[] = Object.entries(overrides).map(([key, allowed]) => {
      const [role, resource, action] = key.split(':');
      return {
        role: role as UserRole,
        resource: resource as Resource,
        action: action as Action,
        allowed,
        updated_at: null,
        updated_by: null,
      };
    });
    return { overrides, rows, storageReady: true };
  } catch (err) {
    console.error('[permissions] overrides unavailable:', (err as Error).message);
    return { overrides: {}, rows: [], storageReady: false };
  }
}

/**
 * Write one cell. `allowed: null` removes the override, putting the cell
 * back to the studio default.
 *
 * Read-modify-write on a JSON blob, so two principals editing the matrix
 * in the same second could lose one change. For a five-person studio with
 * one principal that is not a real risk, and the screen shows the stored
 * truth on its next read.
 */
export async function writeOverride(
  orgId: string,
  role: UserRole,
  resource: Resource,
  action: Action,
  allowed: boolean | null,
): Promise<void> {
  if (!supabaseAdmin) throw new Error('Backend not configured');

  const settings = await readSettings(orgId);
  const overrides = sanitize(settings[SETTINGS_KEY]);
  const key = permissionKey(role, resource, action);

  if (allowed === null) delete overrides[key];
  else overrides[key] = allowed;

  const { error } = await supabaseAdmin
    .from('organizations')
    .update({ settings: { ...settings, [SETTINGS_KEY]: overrides } })
    .eq('id', orgId);
  if (error) throw new Error(error.message);

  invalidatePermissions(orgId);
}

/** Reject anything that is not a real cell of the matrix. */
export function validateCell(
  resource: unknown,
  action: unknown,
): { resource: Resource; action: Action } | null {
  if (!RESOURCES.includes(resource as Resource)) return null;
  if (!ACTIONS.includes(action as Action)) return null;
  return { resource: resource as Resource, action: action as Action };
}

export { isLockedPermission };
