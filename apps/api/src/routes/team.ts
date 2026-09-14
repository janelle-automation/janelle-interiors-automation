import { Router } from 'express';
import { USER_ROLES, type UserRole } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const teamRouter = Router();
teamRouter.use(requireAuth);

// The people in this org, for assignee pickers and the admin screen.
// RLS scopes it to the caller's org.
teamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('profiles')
      .select('id, full_name, email, role, created_at')
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    // How much live work each person is carrying, so the principal can see
    // load before reassigning. A missing tasks table must not break the
    // screen — the roster is still worth showing.
    const { data: tasks } = await req.auth!.db
      .from('tasks')
      .select('assigned_to')
      .in('status', ['open', 'in_progress', 'blocked']);
    const load = new Map<string, number>();
    for (const t of tasks ?? []) {
      const id = (t as { assigned_to: string | null }).assigned_to;
      if (id) load.set(id, (load.get(id) ?? 0) + 1);
    }

    res.json({
      data: (data ?? []).map((p) => {
        const row = p as { id: string };
        return { ...p, live_tasks: load.get(row.id) ?? 0, is_you: row.id === req.auth!.userId };
      }),
    });
  }),
);

// Change someone's role. Principal only — this is how access is granted.
teamRouter.patch(
  '/:id',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    const role = String(req.body?.role ?? '');
    if (!USER_ROLES.includes(role as UserRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role, org_id')
      .eq('id', req.params.id)
      .maybeSingle();

    // Scoped to the caller's own studio: a principal changes their org, not others.
    if (!target || (target as { org_id: string }).org_id !== req.auth!.orgId) {
      return res.status(404).json({ error: 'Person not found in this studio' });
    }

    // A studio with no principal cannot grant access to anyone again, so
    // refuse to demote the last one rather than leaving it unrecoverable.
    // This covers demoting ANY principal, not only yourself — the studio is
    // just as stuck either way.
    if ((target as { role: string }).role === 'principal' && role !== 'principal') {
      const { count } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', req.auth!.orgId)
        .eq('role', 'principal');
      if ((count ?? 0) <= 1) {
        return res.status(400).json({
          error: 'That is the studio’s only principal — promote someone else first',
        });
      }
    }

    // Row-level security lets a person update only their OWN profile row
    // (`profiles_update_self` in 0001), so doing this through the caller's
    // client matched nothing and surfaced as a baffling "Person not found" —
    // the role dropdown could never change anybody. Authorisation for this is
    // requirePermission('team','update') above; the write goes through the
    // service client, exactly as inviting and adding a teammate already do.
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ role })
      .eq('id', req.params.id)
      .select('id, full_name, role')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Person not found in this studio' });

    await supabaseAdmin.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: 'team.role_change',
      entity: 'profiles',
      entity_id: req.params.id,
      meta: { role, name: (data as { full_name: string | null }).full_name },
    });

    res.json({ data });
  }),
);

/**
 * Invite a teammate. Creates the auth user and their profile, then asks
 * Supabase to email them a sign-in link.
 *
 * This SENDS AN EMAIL, which is why it is a deliberate action behind its own
 * button rather than something the system does on its own.
 */
teamRouter.post(
  '/invite',
  requirePermission('team', 'create'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const fullName = String(req.body?.full_name ?? '').trim();
    const role = String(req.body?.role ?? 'assistant');
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!USER_ROLES.includes(role as UserRole)) return res.status(400).json({ error: 'Invalid role' });

    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const { data: invited, error: inviteErr } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
    if (inviteErr || !invited?.user) {
      // Already registered is the common case and worth saying plainly.
      const msg = inviteErr?.message ?? 'Invite failed';
      return res.status(400).json({ error: /already/i.test(msg) ? 'That email already has an account' : msg });
    }

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: invited.user.id,
      org_id: orgId,
      full_name: fullName || email.split('@')[0],
      email,
      role,
    });
    if (profileErr) throw new Error(profileErr.message);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.invite',
      entity: 'profiles',
      entity_id: invited.user.id,
      meta: { email, role },
    });

    res.json({ data: { id: invited.user.id, email, role } });
  }),
);

/**
 * Add a teammate WITHOUT emailing them — for seeding the roster the studio
 * already agreed offline. They can sign in later with the same address.
 */
teamRouter.post(
  '/',
  requirePermission('team', 'create'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const fullName = String(req.body?.full_name ?? '').trim();
    const role = String(req.body?.role ?? 'assistant');
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!USER_ROLES.includes(role as UserRole)) return res.status(400).json({ error: 'Invalid role' });

    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    // A profile row is keyed to an auth user, so one has to exist first.
    // Created without a confirmation email; they set a password via the
    // normal "forgot password" flow when they first sign in.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const msg = createErr?.message ?? 'Could not create the account';
      return res.status(400).json({ error: /already/i.test(msg) ? 'That email already has an account' : msg });
    }

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      org_id: orgId,
      full_name: fullName || email.split('@')[0],
      email,
      role,
    });
    if (profileErr) throw new Error(profileErr.message);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.add',
      entity: 'profiles',
      entity_id: created.user.id,
      meta: { email, role },
    });

    res.json({ data: { id: created.user.id, email, role } });
  }),
);
