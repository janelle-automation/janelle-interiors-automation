import { useCallback, useEffect, useState } from 'react';
import { IconPeople, IconPerson } from './icons';

/**
 * Whose work a screen is showing.
 *
 * The studio's data is shared on purpose — PM support's job is chasing other
 * people's overdue and unassigned tasks, and a principal has to be able to
 * see the whole board. But most of the time a person opening the app wants
 * their own work, and the boards opened on everybody's.
 *
 * So the default is "mine" and the whole studio is one click away, rather
 * than the data being cut in half at the database. Mail is the exception:
 * that really is private, and row security enforces it (migration 0018) —
 * this switch never decides who may see what, only what is shown first.
 */
export type Scope = 'mine' | 'all';

const KEY = 'janelle.scope';

function read(): Scope {
  try {
    return localStorage.getItem(KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
}

/**
 * Shared by every screen that has the switch, so moving between Tasks and
 * Follow-ups does not silently change whose work is on screen. Each hook
 * subscribes to the same event rather than to storage, which does not fire
 * in the tab that wrote it.
 */
const CHANGED = 'janelle:scope';

export function useScope(): [Scope, (next: Scope) => void] {
  const [scope, setScope] = useState<Scope>(read);

  useEffect(() => {
    const onChange = () => setScope(read());
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, []);

  const set = useCallback((next: Scope) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // A private window refuses storage; the choice just will not stick.
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return [scope, set];
}

/**
 * The switch itself: one person, or two.
 *
 * The icon carries the meaning and the count stays as a number, because the
 * count is the part you cannot infer — "Mine 0" beside "Everyone 15" is the
 * whole reason to press it. Each side keeps a title and an aria-label, so
 * the words are a hover and a screen reader away rather than gone.
 */
export function ScopeToggle({ mine, all }: { mine?: number; all?: number }) {
  const [scope, setScope] = useScope();
  const options: { key: Scope; label: string; n?: number; Icon: typeof IconPerson }[] = [
    { key: 'mine', label: 'Only my work', n: mine, Icon: IconPerson },
    { key: 'all', label: "Everyone's work", n: all, Icon: IconPeople },
  ];

  return (
    <div className="inline-flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Whose work to show">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => setScope(o.key)}
          aria-pressed={scope === o.key}
          aria-label={o.label}
          title={o.label}
          className={`focusable flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-semibold transition-colors ${
            scope === o.key ? 'bg-brass text-white' : 'text-ink-soft hover:text-ink'
          }`}
        >
          <o.Icon width={15} height={15} />
          {o.n !== undefined && <span className="tabular-nums">{o.n}</span>}
        </button>
      ))}
    </div>
  );
}
