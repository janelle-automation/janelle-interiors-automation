import { Router } from 'express';
import { SEAT_KEYS, USER_ROLES, canWith, type Seat, type UserRole } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { hasSeatColumn, profileColumns } from '../lib/columns.js';

export const teamRouter = Router();
teamRouter.use(requireAuth);

// The people in this org, for assignee pickers and the admin screen.
// RLS scopes it to the caller's org.
teamRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('profiles')
      .select(await profileColumns('id, full_name, email, role, created_at'))
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

    // The select is built at runtime (seat only exists after 0008), so the
    // client cannot infer a row type for it.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    res.json({
      data: rows.map((p) => {
        const id = p.id as string;
        return { ...p, live_tasks: load.get(id) ?? 0, is_you: id === req.auth!.userId };
      }),
    });
  }),
);

// What the caller may do on this screen, so it offers only those controls.
// The routes below check again; this only decides what is shown.
teamRouter.get('/can', (req, res) => {
  const { permissions, role } = req.auth!;
  res.json({
    data: {
      create: canWith(permissions, role, 'team', 'create'),
      update: canWith(permissions, role, 'team', 'update'),
      delete: canWith(permissions, role, 'team', 'delete'),
    },
  });
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Change someone's name, sign-in email, role or seat. This is how access is
// granted, so only those the permission matrix allows.
teamRouter.patch(
  '/:id',
  requirePermission('team', 'update'),
  asyncHandler(async (req, res) => {
    // Role and seat are set through the same screen but mean different
    // things: the role is what the software lets you touch, the seat is the
    // outcome the roles document holds you to. Either may be sent alone.
    const hasRole = 'role' in (req.body ?? {});
    const hasSeat = 'seat' in (req.body ?? {});
    const hasName = 'full_name' in (req.body ?? {});
    const hasEmail = 'email' in (req.body ?? {});
    const fullName = String(req.body?.full_name ?? '').replace(/\s+/g, ' ').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (hasName && (!fullName || fullName.length > 120)) {
      return res.status(400).json({ error: 'A name is required (at most 120 characters)' });
    }
    if (hasEmail && !EMAIL.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    const role = String(req.body?.role ?? '');
    // An empty seat is meaningful — it takes the seat away again.
    const seat = req.body?.seat === null || req.body?.seat === '' ? null : String(req.body?.seat ?? '');

    if (hasRole && !USER_ROLES.includes(role as UserRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (hasSeat && seat !== null && !SEAT_KEYS.includes(seat as Seat)) {
      return res.status(400).json({ error: 'Invalid seat' });
    }
    if (!hasRole && !hasSeat && !hasName && !hasEmail) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });

    if (hasSeat && !(await hasSeatColumn())) {
      return res.status(503).json({
        error: 'Seats are not available yet — apply migration 0008 (npm run db:apply) first',
      });
    }

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, role, org_id')
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
    if (hasRole && (target as { role: string }).role === 'principal' && role !== 'principal') {
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
    const patch: Record<string, unknown> = {};
    if (hasRole) patch.role = role;
    if (hasSeat) patch.seat = seat;
    if (hasName) patch.full_name = fullName;

    // A new sign-in address changes the account itself, not only the profile.
    // Confirmed on the spot, so Supabase sends no confirmation email to
    // either address — changing someone's email never mails them.
    const previousEmail = (target as { email: string | null }).email;
    if (hasEmail && email !== (previousEmail ?? '').toLowerCase()) {
      const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, { email, email_confirm: true });
      if (authErr) {
        return res.status(400).json({
          error: /already|exists|registered/i.test(authErr.message) ? 'That email already has an account' : authErr.message,
        });
      }
      patch.email = email;
    }
    if (!Object.keys(patch).length) return res.json({ data: target });

    // One seat, one holder: the roles document allows a person two seats but
    // never two people in one seat, and the whole point of routing by seat is
    // that it names exactly one person. Clear it from whoever held it.
    if (hasSeat && seat) {
      await supabaseAdmin
        .from('profiles')
        .update({ seat: null })
        .eq('org_id', req.auth!.orgId)
        .eq('seat', seat)
        .neq('id', req.params.id);
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(patch)
      .eq('id', req.params.id)
      .select(await profileColumns('id, full_name, email, role'))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Person not found in this studio' });

    await supabaseAdmin.from('activity_log').insert({
      org_id: req.auth!.orgId,
      actor: req.auth!.userId,
      action: hasRole || hasSeat ? 'team.role_change' : 'team.edit',
      entity: 'profiles',
      entity_id: req.params.id,
      meta: {
        ...(hasRole ? { role } : {}),
        ...(hasSeat ? { seat } : {}),
        ...(hasName ? { renamed_from: (target as { full_name: string | null }).full_name } : {}),
        ...(patch.email ? { email_from: previousEmail, email_to: patch.email } : {}),
        name: (data as unknown as { full_name: string | null }).full_name,
      },
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

/**
 * Remove someone from the studio: their sign-in account and their profile.
 *
 * Nothing they touched is lost. Their tasks stay on the board, unassigned,
 * for whoever runs it to hand on; what they wrote keeps its history with the
 * author left blank (the foreign keys set it null). Refused for yourself, for
 * the studio's last principal, and for the account the studio's Gmail and
 * Drive are read through — removing that one would stop the reading.
 */
teamRouter.delete(
  '/:id',
  requirePermission('team', 'delete'),
  asyncHandler(async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Backend not configured' });
    const orgId = req.auth!.orgId;
    const id = req.params.id;

    if (id === req.auth!.userId) {
      return res.status(400).json({ error: 'You cannot remove your own account' });
    }

    const { data: target } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, role, org_id')
      .eq('id', id)
      .maybeSingle();
    const person = target as { id: string; full_name: string | null; email: string | null; role: UserRole; org_id: string } | null;
    if (!person || person.org_id !== orgId) {
      return res.status(404).json({ error: 'Person not found in this studio' });
    }

    if (person.role === 'principal') {
      const { count } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('role', 'principal');
      if ((count ?? 0) <= 1) {
        return res.status(400).json({ error: 'That is the studio’s only principal — make someone else principal first' });
      }
    }

    const { data: google } = await supabaseAdmin
      .from('integrations')
      .select('status')
      .eq('user_id', id)
      .eq('provider', 'google')
      .maybeSingle();
    if ((google as { status?: string } | null)?.status === 'connected') {
      return res.status(400).json({
        error: 'The studio’s Gmail and Drive are connected through this account — connect Google from another principal in Settings first',
      });
    }

    // Counted before, because afterwards they belong to nobody.
    const { count: openTasks } = await supabaseAdmin
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('assigned_to', id)
      .in('status', ['open', 'in_progress', 'blocked']);

    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (authErr && !/not.?found/i.test(authErr.message)) throw new Error(authErr.message);
    // Deleting the account removes the profile with it; a profile with no
    // account behind it is removed directly.
    await supabaseAdmin.from('profiles').delete().eq('id', id).eq('org_id', orgId);

    await supabaseAdmin.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'team.remove',
      entity: 'profiles',
      entity_id: id,
      meta: { name: person.full_name, email: person.email, role: person.role, unassigned_tasks: openTasks ?? 0 },
    });

    res.json({ data: { id, unassigned_tasks: openTasks ?? 0 } });
  }),
);
