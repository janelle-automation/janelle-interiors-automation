import { useMemo, useState } from 'react';
import { Card, Pill, StatTile } from '../components/ui';
import { FilterSelect, SearchInput, SortTh, TablePager, TableToolbar, matches, useTable } from '../components/table';
import { IconKey } from '../components/icons';
import { describeDevice } from '../lib/loginEvents';
import { useLoginHistory, type LoginEvent, type LoginHistorySummary, type LoginMethodName } from '../lib/queries';

/**
 * Who got in, when, how — and who could not.
 *
 * Written after a sign-in that did not work and left no trace: Supabase
 * records successes only, in a schema the API cannot read, so "she could
 * not get in with Google yesterday" was unanswerable. Every row here is an
 * attempt, and the failures are the ones worth the screen.
 */

const METHOD_LABELS: Record<LoginMethodName, string> = {
  password: 'Password',
  google: 'Google',
  recovery: 'Reset link',
  invite: 'Invitation',
  unknown: 'Unknown',
};

/** Date and time together: on this screen the time of day is the point. */
function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function Outcome({ row }: { row: LoginEvent }) {
  return row.outcome === 'success' ? <Pill tone="good">Signed in</Pill> : <Pill tone="crit">Failed</Pill>;
}

/**
 * What Google actually said, when Google has actually refused somebody.
 *
 * This used to carry a configuration checklist as well, shown whenever no
 * Google sign-in had ever been recorded. That was wrong twice over: a table
 * created five minutes ago has recorded nothing by definition, so a brand
 * new install accused a perfectly good configuration of never having
 * worked — and the advice was addressed to whoever set the provider up,
 * who had already done it. Absence of evidence was being printed as a
 * verdict.
 *
 * What remains only appears when there is something to report: a recorded
 * failure, with the message the person was given.
 */
function GoogleFailures({ failures }: { failures: LoginEvent[] }) {
  const googleFailures = failures.filter((f) => f.method === 'google');
  if (googleFailures.length === 0) return null;

  return (
    <Card className="border-warn/30 bg-warn/[0.04] p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-warn/30 bg-warn/10 text-warn">
          <IconKey width={18} height={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-ink">Google turned somebody away</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
            What they were told, most recent first. A message naming the redirect URI points at the allowlist in
            Supabase → Authentication → URL Configuration; anything else is usually the one account or the one
            browser.
          </p>
          <ul className="mt-3 space-y-1.5 rounded-lg border border-line bg-surface p-3">
            {googleFailures.slice(0, 4).map((f) => (
              <li key={f.id} className="text-[12.5px] text-ink-soft">
                <span className="tabular-nums text-ink-faint">{when(f.created_at)}</span>
                {f.email && <span className="ml-2 text-ink">{f.email}</span>}
                <span className="ml-2">— {f.reason ?? 'no message recorded'}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/**
 * Where the sign-in came from, as a person would say it.
 *
 * Every answer here that is not a city has to explain ITSELF, because the
 * question this column gets asked is never "what is the value" but "why
 * is there no city". The first attempt said "This network" for every
 * address that could not be looked up, which told the reader nothing and
 * was asked about immediately. Four outcomes, each with a reason on hover:
 *
 *   a city        — resolved, and the only one that is really an answer
 *   Same machine  — loopback: browser and server are the same computer
 *   Local network — an office LAN address, which has no public location
 *   Not resolved  — a real public address the lookup could not place
 *   —             — no address was recorded at all (rows before 0035)
 */
interface Place {
  text: string;
  muted: boolean;
  /** Why this is not a city. Shown on hover. */
  why: string;
}

function describePlace(row: LoginEvent): Place {
  const named = [row.city, row.country].filter(Boolean).join(', ');
  if (named) {
    const full = [row.city, row.region, row.country].filter(Boolean).join(', ');
    return {
      text: named,
      muted: false,
      why:
        `${full}${row.ip ? ` · ${row.ip}` : ''}` +
        // An address the browser asserted is a weaker fact than one the
        // server watched arrive, and the row says which it was.
        (row.ip_source === 'client'
          ? ' · reported by the browser, as the server saw only a local address'
          : ''),
    };
  }

  if (!row.ip) {
    return {
      text: '—',
      muted: true,
      why: 'No address was recorded for this attempt.',
    };
  }

  if (isLoopback(row.ip)) {
    return {
      text: 'Same machine',
      muted: true,
      why:
        `The browser and the server were the same computer (${row.ip}), so there is no public ` +
        'address to look up. Normal when the app is run locally.',
    };
  }

  if (isPrivateAddress(row.ip)) {
    return {
      text: 'Local network',
      muted: true,
      why:
        `A private address on the studio's own network (${row.ip}). These exist only inside that ` +
        'network and have no location of their own.',
    };
  }

  return {
    text: 'Not resolved',
    muted: true,
    why: `${row.ip} is a public address, but the lookup could not place it.`,
  };
}

/** The server itself — the browser was on the same computer. */
function isLoopback(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  return addr === '::1' || addr === '0.0.0.0' || /^127\./.test(addr);
}

/**
 * The same test the API applies before it calls out. Repeated here rather
 * than shared, because the API's copy must never be bundled into the
 * browser and this is four lines of regex.
 */
function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  if (isLoopback(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr) || addr.startsWith('fe80:')) return true;
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(addr);
}

/**
 * The Google tile, which has three things to say and used to say two.
 *
 * "Never used" in amber was shown for both "this has been tried and has
 * never once worked" and "nothing has been recorded yet" — and on a table
 * created minutes ago it is always the second. A screen that cannot tell
 * those apart should say so rather than pick the alarming one.
 */
function GoogleTile({ summary }: { summary: LoginHistorySummary | null }) {
  if (!summary) return <StatTile label="Google sign-in" value="—" hint="Loading" />;

  if (summary.googleEverWorked) {
    return <StatTile label="Google sign-in" value="Working" hint="Has succeeded at least once" tone="good" />;
  }

  const refused = summary.recentFailures.some((f) => f.method === 'google');
  if (refused) {
    return <StatTile label="Google sign-in" value="Refused" hint="Failing — see the message below" tone="crit" />;
  }

  return (
    <StatTile
      label="Google sign-in"
      value="No data yet"
      hint="Nobody has tried it since this screen was added"
    />
  );
}

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];

export default function LoginHistory() {
  const [days, setDays] = useState('30');
  const { data, isLoading, error } = useLoginHistory(Number(days));

  const [query, setQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');

  const all = data?.rows ?? [];
  const shown = useMemo(
    () =>
      all.filter((r) => {
        if (methodFilter !== 'all' && r.method !== methodFilter) return false;
        if (outcomeFilter !== 'all' && r.outcome !== outcomeFilter) return false;
        return matches(query, r.name, r.email, r.city, r.country, r.reason);
      }),
    [all, query, methodFilter, outcomeFilter],
  );

  const table = useTable(shown, {
    storageKey: 'login-history',
    defaultSort: { key: 'when', dir: 'desc' },
    sorters: {
      when: (r) => r.created_at,
      who: (r) => r.name || r.email || '',
      method: (r) => METHOD_LABELS[r.method],
      outcome: (r) => r.outcome,
      location: (r) => describePlace(r).text,
    },
  });

  const filtering = Boolean(query.trim()) || methodFilter !== 'all' || outcomeFilter !== 'all';
  const summary = data?.summary ?? null;
  const methodsPresent = (summary?.byMethod ?? []).map((m) => m.method);

  if (error) {
    return (
      <Card className="p-5">
        <p className="text-[13px] text-crit">{(error as Error).message}</p>
      </Card>
    );
  }

  // Deployed before the migration was run. Said plainly, rather than as an
  // empty table that looks like nobody has ever signed in.
  if (data && !data.ready) {
    return (
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold text-ink">Login history needs migration 0034</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          Run <code className="rounded bg-sunk px-1 py-0.5">npm run db:apply</code> — or paste{' '}
          <code className="rounded bg-sunk px-1 py-0.5">supabase/migrations/0034_login_history.sql</code> into the
          Supabase SQL editor. It creates the table and backfills the sign-ins Supabase has already recorded, so this
          screen opens with history rather than empty.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sign-ins" value={summary?.successes ?? '—'} hint={`In the last ${data?.days ?? 30} days`} tone="good" />
        <StatTile
          label="Failed attempts"
          value={summary?.failures ?? '—'}
          hint={summary?.failures ? 'Listed below, with what they were told' : 'Nothing refused'}
          tone={summary?.failures ? 'crit' : 'neutral'}
        />
        <StatTile label="People who signed in" value={summary?.people ?? '—'} hint="Distinct accounts" />
        <GoogleTile summary={summary} />
      </div>

      {summary && <GoogleFailures failures={summary.recentFailures} />}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Every attempt</h2>
            <p className="text-[12px] text-ink-faint">
              Successes and failures, newest first. Rows marked “from Supabase” predate this screen.
            </p>
          </div>
          <FilterSelect label="Period" value={days} onChange={setDays} options={WINDOWS} />
        </div>

        <TableToolbar
          search={
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search person, address, location or reason"
              label="Search sign-ins"
            />
          }
          filters={
            <>
              <FilterSelect
                label="Filter by how they logged in"
                value={methodFilter}
                onChange={setMethodFilter}
                options={[
                  { value: 'all', label: 'Any login type' },
                  ...methodsPresent.map((m) => ({ value: m, label: METHOD_LABELS[m] })),
                ]}
              />
              <FilterSelect
                label="Filter by outcome"
                value={outcomeFilter}
                onChange={setOutcomeFilter}
                options={[
                  { value: 'all', label: 'Any outcome' },
                  { value: 'success', label: 'Signed in' },
                  { value: 'failure', label: 'Failed' },
                ]}
              />
            </>
          }
          shown={shown.length}
          total={all.length}
          noun="attempt"
          onClear={
            filtering
              ? () => {
                  setQuery('');
                  setMethodFilter('all');
                  setOutcomeFilter('all');
                }
              : null
          }
        />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line-soft bg-sunk/40 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
                <SortTh table={table} col="when" className="py-2.5 pl-5 pr-3 font-semibold">When</SortTh>
                <SortTh table={table} col="who" className="px-3 py-2.5 font-semibold">Who</SortTh>
                <SortTh table={table} col="method" className="px-3 py-2.5 font-semibold">Logged in with</SortTh>
                <SortTh table={table} col="outcome" className="px-3 py-2.5 font-semibold">Outcome</SortTh>
                <th className="px-3 py-2.5 font-semibold">What happened</th>
                <SortTh table={table} col="location" className="px-3 py-2.5 font-semibold">Location</SortTh>
                <th className="py-2.5 pl-3 pr-5 font-semibold">Device</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</td>
                </tr>
              )}

              {!isLoading && all.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    No sign-ins recorded in this period.
                  </td>
                </tr>
              )}

              {!isLoading && all.length > 0 && shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-[13px] text-ink-faint">
                    Nothing matches these filters.
                  </td>
                </tr>
              )}

              {table.rows.map((r) => (
                <tr key={r.id} className={r.outcome === 'failure' ? 'bg-crit/[0.03]' : undefined}>
                  <td className="whitespace-nowrap py-3 pl-5 pr-3 text-[12.5px] tabular-nums text-ink-soft">
                    {when(r.created_at)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-[13px] font-medium text-ink">{r.name ?? r.email ?? 'Unknown'}</div>
                    {r.name && r.email && <div className="text-[11.5px] text-ink-faint">{r.email}</div>}
                    {!r.name && !r.email && (
                      <div className="text-[11.5px] text-ink-faint">No address recorded</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-[12.5px] text-ink-soft">{METHOD_LABELS[r.method]}</td>
                  <td className="px-3 py-3"><Outcome row={r} /></td>
                  <td className="max-w-[320px] px-3 py-3 text-[12.5px] text-ink-soft">
                    {r.reason ?? (r.source === 'backfill'
                      ? <span className="text-ink-faint">From Supabase’s own record</span>
                      : <span className="text-ink-faint">—</span>)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-[12.5px]">
                    {(() => {
                      const place = describePlace(r);
                      return (
                        <span
                          // Dotted underline on anything that is not a city:
                          // it marks the cell as having something to say, so
                          // the explanation gets found rather than guessed at.
                          className={
                            place.muted
                              ? 'cursor-help text-ink-faint underline decoration-dotted decoration-ink-faint/40 underline-offset-[3px]'
                              : 'cursor-help text-ink-soft'
                          }
                          title={place.why}
                        >
                          {place.text}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="whitespace-nowrap py-3 pl-3 pr-5 text-[12.5px] text-ink-soft">
                    {describeDevice(r.user_agent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <TablePager table={table} noun="attempt" />
      </Card>
    </div>
  );
}
