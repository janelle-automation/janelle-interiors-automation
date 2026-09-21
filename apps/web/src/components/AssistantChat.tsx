import { useEffect, useLayoutEffect, useRef, useState, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import { ASSISTANT_NAME } from '@janelle/shared';
import { useAssistant, type AttachedFile, type ChatMessage } from '../context/AssistantContext';
import { api } from '../lib/api';
import { useConfirmAction } from '../lib/queries';
import { bestHearing, listen, speak, type StopListening } from '../lib/speech';
import { AssistantAnswerView, AttachedFiles, answerIsWide, sizeLabel } from './AssistantAnswer';
import { useImagineOptions } from '../lib/queries';
import { readableAttachment } from '../lib/attachments';
import { AssistantGuide } from './AssistantGuide';
import { IconMic, IconSend, IconStop } from './icons';

/**
 * The conversation with Jenny: what was said, what she is doing now, and
 * the ways to say the next thing — typed, one spoken question, or a spoken
 * back-and-forth.
 *
 * One component for both places she appears. `compact` is the side panel,
 * which is narrow whatever the window size; the full page is not.
 */

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconCopy = (p: IconProps) => (
  <svg {...stroke} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></svg>
);
const IconCheck = (p: IconProps) => <svg {...stroke} {...p}><path d="M20 6 9 17l-5-5" /></svg>;
const IconSpeaker = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></svg>
);
const IconClip = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.5 7" /></svg>
);
const IconX = (p: IconProps) => <svg {...stroke} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconRetry = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
);

/** Money as a composer hint: cents when small, whole dollars when not. */
function usdShort(n: number): string {
  return n < 1 ? `${Math.round(n * 100)}c` : `$${n.toFixed(2)}`;
}

export function JennyAvatar({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brass font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.46 }}
      aria-hidden="true"
    >
      {ASSISTANT_NAME[0]}
    </span>
  );
}

// ── Messages ────────────────────────────────────────────────

function dayLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function DayDivider({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-3 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
      <span className="h-px flex-1 bg-line" />
      {dayLabel(at)}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * What a drafted email says, shown before anyone confirms it.
 *
 * Confirming a task sight unseen is fine — its summary is the task. An email
 * is not: the summary is a subject line, and the words that go to a client
 * are the whole point. So the draft is shown in full, where it can be read.
 */
function DraftPreview({ input }: { input: Record<string, unknown> }) {
  const line = (label: string, value: unknown) =>
    value ? (
      <div className="flex gap-2">
        <span className="w-14 shrink-0 text-ink-faint">{label}</span>
        <span className="min-w-0 break-words text-ink">{String(value)}</span>
      </div>
    ) : null;

  return (
    <div className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px]">
      {line('To', input.to)}
      {line('Cc', input.cc)}
      {line('Subject', input.subject)}
      <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-line border-t border-line pt-2 leading-relaxed text-ink-soft">
        {String(input.body ?? '')}
      </p>
    </div>
  );
}

/**
 * What she has prepared, and the person's answer to it.
 *
 * Three states, always visible: waiting (with the ways to answer — a button,
 * or just saying yes), saved, or turned down. A proposal that looks the same
 * before and after is how "I've created the task" got said about a task
 * nobody had saved.
 */
function Proposals({ message }: { message: ChatMessage }) {
  const { markDone, markDismissed, acknowledge } = useAssistant();
  const confirm = useConfirmAction();
  if (!message.proposed?.length) return null;

  return (
    <div className="mt-3 space-y-2.5 border-t border-line pt-3">
      {message.proposed.map((p, j) => {
        const key = `${message.id}-${j}`;
        const saved = message.done?.includes(key);
        const dismissed = message.dismissed?.includes(key);
        const isDraft = p.tool === 'propose_draft';
        const isUpdate = p.tool === 'propose_task_update';
        return (
          <div key={key} className="space-y-2">
            {isDraft && !dismissed && <DraftPreview input={p.input} />}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className={`text-[13px] ${dismissed ? 'text-ink-faint line-through' : 'text-ink'}`}>{p.summary}</span>
              {saved ? (
                <Link
                  to={isDraft ? '/drafts' : '/tasks'}
                  className="inline-flex items-center gap-1 rounded-full bg-good/10 px-2 py-0.5 text-[12px] font-semibold text-good"
                >
                  <IconCheck width={13} height={13} />
                  {isDraft ? 'Saved to Drafts' : isUpdate ? 'Updated' : 'Added to Tasks'}
                </Link>
              ) : dismissed ? (
                <span className="text-[12px] text-ink-faint">{isUpdate ? 'Not changed' : 'Not added'}</span>
              ) : (
                <>
                  <button
                    className="btn-primary btn-sm"
                    disabled={confirm.isPending}
                    onClick={() =>
                      confirm.mutate(
                        { tool: p.tool, input: p.input },
                        {
                          onSuccess: (result) => {
                            markDone(message.id, key);
                            acknowledge(result);
                          },
                        },
                      )
                    }
                  >
                    {confirm.isPending ? 'Saving…' : isDraft ? 'Save to Drafts' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={confirm.isPending}
                    onClick={() => markDismissed(message.id, key)}
                  >
                    Dismiss
                  </button>
                  <span className="text-[11.5px] text-ink-faint">or just say “yes”</span>
                </>
              )}
            </div>
          </div>
        );
      })}
      {confirm.isError && <p className="text-[12.5px] text-crit">{(confirm.error as Error).message}</p>}
    </div>
  );
}

/** Small, quiet actions under an answer: take the words away, or hear them. */
function MessageActions({ message }: { message: ChatMessage }) {
  const { canSpeak } = useAssistant();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused — nothing useful to say about it */
    }
  }

  const btn = 'focusable inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-ink-faint transition-colors hover:bg-sunk hover:text-ink';
  return (
    <div className="mt-1 flex items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
      <button type="button" onClick={copy} className={btn} aria-label="Copy answer">
        {copied ? <IconCheck /> : <IconCopy />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      {canSpeak && (
        <button type="button" onClick={() => speak(message.answer?.speech || message.content)} className={btn} aria-label="Read answer aloud">
          <IconSpeaker />
          Listen
        </button>
      )}
      <span className="ml-1 text-[11px] text-ink-faint">{timeOf(message.at)}</span>
    </div>
  );
}

function MessageView({ message, compact }: { message: ChatMessage; compact: boolean }) {
  const { send, pending } = useAssistant();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brass/10 px-4 py-2.5 text-[14px] leading-relaxed text-ink">
          {message.content && <p className="whitespace-pre-line">{message.content}</p>}
          {message.files?.length ? <AttachedFiles files={message.files} /> : null}
        </div>
      </div>
    );
  }

  if (message.kind === 'error') {
    return (
      <div className="flex gap-2.5">
        <JennyAvatar />
        <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-crit/30 bg-crit/5 px-4 py-2.5">
          <p className="text-[13.5px] text-ink">That didn't work: {message.content}</p>
          {(message.retry || message.retryFiles?.length) && (
            <button
              type="button"
              disabled={pending}
              onClick={() => send(message.retry ?? '', { files: message.retryFiles })}
              className="btn-secondary btn-sm mt-2"
            >
              <IconRetry />
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const briefing = message.kind === 'briefing';
  const width = compact || answerIsWide(message.answer) ? 'w-full' : message.answer?.items.length ? 'w-full max-w-[40rem]' : 'max-w-[85%]';

  return (
    <div className="group flex gap-2.5">
      <JennyAvatar />
      <div className={`min-w-0 ${width}`}>
        <div
          className={`rounded-2xl rounded-tl-md px-4 py-3 text-[14px] leading-relaxed text-ink ${
            briefing ? 'border border-brass/25 bg-brass/[0.06]' : 'bg-sunk'
          }`}
        >
          {briefing && (
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-brass-deep">Your briefing</div>
          )}
          {message.answer ? (
            <AssistantAnswerView answer={message.answer} compact={compact} />
          ) : (
            <p className="whitespace-pre-line">{message.content}</p>
          )}
          <Proposals message={message} />
          <Rendering message={message} />
        </div>
        <MessageActions message={message} />
      </div>
    </div>
  );
}

/**
 * A clip still being drawn.
 *
 * Shown under the answer that asked for it, because the answer arrived
 * first and said so. It is replaced by the video itself when the job
 * finishes — the person does not reload, and does not have to ask again.
 */
function Rendering({ message }: { message: ChatMessage }) {
  const waiting = message.jobs?.length ?? 0;
  if (!waiting) return null;
  return (
    <div
      className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-ink-soft"
      role="status"
      aria-live="polite"
    >
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {waiting > 1 ? `${waiting} clips are rendering` : 'The clip is rendering'} — it appears here when it is ready.
    </div>
  );
}

/** What she is doing while the answer is on its way. */
function Working({ status }: { status: string | null }) {
  return (
    <div className="flex items-center gap-2.5" role="status" aria-live="polite">
      <JennyAvatar />
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-sunk px-4 py-2.5 text-[13px] text-ink-soft">
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {status ? `${status}…` : 'Thinking…'}
      </div>
    </div>
  );
}

function Suggestions({ items, onPick, disabled }: { items: string[]; onPick: (q: string) => void; disabled: boolean }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pl-[38px]">
      {items.map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onPick(s)}
          className="focusable rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:border-brass/50 hover:bg-brass/5 hover:text-ink disabled:opacity-50"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Saying the next thing ───────────────────────────────────

/** What Jenny can read. The server checks the bytes too; this only saves a wasted upload. */
const ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Anything picture-shaped is offered: what the server cannot take is
// converted in the browser first (see lib/attachments).
const ACCEPT_ATTR = '.pdf,image/*,.heic,.heif,.avif,.svg,.xlsx,.xls,.docx,.csv,.tsv,.txt,.md';
const MAX_FILES = 4;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: 'uploading' | 'ready' | 'failed';
  file?: AttachedFile;
  error?: string;
  /** A local picture of an image, for the chip. */
  thumb?: string;
  controller: AbortController;
}

/**
 * Worth trying, rather than known-good.
 *
 * What a file really is gets decided from its bytes a moment later, and
 * anything the browser can display is converted before it is sent — so the
 * gate here only needs to keep out what is plainly not a document or a
 * picture at all.
 */
const readableType = (f: File) =>
  f.type.startsWith('image/') ||
  f.type === 'application/pdf' ||
  ACCEPT.includes(f.type) ||
  /\.(pdf|png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?|svg|xlsx?|docx?|csv|tsv|txt|md)$/i.test(f.name);

function Composer({ compact, dropInto }: { compact: boolean; dropInto: React.MutableRefObject<((files: File[]) => void) | null> }) {
  const {
    send, imagine, pending, stop, canListen, lookingAt, focusRequest, setMicError, vocabulary, uploadFile, prefill, attachRequest,
  } = useAssistant();
  const { data: canMake } = useImagineOptions();
  const [text, setText] = useState('');
  /**
   * Ask, or make.
   *
   * Asking goes through Jenny, who decides what to do with it. Making does
   * not: the person has already decided, so it goes straight to the
   * provider and costs no model tokens at all.
   */
  const [mode, setMode] = useState<'ask' | 'image' | 'video'>('ask');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [listening, setListening] = useState(false);
  // What the microphone last heard, with every hearing of it. Sent along only
  // while the words in the box are still exactly what was heard — once the
  // person corrects them, the correction is the question.
  const [heard, setHeard] = useState<{ best: string; alternatives: string[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const stopListening = useRef<StopListening | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [focusRequest]);

  // Grows with what is typed, up to a few lines, then scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [text]);

  useEffect(() => () => stopListening.current?.({ discard: true }), []);

  // "Create a task for …" from the guide: in the box, cursor at the end.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    setHeard(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [prefill]);

  const attachRequestSeen = useRef(attachRequest);
  useEffect(() => {
    if (attachRequest === attachRequestSeen.current) return;
    attachRequestSeen.current = attachRequest;
    picker.current?.click();
  }, [attachRequest]);

  const patch = (id: string, change: Partial<Attachment>) =>
    setAttachments((list) => list.map((a) => (a.id === id ? { ...a, ...change } : a)));

  /** Start uploading straight away, so sending does not wait on it. */
  function addFiles(files: File[]) {
    setAttachError(null);
    const room = MAX_FILES - attachments.length;
    const refused: string[] = [];
    const accepted = files.filter((f) => {
      if (!readableType(f)) refused.push(`${f.name} is not a PDF or an image`);
      else if (f.size > MAX_FILE_BYTES) refused.push(`${f.name} is too large`);
      else return true;
      return false;
    });
    if (accepted.length > room) refused.push(`only ${MAX_FILES} files fit on one question`);
    if (refused.length) setAttachError(`Not attached: ${refused.join('; ')}.`);

    for (const f of accepted.slice(0, Math.max(0, room))) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      const thumb = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      setAttachments((list) => [
        ...list,
        { id, name: f.name, size: f.size, mimeType: f.type || 'application/pdf', status: 'uploading', thumb, controller },
      ]);
      readableAttachment(f)
        .then((ready) => {
          // A HEIC shows as a broken thumbnail until it has been converted.
          if (ready !== f && ready.type.startsWith('image/')) {
            if (thumb) URL.revokeObjectURL(thumb);
            patch(id, { thumb: URL.createObjectURL(ready), mimeType: ready.type });
          }
          return uploadFile(ready, controller.signal);
        })
        .then((file) => patch(id, { status: 'ready', file, mimeType: file.mimeType }))
        .catch((err: Error) => {
          if (err.name === 'AbortError') return;
          // A format the browser cannot open left a broken thumbnail
          // behind; the message says what it is, so the box is noise.
          if (thumb) URL.revokeObjectURL(thumb);
          patch(id, { status: 'failed', error: err.message, thumb: undefined });
        });
    }
    ref.current?.focus();
  }
  dropInto.current = addFiles;

  function removeAttachment(a: Attachment) {
    a.controller.abort();
    if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttachments((list) => list.filter((x) => x.id !== a.id));
    // Uploaded but never sent: nothing refers to it, so it is not kept.
    if (a.file) {
      void api('/assistant/uploads/forget', { method: 'POST', body: JSON.stringify({ tokens: [a.file.token] }) }).catch(() => {});
    }
  }

  const uploading = attachments.some((a) => a.status === 'uploading');
  const ready = attachments.filter((a) => a.status === 'ready' && a.file).map((a) => a.file as AttachedFile);
  const canSend = !pending && !uploading && (Boolean(text.trim()) || ready.length > 0);

  function submit() {
    if (!canSend) return;
    if (mode !== 'ask') {
      imagine(text, mode, { files: ready });
    } else {
      const spoken = heard && text.trim() === heard.best ? { alternatives: heard.alternatives } : {};
      send(text, { ...spoken, files: ready });
    }
    setText('');
    setHeard(null);
    for (const a of attachments) if (a.thumb) URL.revokeObjectURL(a.thumb);
    setAttachments([]);
    setAttachError(null);
  }

  /**
   * One spoken question, left in the box to check before it goes.
   *
   * It used to send the moment the browser stopped listening, so a misheard
   * name went straight to Jenny. Now the words appear as they are heard, the
   * best hearing stays in the box, and Enter sends it — a second to catch
   * "Danish" before it becomes the question. Hands-free Talk still sends on
   * its own, for when there is nobody's hand free to press Enter.
   *
   * What is said is added to what is already in the box, so a question can
   * be typed and finished aloud, or said in two goes. Listening ends at a
   * pause, or when the microphone is pressed again.
   */
  function toggleMic() {
    if (listening) {
      stopListening.current?.();
      return;
    }
    setMicError(null);
    setHeard(null);
    setListening(true);
    const before = text;
    const withBefore = (words: string) => [before.trim(), words.trim()].filter(Boolean).join(' ');
    stopListening.current = listen({
      // Pressing the microphone means "my turn": she stops talking first.
      interrupt: true,
      // Nothing is sent without Enter, so a thinking pause can be longer.
      pauseMs: 2_600,
      onInterim: (words) => setText(withBefore(words)),
      onResult: (hearings) => {
        const ranked = bestHearing(hearings, vocabulary);
        const best = withBefore(ranked[0].transcript);
        setText(best);
        setHeard({ best, alternatives: ranked.map((h) => withBefore(h.transcript)) });
        requestAnimationFrame(() => {
          const el = ref.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
      onError: (msg) => {
        setMicError(msg);
        setText(before);
      },
      onEnd: () => {
        setListening(false);
        stopListening.current = null;
      },
    });
  }

  return (
    <div className="border-t border-line px-4 pb-4 pt-3">
      {lookingAt && (
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <span className="h-1.5 w-1.5 rounded-full bg-brass" aria-hidden="true" />
          Looking at <span className="font-medium text-ink-soft">{lookingAt}</span> — ask about "this project"
        </div>
      )}
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached files">
          {attachments.map((a) => (
            <li
              key={a.id}
              className={`flex max-w-full items-center gap-2 rounded-lg border px-2 py-1.5 ${
                a.status === 'failed' ? 'border-crit/40 bg-crit/5' : 'border-line bg-surface'
              }`}
            >
              {a.thumb ? (
                <img src={a.thumb} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
              ) : (
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-crit/10 text-[9.5px] font-semibold text-crit" aria-hidden="true">
                  PDF
                </span>
              )}
              <span className="min-w-0">
                <span className="block max-w-[12rem] truncate text-[12.5px] font-medium text-ink" title={a.name}>
                  {a.name}
                </span>
                <span className={`block text-[11px] ${a.status === 'failed' ? 'text-crit' : 'text-ink-faint'}`}>
                  {a.status === 'uploading' ? 'Uploading…' : a.status === 'failed' ? a.error ?? 'Upload failed' : sizeLabel(a.size)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a)}
                aria-label={`Remove ${a.name}`}
                title="Remove"
                className="focusable grid h-6 w-6 shrink-0 place-items-center rounded text-ink-faint hover:bg-sunk hover:text-ink"
              >
                <IconX width={14} height={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {canMake && (canMake.image.ready || canMake.video.ready) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <div className="flex gap-0.5 rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Ask, or make something">
            {([
              ['ask', 'Ask', true],
              ['image', 'Image', canMake.image.ready],
              ['video', 'Video', canMake.video.ready],
            ] as const).map(([key, label, enabled]) => (
              <button
                key={key}
                type="button"
                disabled={!enabled}
                aria-pressed={mode === key}
                onClick={() => setMode(key)}
                className={`focusable rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-35 ${
                  mode === key ? 'bg-brass text-white' : 'text-ink-soft hover:bg-sunk hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'video' && (
            <span className="text-[11.5px] text-ink-faint">
              {canMake.video.defaultSeconds}s · about {usdShort(canMake.video.usdPerSecond * canMake.video.defaultSeconds)}
              {canMake.video.spentTodayUsd > 0 &&
                ` · ${usdShort(canMake.video.spentTodayUsd)} of ${usdShort(canMake.video.dailyCapUsd)} used today`}
            </span>
          )}
          {mode === 'image' && (
            <span className="text-[11.5px] text-ink-faint">
              {attachments.length > 0 ? 'Transforms what you attached' : 'Drawn from your words'} · no tokens spent
            </span>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-1.5 rounded-xl border border-line bg-surface px-2 py-1.5 transition-colors focus-within:border-brass"
      >
        <input
          ref={picker}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={attachments.length >= MAX_FILES}
          aria-label="Attach a PDF or an image"
          title="Attach a PDF or an image"
          className="focusable grid h-9 w-9 shrink-0 place-items-center rounded-lg text-ink-soft transition-colors hover:bg-sunk hover:text-ink disabled:opacity-40"
        >
          <IconClip width={17} height={17} />
        </button>
        {canListen && (
          <button
            type="button"
            onClick={toggleMic}
            aria-label={listening ? 'Stop listening' : 'Ask by voice'}
            aria-pressed={listening}
            title={listening ? 'Stop listening' : 'Ask by voice'}
            className={`focusable relative grid h-9 w-9 shrink-0 place-items-center rounded-lg transition-colors ${
              listening ? 'bg-crit/10 text-crit' : 'text-ink-soft hover:bg-sunk hover:text-ink'
            }`}
          >
            {listening ? <IconStop /> : <IconMic />}
            {listening && <span className="absolute inset-0 animate-ping rounded-lg bg-crit/20" aria-hidden="true" />}
          </button>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // A screenshot pasted in is an attachment, not text.
            const files = Array.from(e.clipboardData.files ?? []);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Not while an input
            // method is composing, or Enter would send half a word.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          // Short in the panel: a placeholder that wraps makes an empty box two lines tall.
          placeholder={
            listening
              ? 'Listening…'
              : mode === 'image'
                ? 'Describe the picture — the room, the materials, the light'
                : mode === 'video'
                  ? 'Describe the clip — the room, the move, the light'
                  : compact
                    ? `Ask ${ASSISTANT_NAME} anything…`
                    : `Ask ${ASSISTANT_NAME} anything, or say what you need done`
          }
          aria-label={`Message ${ASSISTANT_NAME}`}
          className="max-h-36 min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-faint"
        />
        {pending ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop"
            title="Stop waiting for this answer"
            className="focusable grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink text-surface transition-opacity hover:opacity-85"
          >
            <IconStop width={16} height={16} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            title="Send (Enter)"
            disabled={!canSend}
            className="focusable grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brass text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconSend width={18} height={18} />
          </button>
        )}
      </form>
      {attachError && (
        <p className="mt-1.5 px-1 text-[11.5px] text-crit" role="alert">
          {attachError}
        </p>
      )}
      {uploading && !attachError && (
        <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">Uploading — you can send once it's done.</p>
      )}
      {heard && text.trim() === heard.best && !pending && (
        <p className="mt-1.5 px-1 text-[11.5px] text-ink-faint">
          That's what I heard — fix anything I got wrong, then press Enter.
        </p>
      )}
    </div>
  );
}

/**
 * The spoken conversation: one control, and a clear picture of whose turn
 * it is. Typing is still a tap away — "Type instead" ends the loop.
 */
function VoiceBar() {
  const { voice, status, setHandsFree, skipSpeaking, doneTalking, interim } = useAssistant();

  const label =
    voice === 'listening'
      ? interim
        ? 'Listening — pause when you’re done'
        : 'Listening — go ahead'
      : voice === 'speaking'
        ? 'Speaking'
        : `${status ?? 'Thinking'}…`;

  return (
    <div className="border-t border-line px-4 pb-4 pt-4">
      <div className="flex flex-col items-center gap-3">
        <span className={`voice-orb voice-orb--${voice}`} aria-hidden="true">
          {voice === 'listening' ? <IconMic width={22} height={22} /> : <JennyAvatar size={40} />}
        </span>
        <p className="text-[13.5px] font-medium text-ink" role="status" aria-live="polite">
          {label}
        </p>
        {/* The words as they are heard, so a mishearing is visible before it is sent. */}
        {voice === 'listening' && interim && (
          <p className="max-w-full px-2 text-center text-[13px] italic text-ink-soft line-clamp-3">“{interim}”</p>
        )}
        <div className="flex gap-2">
          {voice === 'listening' && interim && (
            <button type="button" onClick={doneTalking} className="btn-primary btn-sm">
              Send now
            </button>
          )}
          {voice === 'speaking' && (
            <button type="button" onClick={skipSpeaking} className="btn-secondary btn-sm">
              Skip
            </button>
          )}
          <button type="button" onClick={() => setHandsFree(false)} className="btn-secondary btn-sm">
            Type instead
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The conversation ────────────────────────────────────────

export function AssistantChat({ compact = false }: { compact?: boolean }) {
  const { messages, pending, status, send, briefingLoading, handsFree, micError, setMicError } = useAssistant();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Files dropped anywhere on the conversation go to the composer.
  const dropInto = useRef<((files: File[]) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  // Follow the conversation down — unless the person has scrolled up to
  // read something, in which case a new line arriving must not yank them.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A fresh conversation reads from the top: the guide starts there.
    if (messages.length === 0) {
      el.scrollTo({ top: 0 });
      pinned.current = true;
      return;
    }
    const last = messages[messages.length - 1];
    if (pinned.current || last?.role === 'user') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, pending, status]);

  const last = messages[messages.length - 1];
  const suggestions = !pending && last?.role === 'assistant' ? (last.answer?.suggestions ?? []) : [];

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!carriesFiles(e) || handsFree) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (carriesFiles(e) && !handsFree) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (!carriesFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!handsFree) dropInto.current?.(Array.from(e.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-brass bg-surface/85 text-center">
          <div>
            <IconClip width={26} height={26} className="mx-auto text-brass-deep" />
            <p className="mt-2 text-[14px] font-semibold text-ink">Drop to attach</p>
            <p className="text-[12.5px] text-ink-soft">PDFs and images — {ASSISTANT_NAME} reads them for you</p>
          </div>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
      >
        {messages.length === 0 &&
          (briefingLoading ? (
            <Working status="Getting today's briefing" />
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2.5">
                <JennyAvatar />
                <div className="rounded-2xl rounded-tl-md bg-sunk px-4 py-3 text-[14px] leading-relaxed text-ink">
                  Hi — I'm {ASSISTANT_NAME}. Ask me about any project, task, order, email or file, attach a PDF or a
                  photo, or tell me what you need done. Here is what I can do:
                </div>
              </div>
              <div className={compact ? 'pl-[38px]' : 'pl-[38px] pr-2'}>
                <AssistantGuide compact={compact} />
              </div>
            </div>
          ))}

        {messages.map((m, i) => (
          <div key={m.id} className="space-y-4">
            {(i === 0 || dayLabel(messages[i - 1].at) !== dayLabel(m.at)) && <DayDivider at={m.at} />}
            <MessageView message={m} compact={compact} />
          </div>
        ))}

        <Suggestions items={suggestions} onPick={send} disabled={pending} />

        {pending && <Working status={status} />}
      </div>

      {micError && (
        <div className="flex items-start justify-between gap-3 border-t border-line bg-crit/5 px-4 py-2 text-[12.5px] text-crit">
          <span>{micError}</span>
          <button type="button" onClick={() => setMicError(null)} className="shrink-0 underline">
            Dismiss
          </button>
        </div>
      )}

      {handsFree ? <VoiceBar /> : <Composer compact={compact} dropInto={dropInto} />}
    </div>
  );
}
