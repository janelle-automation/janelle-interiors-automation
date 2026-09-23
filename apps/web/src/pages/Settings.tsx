import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ASSISTANT_NAME } from '@janelle/shared';
import { Page, PageHeading, Card, Pill, PasswordInput, Switch } from '../components/ui';
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
    <Card className="p-6 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">When the studio chases</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-ink-soft">
            When a nudge is drafted for review. Nothing is ever sent automatically.
          </p>
        </div>
        {dirty && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => save.mutate(draft, { onSuccess: () => setDraft({}) })}
              disabled={save.isPending}
              className="btn-primary btn-sm"
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setDraft({})} disabled={save.isPending} className="btn-ghost btn-sm">
              Cancel
            </button>
          </div>
        )}
      </div>

      {isLoading && <p className="mt-5 text-[13px] text-ink-faint">Loading…</p>}
      {save.isError && <p className="mt-3 text-[12.5px] text-crit">{(save.error as Error).message}</p>}

      {!isLoading && (
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {SLA_DIALS.map((d) => (
            <label key={d.key} className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-ink">{d.label}</span>
              <span className="flex items-center gap-2">
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
                  className="input w-24 tabular-nums"
                />
                <span className="text-[12.5px] text-ink-soft">{d.unit}</span>
              </span>
              <span className="text-[11.5px] text-ink-faint">{d.hint}</span>
            </label>
          ))}
        </div>
      )}
    </Card>
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
    <Card className="p-6">
      <h2 className="text-[16px] font-semibold text-ink">Password</h2>
      <p className="mt-1 text-[13.5px] text-ink-soft">
        {user?.email ? `Signed in as ${user.email}.` : 'Change the password you sign in with.'}
      </p>

      <form onSubmit={submit} className="mt-4 max-w-sm space-y-3">
        <PasswordInput
          required
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
        />
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
          placeholder="Repeat the new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />

        {msg && (
          <p className={`rounded-lg px-3 py-2 text-[12.5px] ${msg.tone === 'crit' ? 'bg-crit/10 text-crit' : 'bg-good/10 text-good'}`}>
            {msg.text}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary btn-sm">
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </Card>
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

 * The studio's Claude credentials. Kept here rather than in a deploy so

 * the key can be rotated by the person who owns the Anthropic account,

 * not by whoever has access to the server.

 *

 * The key never comes back from the API — only whether one is set and its

 * last four characters, which is enough to tell which key is in use.

 */

function AiSetupCard() {

  const config = useAiConfig();

  const setKey = useSetAiKey();

  const clearKey = useClearAiKey();

  const setModel = useSetAiModel();

  const [draft, setDraft] = useState('');



  // A 403 means "not a principal" — say nothing rather than showing an

  // error for a card this person was never meant to use.

  if (config.isError) return null;



  const data = config.data;

  const saving = setKey.isPending || clearKey.isPending;

  const error = (setKey.error ?? clearKey.error ?? setModel.error) as Error | undefined;



  return (

    <Card className="p-6 lg:col-span-2">

      <div className="flex flex-wrap items-start justify-between gap-3">

        <div>

          <h2 className="text-[16px] font-semibold text-ink">{ASSISTANT_NAME}’s brain</h2>

          <p className="mt-1 max-w-2xl text-[13.5px] text-ink-soft">

            {`The Claude account everything runs on — reading email, raising tasks,
            drafting follow-ups and answering ${ASSISTANT_NAME}’s questions. Get a key from`}{' '}
            <a

              href="https://console.anthropic.com/settings/keys"

              target="_blank"

              rel="noreferrer"

              className="font-medium text-brass hover:underline"

            >

              console.anthropic.com

            </a>

            .

          </p>

        </div>

        {data && (

          <Pill tone={data.configured ? 'good' : 'crit'}>

            {data.configured ? 'Connected' : 'No key'}

          </Pill>

        )}

      </div>



      {config.isLoading && <p className="mt-4 text-[13px] text-ink-faint">Loading…</p>}



      {data && (

        <>

          <div className="mt-5">

            <label className="text-[12.5px] font-medium text-ink-soft" htmlFor="ai-key">

              API key

            </label>

            {data.configured && (

              <p className="mt-1 text-[12.5px] text-ink-faint">

                {data.source === 'environment'

                  ? 'Currently using the key from the server environment. Setting one here replaces it.'

                  : `A key ending ${data.keyHint} is in use. Pasting a new one replaces it.`}

              </p>

            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">

              <PasswordInput

                id="ai-key"

                label="key"
                wrapperClassName="min-w-0 flex-1"

                autoComplete="off"

                spellCheck={false}

                value={draft}

                onChange={(e) => setDraft(e.target.value)}

                placeholder={data.configured ? 'Paste a new key to replace it' : 'sk-ant-…'}

                className="w-full"

              />

              <button

                className="btn-primary btn-sm"

                disabled={saving || draft.trim().length === 0}

                onClick={() => setKey.mutate(draft.trim(), { onSuccess: () => setDraft('') })}

              >

                {setKey.isPending ? 'Saving…' : 'Save key'}

              </button>

              {data.source === 'studio' && (

                <button

                  className="btn-secondary btn-sm"

                  disabled={saving}

                  onClick={() => clearKey.mutate(undefined)}

                >

                  {clearKey.isPending ? 'Removing…' : 'Remove'}

                </button>

              )}

            </div>

            <p className="mt-2 text-[11.5px] text-ink-faint">

              Stored encrypted, and never shown again after saving. Removing it falls back to the

              server’s own key, if it has one.

            </p>

          </div>



          <div className="mt-6">
            <label className="block text-[12.5px] font-medium text-ink-soft" htmlFor="ai-model">
              Model
            </label>
            <select
              id="ai-model"
              className="input mt-2 w-full md:max-w-sm"
              value={data.model}
              disabled={setModel.isPending}
              onChange={(e) => setModel.mutate(e.target.value)}
            >
              {data.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              {setModel.isPending ? 'Saving…' : 'Used by every AI feature.'}
            </p>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-crit">{error.message}</p>}
        </>
      )}
    </Card>
  );
}

/**
 * Pictures and video.
 *
 * A third provider with a third key. It sits beside the Claude card rather
 * than in a deploy for the same reason that one does: the person paying
 * for it should be able to switch it on without anyone touching a server.
 *
 * Without a key here the Create buttons do not appear and Jenny says so
 * plainly when asked for a rendering — which is the honest behaviour, but
 * it is also a dead end until somebody can paste a key in.
 */
function MediaSetupCard() {
  const config = useMediaConfig();
  const setKey = useSetMediaKey();
  const clearKey = useClearMediaKey();
  const setModel = useSetMediaModel();
  const [draft, setDraft] = useState('');

  if (config.isError) return null;
  const data = config.data;
  const saving = setKey.isPending || clearKey.isPending;
  const error = (setKey.error ?? clearKey.error ?? setModel.error) as Error | undefined;

  return (
    <Card className="p-6 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-ink">Pictures and video</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-ink-soft">
            Renderings, concept images and short clips — a sketch made photoreal, an empty room
            furnished, a walk-through. Get a key from{' '}
            <a
              href="https://console.x.ai"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brass hover:underline"
            >
              console.x.ai
            </a>
            . Without one, only the studio boards can be drawn.
          </p>
        </div>
        {data && (
          <Pill tone={data.configured ? 'good' : 'crit'}>
            {data.configured ? 'Connected' : 'No key'}
          </Pill>
        )}
      </div>

      {config.isLoading && <p className="mt-4 text-[13px] text-ink-faint">Loading…</p>}

      {data && (
        <>
          <div className="mt-5">
            <label className="text-[12.5px] font-medium text-ink-soft" htmlFor="media-key">
              API key
            </label>
            {data.configured && (
              <p className="mt-1 text-[12.5px] text-ink-faint">
                {data.source === 'environment'
                  ? 'Currently using the key from the server environment. Setting one here replaces it.'
                  : `A key ending ${data.keyHint} is in use. Pasting a new one replaces it.`}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PasswordInput
                id="media-key"
                label="key"
                wrapperClassName="min-w-0 flex-1"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={data.configured ? 'Paste a new key to replace it' : 'xai-…'}
                className="w-full"
              />
              <button
                className="btn-primary btn-sm"
                disabled={saving || draft.trim().length === 0}
                onClick={() => setKey.mutate(draft.trim(), { onSuccess: () => setDraft('') })}
              >
                {setKey.isPending ? 'Saving…' : 'Save key'}
              </button>
              {data.source === 'studio' && (
                <button className="btn-secondary btn-sm" disabled={saving} onClick={() => clearKey.mutate(undefined)}>
                  {clearKey.isPending ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Stored encrypted, and never shown again after saving.
            </p>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <label className="block text-[12.5px] font-medium text-ink-soft" htmlFor="media-image-model">
                Image model
              </label>
              <select
                id="media-image-model"
                className="input mt-2 w-full"
                value={data.imageModel}
                disabled={setModel.isPending}
                onChange={(e) => setModel.mutate({ kind: 'image', model: e.target.value })}
              >
                {data.imageModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {usdEach(m.usdPerImage)} each
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11.5px] text-ink-faint">
                {data.imageModels.find((m) => m.id === data.imageModel)?.note ?? ''}
              </p>
            </div>

            <div>
              <label className="block text-[12.5px] font-medium text-ink-soft" htmlFor="media-video-model">
                Video model
              </label>
              <select
                id="media-video-model"
                className="input mt-2 w-full"
                value={data.videoModel}
                disabled={setModel.isPending}
                onChange={(e) => setModel.mutate({ kind: 'video', model: e.target.value })}
              >
                {data.videoModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} — {usdEach(m.usdPerSecond)} a second
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11.5px] text-ink-faint">
                A clip is capped per day and per length; both are set on the server.
              </p>
            </div>
          </div>

          {error && <p className="mt-3 text-[12.5px] text-crit">{error.message}</p>}
        </>
      )}
    </Card>
  );
}

/** Cents when small, dollars when not — a price people read at a glance. */
function usdEach(n: number): string {
  return n < 1 ? `${Math.round(n * 100)}c` : `$${n.toFixed(2)}`;
}

/**
 * How often the studio looks for new mail.
 *
 * Every new email costs a Claude call to classify, another to decide
 * whether it raises a task, and sometimes a third to draft a reply. How
 * often we look, and whether we think about what we find, are the two
 * dials that actually move the bill — so they belong in front of the
 * person paying it, not in a deploy.
 */
function EmailReadingCard() {
  const settings = useIngestSettings();
  const save = useSetIngestSettings();

  if (settings.isError) return null;
  const data = settings.data;

  return (
    <Card className="p-6 lg:col-span-2">
      <h2 className="text-[16px] font-semibold text-ink">Reading email</h2>
      <p className="mt-1 max-w-2xl text-[13.5px] text-ink-soft">
        How often the studio checks Gmail and Drive for anything new.
      </p>

      {settings.isLoading && <p className="mt-4 text-[13px] text-ink-faint">Loading…</p>}

      {data && (
        <>
          <div className="mt-5">
            <label className="block text-[12.5px] font-medium text-ink-soft" htmlFor="ingest-every">
              Check for new email
            </label>
            <select
              id="ingest-every"
              className="input mt-2 w-full md:max-w-sm"
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
            <p className="mt-2 text-[11.5px] text-ink-faint">
              {data.intervalMinutes === 0
                ? 'Nothing is read on a schedule — use “Read Gmail & Drive” on the dashboard.'
                : 'Checking more often costs more, because each new email is read by Claude.'}
            </p>
          </div>

          <div className="mt-6 flex items-start gap-3 rounded-xl border border-line bg-surface p-4">
            <Switch
              checked={data.useAi}
              disabled={save.isPending}
              label="Let Claude read incoming email"
              onChange={(next) => save.mutate({ useAi: next })}
            />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">
                Let {ASSISTANT_NAME} read what arrives
              </div>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                {data.useAi
                  ? 'Email is classified, linked to a project, and turned into tasks and reply drafts. This is where most of the cost is.'
                  : 'Email is fetched and filed only. Nothing is classified, no tasks are raised, no drafts are written — and nothing is spent.'}
              </p>
            </div>
          </div>

          {save.isError && (
            <p className="mt-3 text-[12.5px] text-crit">{(save.error as Error).message}</p>
          )}
        </>
      )}
    </Card>
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

  // A 403 here just means "not a principal" — say nothing rather than
  // showing an error for a card this person was never meant to use.
  if (link.isError) return null;

  const url = link.data?.path ? `${window.location.origin}${link.data.path}` : null;

  return (
    <Card className="p-6 lg:col-span-2">
      <h2 className="text-[16px] font-semibold text-ink">AI usage link</h2>
      <p className="mt-1 text-[13.5px] text-ink-soft">
        A read-only page showing what the assistant costs to run — tokens, spend, and which
        job spent it. Anyone with the link can open it without signing in, so share it
        deliberately. Nothing else in the studio is reachable from it.
      </p>

      {url ? (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-sunk px-3 py-2 text-[12px] text-ink-soft">
              {url}
            </code>
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="btn-secondary btn-sm"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending ? 'Replacing…' : 'Replace link'}
            </button>
            <button
              className="btn-secondary btn-sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? 'Turning off…' : 'Turn off'}
            </button>
            <span className="text-[11.5px] text-ink-faint">
              Replacing or turning off stops the old link working immediately.
            </span>
          </div>
        </>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className="btn-primary btn-sm"
            disabled={rotate.isPending || link.isLoading}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? 'Creating…' : 'Create a link'}
          </button>
          <span className="text-[12.5px] text-ink-faint">No link exists yet.</span>
        </div>
      )}

      {(rotate.isError || revoke.isError) && (
        <p className="mt-3 text-[12.5px] text-crit">
          {((rotate.error ?? revoke.error) as Error).message}
        </p>
      )}
    </Card>
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
    <Page>
      <PageHeading title="Settings" />

      {flash && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-[13.5px] ${
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
              everConnected={anyConnected}
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
              everConnected={anyConnected}
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

        <AiSetupCard />
        <MediaSetupCard />

        <EmailReadingCard />

        <AiUsageLinkCard />

        <PasswordCard />

        <ChasingCard />

        <Card className="p-6 lg:col-span-2">
          <h2 className="text-[16px] font-semibold text-ink">Team &amp; roles</h2>
          <p className="mt-1 text-[13.5px] text-ink-soft">
            People, their roles, and exactly what each role may do — enforced in the API and again by
            row-level security in the database.
          </p>
          <Link to="/team" className="btn-secondary btn-sm mt-4 inline-flex">Open Team &amp; Roles →</Link>
        </Card>
      </div>
    </Page>
  );
}
