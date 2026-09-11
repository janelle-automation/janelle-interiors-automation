/**
 * Thin wrappers over the browser speech APIs. Both are optional: the
 * assistant must work as plain text everywhere, with voice as a bonus
 * where the browser supports it.
 *
 * Support is uneven — Chrome and Safari expose webkitSpeechRecognition,
 * Firefox does not, and iOS support has historically been partial. Always
 * check `speechInputSupported()` before offering the microphone.
 */

// ── Language detection ──────────────────────────────────────
// The Web Speech API cannot auto-detect: it needs a language BEFORE it
// starts listening. So we infer it from what has already been said. The
// assistant always answers in the user's own language, which makes its
// reply the most reliable signal available — better than the raw ASR
// transcript, which may be garbled if the previous guess was wrong.

/** Writing systems that identify a language on sight. */
const SCRIPTS: { re: RegExp; lang: string }[] = [
  { re: /[ऀ-ॿ]/, lang: 'hi-IN' }, // Devanagari
  { re: /[ঀ-৿]/, lang: 'bn-IN' },
  { re: /[઀-૿]/, lang: 'gu-IN' },
  { re: /[஀-௿]/, lang: 'ta-IN' },
  { re: /[ఀ-౿]/, lang: 'te-IN' },
  { re: /[؀-ۿ]/, lang: 'ar-SA' },
  { re: /[֐-׿]/, lang: 'he-IL' },
  { re: /[Ѐ-ӿ]/, lang: 'ru-RU' },
  { re: /[Ͱ-Ͽ]/, lang: 'el-GR' },
  { re: /[฀-๿]/, lang: 'th-TH' },
  { re: /[가-힯]/, lang: 'ko-KR' },
  // Kana before Han: Japanese uses Han characters too, so checking kana
  // first stops Japanese being misread as Chinese.
  { re: /[぀-ヿ]/, lang: 'ja-JP' },
  { re: /[一-鿿]/, lang: 'zh-CN' },
];

/** Function words that separate the common Latin-script languages. */
const LATIN_MARKERS: { lang: string; words: string[] }[] = [
  { lang: 'pt-BR', words: ['não', 'você', 'são', 'está', 'uma', 'com', 'para', 'mais', 'correio'] },
  { lang: 'es-ES', words: ['qué', 'está', 'correos', 'han', 'para', 'con', 'una', 'pero', 'hay', 'esta'] },
  { lang: 'fr-FR', words: ['les', 'des', 'est', 'une', 'pour', 'avec', 'dans', 'pas', 'sur', 'sont'] },
  { lang: 'de-DE', words: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'eine', 'sind'] },
  { lang: 'it-IT', words: ['che', 'non', 'per', 'con', 'una', 'sono', 'del', 'della', 'più'] },
  { lang: 'en-US', words: ['the', 'and', 'is', 'of', 'to', 'for', 'with', 'you', 'that', 'are'] },
];

/**
 * Best-effort language of a piece of text, as a BCP-47 tag. Returns null
 * when there is nothing to go on. Non-Latin scripts are decided on sight;
 * Latin-script languages are scored on function words, which is rough but
 * good enough to pick a speech voice — a wrong guess is cosmetic, not
 * destructive.
 */
export function detectLang(text: string): string | null {
  if (!text || text.trim().length < 2) return null;

  for (const { re, lang } of SCRIPTS) {
    if (re.test(text)) return lang;
  }

  const words = text.toLowerCase().match(/[\p{L}’']+/gu) ?? [];
  if (words.length === 0) return null;
  const seen = new Set(words);

  let best: { lang: string; score: number } | null = null;
  for (const { lang, words: markers } of LATIN_MARKERS) {
    const score = markers.reduce((n, w) => n + (seen.has(w) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { lang, score };
  }
  // One shared word ("con", "para") is not evidence; require a real signal
  // on short input rather than guessing wrong and breaking the microphone.
  if (!best || (best.score < 2 && words.length > 4)) return null;
  return best.lang;
}

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
  lang?: string,
): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onError('This browser cannot listen. Type instead.');
    onEnd();
    return () => {};
  }

  const rec = new Ctor();
  // Follow the chosen language, falling back to the browser's own. Hard-coding
  // en-US here made the microphone deaf to every other language.
  rec.lang = lang || navigator.language || 'en-US';
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

/**
 * Speak a reply aloud, in the given language where a matching voice exists.
 * Silently does nothing where unsupported.
 */
export function speak(text: string, lang?: string): void {
  if (!speechOutputSupported() || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    const want = lang || navigator.language;
    if (want) {
      u.lang = want;
      // Prefer an exact voice, then any voice for the same base language
      // ("es" matching "es-MX"), so a Spanish reply is not read by an
      // English voice.
      const base = want.split('-')[0].toLowerCase();
      const voices = window.speechSynthesis.getVoices();
      const voice =
        voices.find((v) => v.lang.toLowerCase() === want.toLowerCase()) ??
        voices.find((v) => v.lang.toLowerCase().startsWith(base));
      if (voice) u.voice = voice;
    }
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
