import { useEffect, useState, type SVGProps } from 'react';
import { ASSISTANT_NAME } from '@janelle/shared';
import { PageHeading, Card } from '../components/ui';
import { AssistantChat } from '../components/AssistantChat';
import { AssistantGuide } from '../components/AssistantGuide';
import { AssistantHistory } from '../components/AssistantHistory';
import { IconTalk, SHORTCUT_LABEL } from '../components/AssistantPanel';
import { useAssistant } from '../context/AssistantContext';

type IconProps = SVGProps<SVGSVGElement>;
const stroke = {
  width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};
const IconList = (p: IconProps) => <svg {...stroke} {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>;
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

/**
 * Jenny with the whole screen to herself.
 *
 * The same conversation as the side panel — not a second one — for when an
 * answer is a long table, or a spoken conversation deserves the room. Past
 * conversations sit beside it, and what she can do is a click away.
 */
export default function Assistant() {
  const { handsFree, setHandsFree, canListen, canSpeak, speakReplies, setSpeakReplies, conversations } = useAssistant();
  const [guide, setGuide] = useState(false);
  const [history, setHistory] = useState(false);

  return (
    <>
      <PageHeading
        title={ASSISTANT_NAME}
        sub={`Your assistant for the studio's work — projects, tasks, orders, email and files. She briefs you each day, follows you around the app (${SHORTCUT_LABEL} from anywhere), reads the files you attach, and says so when she cannot check something.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setHistory(true)} className="btn-secondary btn-sm lg:hidden">
              <IconList />
              Conversations{conversations.length ? ` (${conversations.length})` : ''}
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
        }
      />

      <div className="grid gap-4 lg:grid-cols-[17.5rem_minmax(0,1fr)] 2xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Card className="hidden h-[calc(100vh-15rem)] min-h-[28rem] flex-col overflow-hidden lg:flex">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[13.5px] font-semibold text-ink">Conversations</h2>
            <p className="text-[11.5px] text-ink-faint">Kept in this browser</p>
          </div>
          <AssistantHistory />
        </Card>

        <Card className="flex h-[calc(100vh-15rem)] min-h-[28rem] flex-col overflow-hidden">
          <AssistantChat />
        </Card>
      </div>

      <p className="mt-3 text-[12.5px] text-ink-faint">
        {ASSISTANT_NAME} never sends email or changes records on her own — anything she prepares waits for you to confirm.
        {!canListen && ' Voice is not available in this browser; Chrome, Edge and Safari support it.'}
      </p>

      {history && (
        <Sheet side="left" title="Conversations" onClose={() => setHistory(false)}>
          <AssistantHistory onOpened={() => setHistory(false)} onNew={() => setHistory(false)} />
        </Sheet>
      )}
      {guide && (
        <Sheet side="right" title={`What ${ASSISTANT_NAME} can do`} onClose={() => setGuide(false)}>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <AssistantGuide onDone={() => setGuide(false)} />
          </div>
        </Sheet>
      )}
    </>
  );
}
