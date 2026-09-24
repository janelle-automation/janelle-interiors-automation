import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, SEATS, SEAT_KEYS, USER_ROLES, type Seat, type UserRole } from '@janelle/shared';
import { Page, PageHeading, Card, Pill } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { startImpersonation } from '../lib/impersonate';
import {
  useAddTeamMember, useEditTeamMember, useRemoveTeamMember, useSendInvite, useSetRole, useTeam, useTeamAbilities,
  type AddedMember, type TeamMember,
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
  const [added, setAdded] = useState<AddedMember | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          { email: email.trim(), full_name: name.trim(), role, invite },
          {
            onSuccess: (result) => {
              setEmail('');
              setName('');
              // Kept on screen rather than closing: the password is here, and
              // closing the form would be the last anyone saw of it.
              if (invite && result?.password) setAdded(result);
              else onDone();
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
          ? 'Sent from the studio mailbox, with a password to sign in and a copy to the principal.'
          : 'No email is sent. They sign in later with this address using “forgot password”.'}
      </p>

      {add.isError && <p className="mt-2 text-[12.5px] text-crit">{(add.error as Error).message}</p>}

      {/* The password is shown once, here, and never again. It is the only
          copy the studio has if the email did not arrive. */}
      {added && (
        <div
          className={`mt-3 rounded-lg px-3 py-2.5 text-[12.5px] ${
            added.emailed ? 'bg-good/10 text-good' : 'bg-warn/10 text-warn'
          }`}
        >
          {added.emailed ? (
            <>Invitation sent to {added.email}.</>
          ) : (
            <>
              <span className="font-semibold">{added.email} was added, but the email did not send.</span>
              {added.mailError ? ` (${added.mailError})` : ''} Give them this password yourself — it is not
              shown again:
            </>
          )}
          {added.password && (
            <div className="mt-2 flex items-center gap-2">
              <code className="select-all rounded bg-ink/10 px-2 py-1 font-mono text-[12.5px] text-ink">
                {added.password}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(added.password ?? '')}
                className="btn-secondary btn-sm"
              >
                Copy
              </button>
              <button type="button" onClick={() => setAdded(null)} className="btn-ghost btn-sm">
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}

/** Whose Google is connected — until it is, none of that person's mail is read. */
function GoogleStatus({ g }: { g: TeamMember['google'] }) {
  if (!g?.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-faint" title="Their mail is not being read until they connect Gmail in Settings">
        <span className="h-2 w-2 rounded-full bg-ink-faint/40" aria-hidden="true" />
        Not connected
      </span>
    );
  }
  if (g.needs_reconnect) {
    return (
      <span
        className="inline-flex flex-col"
        title={`Google refused the stored access (${g.needs_reconnect}). Only they can fix this: sign in and press Reconnect in Settings.`}
      >
        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-crit">
          <span className="h-2 w-2 rounded-full bg-crit" aria-hidden="true" />
          Needs reconnect
        </span>
        <span className="pl-3.5 text-[11px] text-ink-faint">they must reconnect</span>
      </span>
    );
  }
  const partial = !(g.gmail && g.drive);
  const since = g.connected_at
    ? new Date(g.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  return (
    <span className="inline-flex flex-col">
      <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${partial ? 'text-warn' : 'text-good'}`}>
        <span className={`h-2 w-2 rounded-full ${partial ? 'bg-warn' : 'bg-good'}`} aria-hidden="true" />
        {partial ? (g.gmail ? 'Gmail only' : 'Drive only') : 'Connected'}
      </span>
      {since && <span className="pl-3.5 text-[11px] text-ink-faint">since {since}</span>}
    </span>
  );
}

/**
 * One person as a table row: who they are, their role and seat, whether
 * their Google is connected, what they carry, and — for someone allowed to
 * manage the team — editing, inviting or removing them. The confirmations
 * open as a full-width row beneath, so a person is never lost by a slip.
 */
function PersonRow({
  m, canUpdate, canDelete, canImpersonate, principals, columns,
}: { m: TeamMember; canUpdate: boolean; canDelete: boolean; canImpersonate: boolean; principals: number; columns: number }) {
  const { user } = useAuth();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const setRole = useSetRole();
  const edit = useEditTeamMember();
  const remove = useRemoveTeamMember();
  const [mode, setMode] = useState<'view' | 'edit' | 'remove' | 'invite' | null>('view');
  const invite = useSendInvite();
  // The issued password, shown once. Kept on the row rather than in a toast,
  // because it belongs to this person and nothing else can recover it.
  const [sent, setSent] = useState<AddedMember | null>(null);
  const [name, setName] = useState(m.full_name ?? '');
  const [email, setEmail] = useState(m.email ?? '');

  const lastPrincipal = m.role === 'principal' && principals <= 1;
  const error = (setRole.error ?? edit.error ?? remove.error ?? (switchError ? new Error(switchError) : null)) as Error | null;
  const panel = mode === 'edit' || mode === 'invite' || mode === 'remove' || Boolean(sent) || Boolean(error);

  return (
    <>
      <tr className={`transition-colors hover:bg-sunk/40 ${panel ? 'bg-sunk/30' : ''}`}>
        <td className="py-2.5 pl-5 pr-3">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brass/10 text-[12.5px] font-bold text-brass-deep">
              {(m.full_name ?? m.email ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium text-ink">
                {m.full_name ?? '—'}
                {m.is_you && <span className="ml-1.5 rounded bg-brass/10 px-1.5 py-px text-[10.5px] font-semibold text-brass-deep">you</span>}
              </div>
              <div className="truncate text-[12px] text-ink-soft">{m.email ?? '—'}</div>
            </div>
          </div>
        </td>

        <td className="px-3 py-2.5">
          {canUpdate ? (
            <select
              className="input h-8 w-full min-w-[9rem] py-0 text-[12.5px]"
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
          ) : (
            <Pill tone="neutral">{ROLE_LABELS[m.role]}</Pill>
          )}
        </td>

        <td className="px-3 py-2.5">
          {/* The seat is what routes work: two people can share a role and
              owe completely different outcomes. */}
          {canUpdate ? (
            <select
              className="input h-8 w-full min-w-[10rem] py-0 text-[12.5px]"
              value={m.seat ?? ''}
              disabled={setRole.isPending}
              title="The named seat from the roles document — this is what routes work"
              onChange={(e) => setRole.mutate({ id: m.id, seat: (e.target.value || null) as Seat | null })}
            >
              <option value="">No seat</option>
              {SEAT_KEYS.map((k) => (
                <option key={k} value={k}>{SEATS[k].label}</option>
              ))}
            </select>
          ) : m.seat ? (
            <Pill tone="brass">{SEATS[m.seat].label}</Pill>
          ) : (
            <span className="text-[12px] text-ink-faint">—</span>
          )}
        </td>

        <td className="px-3 py-2.5">
          <GoogleStatus g={m.google} />
        </td>

        <td className="px-3 py-2.5 text-right tabular-nums">
          {m.live_tasks ? (
            <span className="text-[13px] font-medium text-ink">{m.live_tasks}</span>
          ) : (
            <span className="text-[12px] text-ink-faint">—</span>
          )}
        </td>

        {columns > 5 && (
          <td className="py-2.5 pl-3 pr-5">
            <div className="flex justify-end gap-1">
              {/* Only the studio admin account sees this; the API checks again. */}
              {canImpersonate && !m.is_you && m.email && (
                <button
                  type="button"
                  className="btn-ghost btn-sm text-brass-deep"
                  disabled={switching}
                  title={`See the system exactly as ${m.full_name ?? m.email} does. Recorded in the audit log.`}
                  onClick={() => {
                    setSwitching(true);
                    setSwitchError(null);
                    startImpersonation(m.id, user?.name ?? 'your account').catch((err: Error) => {
                      setSwitchError(err.message);
                      setSwitching(false);
                    });
                  }}
                >
                  {switching ? 'Signing in…' : 'Log in as'}
                </button>
              )}
              {canUpdate && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')} aria-label={`Edit ${m.full_name ?? m.email}`}>
                  Edit
                </button>
              )}
              {canUpdate && m.email && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => setMode(mode === 'invite' ? 'view' : 'invite')}
                  disabled={invite.isPending}
                  title="Email them a new password to sign in with"
                  aria-label={`Send sign-in details to ${m.full_name ?? m.email}`}
                >
                  {invite.isPending ? 'Sending…' : 'Invite'}
                </button>
              )}
              {canDelete && !m.is_you && (
                <button
                  type="button"
                  className="btn-ghost btn-sm text-crit hover:text-crit"
                  onClick={() => setMode(mode === 'remove' ? 'view' : 'remove')}
                  disabled={lastPrincipal}
                  title={lastPrincipal ? 'The studio needs at least one principal' : undefined}
                  aria-label={`Remove ${m.full_name ?? m.email}`}
                >
                  Remove
                </button>
              )}
            </div>
          </td>
        )}
      </tr>

      {panel && (
        <tr className="bg-sunk/30">
          <td colSpan={columns} className="px-5 pb-3.5 pt-0">
            {mode === 'edit' && (
              <form
                className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3"
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
                <p className="w-full text-[11.5px] text-ink-faint">No email is sent when a name or address changes.</p>
              </form>
            )}

            {/* Asked first, because it REPLACES whatever password they have.
                Nobody can read an existing password back — not even a
                principal — so "send it again" can only mean "issue a new one". */}
            {mode === 'invite' && (
              <div role="alertdialog" aria-label={`Send sign-in details to ${m.full_name ?? m.email}`} className="rounded-lg border border-warn/30 bg-warn/5 px-4 py-3">
                <p className="text-[13px] text-ink">
                  Email <span className="font-semibold">{m.email}</span> a new password? Their current one stops working,
                  and a copy of the message goes to the principal.
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={invite.isPending}
                    onClick={() =>
                      invite.mutate(m.id, {
                        onSuccess: (r) => {
                          setSent(r);
                          setMode(null);
                        },
                      })
                    }
                  >
                    {invite.isPending ? 'Sending…' : 'Send it'}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setMode('view')}>
                    Cancel
                  </button>
                  {invite.isError && <span className="text-[12.5px] text-crit">{(invite.error as Error).message}</span>}
                </div>
              </div>
            )}

            {sent && (
              <div className={`rounded-lg px-4 py-3 text-[12.5px] ${sent.emailed ? 'bg-good/10 text-good' : 'bg-warn/10 text-warn'}`}>
                {sent.emailed ? (
                  <>Sent to {sent.email}.</>
                ) : (
                  <>
                    <span className="font-semibold">The email did not send.</span>
                    {sent.mailError ? ` (${sent.mailError})` : ''} Their password has still been changed — give them this:
                  </>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {sent.password && (
                    <code className="select-all rounded bg-ink/10 px-2 py-1 font-mono text-[12.5px] text-ink">{sent.password}</code>
                  )}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void navigator.clipboard?.writeText(sent.password ?? '')}>
                    Copy
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => setSent(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {mode === 'remove' && (
              <div role="alertdialog" aria-label={`Remove ${m.full_name ?? m.email}`} className="rounded-lg border border-crit/30 bg-crit/5 px-4 py-3">
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
          </td>
        </tr>
      )}
    </>
  );
}

export default function Team() {
  const { data: team, isLoading } = useTeam();
  const { data: can } = useTeamAbilities();
  const [adding, setAdding] = useState(false);

  const principals = team.filter((m) => m.role === 'principal').length;
  const manages = Boolean(can?.create || can?.update || can?.delete || can?.impersonate);
  const columns = manages ? 6 : 5;
  const googleConnected = team.filter((m) => m.google?.connected).length;

  return (
    <Page>
      <PageHeading
        title="Team & roles"
        action={
          can?.create ? (
            <button onClick={() => setAdding((v) => !v)} className="btn-primary btn-sm">
              {adding ? 'Cancel' : 'Add person'}
            </button>
          ) : undefined
        }
      />

      <div className="space-y-6">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">People</h2>
              <p className="text-[12px] text-ink-faint">{team.length} in the studio</p>
            </div>
            {!isLoading && team.length > 0 && (
              <div className="flex items-center gap-2 text-[12px]">
                <Pill tone={googleConnected === team.length ? 'good' : 'warn'}>
                  {googleConnected} of {team.length} connected Google
                </Pill>
                {googleConnected < team.length && (
                  <span className="hidden text-ink-faint md:inline">Mail is only read for people who have connected.</span>
                )}
              </div>
            )}
          </div>

          {adding && <AddPerson onDone={() => setAdding(false)} />}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line-soft bg-sunk/40 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                  <th className="py-2.5 pl-5 pr-3 font-semibold">Person</th>
                  <th className="px-3 py-2.5 font-semibold">Role</th>
                  <th className="px-3 py-2.5 font-semibold">Seat</th>
                  <th className="px-3 py-2.5 font-semibold">Google</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Open tasks</th>
                  {manages && (
                    <th className="py-2.5 pl-3 pr-5 text-right font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {isLoading && (
                  <tr>
                    <td colSpan={columns} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td>
                  </tr>
                )}

                {!isLoading && team.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                      Nobody here yet. Tasks stay unassigned until the studio's people are added.
                    </td>
                  </tr>
                )}

                {team.map((m) => (
                  <PersonRow
                    key={m.id}
                    m={m}
                    canUpdate={Boolean(can?.update)}
                    canDelete={Boolean(can?.delete)}
                    canImpersonate={Boolean(can?.impersonate)}
                    principals={principals}
                    columns={columns}
                  />
                ))}
              </tbody>
            </table>
          </div>

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
    </Page>
  );
}
