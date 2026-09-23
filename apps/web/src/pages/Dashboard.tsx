import { useEffect, useState, type ReactNode, type SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
import { Link, useNavigate } from 'react-router-dom';
import {
  DASHBOARD_CARD_LABELS,
  DASHBOARD_CARD_LINKS,
  ROLE_LABELS,
  type DashboardCardKey,
} from '@janelle/shared';
import { Page, PageHeading, StatTile, Card, Pill, money, shortDate } from '../components/ui';
import { IconArrow, IconBell, IconInbox, IconReport, IconSettings } from '../components/icons';
import {
  useDashboard, useFollowUps, usePurchaseOrders, useOps,
  useLatestDigest, useRunDigest, type IngestProgress,
} from '../lib/queries';
import { PROJECT_STAGES, STAGE_LABELS } from '@janelle/shared';
import { ScopeToggle, useScope } from '../components/ScopeToggle';
import { useAuth } from '../context/AuthContext';

const followTone: Record<string, 'crit' | 'warn' | 'brass'> = {
  vendor_silence: 'warn',
  client_approval_overdue: 'crit',
  date_slipping: 'crit',
  spec_gap: 'brass',
  quote_overdue: 'crit',
  client_waiting: 'crit',
  task_overdue: 'warn',
  task_escalation: 'crit',
  task_unowned: 'warn',
  task_no_next_step: 'brass',
  task_no_due_date: 'brass',
};
const followLabel: Record<string, string> = {
  vendor_silence: 'Vendor silent',
  client_approval_overdue: 'Approval overdue',
  date_slipping: 'Date slipping',
  spec_gap: 'Spec gap',
  quote_overdue: 'Quote overdue',
  client_waiting: 'Client waiting',
  task_overdue: 'Reminder sent',
  task_escalation: 'Escalated',
  task_unowned: 'No owner',
  task_no_next_step: 'No next step',
  task_no_due_date: 'No due date',
};

function OpsBar() {
  const { ingest, followUps, report } = useOps();
  const navigate = useNavigate();
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit'; to?: string; linkText?: string } | null>(null);
  // Reading runs in several passes; this is the running total between them.
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const busy = ingest.isPending || followUps.isPending || report.isPending;

  const ok = (text: string, to?: string, linkText?: string) => setMsg({ text, tone: 'good', to, linkText });
  const err = (e: unknown) => setMsg({ text: (e as Error).message, tone: 'crit' });

  // Closed by anything else being clicked. A transparent sheet behind the
  // menu rather than a document listener, which would fight the trigger's
  // own click and close it again on the way open.
  const [open, setOpen] = useState(false);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const readMail = () => {
    setProgress(null);
    ingest.mutate(setProgress, {
      onSuccess: (d) => {
        setProgress(null);
        if (d.reason === 'busy') {
          return ok('Auto-sync is already running — new mail appears within seconds.');
        }
        // Not a fault in the system: the stored Google grant no longer
        // matches the credentials, so only a reconnect fixes it.
        if (d.reason === 'google_auth_failed') {
          return err(new Error('Google refused the connection — reconnect Gmail and Drive in Settings.'));
        }
        if (d.reason === 'no_source_user') {
          return err(new Error('No Google account is connected yet — connect Gmail and Drive in Settings.'));
        }
        if (d.reason === 'anthropic_not_configured') {
          return err(new Error('Claude is not set up — add an API key in Settings.'));
        }
        const read = `Read ${d.emails} new email${d.emails === 1 ? '' : 's'}, ${d.documents} document${d.documents === 1 ? '' : 's'}, ${d.replies} reply draft${d.replies === 1 ? '' : 's'}.`;
        // Everything read so far is saved either way — the run just stopped
        // early, on its time budget or on a dropped request.
        if (d.interrupted) return ok(`${read} The connection dropped before it finished — run it again to carry on.`);
        return ok(d.done === false ? `${read} More is still waiting — run it again to carry on.` : read);
      },
      onError: (e) => {
        setProgress(null);
        err(e);
      },
    });
  };

  const runFollowUps = () =>
    followUps.mutate(undefined, {
      onSuccess: (d) =>
        d.raised > 0
          ? ok(`Raised ${d.raised} follow-up${d.raised === 1 ? '' : 's'}, ${d.drafted} draft${d.drafted === 1 ? '' : 's'}.`, '/follow-ups', 'Open inbox →')
          : ok('Nothing needs following up right now.'),
      onError: err,
    });

  const writeReport = () =>
    report.mutate(undefined, {
      onSuccess: (d) => navigate(`/reports?generated=${encodeURIComponent(d.weekOf)}`),
      onError: err,
    });

  /** What each one is for, so the menu explains itself without a manual. */
  const actions = [
    { key: 'read', label: 'Read Gmail & Drive', hint: 'New mail, documents and the tasks in them', Icon: IconInbox, go: readMail, pending: ingest.isPending },
    { key: 'follow', label: 'Run follow-ups', hint: 'Check for silence, overdue approvals and slipping dates', Icon: IconBell, go: runFollowUps, pending: followUps.isPending },
    { key: 'report', label: 'Generate report', hint: 'The whole studio, written up for the week', Icon: IconReport, go: writeReport, pending: report.isPending },
  ];

  const status = busy
    ? ingest.isPending
      ? progress
        ? `Reading — ${progress.emails} email${progress.emails === 1 ? '' : 's'}, ${progress.documents} document${progress.documents === 1 ? '' : 's'} so far…`
        : 'Reading Gmail & Drive — this can take a few minutes…'
      : followUps.isPending
        ? 'Checking for follow-ups…'
        : 'Writing the report…'
    : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Run a studio job"
        title={status ?? 'Run a studio job'}
        className={`focusable grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
          open || busy
            ? 'border-brass bg-brass/10 text-brass-deep'
            : 'border-line bg-surface text-ink-soft hover:border-ink-faint hover:text-ink'
        }`}
      >
        <IconSettings width={17} height={17} className={busy ? 'animate-spin-slow' : ''} />
        {/* Something is running behind a closed menu — say so on the trigger,
            or a job that takes minutes looks like a button that did nothing. */}
        {busy && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brass ring-2 ring-surface" aria-hidden="true" />
        )}
      </button>

      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="popover absolute right-0 top-full z-40 mt-1.5 w-[19rem] overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
          >
            <div className="border-b border-line-soft px-3 py-2 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-faint">
              Run now
            </div>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={run(a.go)}
                className="focusable flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
              >
                <a.Icon width={15} height={15} className="mt-0.5 shrink-0 text-ink-faint" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-ink">
                    {a.label}
                    {a.pending && <span className="ml-1.5 text-[11.5px] font-normal text-brass-deep">running…</span>}
                  </span>
                  <span className="block text-[11.5px] leading-snug text-ink-faint">{a.hint}</span>
                </span>
              </button>
            ))}

            {(status || msg) && (
              <div
                className={`border-t border-line-soft px-3 py-2.5 text-[12px] ${
                  status ? 'text-ink-faint' : msg?.tone === 'crit' ? 'text-crit' : 'text-good'
                }`}
              >
                {status ?? (
                  <>
                    {msg?.text}
                    {msg?.to && (
                      <Link
                        to={msg.to}
                        onClick={() => setOpen(false)}
                        className="focusable ml-1.5 font-semibold text-brass-deep hover:underline"
                      >
                        {msg.linkText}
                      </Link>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "It worked" — said where they land, not where they left.
 *
 * The first-run prompt sends Google back to the dashboard, so the usual
 * confirmation on Settings would never be seen. Connecting also starts a
 * read of their last thirty days in the background, which is why the board
 * may still be empty for a few minutes: saying so here is the difference
 * between waiting and assuming it is broken.
 */
function ConnectedNotice() {
  const [shown, setShown] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('google') === 'connected';
    } catch {
      return false;
    }
  });

  // Taken out of the URL once read, so a refresh does not say it again.
  useEffect(() => {
    if (!shown) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('google')) return;
    url.searchParams.delete('google');
    url.searchParams.delete('service');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [shown]);

  if (!shown) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-good/30 bg-good/5 px-4 py-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-good/15 text-good">
        <IconOk />
      </span>
      <p className="flex-1 text-[13px] leading-relaxed text-ink-soft">
        <span className="font-semibold text-ink">Gmail and Drive are connected.</span> Your last thirty days of
        studio mail is being read now — tasks and follow-ups will appear here as it goes. It can take a few minutes.
      </p>
      <button type="button" onClick={() => setShown(false)} className="btn-ghost btn-sm shrink-0">
        Dismiss
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-[15px] font-semibold text-ink">{children}</h2>;
}

// ── Today, at a glance ──────────────────────────────────────

type Sev = 'clear' | 'warn' | 'crit';

/**
 * How a headline figure is dressed.
 *
 * Colour never carries the meaning on its own: each tile also has an icon and
 * a label, so the difference between "fine" and "on fire" survives a
 * colourblind reader, a greyscale print and a forced-colours theme.
 */
const SEV: Record<Sev, { bar: string; chip: string; value: string }> = {
  clear: { bar: 'bg-good/50', chip: 'bg-good/10 text-good', value: 'text-ink' },
  warn: { bar: 'bg-warn', chip: 'bg-warn/12 text-warn', value: 'text-warn' },
  crit: { bar: 'bg-crit', chip: 'bg-crit/12 text-crit', value: 'text-crit' },
};

const dot = {
  width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconAlert = (p: IconProps) => (
  <svg {...dot} {...p}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
);
const IconClock = (p: IconProps) => (
  <svg {...dot} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
const IconWaiting = (p: IconProps) => (
  <svg {...dot} {...p}><path d="M6 2h12M6 22h12" /><path d="M8 2v4.5a4 4 0 0 0 8 0V2" /><path d="M8 22v-4.5a4 4 0 0 1 8 0V22" /></svg>
);
const IconUnowned = (p: IconProps) => (
  <svg {...dot} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M18 8.5v4M18 16h.01" /></svg>
);
const IconOk = (p: IconProps) => <svg {...dot} {...p}><path d="M20 6 9 17l-5-5" /></svg>;

/**
 * One headline figure.
 *
 * A number, not a chart: these answer "how many, right now", and a bar chart
 * of four unrelated counts would be four bars that cannot be compared with
 * each other. They lead the page because they are the only thing on it that
 * can be read in a second, and they used to sit at the FOOT of the briefing
 * card — below four paragraphs of prose and eleven rows of text.
 */
function HeroTile({
  label, value, hint, to, sev, Icon,
}: {
  label: string; value: number; hint: string; to: string; sev: Sev;
  Icon: (p: IconProps) => ReactNode;
}) {
  const s = SEV[sev];
  return (
    <Link
      to={to}
      className="focusable group relative block overflow-hidden rounded-xl border border-line bg-surface p-5 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-pop"
    >
      <span className={`absolute inset-x-0 top-0 h-[3px] ${s.bar}`} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${s.chip}`} aria-hidden="true">
              <Icon />
            </span>
            <span className="truncate text-[12.5px] font-medium text-ink-soft">{label}</span>
          </div>
          <div className={`mt-2.5 text-[34px] font-bold leading-none tracking-[-0.02em] tabular-nums ${s.value}`}>
            {value}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-faint">{hint}</div>
        </div>
        <IconArrow
          className="mt-0.5 shrink-0 text-transparent transition-colors group-hover:text-ink-faint"
          width={16}
          height={16}
        />
      </div>
    </Link>
  );
}

/** "4 days late", "due today", "raised 6 days ago" — the urgency in words. */
function whenDue(r: { due_date: string | null; age_days: number }): { text: string; sev: Sev } {
  if (r.due_date) {
    const today = new Date();
    const [y, m, d] = r.due_date.split('-').map(Number);
    const days = Math.round(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, m - 1, d)) / 86_400_000,
    );
    if (days > 0) return { text: `${days} day${days === 1 ? '' : 's'} late`, sev: days >= 3 ? 'crit' : 'warn' };
    if (days === 0) return { text: 'due today', sev: 'warn' };
    return { text: `due in ${-days} day${days === -1 ? '' : 's'}`, sev: 'clear' };
  }
  return { text: `raised ${r.age_days} day${r.age_days === 1 ? '' : 's'} ago`, sev: r.age_days >= 5 ? 'warn' : 'clear' };
}

/**
 * The morning briefing. Sits at the top of the dashboard because the
 * founder's stated need is to know what is wrong without going looking.
 */
function MorningDigest() {
  const { data: digest, isLoading } = useLatestDigest();
  const run = useRunDigest();

  const [scope] = useScope();
  const { user, googleConnected } = useAuth();

  /**
   * Whose figures these are.
   *
   * The briefing is written for the whole studio, so every count on it was
   * the studio's — "11 overdue" told you the studio was behind, not that
   * you were.
   *
   * Yours means YOURS. This once let unowned rows through on both views, on
   * the reasoning that work nobody has picked up should not be invisible —
   * but that showed somebody invited this morning the studio's entire
   * backlog on their first screen. Unclaimed work belongs under "Everyone",
   * where whoever runs the board will find it.
   */
  const me = (user?.name ?? '').trim().toLowerCase();
  const mine = <T extends { owner?: string }>(rows: T[]): T[] =>
    scope === 'all' ? rows : !me ? [] : rows.filter((r) => (r.owner ?? '').trim().toLowerCase() === me);

  const raw = digest?.figures;
  const f = raw && {
    overdue: mine(raw.overdue),
    quote_breaches: mine(raw.quote_breaches),
    client_waiting: mine(raw.client_waiting),
    // Unassigned is a studio-wide count by definition — nobody's, so nobody
    // sees it as theirs. It returns the moment "Everyone" is selected.
    unassigned: scope === 'all' ? raw.unassigned : [],
  };
  const escalations = mine(digest?.escalations ?? []);
  const stale = digest ? digest.digest_date !== new Date().toISOString().slice(0, 10) : false;

  // The narrative arrives as several paragraphs in one string. Split, it
  // becomes a list of findings that can be skimmed; whole, it was a wall of
  // prose nobody read past the first line of.
  const points = (digest?.narrative ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const SHOWN = 6;

  return (
    <section className="space-y-4">
      {/* The figures first. Everything below them is the explanation. */}
      {f && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <HeroTile
            label="Overdue" value={f.overdue.length} hint="past their due date"
            to="/tasks" sev={f.overdue.length ? 'crit' : 'clear'}
            Icon={f.overdue.length ? IconAlert : IconOk}
          />
          <HeroTile
            label="Quote SLA missed" value={f.quote_breaches.length} hint="past the studio's promise"
            to="/follow-ups" sev={f.quote_breaches.length ? 'crit' : 'clear'}
            Icon={f.quote_breaches.length ? IconClock : IconOk}
          />
          <HeroTile
            label="Client waiting" value={f.client_waiting.length} hint="an approval sits with them"
            to="/follow-ups" sev={f.client_waiting.length ? 'warn' : 'clear'}
            Icon={f.client_waiting.length ? IconWaiting : IconOk}
          />
          <HeroTile
            label="Unassigned" value={f.unassigned.length} hint="nobody owns these yet"
            to="/tasks" sev={f.unassigned.length ? 'warn' : 'clear'}
            Icon={f.unassigned.length ? IconUnowned : IconOk}
          />
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[15px] font-semibold text-ink">This morning</h2>
            <span
              className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.05em] ${
                stale ? 'bg-warn/12 text-warn' : 'bg-sunk text-ink-faint'
              }`}
            >
              {stale ? `${shortDate(digest?.digest_date)} · not today's` : shortDate(digest?.digest_date)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ScopeToggle />
            <button onClick={() => run.mutate()} disabled={run.isPending} className="btn-secondary btn-sm">
              {run.isPending ? 'Building…' : 'Rebuild'}
            </button>
          </div>
        </div>

        {isLoading && <div className="px-5 py-10 text-center text-[13px] text-ink-faint">Loading…</div>}

        {!isLoading && !digest && (
          <div className="px-5 py-10 text-center text-[13px] text-ink-faint">
            No digest yet. It runs every morning at 7:05 — or build one now.
          </div>
        )}

        {!isLoading && digest && (
          <div className="grid gap-px bg-line-soft lg:grid-cols-2">
            <div className="bg-surface px-5 py-4">
              <div className="mb-2.5 text-[10.5px] font-bold uppercase tracking-[0.07em] text-ink-faint">
                What happened
              </div>
              {/* The briefing is written from the shared mailbox and names
                  other people's jobs, clients and money. Somebody who has not
                  connected their own mail has no part in any of it yet, so
                  they are told how to get their own rather than shown it. */}
              {googleConnected === false ? (
                <p className="text-[13.5px] leading-relaxed text-ink-faint">
                  This is written from the studio mailbox each morning. Connect your Gmail and your own
                  projects, tasks and vendor mail will be read into it too.
                </p>
              ) : (
                <>
                  {points.length === 0 && <p className="text-[13.5px] text-ink-faint">No summary available.</p>}
                  <ul className="space-y-2.5">
                    {points.map((p, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden="true" />
                        <span className="text-[13.5px] leading-relaxed text-ink-soft">{p}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="bg-surface px-5 py-4">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[10.5px] font-bold uppercase tracking-[0.07em] text-crit">Needs you</span>
                {escalations.length > 0 && (
                  <span className="text-[11.5px] tabular-nums text-ink-faint">{escalations.length}</span>
                )}
              </div>

              {escalations.length === 0 ? (
                <div className="flex items-center gap-2.5 py-2 text-[13px] text-ink-soft">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-good/10 text-good">
                    <IconOk />
                  </span>
                  Nothing is escalated to you.
                </div>
              ) : (
                <>
                  <ul className="-mx-2 space-y-0.5">
                    {escalations.slice(0, SHOWN).map((r) => {
                      const due = whenDue(r);
                      return (
                        <li key={r.id}>
                          {/* Straight to the task. These were flat text, so the
                              only way to act on one was to go and find it. */}
                          <Link
                            to={`/tasks?task=${r.id}`}
                            className="focusable flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-sunk/60"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink">{r.title}</span>
                              <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">
                                {r.owner}
                                {r.project && r.project !== '—' ? ` · ${r.project}` : ''}
                                {r.status === 'blocked' ? ' · blocked' : ''}
                              </span>
                            </span>
                            <span
                              className={`mt-0.5 shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                                due.sev === 'crit'
                                  ? 'bg-crit/12 text-crit'
                                  : due.sev === 'warn'
                                    ? 'bg-warn/12 text-warn'
                                    : 'bg-sunk text-ink-faint'
                              }`}
                            >
                              {due.text}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                  {escalations.length > SHOWN && (
                    <Link
                      to="/tasks"
                      className="focusable mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brass-deep hover:underline"
                    >
                      {escalations.length - SHOWN} more on the board <IconArrow width={13} height={13} />
                    </Link>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {run.isError && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-crit">
            {(run.error as Error).message}
          </div>
        )}
      </Card>
    </section>
  );
}

/**
 * Which cards are alarming depends on the card, not on the number: three
 * active projects is fine, three overdue tasks is not.
 */
const URGENT: Partial<Record<DashboardCardKey, 'crit' | 'warn'>> = {
  escalations: 'crit',
  myOverdueTasks: 'crit',
  awaitingClient: 'crit',
  unassignedTasks: 'warn',
  tasksWithoutNextStep: 'warn',
  specGaps: 'warn',
};

const CARD_HINTS: Partial<Record<DashboardCardKey, string>> = {
  myOpenTasks: 'assigned to you',
  myOverdueTasks: 'past their due date',
  unassignedTasks: 'nobody owns these yet',
  tasksWithoutNextStep: 'no next action named',
  openFollowUps: 'waiting on someone',
  awaitingClient: 'approvals overdue',
  draftsPending: 'waiting in Gmail for review',
  specGaps: 'blocking an order',
  openPOs: 'awaiting confirm or delivery',
  activeProjects: 'across all stages',
  installsSoon: 'shipping or installing',
  emailsRead: 'classified & linked',
  documentsParsed: 'quotes & confirmations',
  escalations: 'overdue and escalated to you',
};

function RoleCard({ cardKey, value }: { cardKey: DashboardCardKey; value: number }) {
  const tone = value > 0 ? (URGENT[cardKey] ?? 'neutral') : 'neutral';
  return (
    <Link to={DASHBOARD_CARD_LINKS[cardKey]} className="focusable block h-full rounded-xl">
      <StatTile
        label={DASHBOARD_CARD_LABELS[cardKey]}
        value={value}
        tone={tone}
        hint={CARD_HINTS[cardKey]}
      />
    </Link>
  );
}

/**
 * A seat nobody holds silently swallows work: routing falls back to the
 * role, and if that is empty too the task lands unassigned. The studio is
 * still waiting on its own roster, so this stays visible until it is filled.
 */
function VacantSeats({ seats }: { seats: { seat: string; label: string; role: string }[] }) {
  if (seats.length === 0) return null;
  return (
    <Card className="border-warn/40 p-5">
      <div className="text-[13px] font-semibold text-ink">
        {seats.length} seat{seats.length === 1 ? '' : 's'} with nobody in {seats.length === 1 ? 'it' : 'them'}
      </div>
      <p className="mt-1 text-[12.5px] text-ink-soft">
        Work routed here falls back to the role, then lands unassigned.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {seats.map((s) => (
          <Pill key={s.seat} tone="warn">{s.label}</Pill>
        ))}
      </div>
      <Link to="/team" className="mt-3 inline-block text-[12.5px] font-medium text-brass hover:underline">
        Add someone to a seat →
      </Link>
    </Card>
  );
}

function CardHeader({ title, to, linkText }: { title: string; to?: string; linkText?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {to && (
        <Link to={to} className="focusable inline-flex items-center gap-1 text-[13px] font-semibold text-brass-deep hover:underline">
          {linkText} <IconArrow width={14} height={14} />
        </Link>
      )}
    </div>
  );
}

export default function Dashboard() {
  const summary = useDashboard().data!;
  const { data: followUps } = useFollowUps();
  const { data: pos } = usePurchaseOrders();

  const stageCounts = PROJECT_STAGES.map((s) => ({ stage: s, count: summary.byStage[s] ?? 0 }));
  const maxCount = Math.max(1, ...stageCounts.map((s) => s.count));
  const total = stageCounts.reduce((sum, s) => sum + s.count, 0);
  const topFollowUps = followUps.slice(0, 5);
  const recentPos = pos.slice(0, 5);

  const intel = [
    { label: 'Emails read', value: summary.figures.emailsRead, hint: 'classified & linked to projects', to: '/inbox' },
    { label: 'Documents parsed', value: summary.figures.documentsParsed, hint: 'quotes & order confirmations', to: '/documents' },
    { label: 'Reply drafts', value: summary.figures.draftsPending, hint: 'waiting in Gmail for review', to: '/drafts' },
  ];

  return (
    <Page>
      <PageHeading
        title="Dashboard"
        action={<OpsBar />}
      />

      <ConnectedNotice />

      <MorningDigest />

      <section>
        <SectionTitle>
          {summary.role ? `${ROLE_LABELS[summary.role]} · your board` : 'Studio at a glance'}
        </SectionTitle>
        {summary.focus && (
          <p className="-mt-1 mb-4 text-[13px] text-ink-soft">{summary.focus}</p>
        )}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {summary.cards.map((key) => (
            <RoleCard key={key} cardKey={key} value={summary.figures[key] ?? 0} />
          ))}
        </div>
      </section>

      <VacantSeats seats={summary.vacantSeats} />

      <section>
        <SectionTitle>
          Intelligence layer <span className="font-normal text-ink-faint">· from Gmail &amp; Drive</span>
        </SectionTitle>
        <Card>
          <div className="grid divide-y divide-line-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {intel.map((i) => (
              <Link key={i.label} to={i.to} className="focusable group flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-sunk/60">
                <div>
                  <div className="text-[12.5px] font-medium text-ink-soft">{i.label}</div>
                  <div className="mt-1 text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">{i.value}</div>
                  <div className="mt-1.5 text-[12px] text-ink-faint">{i.hint}</div>
                </div>
                <IconArrow className="text-ink-faint transition-colors group-hover:text-brass-deep" width={16} height={16} />
              </Link>
            ))}
          </div>
        </Card>
      </section>

      <section className="grid items-start gap-5 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Needs you today" to="/follow-ups" linkText="Follow-up inbox" />
          <ul className="divide-y divide-line-soft">
            {topFollowUps.length === 0 && (
              <li className="flex flex-col items-center px-5 py-10 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-good/10 text-good">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                </span>
                <div className="mt-3 text-[14px] font-semibold text-ink">All clear</div>
                <div className="mt-1 max-w-xs text-[13px] text-ink-soft">No overdue vendors, approvals or spec gaps right now.</div>
              </li>
            )}
            {topFollowUps.map((f) => (
              <li key={f.id} className="flex items-start gap-4 px-5 py-3.5">
                <Pill tone={followTone[f.type]}>{followLabel[f.type]}</Pill>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink">{f.who}</div>
                  <div className="truncate text-[13px] text-ink-soft">{f.reason}</div>
                </div>
                <div className="whitespace-nowrap text-right">
                  <div className="text-[12.5px] font-medium text-ink-soft">{f.age}</div>
                  <div className="text-[11.5px] text-ink-faint">{f.project}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="border-t border-line-soft bg-sunk/40 px-5 py-2.5 text-[12px] text-ink-faint">
            Each becomes a Gmail draft you review and send.
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Pipeline" to="/projects" linkText="All projects" />
          {/* One measure, one hue: this is magnitude across stages, not nine
              different things, so nine colours would encode nothing and
              invent an identity each stage does not have. The bar is the
              value; the label beside it is the number, so the chart is still
              readable with no colour at all. */}
          <ul className="px-5 py-4">
            {stageCounts.map(({ stage, count }) => {
              const share = total ? Math.round((count / total) * 100) : 0;
              return (
                <li
                  key={stage}
                  className="group flex items-center gap-3 rounded-lg py-[5px] transition-colors hover:bg-sunk/50"
                  title={`${STAGE_LABELS[stage]}: ${count} project${count === 1 ? '' : 's'}${total ? ` · ${share}% of the pipeline` : ''}`}
                >
                  <span className="w-[86px] shrink-0 text-[12.5px] font-medium text-ink-soft">
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-brass transition-[width] duration-500"
                      style={{ width: count ? `${Math.max(4, (count / maxCount) * 100)}%` : '0%' }}
                    />
                  </span>
                  <span
                    className={`w-5 shrink-0 text-right text-[12.5px] font-semibold tabular-nums ${
                      count > 0 ? 'text-ink' : 'text-ink-faint'
                    }`}
                  >
                    {count}
                  </span>
                  {/* The share is the question the bar raises and cannot answer;
                      shown on hover so it does not put a number on every row. */}
                  <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-transparent transition-colors group-hover:text-ink-faint">
                    {count ? `${share}%` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>

      <section>
        <Card>
          <CardHeader title="Recent purchase orders" to="/vendors" linkText="All vendors & POs" />
          <div className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line-soft bg-sunk/40 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                  <th className="px-5 py-2.5 font-semibold">PO</th>
                  <th className="px-5 py-2.5 font-semibold">Vendor</th>
                  <th className="px-5 py-2.5 font-semibold">Project</th>
                  <th className="px-5 py-2.5 font-semibold">Status</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Amount</th>
                  <th className="px-5 py-2.5 text-right font-semibold">ETA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {recentPos.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center text-[13px] text-ink-faint">No purchase orders yet.</td>
                  </tr>
                )}
                {recentPos.map((o) => (
                  <tr key={o.id} className="text-ink-soft transition-colors hover:bg-sunk/40">
                    {/* The view model returns '' for an unset field now, so the
                        dash is applied here rather than baked into the data —
                        the Vendors table hides such columns instead. */}
                    <td className="px-5 py-3 font-semibold text-ink">{o.po || '—'}</td>
                    <td className="px-5 py-3 font-medium text-ink">{o.vendor || '—'}</td>
                    <td className="px-5 py-3">{o.project || '—'}</td>
                    <td className="px-5 py-3">
                      <Pill tone={o.status === 'received' ? 'good' : o.status === 'shipped' ? 'brass' : 'neutral'}>
                        {o.status.replace('_', ' ')}
                      </Pill>
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums text-ink">{money(o.amount)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{shortDate(o.eta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </Page>
  );
}
