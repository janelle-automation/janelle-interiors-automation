import { useState } from 'react';
import { PageHeading, Card, Pill } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { useMe, useConnectGoogle, useDisconnectGoogle, type GoogleService } from '../lib/queries';
import { ROLE_LABELS, type UserRole } from '@janelle/shared';

const TEAM: { name: string; role: UserRole }[] = [
  { name: 'Janelle', role: 'principal' },
  { name: 'Priya', role: 'designer' },
  { name: 'Devon', role: 'procurement' },
  { name: 'Sam', role: 'coordinator' },
  { name: 'Alex', role: 'assistant' },
];

const SERVICE_LABEL: Record<GoogleService | 'all', string> = { gmail: 'Gmail', drive: 'Google Drive', all: 'Google' };

function googleFlash(): { text: string; tone: 'good' | 'crit' } | null {
  const q = new URLSearchParams(window.location.search);
  const p = q.get('google');
  const svc = q.get('service');
  const name = SERVICE_LABEL[(svc === 'gmail' || svc === 'drive' ? svc : 'all') as GoogleService | 'all'];
  if (p === 'connected') return { text: `${name} connected.`, tone: 'good' };
  if (p === 'error') return { text: `${name} connection failed — try again.`, tone: 'crit' };
  return null;
}

function GmailMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#EA4335" d="M4 6.5v11A1.5 1.5 0 0 0 5.5 19H7v-8.2l5 3.7 5-3.7V19h1.5a1.5 1.5 0 0 0 1.5-1.5v-11L12 12 4 6.5Z" />
      <path fill="#4285F4" d="M18.5 5H17v5.8l3-2.2V6.5A1.5 1.5 0 0 0 18.5 5Z" />
      <path fill="#34A853" d="M7 10.8V5H5.5A1.5 1.5 0 0 0 4 6.5v2.1l3 2.2Z" />
      <path fill="#FBBC04" d="M7 5v5.8l5 3.7 5-3.7V5l-5 3.7L7 5Z" />
    </svg>
  );
}

function DriveMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0F9D58" d="M8.2 3h7.6l6 10.4h-7.6L8.2 3Z" />
      <path fill="#F4B400" d="M8.2 3 2.2 13.4l3.8 6.6 6-10.4L8.2 3Z" />
      <path fill="#4285F4" d="M6 20h12l3.8-6.6H9.8L6 20Z" />
    </svg>
  );
}

function ServiceCard({
  service,
  title,
  blurb,
  scopes,
  connected,
  Mark,
}: {
  service: GoogleService;
  title: string;
  blurb: string;
  scopes: { name: string; note?: string }[];
  connected: boolean;
  Mark: () => JSX.Element;
}) {
  const connect = useConnectGoogle();
  const pending = connect.isPending && connect.variables === service;
  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-sunk/60">
          <Mark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
            <Pill tone={connected ? 'good' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Pill>
          </div>
          <p className="mt-0.5 text-[13px] text-ink-soft">{blurb}</p>
        </div>
      </div>

      <ul className="mt-3 space-y-1 text-[12px] text-ink-soft">
        {scopes.map((s) => (
          <li key={s.name} className="flex items-baseline gap-2">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-good' : 'bg-ink-faint'}`} aria-hidden="true" />
            <span className="font-medium text-ink">{s.name}</span>
            {s.note && <span className="text-ink-faint">{s.note}</span>}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => connect.mutate(service)}
          disabled={connect.isPending}
          className={connected ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
        >
          {pending ? 'Redirecting…' : connected ? `Reconnect ${title}` : `Connect ${title}`}
        </button>
      </div>
      {connect.isError && <p className="mt-2 text-[12.5px] text-crit">{(connect.error as Error).message}</p>}
    </div>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const me = useMe();
  const connectAll = useConnectGoogle();
  const disconnect = useDisconnectGoogle();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const flash = googleFlash();

  const google = me.data?.google;
  const gmail = google?.services?.gmail ?? false;
  const drive = google?.services?.drive ?? false;
  const anyConnected = gmail || drive;
  const overall = gmail && drive ? 'Fully connected' : anyConnected ? 'Partially connected' : 'Not connected';

  return (
    <>
      <PageHeading title="Settings" sub="Integrations, appearance, team and studio rules." />

      {flash && (
        <div
          className={`mb-5 rounded-lg border px-4 py-2.5 text-[13.5px] ${
            flash.tone === 'good' ? 'border-good/30 bg-good/10 text-good' : 'border-crit/30 bg-crit/10 text-crit'
          }`}
        >
          {flash.text}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-6 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">Google Workspace</h2>
              <p className="mt-1 text-[13.5px] text-ink-soft">
                Connect Gmail and Drive separately, or both at once. Read-only, plus draft creation in Gmail. Revocable any time.
              </p>
            </div>
            <Pill tone={gmail && drive ? 'good' : anyConnected ? 'warn' : 'neutral'}>{overall}</Pill>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <ServiceCard
              service="gmail"
              title="Gmail"
              blurb="Reads project mail, classifies it, and writes reply drafts."
              connected={gmail}
              Mark={GmailMark}
              scopes={[
                { name: 'gmail.readonly', note: 'read messages and attachments' },
                { name: 'gmail.compose', note: 'create drafts only — never sends' },
              ]}
            />
            <ServiceCard
              service="drive"
              title="Google Drive"
              blurb="Finds PDF quotes and order confirmations and parses them."
              connected={drive}
              Mark={DriveMark}
              scopes={[{ name: 'drive.readonly', note: 'list and download files' }]}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
            <div className="text-[12.5px] text-ink-faint">
              {google?.connected_at
                ? `Last connected ${new Date(google.connected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                : 'Nothing connected yet.'}
            </div>
            <div className="flex items-center gap-2">
              {!(gmail && drive) && (
                <button
                  onClick={() => connectAll.mutate('all')}
                  disabled={connectAll.isPending}
                  className="btn-secondary btn-sm"
                >
                  {connectAll.isPending && connectAll.variables === 'all' ? 'Redirecting…' : 'Connect both at once'}
                </button>
              )}
              {anyConnected && !confirmDisconnect && (
                <button onClick={() => setConfirmDisconnect(true)} className="btn-ghost btn-sm text-crit hover:text-crit">
                  Disconnect Google
                </button>
              )}
              {anyConnected && confirmDisconnect && (
                <div className="flex items-center gap-2 rounded-lg border border-crit/30 bg-crit/10 px-3 py-1.5">
                  <span className="text-[12.5px] text-crit">Revoke Gmail and Drive access?</span>
                  <button
                    onClick={() => disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })}
                    disabled={disconnect.isPending}
                    className="btn btn-sm bg-crit text-white hover:opacity-90"
                  >
                    {disconnect.isPending ? 'Revoking…' : 'Yes, disconnect'}
                  </button>
                  <button onClick={() => setConfirmDisconnect(false)} className="btn-ghost btn-sm">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
          {disconnect.isError && <p className="mt-2 text-[12.5px] text-crit">{(disconnect.error as Error).message}</p>}
        </Card>

        <Card className="p-6">
          <h2 className="text-[16px] font-semibold text-ink">Appearance</h2>
          <p className="mt-1 text-[13.5px] text-ink-soft">Choose a theme, or follow your system.</p>
          <div className="mt-4 flex rounded-lg bg-sunk p-1">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`focusable flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors ${
                  theme === t ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-[16px] font-semibold text-ink">Studio rules</h2>
          <p className="mt-1 text-[13.5px] text-ink-soft">Thresholds the follow-up engine uses.</p>
          <dl className="mt-4 divide-y divide-line-soft text-[14px]">
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-soft">Vendor silence before a nudge</dt>
              <dd className="tabular-nums text-ink">3 days</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-soft">Client approval overdue</dt>
              <dd className="tabular-nums text-ink">5 days</dd>
            </div>
            <div className="flex items-center justify-between py-2.5">
              <dt className="text-ink-soft">Weekly report</dt>
              <dd className="text-ink">Monday</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-ink-faint">Editable controls arrive with the settings API.</p>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <h2 className="text-[16px] font-semibold text-ink">Team & roles</h2>
          <p className="mt-1 text-[13.5px] text-ink-soft">Access is per role and per project assignment.</p>
          <ul className="mt-4 divide-y divide-line-soft">
            {TEAM.map((m) => (
              <li key={m.name} className="flex items-center justify-between py-2.5">
                <div className="flex items-center gap-3">
                  <span className="grid h-7 w-7 place-items-center rounded-md bg-olive/20 text-[13px] font-semibold text-olive">
                    {m.name.slice(0, 1)}
                  </span>
                  <span className="text-[14px] text-ink">{m.name}</span>
                </div>
                <span className="text-[11px] uppercase tracking-wide text-ink-faint">{ROLE_LABELS[m.role]}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
