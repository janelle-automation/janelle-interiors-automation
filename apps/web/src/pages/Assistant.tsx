import { useEffect, useRef, useState } from 'react';
import { PageHeading, Card } from '../components/ui';
import {
  useAsk,
  useConfirmAction,
  type AssistantTurn,
  type ProposedAction,
} from '../lib/queries';
import {
  detectLang, listenOnce, speak, speechInputSupported, speechOutputSupported, stopSpeaking,
} from '../lib/speech';

/** Remembered so the microphone opens in the right language next time. */
const LANG_KEY = 'janelle.assistant.detected-lang';

interface Message extends AssistantTurn {
  proposed?: ProposedAction[];
  /** Proposals already committed, so the button does not offer twice. */
  done?: string[];
}

const SUGGESTIONS = [
  'What needs me today?',
  'How is the Harborview hotel going?',
  'What is overdue and who owns it?',
  'Who is carrying the most work right now?',
];

export default function Assistant() {
  const ask = useAsk();
  const confirm = useConfirmAction();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  // Learned, never chosen: seeded from the last conversation, then updated
  // from the language the assistant actually replies in.
  const [lang, setLang] = useState<string>(() => {
    try {
      return localStorage.getItem(LANG_KEY) ?? '';
    } catch {
      return '';
    }
  });

  function rememberLang(next: string | null) {
    if (!next || next === lang) return;
    setLang(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* storage may be blocked; detection still works for this session */
    }
  }
  const stopRef = useRef<(() => void) | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const canListen = speechInputSupported();
  const canSpeak = speechOutputSupported();

  // Block body on purpose: an effect that implicitly returns whatever its
  // last expression evaluates to is how "destroy is not a function" happens.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, ask.isPending]);

  // Stop the microphone and any speech if the page goes away mid-sentence.
  useEffect(() => {
    return () => {
      stopRef.current?.();
      stopSpeaking();
    };
  }, []);

  function send(text: string) {
    const message = text.trim();
    if (!message || ask.isPending) return;

    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');

    ask.mutate(
      { message, history },
      {
        onSuccess: (r) => {
          setMessages((prev) => [...prev, { role: 'assistant', content: r.reply, proposed: r.proposed, done: [] }]);
          // The assistant answers in the user's language, so its reply is the
          // cleanest signal of what that language is.
          const replyLang = detectLang(r.reply) ?? detectLang(message);
          rememberLang(replyLang);
          if (voiceReplies) speak(r.reply, replyLang ?? lang ?? undefined);
        },
        onError: (e) => {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Something went wrong: ${(e as Error).message}` }]);
        },
      },
    );
  }

  function toggleMic() {
    if (listening) {
      stopRef.current?.();
      return;
    }
    setMicError(null);
    setListening(true);
    stopRef.current = listenOnce(
      (text) => send(text),
      (msg) => setMicError(msg),
      () => setListening(false),
      lang || undefined,
    );
  }

  return (
    <>
      <PageHeading
        title="Assistant"
        sub="Ask where things stand, or say what you need done — in any language. Answers come from the studio's live data, and it will say so when it cannot check something."
        action={
          canSpeak ? (
            <button
              onClick={() => {
                stopSpeaking();
                setVoiceReplies((v) => !v);
              }}
              className="btn-secondary btn-sm"
            >
              {voiceReplies ? 'Spoken replies on' : 'Spoken replies off'}
            </button>
          ) : undefined
        }
      />

      <Card className="flex h-[calc(100vh-16rem)] min-h-[26rem] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {messages.length === 0 && (
            <div className="py-6">
              <p className="mb-4 text-center text-[13px] text-ink-faint">
                Ask anything about the studio's work.
              </p>
              <div className="mx-auto flex max-w-lg flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="focusable rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:bg-sunk"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-[14px] leading-relaxed ${
                  m.role === 'user' ? 'bg-brass/10 text-ink' : 'bg-sunk text-ink'
                }`}
              >
                <p className="whitespace-pre-line">{m.content}</p>

                {m.proposed && m.proposed.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-line-soft pt-3">
                    {m.proposed.map((p, j) => {
                      const key = `${i}-${j}`;
                      const committed = m.done?.includes(key);
                      return (
                        <div key={key} className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] text-ink-soft">{p.summary}</span>
                          {committed ? (
                            <span className="text-[12.5px] font-semibold text-good">Created</span>
                          ) : (
                            <button
                              className="btn-primary btn-sm"
                              disabled={confirm.isPending}
                              onClick={() =>
                                confirm.mutate(
                                  { input: p.input },
                                  {
                                    onSuccess: () =>
                                      setMessages((prev) =>
                                        prev.map((msg, idx) =>
                                          idx === i ? { ...msg, done: [...(msg.done ?? []), key] } : msg,
                                        ),
                                      ),
                                  },
                                )
                              }
                            >
                              Confirm
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}

          {ask.isPending && (
            <div className="flex justify-start">
              <div className="rounded-xl bg-sunk px-4 py-2.5 text-[13px] text-ink-faint">Checking…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {(micError || confirm.isError) && (
          <div className="border-t border-line-soft px-5 py-2 text-[12.5px] text-crit">
            {micError ?? (confirm.error as Error)?.message}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2 border-t border-line-soft px-5 py-3"
        >
          {canListen && (
            <button
              type="button"
              onClick={toggleMic}
              className={`btn-sm ${listening ? 'btn-primary' : 'btn-secondary'}`}
              title={listening ? 'Stop listening' : 'Speak instead of typing'}
            >
              {listening ? 'Listening…' : 'Speak'}
            </button>
          )}
          <input
            className="input flex-1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={listening ? 'Listening…' : 'Ask about a project, or say what you need done'}
            disabled={ask.isPending}
          />
          <button type="submit" className="btn-primary btn-sm" disabled={ask.isPending || !input.trim()}>
            Send
          </button>
        </form>
      </Card>

      <p className="mt-3 text-[12.5px] text-ink-faint">
        Write or speak in any language — it answers in the one you used.
        The assistant never creates or reassigns work on its own; anything it prepares waits for your confirmation.
        {!canListen && ' Voice input is not available in this browser.'}
      </p>
    </>
  );
}
