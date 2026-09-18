import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ACTIONS,
  RESOURCES,
  RESOURCE_LABELS,
  ROLE_LABELS,
  USER_ROLES,
  type Action,
  type Resource,
  type UserRole,
} from '@janelle/shared';
import { PageHeading, Card, Pill, Switch } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import {
  usePermissionMatrix,
  useResetPermission,
  useSetPermission,
  useTeam,
  type PermissionCell,
} from '../lib/queries';

/**
 * Who may do what, per role, per module — and the screen where a principal
 * changes it without a deploy.
 *
 * The matrix in code is the studio DEFAULT. Anything changed here is stored
 * as a single override row, read by the API and by row-level security in
 * Postgres, so a grant made on this page is a grant the database honours.
 */

const ACTION_LABELS: Record<Action, string> = {
  read: 'View',
  create: 'Add',
  update: 'Edit',
  delete: 'Delete',
};

const ACTION_HINTS: Record<Action, string> = {
  read: 'See it',
  create: 'Create new ones',
  update: 'Change existing ones',
  delete: 'Remove them for good',
};

/** What each role is for, in the studio's own terms. */
const ROLE_BLURB: Record<UserRole, string> = {
  principal: 'Full access. The only role that can change people, roles and studio rules.',
  coordinator: 'Runs the board: reassigns work, chases follow-ups, edits any project or order.',
  designer: 'Owns specs and drawings. Edits projects and the prompt library, not money.',
  procurement: 'Owns vendors, purchase orders and chasing vendors who have gone quiet.',
  assistant: 'Works their own queue and drafts, and keeps the task board honest.',
};

/** Compact, read-only: for comparing roles side by side. */
function Mark({ cell }: { cell: PermissionCell | undefined }) {
  if (!cell) return <span className="text-ink-faint/40">–</span>;
  return (
    <span
      title={`${cell.allowed ? 'Allowed' : 'Not allowed'}${cell.overridden ? ' · changed from default' : ''}`}
      className={cell.overridden ? 'rounded-sm px-1 ring-1 ring-brass/50' : undefined}
    >
      {cell.allowed ? (
        <span className="text-brass">●</span>
      ) : (
        <span className="text-ink-faint/40">–</span>
      )}
    </span>
  );
}

/**
 * One grant, as a switch. Flipping it back to the studio default deletes
 * the override rather than storing the same answer twice — so a marked
 * switch always means someone deliberately changed it.
 */
function Toggle({
  cell,
  moduleLabel,
  actionLabel,
  editable,
  busy,
  onChange,
}: {
  cell: PermissionCell | undefined;
  moduleLabel: string;
  actionLabel: string;
  editable: boolean;
  busy: boolean;
  onChange: (next: boolean, backToDefault: boolean) => void;
}) {
  if (!cell) return <span className="text-ink-faint/40">–</span>;

  const why = cell.locked
    ? 'Locked — cannot be changed'
    : cell.overridden
      ? `Changed by the studio (default: ${cell.default ? 'allowed' : 'not allowed'})`
      : 'Studio default';

  return (
    <Switch
      checked={cell.allowed}
      disabled={cell.locked || busy}
      marked={cell.overridden}
      label={`${actionLabel} ${moduleLabel}`}
      title={`${actionLabel} ${moduleLabel} · ${why}`}
      onChange={
        editable && !cell.locked
          ? (next) => onChange(next, next === cell.default)
          : undefined
      }
    />
  );
}

export default function Permissions() {
  const { user } = useAuth();
  const matrix = usePermissionMatrix();
  const setPermission = useSetPermission();
  const resetPermission = useResetPermission();
  const { data: team } = useTeam();

  const [role, setRole] = useState<UserRole>(user?.role ?? 'assistant');

  const cells = matrix.data?.cells ?? [];
  const storageReady = matrix.data?.storageReady ?? false;
  const canEdit = matrix.data?.canEdit ?? false;
  const busy = setPermission.isPending || resetPermission.isPending;

  const index = new Map(cells.map((c) => [`${c.role}:${c.resource}:${c.action}`, c]));
  const at = (r: UserRole, resource: Resource, action: Action) =>
    index.get(`${r}:${resource}:${action}`);

  const changedCount = cells.filter((c) => c.overridden).length;
  const peopleInRole = (r: UserRole) => team.filter((m) => m.role === r).length;

  const change = (r: UserRole, resource: Resource, action: Action) =>
    (next: boolean, backToDefault: boolean) =>
      backToDefault
        ? resetPermission.mutate({ role: r, resource, action })
        : setPermission.mutate({ role: r, resource, action, allowed: next });

  const error = (setPermission.error ?? resetPermission.error) as Error | undefined;

  return (
    <>
      <PageHeading
        title="Permissions"
        sub="Which type of user may do what, in every module. Change it here — no deploy needed."
      />

      {matrix.isLoading && (
        <Card className="p-6 text-[13px] text-ink-faint">Loading the access rules…</Card>
      )}

      {!matrix.isLoading && !storageReady && (
        <Card className="mb-6 border-warn/40 p-5">
          <div className="text-[13.5px] font-semibold text-ink">
            Showing the studio defaults — the database isn’t reachable
          </div>
          <p className="mt-1 text-[13px] text-ink-soft">
            The rules below are the built-in defaults and the toggles are read-only until the
            connection comes back. Nothing has been lost.
          </p>
        </Card>
      )}

      {!matrix.isLoading && storageReady && !canEdit && (
        <Card className="mb-6 p-5 text-[13px] text-ink-soft">
          These are the rules you work under. Only a principal can change them.
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        {/* Pick a type of user. */}
        <Card className="h-fit">
          <div className="border-b border-line-soft px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Type of user
          </div>
          <ul className="divide-y divide-line-soft">
            {USER_ROLES.map((r) => {
              const changed = cells.filter((c) => c.role === r && c.overridden).length;
              return (
                <li key={r}>
                  <button
                    onClick={() => setRole(r)}
                    className={`focusable flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors ${
                      role === r ? 'bg-sunk' : 'hover:bg-sunk/50'
                    }`}
                  >
                    <span className={`text-[13.5px] font-medium ${role === r ? 'text-ink' : 'text-ink-soft'}`}>
                      {ROLE_LABELS[r]}
                    </span>
                    <span className="text-[11.5px] text-ink-faint">
                      {peopleInRole(r)} {peopleInRole(r) === 1 ? 'person' : 'people'}
                      {changed > 0 && ` · ${changed} changed`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line-soft px-4 py-3 text-[11.5px] text-ink-faint">
            {changedCount === 0
              ? 'Every rule is at its default.'
              : `${changedCount} rule${changedCount === 1 ? '' : 's'} changed from default.`}
          </div>
        </Card>

        {/* What that user type may do, module by module. */}
        <div className="space-y-6">
          <Card>
            <div className="border-b border-line-soft px-5 py-4">
              <h2 className="text-[16px] font-semibold text-ink">
                What a {ROLE_LABELS[role]} may do
              </h2>
              <p className="mt-1 text-[13px] text-ink-soft">{ROLE_BLURB[role]}</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    <th className="px-5 py-3 font-semibold">Module</th>
                    {ACTIONS.map((a) => (
                      <th key={a} className="px-4 py-3 text-center font-semibold" title={ACTION_HINTS[a]}>
                        {ACTION_LABELS[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {RESOURCES.map((resource) => (
                    <tr key={resource}>
                      <td className="px-5 py-2.5 font-medium text-ink">
                        {RESOURCE_LABELS[resource]}
                      </td>
                      {ACTIONS.map((a) => (
                        <td key={a} className="px-4 py-2.5">
                          <div className="flex justify-center">
                            <Toggle
                              cell={at(role, resource, a)}
                              moduleLabel={RESOURCE_LABELS[resource]}
                              actionLabel={ACTION_LABELS[a]}
                              editable={canEdit}
                              busy={busy}
                              onChange={change(role, resource, a)}
                            />
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-1.5 border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-faint">
              {canEdit && <div>Flip a switch to grant or take away that module.</div>}
              <div>
                A ringed switch is one this studio changed; setting it back to the default clears
                the change. Locked switches are greyed out.
              </div>
              <div>
                Turning off View closes the module completely: it disappears from that role's
                sidebar and the API refuses it, whatever the other three switches say.
              </div>
              <div>
                A principal always keeps Team &amp; roles and Studio settings — otherwise nobody
                could grant access again.
              </div>
              {error && <div className="text-crit">{error.message}</div>}
            </div>
          </Card>

          {/* The whole picture, for comparing roles at a glance. */}
          <Card>
            <div className="border-b border-line-soft px-5 py-4">
              <h2 className="text-[16px] font-semibold text-ink">Every role, side by side</h2>
              <p className="mt-1 text-[13px] text-ink-soft">
                Each cell reads <span className="text-ink">View · Add · Edit · Delete</span>.
                Read-only here — click a role to edit it above.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                    <th className="px-5 py-3 font-semibold">Module</th>
                    {USER_ROLES.map((r) => (
                      <th key={r} className="px-3 py-3 text-center font-semibold">
                        {ROLE_LABELS[r].split(' ')[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {RESOURCES.map((resource) => (
                    <tr key={resource} className="text-ink-soft">
                      <td className="px-5 py-2.5 font-medium text-ink">
                        {RESOURCE_LABELS[resource]}
                      </td>
                      {USER_ROLES.map((r) => (
                        <td key={r} className="px-3 py-2.5 text-center">
                          <button
                            type="button"
                            onClick={() => setRole(r)}
                            title={`Edit what a ${ROLE_LABELS[r]} may do`}
                            className="focusable inline-flex gap-1.5 rounded px-1 py-0.5 hover:bg-sunk"
                          >
                            {ACTIONS.map((a) => (
                              <Mark key={a} cell={at(r, resource, a)} />
                            ))}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13.5px] font-semibold text-ink">Who is in each role?</div>
                <p className="mt-0.5 text-[12.5px] text-ink-soft">
                  Roles are assigned per person on Team &amp; Roles.
                </p>
              </div>
              <Link to="/team" className="btn-secondary btn-sm">Open Team &amp; Roles →</Link>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {USER_ROLES.map((r) => (
                <Pill key={r} tone={r === role ? 'brass' : 'neutral'}>
                  {ROLE_LABELS[r]} · {peopleInRole(r)}
                </Pill>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
