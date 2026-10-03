import { useEffect, useLayoutEffect, useRef, useState, type SVGProps } from 'react';
import { ASSISTANT_NAME } from '@janelle/shared';
import { Page, PageHeading, Card } from '../components/ui';
import { AssistantChat } from '../components/AssistantChat';
import { AssistantGuide } from '../components/AssistantGuide';
import { AssistantHistory } from '../components/AssistantHistory';
import { IconTalk } from '../components/AssistantPanel';
import { AgentCards } from '../components/AgentPicker';
import { IconPlus } from '../components/icons';
import { useSearchParams } from 'react-router-dom';
import { useAssistant } from '../context/AssistantContext';

type IconProps = SVGProps<SVGSVGElement>;

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
const stroke = {
  width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconSpark = (p: IconProps) => (
  <svg {...stroke} {...p}><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" /><path d="M19 17v4M17 19h4" /></svg>
);
const IconClose = (p: IconProps) => <svg {...stroke} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>;

/** A sheet over the page, closed by Escape, the backdrop or its button. */
function Sheet({ side, title, onClose, children }: { side: 'left' | 'right'; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50" />
      <div
        className={`absolute inset-y-0 ${side === 'left' ? 'left-0 border-r' : 'right-0 border-l'} flex w-full max-w-[26rem] flex-col border-line bg-surface shadow-pop ${
          side === 'right' ? 'sm:max-w-[40rem]' : ''
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focusable grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-sunk hover:text-ink">
            <IconClose width={18} height={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
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
  const { handsFree, setHandsFree, canListen, canSpeak, speakReplies, setSpeakReplies, conversations, agents, setAgents, newConversation, messages } = useAssistant();
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
  const [guide, setGuide] = useState(false);

  return (
    <Page>
      <PageHeading
        title={ASSISTANT_NAME}
        action={
          tab === 'chat' ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={newConversation}
              disabled={messages.length === 0}
              title={messages.length === 0 ? 'This conversation has not started yet' : 'Start a new conversation'}
              className="btn-primary btn-sm"
            >
              <IconPlus width={15} height={15} />
              New conversation
            </button>
            <button type="button" onClick={() => setGuide(true)} className="btn-secondary btn-sm">
              <IconSpark />
              What {ASSISTANT_NAME} can do
            </button>
            {canSpeak && !handsFree && (
              <button
                type="button"
                onClick={() => setSpeakReplies(!speakReplies)}
                aria-pressed={speakReplies}
                className="btn-secondary btn-sm"
              >
                {speakReplies ? 'Reading answers aloud' : 'Read answers aloud'}
              </button>
            )}
            {canListen && (
              <button
                type="button"
                onClick={() => setHandsFree(!handsFree)}
                aria-pressed={handsFree}
                className={handsFree ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              >
                <IconTalk width={15} height={15} />
                {handsFree ? 'End conversation' : 'Talk hands-free'}
              </button>
            )}
          </div>
          ) : undefined
        }
      />

      <div role="tablist" aria-label="Jenny sections" className="mb-4 inline-flex gap-1 rounded-xl border border-line bg-surface p-1">
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

      {/* Only when it explains something the person can see is missing: the
          microphone button is absent in a browser that cannot listen, and
          without a word that reads as the app being broken. */}
      {tab === 'chat' && !canListen && (
        <p className="mt-3 text-[12.5px] text-ink-faint">
          Voice is not available in this browser; Chrome, Edge and Safari support it.
        </p>
      )}

      {guide && (
        <Sheet side="right" title={`What ${ASSISTANT_NAME} can do`} onClose={() => setGuide(false)}>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <AssistantGuide onDone={() => setGuide(false)} />
          </div>
        </Sheet>
      )}
    </Page>
  );
}
