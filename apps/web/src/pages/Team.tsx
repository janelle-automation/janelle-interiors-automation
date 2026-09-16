import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, SEATS, SEAT_KEYS, USER_ROLES, type Seat, type UserRole } from '@janelle/shared';
import { PageHeading, Card, Pill } from '../components/ui';
import {
  useAddTeamMember, useEditTeamMember, useRemoveTeamMember, useSetRole, useTeam, useTeamAbilities,
  type TeamMember,
} from '../lib/queries';


/** What each role is for, in the studio's own terms. */
const ROLE_BLURB: Record<UserRole, string> = {
  principal: 'Full access. The only role that can change people, roles and studio rules.',
  coordinator: 'Runs the board: reassigns work, chases follow-ups, edits any project or order.',
  designer: 'Owns specs and drawings. Edits projects and the prompt library, not money.',
  procurement: 'Owns vendors and purchase orders. Cannot change project stages.',
  assistant: 'Works their own queue and drafts. Read-only everywhere else.',
};


function AddPerson({ onDone }: { onDone: () => void }) {
  const add = useAddTeamMember();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('assistant');
  const [invite, setInvite] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          { email: email.trim(), full_name: name.trim(), role, invite },
          {
            onSuccess: () => {
              setEmail('');
              setName('');
              onDone();
            },
          },
        );
      }}
      className="border-t border-line-soft bg-sunk/30 px-5 py-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[12rem]">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Name</span>
          <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Joanna" />
        </label>
        <label className="flex-1 min-w-[14rem]">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Email</span>
          <input
            className="input w-full"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="joanna@janelleinteriors.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {USER_ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary btn-sm" disabled={add.isPending || !email.trim()}>
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[12.5px] text-ink-soft">
        <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
        {/* Off by default: adding someone to the roster should not put mail in
            their inbox unless the studio chose to. */}
        Email them a sign-in link now
      </label>
      <p className="mt-1 text-[11px] text-ink-faint">
        {invite
          ? 'Supabase will send them an invitation email.'
          : 'No email is sent. They sign in later with this address using “forgot password”.'}
      </p>

      {add.isError && <p className="mt-2 text-[12.5px] text-crit">{(add.error as Error).message}</p>}
    </form>
  );
}

/**
 * One person: who they are, what they carry, and — for someone allowed to
 * manage the team — their role and seat, and editing or removing them.
 * Removing asks first, in place: a person is not a row to lose by a slip.
 */
function PersonRow({
  m, canUpdate, canDelete, principals,
}: { m: TeamMember; canUpdate: boolean; canDelete: boolean; principals: number }) {
  const setRole = useSetRole();
  const edit = useEditTeamMember();
  const remove = useRemoveTeamMember();
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [name, setName] = useState(m.full_name ?? '');
  const [email, setEmail] = useState(m.email ?? '');

  const lastPrincipal = m.role === 'principal' && principals <= 1;
  const error = (setRole.error ?? edit.error ?? remove.error) as Error | null;

  if (mode === 'edit') {
    return (
      <li className="px-5 py-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const change: { id: string; full_name?: string; email?: string } = { id: m.id };
            if (name.trim() !== (m.full_name ?? '')) change.full_name = name.trim();
            if (email.trim().toLowerCase() !== (m.email ?? '').toLowerCase()) change.email = email.trim();
            if (!change.full_name && !change.email) {
              setMode('view');
              return;
            }
            edit.mutate(change, { onSuccess: () => setMode('view') });
          }}
        >
          <label className="min-w-[12rem] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Name</span>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus />
          </label>
          <label className="min-w-[14rem] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Sign-in email</span>
            <input className="input w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary btn-sm" disabled={edit.isPending}>
              {edit.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                setName(m.full_name ?? '');
                setEmail(m.email ?? '');
                edit.reset();
                setMode('view');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
        <p className="mt-2 text-[11.5px] text-ink-faint">No email is sent when a name or address changes.</p>
        {edit.isError && <p className="mt-1 text-[12.5px] text-crit">{(edit.error as Error).message}</p>}
      </li>
    );
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brass/10 text-[13px] font-bold text-brass-deep">
          {(m.full_name ?? m.email ?? '?').slice(0, 1).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">
            {m.full_name ?? '—'}
            {m.is_you && <span className="ml-2 text-[11px] font-normal text-ink-faint">you</span>}
          </div>
          <div className="truncate text-[12.5px] text-ink-soft">{m.email ?? '—'}</div>
        </div>

        <div className="text-[12px] text-ink-faint sm:w-28">
          {m.live_tasks ? `${m.live_tasks} open task${m.live_tasks === 1 ? '' : 's'}` : 'no open work'}
        </div>

        {canUpdate ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="input sm:w-44"
              value={m.role}
              // Losing the last principal would make roles unchangeable
              // by anyone, so that one case is locked in the UI too.
              disabled={setRole.isPending || lastPrincipal}
              title={lastPrincipal ? 'The studio needs at least one principal' : undefined}
              onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as UserRole })}
            >
              {USER_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            {/* The seat is what routes work: two people can share a
                role and owe completely different outcomes. */}
            <select
              className="input sm:w-52"
              value={m.seat ?? ''}
              disabled={setRole.isPending}
              title="The named seat from the roles document — this is what routes work"
              onChange={(e) =>
                setRole.mutate({ id: m.id, seat: (e.target.value || null) as Seat | null })
              }
            >
              <option value="">No seat</option>
              {SEAT_KEYS.map((k) => (
                <option key={k} value={k}>{SEATS[k].label}</option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Pill tone="neutral">{ROLE_LABELS[m.role]}</Pill>
            {m.seat && <Pill tone="brass">{SEATS[m.seat].label}</Pill>}
          </div>
        )}

        {(canUpdate || canDelete) && (
          <div className="flex gap-1.5 sm:ml-1">
            {canUpdate && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => setMode('edit')} aria-label={`Edit ${m.full_name ?? m.email}`}>
                Edit
              </button>
            )}
            {canDelete && !m.is_you && (
              <button
                type="button"
                className="btn-secondary btn-sm text-crit hover:border-crit/50"
                onClick={() => setMode('remove')}
                disabled={lastPrincipal}
                title={lastPrincipal ? 'The studio needs at least one principal' : undefined}
                aria-label={`Remove ${m.full_name ?? m.email}`}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      {mode === 'remove' && (
        <div role="alertdialog" aria-label={`Remove ${m.full_name ?? m.email}`} className="mt-3 rounded-lg border border-crit/30 bg-crit/5 px-4 py-3">
          <p className="text-[13px] text-ink">
            Remove <span className="font-semibold">{m.full_name ?? m.email}</span> from the studio? They will no longer be
            able to sign in.
            {m.live_tasks ? ` Their ${m.live_tasks} open task${m.live_tasks === 1 ? '' : 's'} will stay on the board, unassigned.` : ''}{' '}
            Nothing is emailed to them.
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-crit px-3 py-1.5 text-[12.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
              disabled={remove.isPending}
              onClick={() => remove.mutate(m.id)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { remove.reset(); setMode('view'); }}>
              Keep
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[12.5px] text-crit">{error.message}</p>}
    </li>
  );
}

export default function Team() {
  const { data: team, isLoading } = useTeam();
  const { data: can } = useTeamAbilities();
  const [adding, setAdding] = useState(false);

  const principals = team.filter((m) => m.role === 'principal').length;
  const manages = Boolean(can?.create || can?.update || can?.delete);

  return (
    <>
      <PageHeading
        title="Team & roles"
        sub="Who is in the studio, what each role may do, and who owns what. Roles are enforced in the app and again in the database."
        action={
          can?.create ? (
            <button onClick={() => setAdding((v) => !v)} className="btn-primary btn-sm">
              {adding ? 'Cancel' : 'Add person'}
            </button>
          ) : undefined
        }
      />

      <div className="space-y-8">
        <Card>
          <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">People</h2>
            <span className="text-[12px] text-ink-faint">{team.length} in the studio</span>
          </div>

          {adding && <AddPerson onDone={() => setAdding(false)} />}

          <ul className="divide-y divide-line-soft">
            {isLoading && <li className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</li>}

            {!isLoading && team.length === 0 && (
              <li className="px-5 py-10 text-center text-[13px] text-ink-faint">
                Nobody here yet. Tasks stay unassigned until the studio's people are added.
              </li>
            )}

            {team.map((m) => (
              <PersonRow key={m.id} m={m} canUpdate={Boolean(can?.update)} canDelete={Boolean(can?.delete)} principals={principals} />
            ))}
          </ul>

          {!manages && (
            <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
              Only someone allowed to manage the team can add, edit or remove people.
            </div>
          )}
        </Card>

        <Card>
          <div className="border-b border-line-soft px-5 py-4">
            <h2 className="text-[16px] font-semibold text-ink">What each role may do</h2>
            <p className="mt-1 text-[13px] text-ink-soft">
              Everyone can see the studio's work — that visibility is the point. What is restricted is
              changing money, changing someone else's assignment, and changing the rules.
            </p>
          </div>

          <ul className="divide-y divide-line-soft">
            {USER_ROLES.map((r) => (
              <li key={r} className="px-5 py-3">
                <span className="text-[13.5px] font-semibold text-ink">{ROLE_LABELS[r]}</span>
                <span className="ml-2 text-[13px] text-ink-soft">{ROLE_BLURB[r]}</span>
              </li>
            ))}
          </ul>

          <div className="border-t border-line-soft px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12.5px] text-ink-soft">
                Exactly what each role may do — module by module, and editable without a deploy —
                lives in Permissions.
              </p>
              <Link to="/permissions" className="btn-secondary btn-sm shrink-0">
                Open Permissions →
              </Link>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
