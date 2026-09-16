import { useEffect, useMemo, useRef, useState, type SVGProps } from 'react';
import { useAssistant, type ConversationSummary } from '../context/AssistantContext';

/**
 * Past conversations: find one, go back to it, and keep the list tidy —
 * rename, pin, download, delete.
 *
 * Kept in this browser, per person, like the conversation itself was.
 */

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconPlus = (p: IconProps) => <svg {...stroke} {...p}><path d="M12 5v14M5 12h14" /></svg>;
const IconSearch = (p: IconProps) => <svg {...stroke} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
const IconDots = (p: IconProps) => <svg {...stroke} {...p}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
const IconPin = (p: IconProps) => <svg {...stroke} {...p}><path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3Z" /></svg>;

/** Which heading a conversation sits under, by when it was last used. */
function groupOf(at: number): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(new Date());
  const then = day(new Date(at));
  const days = Math.round((today - then) / 86400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return new Date(at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const whenOf = (at: number) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

function Row({ c, active, onOpened }: { c: ConversationSummary; active: boolean; onOpened?: () => void }) {
  const { openConversation, renameConversation, pinConversation, deleteConversation, downloadConversation } = useAssistant();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(c.title);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (renaming) {
    return (
      <form
        className="px-1.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          renameConversation(c.id, title);
          setRenaming(false);
        }}
      >
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            renameConversation(c.id, title);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setTitle(c.title);
              setRenaming(false);
            }
          }}
          aria-label="Conversation name"
          className="input w-full py-1.5 text-[13px]"
          maxLength={80}
        />
      </form>
    );
  }

  if (confirming) {
    return (
      <div className="rounded-lg border border-crit/30 bg-crit/5 px-2.5 py-2 text-[12.5px]" role="alertdialog" aria-label="Delete conversation">
        <p className="text-ink">
          Delete “<span className="font-medium">{c.title}</span>”? Files attached in it are deleted too.
        </p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" onClick={() => deleteConversation(c.id)} className="btn-sm rounded-lg bg-crit px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90">
            Delete
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="btn-secondary btn-sm">
            Keep
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={menuRef}
      className={`group relative flex items-center rounded-lg transition-colors ${active ? 'bg-brass/10' : 'hover:bg-sunk'}`}
    >
      <button
        type="button"
        onClick={() => {
          openConversation(c.id);
          onOpened?.();
        }}
        aria-current={active ? 'true' : undefined}
        className="focusable min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-1.5">
          {c.pinned && <IconPin width={12} height={12} className="shrink-0 text-brass-deep" aria-label="Pinned" />}
          <span className={`truncate text-[13px] ${active ? 'font-semibold text-ink' : 'font-medium text-ink'}`} title={c.title}>
            {c.title}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <span className="shrink-0">{whenOf(c.updatedAt)}</span>
          {c.preview && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{c.preview}</span>
            </>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => setMenu((v) => !v)}
        aria-label={`More for ${c.title}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        className={`focusable mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-surface hover:text-ink ${
          menu || active ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover:opacity-100'
        }`}
      >
        <IconDots />
      </button>
      {menu && (
        <div role="menu" className="absolute right-1 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop">
          {[
            { label: 'Rename', run: () => setRenaming(true) },
            { label: c.pinned ? 'Unpin' : 'Pin to top', run: () => pinConversation(c.id, !c.pinned) },
            { label: 'Download', run: () => downloadConversation(c.id) },
            { label: 'Delete', run: () => setConfirming(true), danger: true },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                item.run();
              }}
              className={`block w-full px-3 py-1.5 text-left text-[13px] hover:bg-sunk ${item.danger ? 'text-crit' : 'text-ink'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AssistantHistory({ onOpened, onNew }: { onOpened?: () => void; onNew?: () => void }) {
  const { conversations, activeConversationId, newConversation, messages } = useAssistant();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = needle
      ? conversations.filter((c) => c.title.toLowerCase().includes(needle) || c.preview.toLowerCase().includes(needle))
      : conversations;
    const out: { label: string; rows: ConversationSummary[] }[] = [];
    for (const c of shown) {
      const label = c.pinned ? 'Pinned' : groupOf(c.updatedAt);
      const group = out.find((g) => g.label === label);
      if (group) group.rows.push(c);
      else out.push({ label, rows: [c] });
    }
    return out;
  }, [conversations, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <button
          type="button"
          onClick={() => {
            newConversation();
            onNew?.();
          }}
          disabled={messages.length === 0}
          className="btn-primary btn-sm w-full justify-center"
        >
          <IconPlus width={15} height={15} />
          New conversation
        </button>
        <label className="relative block">
          <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" width={14} height={14} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="input w-full py-1.5 pl-8 text-[13px]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[12.5px] text-ink-faint">
            {query ? 'No conversation matches that.' : 'Your conversations will be kept here.'}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{g.label}</div>
              <div className="space-y-0.5">
                {g.rows.map((c) => (
                  <Row key={c.id} c={c} active={c.id === activeConversationId} onOpened={onOpened} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
