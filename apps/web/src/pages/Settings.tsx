import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ASSISTANT_NAME } from '@janelle/shared';
import { Page, PageHeading, Card, Pill, PasswordInput, Switch } from '../components/ui';
import {
  IconActivity,
  IconAssistant,
  IconBell,
  IconBoard,
  IconInbox,
  IconKey,
  IconMailScan,
  IconPerson,
  IconPrompt,
  IconSun,
  IconTeam,
} from '../components/icons';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { MIN_PASSWORD } from './ResetPassword';
import {
  useMe,
  useConnectGoogle,
  useDisconnectGoogle,
  useAiConfig,
  useMediaConfig,
  useSetMediaKey,
  useClearMediaKey,
  useSetMediaModel,
  useGeminiConfig,
  useSetGeminiKey,
  useClearGeminiKey,
  useSetGeminiModel,
  useSetPictureEngine,
  useCloudflareConfig,
  useSetCloudflareKey,
  useClearCloudflareKey,
  useSetCloudflareModel,
  useClearAiKey,
  useDisconnectGoogleService,
  useSetAiKey,
  useSetAiModel,
  useIngestSettings,
  useSetIngestSettings,
  useRevokeUsageLink,
  useRotateUsageLink,
  useUsageLink,
  useSla,
  useSaveSla,
  type GoogleService,
  type Sla,
} from '../lib/queries';

const SERVICE_LABEL: Record<GoogleService | 'all', string> = { gmail: 'Gmail', drive: 'Google Drive', all: 'Google' };

/**
 * How long the studio waits before it says something.
 *
 * Written the way the studio talks about the wait rather than as field
 * names: someone tuning this is answering "we chase too early", not editing
 * `vendor_silence_days`.
 */
const SLA_DIALS: { key: keyof Sla; label: string; unit: string; hint: string; min: number; max: number }[] = [
  { key: 'vendor_silence_days', label: 'Chase a silent vendor after', unit: 'days', min: 1, max: 30,
    hint: 'An order placed but not confirmed this long.' },
  { key: 'quote_response_days', label: 'A quote is late after', unit: 'days', min: 1, max: 30,
    hint: 'Past this, the client gets an update whether or not the vendor replied.' },
  { key: 'client_approval_days', label: 'Chase a client for approval after', unit: 'days', min: 1, max: 60,
    hint: 'A project parked in the approval stage this long.' },
  { key: 'client_waiting_hours', label: 'A client left waiting is flagged after', unit: 'hours', min: 1, max: 336,
    hint: 'Nudges whoever owns the reply, not the client.' },
  { key: 'task_reminder_days', label: 'Remind an owner their task is late after', unit: 'days', min: 0, max: 30,
    hint: 'Zero nudges on the due date itself.' },
  { key: 'reminder_repeat_days', label: 'Repeat that reminder every', unit: 'days', min: 1, max: 30,
    hint: 'A cadence rather than a nightly repeat of the same nudge.' },
  { key: 'escalation_days', label: 'Escalate to the principal after', unit: 'days', min: 1, max: 30,
    hint: 'A reminded task still open this long goes up.' },
];

function ChasingCard() {
  const { data: sla, isLoading } = useSla();
  const save = useSaveSla();
  // Only what has actually been changed is sent, so two people tuning
  // different dials do not overwrite each other's.
  const [draft, setDraft] = useState<Partial<Sla>>({});

  const value = (key: keyof Sla): number | '' => {
    const pending = draft[key];
    if (pending !== undefined) return pending;
    return sla ? sla[key] : '';
  };
  const dirty = Object.keys(draft).length > 0;

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconBell width={18} height={18} />}
      title="When the studio chases"
      description="When a nudge is drafted for review. Nothing is ever sent automatically."
      status={
        dirty && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => save.mutate(draft, { onSuccess: () => setDraft({}) })}
              disabled={save.isPending}
              className="btn-primary btn-sm"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button onClick={() => setDraft({})} disabled={save.isPending} className="btn-ghost btn-sm">
              Cancel
            </button>
          </div>
        )
      }
    >
      {isLoading ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {SLA_DIALS.map((d) => (
            <label
              key={d.key}
              title={d.hint}
              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                draft[d.key] !== undefined ? 'border-brass/50 bg-brass/5' : 'border-line bg-sunk/30'
              }`}
            >
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium leading-snug text-ink">{d.label}</span>
                <span className="block truncate text-[11px] text-ink-faint">{d.hint}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  min={d.min}
                  max={d.max}
                  step={1}
                  value={value(d.key)}
                  onChange={(e) => {
                    const next = e.target.value;
                    setDraft((f) => ({ ...f, [d.key]: next === '' ? d.min : Number(next) }));
                  }}
                  className="input h-8 w-16 px-2 text-center tabular-nums"
                />
                <span className="w-8 text-[11.5px] text-ink-soft">{d.unit}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

/**
 * Change the password, from inside the app.
 *
 * The current one is asked for and checked, which Supabase does not require
 * — `updateUser` will change the password of whoever holds the session. So
 * a laptop left open, or a stolen token, would be enough to take the
 * account away from its owner. Re-authenticating first makes the person at
 * the keyboard prove they are the person whose account it is.
 */
function PasswordCard() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'crit' } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase || !user?.email) return;
    if (next.length < MIN_PASSWORD) return setMsg({ text: `Use at least ${MIN_PASSWORD} characters.`, tone: 'crit' });
    if (next !== confirm) return setMsg({ text: 'The two new passwords do not match.', tone: 'crit' });
    if (next === current) return setMsg({ text: 'That is already your password.', tone: 'crit' });

    setBusy(true);
    setMsg(null);
    try {
      // Proves who is at the keyboard. On success this also refreshes the
      // session, which is harmless — it is the same account either way.
      const { error: wrong } = await supabase.auth.signInWithPassword({ email: user.email, password: current });
      if (wrong) throw new Error('That is not your current password.');

      const { error: failed } = await supabase.auth.updateUser({ password: next });
      if (failed) throw failed;

      // Everywhere else is signed out — a password change should end any
      // session the person did not know about.
      try {
        await supabase.auth.signOut({ scope: 'others' });
      } catch {
        /* the new password still stands */
      }

      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ text: 'Password changed. Any other device has been signed out.', tone: 'good' });
    } catch (err) {
      setMsg({ text: (err as Error).message, tone: 'crit' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      icon={<IconKey width={18} height={18} />}
      title="Password"
      description={user?.email ? `Signed in as ${user.email}.` : 'Change the password you sign in with.'}
    >
      <form onSubmit={submit} className="space-y-2.5">
        <PasswordInput
          required
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="New password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="Repeat it"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>

        {msg && (
          <p className={`rounded-lg px-3 py-2 text-[12.5px] ${msg.tone === 'crit' ? 'bg-crit/10 text-crit' : 'bg-good/10 text-good'}`}>
            {msg.text}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary btn-sm">
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </SettingsCard>
  );
}

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
  everConnected,
  Mark,
}: {
  service: GoogleService;
  title: string;
  blurb: string;
  scopes: { name: string; note?: string }[];
  connected: boolean;
  /** True when Google is linked at all — so an unused service reads as "Reconnect". */
  everConnected: boolean;
  Mark: () => JSX.Element;
}) {
  const connect = useConnectGoogle();
  const disconnect = useDisconnectGoogleService();
  const pending = connect.isPending && connect.variables === service;
  return (
    <div className="flex flex-col rounded-lg border border-line bg-sunk/30 p-3.5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface">
          <Mark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            <Pill tone={connected ? 'good' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Pill>
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">{blurb}</p>
        </div>
      </div>

      <ul className="mt-2.5 space-y-0.5 text-[11.5px] text-ink-soft">
        {scopes.map((s) => (
          <li key={s.name} className="flex items-baseline gap-2">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${connected ? 'bg-good' : 'bg-ink-faint'}`} aria-hidden="true" />
            <span className="font-medium text-ink">{s.name}</span>
            {s.note && <span className="text-ink-faint">{s.note}</span>}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        {connected ? (
          <button
            onClick={() => disconnect.mutate(service)}
            disabled={disconnect.isPending}
            className="btn-secondary btn-sm"
            title={`Stop reading ${title}. The other service keeps working.`}
          >
            {disconnect.isPending ? 'Disconnecting…' : `Disconnect ${title}`}
          </button>
        ) : (
          <button
            onClick={() => connect.mutate(service)}
            disabled={connect.isPending}
            className="btn-primary btn-sm"
          >
            {pending ? 'Redirecting…' : everConnected ? `Reconnect ${title}` : `Connect ${title}`}
          </button>
        )}
      </div>
      {connect.isError && <p className="mt-2 text-[12.5px] text-crit">{(connect.error as Error).message}</p>}
      {disconnect.isError && (
        <p className="mt-2 text-[12.5px] text-crit">{(disconnect.error as Error).message}</p>
      )}
    </div>
  );
}
/**
 * The one card shape every setting uses: an icon, a title, one line of
 * explanation and, where there is one, a status — then the controls.
 *
 * The page used to be ten cards each opening with a heading and a paragraph,
 * which made it long to scroll and hard to scan. The explanation still
 * matters, so it stays, but as a single line under the title.
 */
function SettingsCard({
  icon,
  title,
  description,
  status,
  className = '',
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-sunk/60 text-brass">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold leading-tight text-ink">{title}</h2>
            {status}
          </div>
          {description && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-soft">{description}</p>}
        </div>
      </div>
      {children && <div className="mt-4">{children}</div>}
    </Card>
  );
}

/** A small label above a control, so every field on the page reads alike. */
function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">
      {children}
    </label>
  );
}

/** The quiet line under a control. */
function Hint({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">{children}</p>;
}

function Connected({ on }: { on: boolean }) {
  return <Pill tone={on ? 'good' : 'crit'}>{on ? 'Connected' : 'No key'}</Pill>;
}

/**
 * An API key: paste, save, remove.
 *
 * Three providers used to carry three copies of this. The key is never
 * shown again after saving — only where it came from and its last four.
 */
function KeyField({
  id,
  placeholder,
  view,
  onSave,
  onClear,
  saving,
  clearing,
}: {
  id: string;
  placeholder: string;
  view: { configured: boolean; source: 'studio' | 'environment' | 'none'; keyHint: string | null };
  onSave: (key: string, done: () => void) => void;
  onClear: () => void;
  saving: boolean;
  clearing: boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <FieldLabel htmlFor={id}>API key</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <PasswordInput
          id={id}
          label="key"
          wrapperClassName="min-w-0 flex-1"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={view.configured ? `•••• ${view.keyHint ?? ''} — paste a new key to replace it` : placeholder}
          className="w-full"
        />
        <button
          className="btn-primary btn-sm"
          disabled={saving || clearing || draft.trim().length === 0}
          onClick={() => onSave(draft.trim(), () => setDraft(''))}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {view.source === 'studio' && (
          <button className="btn-ghost btn-sm" disabled={saving || clearing} onClick={onClear}>
            {clearing ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
      <Hint>
        {view.source === 'environment'
          ? 'Using the server’s key. A key saved here replaces it.'
          : 'Stored encrypted and never shown again.'}
      </Hint>
    </div>
  );
}

/** A labelled select, with the chosen option's note beneath it. */
function ModelSelect({
  id,
  label,
  value,
  options,
  note,
  pending,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  note?: string;
  pending: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select id={id} className="input w-full" value={value} disabled={pending} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {(pending || note) && <Hint>{pending ? 'Saving…' : note}</Hint>}
    </div>
  );
}

function ErrorLine({ error }: { error?: Error | null }) {
  return error ? <p className="mt-3 text-[12.5px] text-crit">{error.message}</p> : null;
}

/**
 * The studio's Claude credentials. Kept here rather than in a deploy so the
 * key can be rotated by the person who owns the Anthropic account, not by
 * whoever has access to the server.
 */
function AiSetupCard() {
  const config = useAiConfig();
  const setKey = useSetAiKey();
  const clearKey = useClearAiKey();
  const setModel = useSetAiModel();

  // A 403 means "not a principal" — say nothing rather than showing an
  // error for a card this person was never meant to use.
  if (config.isError) return null;
  const data = config.data;
  const model = data?.models.find((m) => m.id === data.model);

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconAssistant width={18} height={18} />}
      title={`${ASSISTANT_NAME}’s brain — Claude`}
      description={
        <>
          Reads email, raises tasks, drafts follow-ups and answers questions. Keys from{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            console.anthropic.com
          </a>
          .
        </>
      }
      status={data && <Connected on={data.configured} />}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <KeyField
            id="ai-key"
            placeholder="sk-ant-…"
            view={data}
            saving={setKey.isPending}
            clearing={clearKey.isPending}
            onSave={(key, done) => setKey.mutate(key, { onSuccess: done })}
            onClear={() => clearKey.mutate(undefined)}
          />
          <ModelSelect
            id="ai-model"
            label="Model"
            value={data.model}
            options={data.models}
            note={model?.note ?? 'Used by every AI feature.'}
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate(m)}
          />
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error) as Error | null} />
    </SettingsCard>
  );
}

/**
 * Renderings and boards: who draws them, and the Gemini account.
 *
 * The key and model were only settable in the server environment, so a
 * studio stuck on a model that cannot photograph had no way out without a
 * deploy. When Gemini fails or has no key, Claude draws a sketch instead.
 */
function GeminiSetupCard() {
  const config = useGeminiConfig();
  const setKey = useSetGeminiKey();
  const clearKey = useClearGeminiKey();
  const setModel = useSetGeminiModel();
  const setEngine = useSetPictureEngine();

  if (config.isError) return null;
  const data = config.data;

  return (
    <SettingsCard
      icon={<IconPrompt width={18} height={18} />}
      title="Renderings & boards"
      description={
        <>
          Who draws the picture on a board, and the Gemini key. Keys from{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            aistudio.google.com
          </a>
          .
        </>
      }
      status={data && <Pill tone={data.configured ? 'good' : 'warn'}>{data.configured ? 'Gemini connected' : 'No Gemini key'}</Pill>}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <ModelSelect
            id="picture-engine"
            label="Drawn by"
            value={data.engine}
            options={data.engines}
            note={data.engines.find((e) => e.id === data.engine)?.note}
            pending={setEngine.isPending}
            onChange={(e) => setEngine.mutate(e)}
          />
          <KeyField
            id="gemini-key"
            placeholder="AIza…"
            view={data}
            saving={setKey.isPending}
            clearing={clearKey.isPending}
            onSave={(key, done) => setKey.mutate(key, { onSuccess: done })}
            onClear={() => clearKey.mutate(undefined)}
          />
          <ModelSelect
            id="gemini-model"
            label="Gemini model"
            value={data.model}
            options={data.models.map((m) => ({
              id: m.id,
              label: `${m.label} — ${m.usdPerImage ? `${usdEach(m.usdPerImage)} each` : 'free tier'}`,
            }))}
            note={data.models.find((m) => m.id === data.model)?.note}
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate(m)}
          />
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error ?? setEngine.error) as Error | null} />
    </SettingsCard>
  );
}

/**
 * Cloudflare Workers AI — free photoreal renderings.
 *
 * Two values rather than one: the account the models run in (not secret —
 * it is in every dashboard URL) and a token allowed to run them. The free
 * plan's daily allowance is refused, never billed, once it is used up.
 */
function CloudflareSetupCard() {
  const config = useCloudflareConfig();
  const setKey = useSetCloudflareKey();
  const clearKey = useClearCloudflareKey();
  const setModel = useSetCloudflareModel();
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');

  if (config.isError) return null;
  const data = config.data;
  const model = data?.models.find((m) => m.id === data.model);
  const maxSteps = model?.maxSteps ?? 8;
  const stepChoices = maxSteps <= 8 ? [4, 8] : [10, 20];

  return (
    <SettingsCard
      icon={<IconBoard width={18} height={18} />}
      title="Free photos — Cloudflare"
      description={
        <>
          Photoreal renderings on Cloudflare’s free daily allowance — no card, never billed. Account ID and token from{' '}
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            dash.cloudflare.com
          </a>
          .
        </>
      }
      status={data && <Connected on={data.configured} />}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div>
            <FieldLabel htmlFor="cf-account">Account ID &amp; API token</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                id="cf-account"
                className="input w-full font-mono text-[12.5px]"
                autoComplete="off"
                spellCheck={false}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder={data.accountId ? `${data.accountId.slice(0, 6)}… (in use)` : '32-character Account ID'}
              />
              <PasswordInput
                label="token"
                wrapperClassName="min-w-0"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={data.configured ? `•••• ${data.keyHint ?? ''} — paste to replace` : 'API token'}
                className="w-full"
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                className="btn-primary btn-sm"
                disabled={setKey.isPending || !account.trim() || !token.trim()}
                onClick={() =>
                  setKey.mutate(
                    { accountId: account.trim(), apiToken: token.trim() },
                    { onSuccess: () => { setAccount(''); setToken(''); } },
                  )
                }
              >
                {setKey.isPending ? 'Saving…' : 'Save'}
              </button>
              {data.source === 'studio' && (
                <button className="btn-ghost btn-sm" disabled={clearKey.isPending} onClick={() => clearKey.mutate(undefined)}>
                  {clearKey.isPending ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            <Hint>
              {data.source === 'environment'
                ? 'Using CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from the server. Values saved here replace them.'
                : 'The token is stored encrypted and never shown again.'}
            </Hint>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <ModelSelect
              id="cf-model"
              label="Model"
              value={data.model}
              options={data.models}
              note={model?.note}
              pending={setModel.isPending}
              onChange={(m) => setModel.mutate({ model: m })}
            />
            <ModelSelect
              id="cf-steps"
              label="Quality"
              value={String(data.steps)}
              options={stepChoices.map((n, i) => ({ id: String(n), label: i === 0 ? `Fast — ${n} steps` : `Best — ${n} steps` }))}
              note="More steps: finer detail, fewer free images a day."
              pending={setModel.isPending}
              onChange={(n) => setModel.mutate({ model: data.model, steps: Number(n) })}
            />
          </div>
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error) as Error | null} />
    </SettingsCard>
  );
}

/**
 * Pictures and video through Grok (xAI). Without a key the video button
 * does not appear and Jenny says so plainly when asked for a clip.
 */
function MediaSetupCard() {
  const config = useMediaConfig();
  const setKey = useSetMediaKey();
  const clearKey = useClearMediaKey();
  const setModel = useSetMediaModel();

  if (config.isError) return null;
  const data = config.data;

  return (
    <SettingsCard
      icon={<IconBoard width={18} height={18} />}
      title="Photos & video — Grok"
      description={
        <>
          Photoreal renderings and short clips. Keys from{' '}
          <a href="https://console.x.ai" target="_blank" rel="noreferrer" className="font-medium text-brass hover:underline">
            console.x.ai
          </a>
          .
        </>
      }
      status={data && <Connected on={data.configured} />}
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="space-y-4">
          <KeyField
            id="media-key"
            placeholder="xai-…"
            view={data}
            saving={setKey.isPending}
            clearing={clearKey.isPending}
            onSave={(key, done) => setKey.mutate(key, { onSuccess: done })}
            onClear={() => clearKey.mutate(undefined)}
          />
          <ModelSelect
            id="media-image-model"
            label="Image model"
            value={data.imageModel}
            options={data.imageModels.map((m) => ({ id: m.id, label: `${m.label} — ${usdEach(m.usdPerImage)} each` }))}
            note={data.imageModels.find((m) => m.id === data.imageModel)?.note}
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate({ kind: 'image', model: m })}
          />
          <ModelSelect
            id="media-video-model"
            label="Video model"
            value={data.videoModel}
            options={data.videoModels.map((m) => ({ id: m.id, label: `${m.label} — ${usdEach(m.usdPerSecond)} a second` }))}
            note="Clips are capped per day and per length on the server."
            pending={setModel.isPending}
            onChange={(m) => setModel.mutate({ kind: 'video', model: m })}
          />
        </div>
      )}
      <ErrorLine error={(setKey.error ?? clearKey.error ?? setModel.error) as Error | null} />
    </SettingsCard>
  );
}

/** Cents when small, dollars when not — a price people read at a glance. */
function usdEach(n: number): string {
  return n < 1 ? `${Math.round(n * 100)}c` : `$${n.toFixed(2)}`;
}

/**
 * How often the studio looks for new mail, and whether Claude reads it —
 * the two dials that actually move the bill, in front of the person paying.
 */
function EmailReadingCard() {
  const settings = useIngestSettings();
  const save = useSetIngestSettings();

  if (settings.isError) return null;
  const data = settings.data;

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<IconMailScan width={18} height={18} />}
      title="Reading email"
      description="How often Gmail and Drive are checked, and whether Claude reads what arrives."
    >
      {!data ? (
        <p className="text-[13px] text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <FieldLabel htmlFor="ingest-every">Check for new email</FieldLabel>
            <select
              id="ingest-every"
              className="input w-full"
              value={data.intervalMinutes}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ intervalMinutes: Number(e.target.value) })}
            >
              {data.intervals.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
            <Hint>
              {data.intervalMinutes === 0
                ? 'Nothing is read on a schedule — use “Read Gmail & Drive” on the dashboard.'
                : 'Checking more often costs more: each new email is read by Claude.'}
            </Hint>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-line bg-sunk/40 p-3">
            <Switch
              checked={data.useAi}
              disabled={save.isPending}
              label="Let Claude read incoming email"
              onChange={(next) => save.mutate({ useAi: next })}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">Let {ASSISTANT_NAME} read what arrives</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-soft">
                {data.useAi
                  ? 'Classified, linked to a project, turned into tasks and drafts. Most of the cost is here.'
                  : 'Fetched and filed only — no tasks, no drafts, nothing spent.'}
              </p>
            </div>
          </div>
        </div>
      )}
      <ErrorLine error={save.error as Error | null} />
    </SettingsCard>
  );
}

/**
 * The AI usage page has no menu entry and no sign-in: the link is the
 * credential. That is what makes it shareable with someone who has no
 * account — an accountant, a partner — so minting and revoking it is a
 * deliberate act, kept with the other things only a principal may change.
 */
function AiUsageLinkCard() {
  const link = useUsageLink();
  const rotate = useRotateUsageLink();
  const revoke = useRevokeUsageLink();
  const [copied, setCopied] = useState(false);

  if (link.isError) return null;
  const url = link.data?.path ? `${window.location.origin}${link.data.path}` : null;

  return (
    <SettingsCard
      icon={<IconActivity width={18} height={18} />}
      title="AI usage link"
      description="A read-only spend page anyone with the link can open without signing in. Share it deliberately."
      status={<Pill tone={url ? 'good' : 'neutral'}>{url ? 'Live' : 'Off'}</Pill>}
    >
      {url ? (
        <>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-sunk px-3 py-2 text-[12px] text-ink-soft">{url}</code>
            <button
              className="btn-secondary btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(url).then(
                  () => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  },
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a href={url} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">Open</a>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <button className="btn-ghost btn-sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {rotate.isPending ? 'Replacing…' : 'Replace link'}
            </button>
            <button className="btn-ghost btn-sm text-crit hover:text-crit" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              {revoke.isPending ? 'Turning off…' : 'Turn off'}
            </button>
            <span className="text-[11.5px] text-ink-faint">The old link stops working immediately.</span>
          </div>
        </>
      ) : (
        <button className="btn-primary btn-sm" disabled={rotate.isPending || link.isLoading} onClick={() => rotate.mutate()}>
          {rotate.isPending ? 'Creating…' : 'Create a link'}
        </button>
      )}
      <ErrorLine error={(rotate.error ?? revoke.error) as Error | null} />
    </SettingsCard>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1Z" />
    </svg>
  );
}

function GoogleCard() {
  const me = useMe();
  const connectAll = useConnectGoogle();
  const disconnect = useDisconnectGoogle();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const google = me.data?.google;
  const gmail = google?.services?.gmail ?? false;
  const drive = google?.services?.drive ?? false;
  const anyConnected = gmail || drive;

  return (
    <SettingsCard
      className="lg:col-span-2"
      icon={<GoogleMark />}
      title="Google Workspace"
      description="Gmail and Drive, together or separately. Read-only, plus drafts in Gmail. Revocable any time."
      status={
        <Pill tone={gmail && drive ? 'good' : anyConnected ? 'warn' : 'neutral'}>
          {gmail && drive ? 'Fully connected' : anyConnected ? 'Partially connected' : 'Not connected'}
        </Pill>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <ServiceCard
          service="gmail"
          title="Gmail"
          blurb="Reads project mail, classifies it, writes reply drafts."
          connected={gmail}
          everConnected={anyConnected}
          Mark={GmailMark}
          scopes={[
            { name: 'gmail.readonly', note: 'read messages' },
            { name: 'gmail.compose', note: 'drafts only — never sends' },
          ]}
        />
        <ServiceCard
          service="drive"
          title="Google Drive"
          blurb="Finds PDF quotes and order confirmations."
          connected={drive}
          everConnected={anyConnected}
          Mark={DriveMark}
          scopes={[{ name: 'drive.readonly', note: 'list and download files' }]}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        <span className="text-[12px] text-ink-faint">
          {google?.connected_at
            ? `Last connected ${new Date(google.connected_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
            : 'Nothing connected yet.'}
        </span>
        <div className="flex items-center gap-1.5">
          {!(gmail && drive) && (
            <button onClick={() => connectAll.mutate('all')} disabled={connectAll.isPending} className="btn-secondary btn-sm">
              {connectAll.isPending && connectAll.variables === 'all' ? 'Redirecting…' : 'Connect both'}
            </button>
          )}
          {anyConnected && !confirmDisconnect && (
            <button onClick={() => setConfirmDisconnect(true)} className="btn-ghost btn-sm text-crit hover:text-crit">
              Disconnect Google
            </button>
          )}
          {anyConnected && confirmDisconnect && (
            <div className="flex items-center gap-2 rounded-lg border border-crit/30 bg-crit/10 px-2.5 py-1">
              <span className="text-[12px] text-crit">Revoke Gmail and Drive?</span>
              <button
                onClick={() => disconnect.mutate(undefined, { onSettled: () => setConfirmDisconnect(false) })}
                disabled={disconnect.isPending}
                className="btn btn-sm bg-crit text-white hover:opacity-90"
              >
                {disconnect.isPending ? 'Revoking…' : 'Disconnect'}
              </button>
              <button onClick={() => setConfirmDisconnect(false)} className="btn-ghost btn-sm">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
      <ErrorLine error={disconnect.error as Error | null} />
    </SettingsCard>
  );
}

function AppearanceCard() {
  const { theme, setTheme } = useTheme();
  return (
    <SettingsCard icon={<IconSun width={18} height={18} />} title="Appearance" description="A theme, or follow your system.">
      <div className="flex rounded-lg bg-sunk p-1">
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
    </SettingsCard>
  );
}

function TeamCard() {
  return (
    <SettingsCard
      icon={<IconTeam width={18} height={18} />}
      title="Team & roles"
      description="People, their roles and what each may do — enforced in the API and again in the database."
    >
      <Link to="/team" className="btn-secondary btn-sm inline-flex">Open Team &amp; Roles →</Link>
    </SettingsCard>
  );
}

type SettingsTab = 'connections' | 'ai' | 'studio' | 'account';

const TABS: { id: SettingsTab; label: string; Icon: (p: { width?: number; height?: number }) => JSX.Element; principal: boolean }[] = [
  { id: 'connections', label: 'Connections', Icon: IconInbox, principal: false },
  { id: 'ai', label: 'AI & media', Icon: IconAssistant, principal: true },
  { id: 'studio', label: 'Studio', Icon: IconBell, principal: true },
  { id: 'account', label: 'Account', Icon: IconPerson, principal: false },
];

export default function Settings() {
  const { may } = useAuth();
  const [params, setParams] = useSearchParams();
  const flash = googleFlash();

  // Principal-only sections are hidden rather than shown empty: their cards
  // answer 403 to anybody else.
  const principal = may('settings', 'update');
  const tabs = TABS.filter((t) => principal || !t.principal);
  const asked = params.get('tab') as SettingsTab | null;
  // Coming back from Google always lands on Connections, where the result is.
  const tab: SettingsTab =
    params.get('google') ? 'connections' : tabs.some((t) => t.id === asked) ? (asked as SettingsTab) : 'connections';

  const choose = (next: SettingsTab) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    p.delete('google');
    p.delete('service');
    setParams(p, { replace: true });
  };

  return (
    <Page>
      <PageHeading title="Settings" />

      {flash && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-[13px] ${
            flash.tone === 'good' ? 'border-good/30 bg-good/10 text-good' : 'border-crit/30 bg-crit/10 text-crit'
          }`}
        >
          {flash.text}
        </div>
      )}

      <div role="tablist" aria-label="Settings sections" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => choose(id)}
            className={`focusable flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
              tab === id ? 'bg-brass/15 text-ink shadow-card' : 'text-ink-soft hover:bg-sunk hover:text-ink'
            }`}
          >
            <Icon width={16} height={16} />
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {tab === 'connections' && (
          <>
            <GoogleCard />
            <EmailReadingCard />
          </>
        )}

        {tab === 'ai' && (
          <>
            <AiSetupCard />
            <GeminiSetupCard />
            <CloudflareSetupCard />
            <MediaSetupCard />
          </>
        )}

        {tab === 'studio' && (
          <>
            <ChasingCard />
            <AiUsageLinkCard />
            <TeamCard />
          </>
        )}

        {tab === 'account' && (
          <>
            <AppearanceCard />
            <PasswordCard />
          </>
        )}
      </div>
    </Page>
  );
}
