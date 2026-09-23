import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useConnectGoogle } from '../lib/queries';

const SEEN_KEY = 'janelle.connect.deferred';

/**
 * Asked once a day at most.
 *
 * Someone who has said "not now" has a reason — they are on a shared
 * machine, or it is not their mail to connect. A prompt that returns on
 * every page load is one people learn to dismiss without reading, and it
 * would be in the way of the work they signed in to do.
 */
function deferredToday(userId: string): boolean {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return false;
    const [who, day] = raw.split('|');
    return who === userId && day === new Date().toDateString();
  } catch {
    return false;
  }
}

function defer(userId: string) {
  try {
    localStorage.setItem(SEEN_KEY, `${userId}|${new Date().toDateString()}`);
  } catch {
    /* a private window refuses storage; it will simply ask again */
  }
}

function IconGoogle() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14Z" />
      <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1Z" />
    </svg>
  );
}

/**
 * The first thing someone sees after an invitation.
 *
 * A teammate who signs in without connecting their Google has an empty
 * system: no mail is read for them, so no tasks are raised from it and the
 * board they were invited to look at has nothing on it. Explaining that
 * afterwards is harder than asking here.
 *
 * It says plainly what happens to their mail, because the honest answer is
 * the persuasive one — only studio correspondence is read, and only they
 * can see it (migration 0018).
 */
export function ConnectGooglePrompt() {
  // Taken from AuthContext, not from a query of its own: `/me` has already
  // been awaited before the shell renders, so this is known on the first
  // paint. Fetching it here again is what made the prompt arrive late,
  // after the dashboard had drawn itself.
  const { user, googleConnected } = useAuth();
  const connect = useConnectGoogle();
  const [dismissed, setDismissed] = useState(false);

  const close = useCallback(() => {
    if (user) defer(user.id);
    setDismissed(true);
  }, [user]);

  // `null` means the answer has not arrived — never guess "not connected"
  // and flash the prompt at somebody who has already done this.
  const showing =
    Boolean(user) && googleConnected === false && !dismissed && !deferredToday(user!.id);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing, close]);

  if (!showing) return null;

  return (
    <div className="dock-aware fixed inset-0 z-50 grid place-items-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-heading"
        className="popover relative w-full max-w-md overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
      >
        <div className="px-6 pt-6">
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-sunk/60">
            <IconGoogle />
          </span>
          <h2 id="connect-heading" className="mt-4 text-[18px] font-semibold leading-snug text-ink">
            Connect your Gmail and Drive
          </h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">
            This is how the studio reads your project mail, files it against the right job, and raises
            the work it finds. Until it is connected, your board stays empty.
          </p>

          <ul className="mt-4 space-y-2 text-[13px] text-ink-soft">
            {[
              'Only mail involving the studio, its clients and its suppliers is read — nothing else is fetched.',
              'What is read stays yours. Nobody else in the studio can see your mailbox, principals included.',
              'Nothing is ever sent on your behalf. Replies are left as drafts for you to approve.',
            ].map((line) => (
              <li key={line} className="flex gap-2.5">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brass" aria-hidden="true" />
                <span className="leading-snug">{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-line-soft bg-sunk/40 px-6 py-3.5">
          <button type="button" onClick={close} className="btn-ghost btn-sm">
            Not now
          </button>
          <div className="flex items-center gap-2">
            <Link to="/settings" onClick={close} className="btn-secondary btn-sm">
              Later, in Settings
            </Link>
            <button
              type="button"
              disabled={connect.isPending}
              // `dashboard`: this is the first-run prompt, so Google comes
              // back to the board rather than to the Settings screen they
              // never asked for.
              onClick={() => connect.mutate({ service: 'all', next: 'dashboard' })}
              className="btn-primary btn-sm"
            >
              {connect.isPending ? 'Opening Google…' : 'Connect'}
            </button>
          </div>
        </div>

        {connect.isError && (
          <p className="border-t border-line-soft px-6 py-2.5 text-[12.5px] text-crit">
            {(connect.error as Error).message}
          </p>
        )}
      </div>
    </div>
  );
}
