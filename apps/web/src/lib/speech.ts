/**
 * Thin wrappers over the browser speech APIs. Both are optional: the
 * assistant must work as plain text everywhere, with voice as a bonus
 * where the browser supports it.
 *
 * Support is uneven — Chrome and Safari expose webkitSpeechRecognition,
 * Firefox does not, and iOS support has historically been partial. Always
 * check `speechInputSupported()` before offering the microphone.
 */

/**
 * The studio works in English, so both the microphone and the spoken
 * replies are pinned to it. The Web Speech API needs a language before it
 * starts listening and cannot auto-detect, so a fixed value is also the
 * most reliable one.
 */
const LANG = 'en-US';

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export function speechOutputSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Listen once and resolve with the transcript. Returns a cancel function
 * so a component can stop listening on unmount.
 */
export function listenOnce(
  onResult: (text: string) => void,
  onError: (message: string) => void,
  onEnd: () => void,
): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onError('This browser cannot listen. Type instead.');
    onEnd();
    return () => {};
  }

  const rec = new Ctor();
  rec.lang = LANG;
  rec.continuous = false;
  rec.interimResults = false;

  rec.onresult = (e) => {
    const text = Array.from({ length: e.results.length }, (_, i) => e.results[i][0].transcript).join(' ').trim();
    if (text) onResult(text);
  };
  rec.onerror = (e) => {
    // "no-speech" and "aborted" are ordinary, not failures worth shouting about.
    if (e.error === 'no-speech') onError('I did not catch that.');
    else if (e.error === 'not-allowed') onError('Microphone access was blocked.');
    else if (e.error !== 'aborted') onError(`Microphone error: ${e.error}`);
  };
  rec.onend = onEnd;

  try {
    rec.start();
  } catch {
    onError('Could not start listening.');
    onEnd();
  }
  return () => {
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };
}

/** Speak a reply aloud. Silently does nothing where unsupported. */
export function speak(text: string): void {
  if (!speechOutputSupported() || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.lang = LANG;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith('en'));
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  } catch {
    /* speech is a nicety; never let it break the page */
  }
}

export function stopSpeaking(): void {
  if (!speechOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* no-op */
  }
}
