import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '../components/ui';
import { IconMonitor, IconChevronLeft } from '../components/icons';
import { AssistantChat } from '../components/AssistantChat';
import { BrandLogo } from '../components/BrandLogo';
import { useAuth } from '../context/AuthContext';

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

/* ── Minimal top bar ─────────────────────────────────────────── */
function TopBar({
  onInstall,
  showTip,
  setShowTip,
  installed,
  installPrompt,
}: {
  onInstall: () => void;
  showTip: boolean;
  setShowTip: (v: boolean) => void;
  installed: boolean;
}) {
  const { user } = useAuth();
  const initial = (user?.name ?? '?').slice(0, 1).toUpperCase();

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <Link
        to="/"
        className="focusable flex items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunk hover:text-ink"
        title="Back to studio"
      >
        <IconChevronLeft width={16} height={16} />
        <span className="hidden sm:inline">Studio</span>
      </Link>

      <span className="h-4 w-px bg-line" aria-hidden="true" />

      <div className="flex items-center gap-2">
        <BrandLogo variant="mark" className="w-7 shrink-0 text-ink-soft" />
        <span className="text-[14px] font-semibold text-ink">Jenny</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {!installed && (
          <div className="relative">
            <button
              type="button"
              onClick={onInstall}
              className="btn-secondary btn-sm"
              title="Add to Home Screen"
            >
              <IconMonitor width={14} height={14} />
              <span className="hidden sm:inline">
                {isIOS || isAndroid ? 'Add to Home Screen' : 'Pin to desktop'}
              </span>
            </button>

            {showTip && (
              <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-line bg-surface p-4 shadow-xl text-[12.5px] text-ink-soft leading-relaxed">
                <p className="font-semibold text-ink mb-2">Add to Home Screen</p>
                {isIOS ? (
                  <ol className="list-decimal list-inside space-y-1.5">
                    <li>Tap the <span className="font-medium text-ink">Share</span> <span className="text-[11px]">(&#x2191;)</span> button in Safari</li>
                    <li>Scroll and tap <span className="font-medium text-ink">Add to Home Screen</span></li>
                    <li>Tap <span className="font-medium text-ink">Add</span></li>
                  </ol>
                ) : isAndroid ? (
                  <ol className="list-decimal list-inside space-y-1.5">
                    <li>Tap the <span className="font-medium text-ink">&#8942; menu</span> in Chrome</li>
                    <li>Tap <span className="font-medium text-ink">Add to Home screen</span></li>
                    <li>Tap <span className="font-medium text-ink">Add</span></li>
                  </ol>
                ) : (
                  <ol className="list-decimal list-inside space-y-1.5">
                    <li>Click the <span className="font-medium text-ink">&#8942; menu</span> in Chrome</li>
                    <li>Click <span className="font-medium text-ink">Save and share</span></li>
                    <li>Click <span className="font-medium text-ink">Install page as app</span></li>
                  </ol>
                )}
                <button
                  type="button"
                  onClick={() => setShowTip(false)}
                  className="mt-3 text-brass-deep font-medium hover:underline"
                >
                  Got it
                </button>
              </div>
            )}
          </div>
        )}

        <div
          className="grid h-8 w-8 place-items-center rounded-full bg-brass text-[13px] font-bold text-white"
          title={user?.name ?? ''}
        >
          {initial}
        </div>
      </div>
    </header>
  );
}

/* ── Page ────────────────────────────────────────────────────── */
export default function AuditChat() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [chatHeight, setChatHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = wrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(320, Math.floor(window.innerHeight - top - 16));
      setChatHeight((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); };
  }, []);

  /* PWA install */
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone);
  const [showTip, setShowTip] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallPrompt(e as BeforeInstallPromptEvent); };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === 'accepted') setInstalled(true);
      setInstallPrompt(null);
    } else {
      setShowTip((v) => !v);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      <TopBar
        onInstall={handleInstall}
        showTip={showTip}
        setShowTip={setShowTip}
        installed={installed}
      />

      <div
        ref={wrapRef}
        className="flex-1 px-4 pb-4 pt-3 sm:px-6 sm:pb-6"
        style={chatHeight ? { height: chatHeight } : undefined}
      >
        <Card className="mx-auto flex h-full min-h-0 max-w-3xl flex-col overflow-hidden">
          <AssistantChat />
        </Card>
      </div>
    </div>
  );
}
