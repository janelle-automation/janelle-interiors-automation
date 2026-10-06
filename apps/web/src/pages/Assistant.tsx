import { useLayoutEffect, useRef, useState } from 'react';
import { Page, Card } from '../components/ui';
import { AssistantChat } from '../components/AssistantChat';
import { AssistantHistory } from '../components/AssistantHistory';
import { AgentCards } from '../components/AgentPicker';
import { useSearchParams } from 'react-router-dom';
import { useAssistant } from '../context/AssistantContext';

/** Never shorter than this, however little room the window has. */
const MIN_CHAT_PX = 448;

/** The page's own bottom padding, left clear beneath the card. */
const BOTTOM_GAP_PX = 32;

/**
 * Stretch from wherever this lands to the bottom of the window.
 *
 * The height was `calc(100vh - 15rem)` — a guess at everything above it,
 * which went stale the moment the page heading changed size and left a band
 * of dead space under the conversation. Measuring is right whatever the
 * heading does, and stays right the next time it changes.
 *
 * It cannot feed back on itself: this element is the last block in its
 * column, so its own height can never move its top, and a measurement that
 * has not changed writes no state.
 */
function useFillsViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // Where it starts on the PAGE, not in the window. getBoundingClientRect
      // is window-relative, so once the page had scrolled even slightly the
      // top read smaller and the card grew by exactly the scroll distance;
      // that overflowed the window, kept the page scrolled, and left the
      // composer below the fold — and it stayed that way until a reload.
      // The two pixels of slack stop rounding from tipping the page into
      // overflow, whose scrollbar narrows the page and re-wraps the heading
      // above, which moves the top and starts the measuring over.
      const top = el.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(MIN_CHAT_PX, Math.floor(window.innerHeight - top - BOTTOM_GAP_PX - 2));
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next));
    };

    measure();
    window.addEventListener('resize', measure);
    // Anything above it changing height — a heading wrapping, a banner
    // appearing — moves where it starts, so the page itself is watched.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  return [ref, height] as const;
}

/** The conversation, filling what is left of the window. Past ones are on their own tab. */
function ChatTab() {
  const [fillRef, fillHeight] = useFillsViewport<HTMLDivElement>();
  return (
    <div ref={fillRef} style={fillHeight ? { height: fillHeight } : undefined}>
      <Card className="flex h-full min-h-0 flex-col overflow-hidden">
        <AssistantChat />
      </Card>
    </div>
  );
}

/**
 * Jenny with the whole screen to herself.
 *
 * The same conversation as the side panel — not a second one — for when an
 * answer is a long table, or a spoken conversation deserves the room. Past
 * conversations sit beside it, and what she can do is a click away.
 */
export default function Assistant() {
  const { conversations, agents, setAgents } = useAssistant();
  const [params, setParams] = useSearchParams();
  type Tab = 'chat' | 'conversations' | 'agents';
  const asked = params.get('tab');
  const tab: Tab = asked === 'agents' || asked === 'conversations' ? asked : 'chat';
  const chooseTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'chat') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <Page>

      <div role="tablist" aria-label="Jenny sections" className="mb-4 flex w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 pr-10 sm:w-auto sm:pr-1">
        {([['chat', 'Chat'], ['conversations', 'Conversations'], ['agents', 'Agents']] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => chooseTab(id)}
            className={`focusable flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-medium transition-colors ${
              tab === id ? 'bg-brass/15 text-ink shadow-card' : 'text-ink-soft hover:bg-sunk hover:text-ink'
            }`}
          >
            {label}
            {id === 'conversations' && conversations.length > 0 && (
              <span className="grid min-w-5 place-items-center rounded-full bg-sunk px-1.5 text-[11px] font-bold leading-5 text-ink-faint">
                {conversations.length}
              </span>
            )}
            {id === 'agents' && (
              <span
                className={`grid min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-bold leading-5 ${
                  agents.length ? 'bg-brass text-white' : 'bg-sunk text-ink-faint'
                }`}
                title={agents.length ? `${agents.length} agent(s) on` : 'No agent on'}
              >
                {agents.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'agents' && <AgentCards agents={agents} onChange={setAgents} />}
      {tab === 'chat' && <ChatTab />}
      {tab === 'conversations' && (
        <div className="mx-auto max-w-3xl" style={{ height: 'min(44rem, calc(100vh - 14rem))' }}>
          <Card className="flex h-full min-h-0 flex-col overflow-hidden">
              <AssistantHistory showAgents={false} onOpened={() => chooseTab('chat')} onNew={() => chooseTab('chat')} />
          </Card>
        </div>
      )}

    </Page>
  );
}
