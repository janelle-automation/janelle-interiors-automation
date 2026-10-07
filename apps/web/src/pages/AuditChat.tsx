import { useEffect, useState } from 'react';
import { IconMonitor, IconPlus, IconList } from '../components/icons';
import { AssistantChat } from '../components/AssistantChat';
import { AssistantHistory } from '../components/AssistantHistory';

/* ── PWA install prompt type ─────────────────────────────────── */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isIOS =
  typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

const isAndroid =
  typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

const isStandalone =
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone);

// Waved away once, stays away: the chip floats over the conversation and has
// no title bar to retreat into, so it must not be askable twice.
const DISMISSED_KEY = 'jenny-install-dismissed';

/* ── The one affordance ──────────────────────────────────────────
   Jenny carries no chrome of her own, so the offer to install her floats
   above the conversation and leaves for good once it has been taken,
   waved away, or made redundant by already running as an app. */
function InstallChip() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);
  const [showTip, setShowTip] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* storage may be blocked; the chip simply returns next visit */
    }
  };

  // Chrome and Edge hand us a real prompt. Safari and Firefox never will, so
  // there the button opens the instructions for doing it by hand instead.
  const install = async () => {
    if (!prompt) {
      setShowTip((v) => !v);
      return;
    }
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setPrompt(null);
  };

  return (
    <div className="jenny-chip jenny-chip-right fixed z-50">
      <div className="flex items-center gap-0.5 rounded-full border border-line bg-surface/90 py-0.5 pl-1 pr-1 shadow-pop backdrop-blur">
        <button
          type="button"
          onClick={install}
          className="focusable flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-ink-soft transition-colors hover:text-ink"
        >
          <IconMonitor width={14} height={14} />
          <span>{isIOS || isAndroid ? 'Add to Home Screen' : 'Install Jenny'}</span>
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now"
          title="Not now"
          className="focusable grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-sunk hover:text-ink"
        >
          <IconPlus width={12} height={12} className="rotate-45" />
        </button>
      </div>

      {showTip && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-line bg-surface p-4 text-[12.5px] leading-relaxed text-ink-soft shadow-pop">
          <p className="mb-2 font-semibold text-ink">Add to Home Screen</p>
          {isIOS ? (
            <ol className="list-inside list-decimal space-y-1.5">
              <li>Tap the <span className="font-medium text-ink">Share</span> <span className="text-[11px]">(&#x2191;)</span> button in Safari</li>
              <li>Scroll and tap <span className="font-medium text-ink">Add to Home Screen</span></li>
              <li>Tap <span className="font-medium text-ink">Add</span></li>
            </ol>
          ) : isAndroid ? (
            <ol className="list-inside list-decimal space-y-1.5">
              <li>Tap the <span className="font-medium text-ink">&#8942; menu</span> in Chrome</li>
              <li>Tap <span className="font-medium text-ink">Add to Home screen</span></li>
              <li>Tap <span className="font-medium text-ink">Add</span></li>
            </ol>
          ) : (
            <ol className="list-inside list-decimal space-y-1.5">
              <li>Click the <span className="font-medium text-ink">&#8942; menu</span> in Chrome</li>
              <li>Click <span className="font-medium text-ink">Save and share</span></li>
              <li>Click <span className="font-medium text-ink">Install page as app</span></li>
            </ol>
          )}
          <button
            type="button"
            onClick={() => setShowTip(false)}
            className="mt-3 font-medium text-brass-deep hover:underline"
          >
            Got it
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Past conversations ─────────────────────────────────────────
   In the studio the history hangs off the panel's own header. Here there is
   no header to hang it from, so it arrives as a drawer over the conversation
   and leaves the moment a conversation is picked — the chat behind it is the
   point of the page, and the list is only how you get back to one. */
function HistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        aria-label="Past conversations"
        className="assistant-drawer-left jenny-drawer fixed inset-y-0 left-0 z-50 flex w-full flex-col border-r border-line bg-surface shadow-pop sm:w-[340px]"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
          <span className="text-[13px] font-semibold text-ink">Conversations</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focusable grid h-7 w-7 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-sunk hover:text-ink"
          >
            <IconPlus width={14} height={14} className="rotate-45" />
          </button>
        </header>
        <AssistantHistory onOpened={onClose} onNew={onClose} />
      </aside>
    </>
  );
}

/* ── Page ────────────────────────────────────────────────────── */
export default function AuditChat() {
  const [history, setHistory] = useState(false);

  /*
   * Nothing behind the conversation scrolls while Jenny is open, so the
   * message list owns the only scrollbar on the page — and a pull past the
   * end of it cannot drag the document or trigger pull-to-refresh.
   */
  useEffect(() => {
    document.documentElement.classList.add('jenny-locked');
    return () => document.documentElement.classList.remove('jenny-locked');
  }, []);

  /*
   * index.html picks the manifest on a cold load, which is the path that
   * matters for installing. Reaching Jenny from the studio's sidebar is a
   * client-side navigation the browser never sees, so the swap is repeated
   * here — and undone on the way out, so the studio does not offer itself
   * as Jenny afterwards.
   */
  useEffect(() => {
    const link = document.getElementById('app-manifest') as HTMLLinkElement | null;
    if (!link) return;
    const previous = link.getAttribute('href');
    link.setAttribute('href', '/jenny-manifest.json');
    return () => { if (previous) link.setAttribute('href', previous); };
  }, []);

  return (
    <div className="jenny-shell flex flex-col bg-paper">
      <button
        type="button"
        onClick={() => setHistory(true)}
        aria-label="Past conversations"
        title="Past conversations"
        className="focusable jenny-chip jenny-chip-left fixed z-30 flex items-center gap-1.5 rounded-full border border-line bg-surface/90 py-1.5 pl-2.5 pr-3 text-[12.5px] font-medium text-ink-soft shadow-pop backdrop-blur transition-colors hover:text-ink"
      >
        <IconList width={14} height={14} />
        <span>History</span>
      </button>

      <HistoryDrawer open={history} onClose={() => setHistory(false)} />

      <InstallChip />

      {/*
        * No card. On her own page Jenny is not a panel sitting on a studio
        * screen, she is the screen — so the conversation runs to the edges
        * and the only drawn thing left is the composer.
        */}
      <div className="jenny-body flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col overflow-hidden">
          <AssistantChat app />
        </div>
      </div>
    </div>
  );
}
