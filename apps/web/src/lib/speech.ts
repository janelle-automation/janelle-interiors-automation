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

interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface RecognitionResult extends ArrayLike<RecognitionAlternative> {
  isFinal: boolean;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<RecognitionResult> }) => void) | null;
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

// ── Hearing it right ────────────────────────────────────────

/** One way the browser heard what was said. */
export interface Hearing {
  transcript: string;
  confidence: number;
}

export interface ListenOptions {
  /** The words so far, while the person is still talking. */
  onInterim?: (text: string) => void;
  /** Every way the finished sentence was heard, best guesses first. */
  onResult: (hearings: Hearing[]) => void;
  onError: (message: string) => void;
  onEnd: () => void;
  /**
   * Cut Jenny off to listen — true when the person pressed the microphone,
   * which means "stop talking, it's my turn". False in a hands-free
   * conversation, where listening waits for her to finish instead.
   */
  interrupt?: boolean;
  /** How long a pause means they have finished. Longer after a word no sentence ends on. */
  pauseMs?: number;
}

/**
 * Stop listening from outside. By default what was heard so far is delivered
 * — pressing the microphone again means "that's everything". `discard`
 * throws it away, for leaving hands-free or closing the panel.
 */
export type StopListening = (how?: { discard?: boolean }) => void;

/** Resolves once nothing is being spoken, plus a moment for the room to go quiet. */
function silence(maxWaitMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    if (!speechOutputSupported()) return resolve();
    const started = Date.now();
    const check = () => {
      const synth = window.speechSynthesis;
      if ((!synth.speaking && !synth.pending) || Date.now() - started > maxWaitMs) {
        // The speaker's last syllable is still in the air — and in the
        // microphone — for a beat after the engine says it has finished.
        setTimeout(resolve, 350);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

/** A pause this long means they have finished; a person thinking mid-sentence pauses less. */
const PAUSE_MS = 2_000;
/** Added when the last word leaves the sentence hanging: "can you give me the…". */
const HANGING_MS = 1_800;
/** Added while the browser has not settled on the last words yet. */
const UNSETTLED_MS = 1_000;
/** Nothing at all said for this long is silence. */
const NO_SPEECH_MS = 8_000;

/** Words a sentence does not end on: a pause after one is a breath, not the end. */
const HANGING = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'with', 'about', 'from', 'in', 'on', 'at', 'by', 'into', 'as',
  'and', 'or', 'but', 'so', 'if', 'because', 'than', 'then', 'also',
  'me', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'some', 'any',
  'is', 'are', 'was', 'were', 'be', 'can', 'could', 'would', 'will', 'should', 'do', 'does', 'did', 'have', 'has',
  'please', 'give', 'show', 'tell', 'find', 'send', 'get', 'make', 'add', 'create', 'put', 'move', 'assign',
  'what', 'which', 'who', 'where', 'when', 'how', 'why', 'um', 'uh', 'er', 'like',
]);

/** One stretch of speech as the browser heard it, copied out of its live objects. */
interface Heard {
  isFinal: boolean;
  alternatives: RecognitionAlternative[];
}

const plainWords = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Every way the whole of what was said was heard.
 *
 * Listening now runs across pauses, so one question can arrive as several
 * stretches. The first hearing joins each stretch's best guess, the second
 * each stretch's second guess, and so on — the alternatives a name needs
 * survive the join. A stretch repeated inside the next one (some phones
 * report the sentence so far, again, each time) is counted once.
 */
export function hearingsOf(stretches: Heard[]): Hearing[] {
  const kept = stretches.filter((s, i) => {
    const said = plainWords(s.alternatives[0]?.transcript ?? '');
    if (!said) return false;
    const next = stretches[i + 1];
    const then = next ? plainWords(next.alternatives[0]?.transcript ?? '') : '';
    return !(then.length > said.length && then.startsWith(said));
  });
  if (!kept.length) return [];
  const most = Math.min(5, Math.max(...kept.map((s) => s.alternatives.length)));
  const hearings: Hearing[] = [];
  for (let i = 0; i < most; i++) {
    const picks = kept.map((s) => s.alternatives[Math.min(i, s.alternatives.length - 1)]);
    const transcript = picks.map((p) => p.transcript).join(' ').replace(/\s+/g, ' ').trim();
    if (!transcript || hearings.some((h) => h.transcript === transcript)) continue;
    hearings.push({
      transcript,
      confidence: picks.reduce((sum, p) => sum + (Number(p.confidence) || 0), 0) / picks.length,
    });
  }
  return hearings;
}

/** How long to wait, after the latest words, before taking them as finished. */
export function pauseFor(stretches: Heard[], pauseMs = PAUSE_MS): number {
  const words = plainWords(stretches.map((s) => s.alternatives[0]?.transcript ?? '').join(' ')).split(' ');
  const last = words[words.length - 1] ?? '';
  const settled = stretches.every((s) => s.isFinal);
  return pauseMs + (HANGING.has(last) ? HANGING_MS : 0) + (settled ? 0 : UNSETTLED_MS);
}

/**
 * Listen for one thing said, keeping every way it was heard.
 *
 * The browser used to decide when the person had finished, and it decides at
 * the first breath: "hey can you give me the" went to Jenny while the rest of
 * the sentence was still being said. Now the browser listens continuously and
 * the sentence ends here — after a real pause, longer when the last word
 * leaves the sentence hanging, and never while the browser is still revising
 * the last words.
 *
 * The browser is asked for up to five hearings, because its first guess at an
 * unusual name is often wrong while its third is right — the caller picks
 * with the studio's own vocabulary (bestHearing). And it never listens while
 * Jenny is talking: the microphone hears the speaker as well as the person,
 * and her own words used to come back to her as the next question.
 */
export function listen(opts: ListenOptions): StopListening {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    opts.onError('This browser cannot listen. Type instead.');
    opts.onEnd();
    return () => {};
  }

  let cancelled = false;
  let rec: SpeechRecognitionLike | null = null;
  let finished = false;
  let ended = false;
  let heard: Heard[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    opts.onEnd();
  };

  const finish = (deliver: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (deliver) {
      const hearings = hearingsOf(heard);
      if (hearings.length) opts.onResult(hearings);
    }
    try {
      if (deliver) rec?.stop();
      else rec?.abort();
    } catch {
      /* already stopped */
    }
  };

  if (opts.interrupt) stopSpeaking();

  void silence().then(() => {
    if (cancelled) {
      end();
      return;
    }
    const r = new Ctor();
    rec = r;
    r.lang = LANG;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 5;

    r.onresult = (e) => {
      if (finished) return;
      heard = Array.from({ length: e.results.length }, (_, i) => {
        const result = e.results[i];
        return {
          isFinal: result.isFinal,
          alternatives: Array.from({ length: result.length }, (_, j) => ({
            transcript: result[j].transcript,
            confidence: result[j].confidence,
          })),
        };
      });
      const soFar = heard.map((s) => s.alternatives[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim();
      if (!soFar) return;
      opts.onInterim?.(soFar);
      // Wait for the end of what is being said, not the first breath in it.
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), pauseFor(heard, opts.pauseMs));
    };
    r.onerror = (e) => {
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') {
        // Silence after something was said is only the end of it.
        if (heard.length) return;
        finished = true;
        clearTimeout(timer);
        opts.onError('I did not catch that.');
        return;
      }
      finished = true;
      clearTimeout(timer);
      opts.onError(e.error === 'not-allowed' ? 'Microphone access was blocked.' : `Microphone error: ${e.error}`);
    };
    // The browser can stop on its own — a long silence, a dropped connection.
    // Whatever was heard by then is still what was said.
    r.onend = () => {
      finish(true);
      end();
    };
    try {
      r.start();
      timer = setTimeout(() => {
        if (heard.length || finished) return;
        opts.onError('I did not catch that.');
        finish(false);
      }, NO_SPEECH_MS);
    } catch {
      finished = true;
      opts.onError('Could not start listening.');
      end();
    }
  });

  return (how = {}) => {
    cancelled = true;
    if (rec) finish(!how.discard);
  };
}

/** Lower-case words, for comparing what was said with what was heard. */
const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Words too common to tell one name from another. */
const COMMON = new Set([
  'the', 'and', 'for', 'with', 'from', 'residence', 'house', 'home', 'hotel', 'group', 'suite', 'project',
  'studio', 'design', 'designs', 'interiors', 'company', 'inc', 'llc', 'primary', 'main', 'new',
]);

/**
 * The hearings, best first, judged by the names the studio actually uses.
 *
 * A recogniser's confidence knows English, not this studio: it is sure of
 * "Danish" and unsure of "Denish". So a hearing that contains a real name —
 * a person, a project, a client, a vendor — is preferred over one that does
 * not, and confidence breaks the tie.
 */
export function bestHearing(hearings: Hearing[], vocabulary: string[]): Hearing[] {
  const known = new Set(
    vocabulary.flatMap((name) => wordsOf(name)).filter((w) => w.length >= 3 && !COMMON.has(w)),
  );
  const score = (h: Hearing) => {
    const names = wordsOf(h.transcript).filter((w) => known.has(w)).length;
    return names * 0.35 + (h.confidence || 0);
  };
  return hearings
    .map((h, i) => ({ h, i, s: score(h) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h);
}

/** What Jenny said last, and when she stopped — to recognise it coming back. */
let lastSaid: { text: string; endedAt: number | null } = { text: '', endedAt: 0 };

/**
 * Whether something heard is Jenny's own voice picked up by the microphone.
 *
 * Most of its words were in what she just said, and she said it within the
 * last few seconds. A real reply shares a few words with the question at
 * most; an echo shares nearly all of them.
 */
export function soundsLikeEcho(heard: string): boolean {
  if (!lastSaid.text) return false;
  const since = lastSaid.endedAt === null ? 0 : Date.now() - lastSaid.endedAt;
  if (since > 10_000) return false;
  const said = new Set(wordsOf(lastSaid.text));
  const words = wordsOf(heard);
  if (words.length < 3) return false;
  return words.filter((w) => said.has(w)).length / words.length >= 0.7;
}

// ── What gets said ──────────────────────────────────────────

/** Zero-width joiner and emoji presentation selector: the glue of composed emoji. */
const JOINERS = new RegExp(`[${String.fromCharCode(0x200d, 0xfe0f)}]`, 'g');

/**
 * Text as a person would say it.
 *
 * Speech engines read symbols out: "PO dash 1042", "Brianna slash Amanda",
 * "open bracket", "asterisk asterisk Done". The model is asked to write its
 * spoken answer in plain words, but not everything spoken comes from there —
 * a briefing, an error, "Listen" on an older message — and a request is not
 * a guarantee. So everything passes through this on the way to the speaker.
 *
 * What stays: letters, numbers, ordinary sentence punctuation, apostrophes
 * inside words (O'Neill, don't) and money ($12,400), which every engine
 * already reads well. Everything else becomes a pause or goes.
 */
export function speakable(text: string): string {
  let s = text
    // Addresses and links are unsayable; the screen still has them.
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    // Emoji and the joiners that build them.
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(JOINERS, '');

  // Line by line first, so a bullet or a heading marker is known by where it sits.
  s = s
    .split(/\r?\n+/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•·>]|#{1,6}|\d+[.)])\s+/, '')
        .trim(),
    )
    .filter(Boolean)
    // A line break is a full stop — unless the line already ended on one.
    .reduce((said, line) => (said ? `${said}${/[.!?:;,]$/.test(said) ? ' ' : '. '}${line}` : line), '');

  s = s
    // Markdown emphasis and code.
    .replace(/\*\*|__|`+/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](?=\s|$|[.,!?])/g, '$1')
    // Separators that stand for a pause.
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s*[·•|]\s*/g, ', ')
    // PO-1042, follow-up: joined words and codes are said with a space.
    .replace(/([\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, '$1 ')
    // Brianna / Amanda — letters either side. Dates like 9/18 are left alone.
    .replace(/(\p{L})\s*\/\s*(?=\p{L})/gu, '$1 or ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/#(?=\d)/g, 'number ')
    // Quotation marks, and apostrophes that are not inside a word — O'Neill
    // and don't keep theirs.
    .replace(/[“”„‟"«»]/g, '')
    .replace(/(?<!\p{L})[‘’']|[‘’'](?!\p{L})/gu, '')
    .replace(/’/g, "'")
    // Brackets become the pauses they were.
    .replace(/\s*[([{]\s*/g, ', ')
    .replace(/\s*[)\]}]\s*/g, ', ')
    // Arrows and the rest of the symbol drawer.
    .replace(/…|\.{3,}/g, '.')
    .replace(/[→←↑↓⇒⇐↗↘✓✔✗✘*_~^=<>\\]/g, ' ')
    .replace(/\$(?!\d)/g, ' ');

  // Tidy the pauses that all of that left behind.
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/([.!?;:]),/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/([.!?])(\s*\.)+/g, '$1')
    .replace(/^[\s,.;:]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
}

// ── Jenny's voice ───────────────────────────────────────────

/**
 * Jenny is a woman, and she should sound like one.
 *
 * Browsers expose whatever voices the operating system has and say nothing
 * about who they sound like; the first English one on Windows is usually
 * "Microsoft David". So voices are chosen by name. These are the women's
 * voices shipped by Windows and Edge (including Microsoft's own neural
 * "Jenny"), Chrome, macOS/iOS and Android.
 */
const FEMALE_VOICE =
  /\b(jenny|aria|ava|emma|michelle|jane|nancy|sara|zira|hazel|susan|libby|sonia|natasha|clara|samantha|allison|victoria|karen|moira|tessa|serena|kate|fiona|veena|nicky|joanna|salli|kimberly|kendra|ivy|female|google us english)\b/i;

/** Named men's voices — never chosen, whatever else they have going for them. */
const MALE_VOICE =
  /\b(david|mark|guy|davis|tony|jason|christopher|eric|roger|steffan|brian|andrew|ryan|george|thomas|william|alex|daniel|fred|tom|aaron|arthur|oliver|rishi|gordon|male)\b/i;

/** The newer neural voices sound like a person rather than a telephone menu. */
const NATURAL_VOICE = /natural|neural|online|enhanced|premium/i;

function voiceScore(v: SpeechSynthesisVoice): number {
  if (!v.lang.toLowerCase().startsWith('en')) return -1;
  if (MALE_VOICE.test(v.name)) return -1;
  let score = v.lang === 'en-US' ? 3 : 1;
  if (FEMALE_VOICE.test(v.name)) score += 10;
  if (NATURAL_VOICE.test(v.name)) score += 4;
  // Chrome's own voices are far more natural than the old Windows desktop
  // ones sitting beside them in the same list.
  if (/^google\b/i.test(v.name)) score += 2;
  if (/\bdesktop\b/i.test(v.name)) score -= 1;
  // Her namesake, where the system has it.
  if (/\bjenny\b/i.test(v.name)) score += 3;
  return score;
}

/**
 * The voices, once the browser has them.
 *
 * Chrome answers `getVoices()` with an empty list until `voiceschanged` has
 * fired, so asking once at speaking time gave Jenny's first sentence of the
 * session the system default voice. Waited for here, briefly — a browser
 * that never fires the event still speaks, just without the choice.
 */
let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = window.speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  voicesReady ??= new Promise((resolve) => {
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
  return voicesReady;
}

/** The best woman's voice available, or the best voice not known to be a man's. */
function jennyVoice(voices: SpeechSynthesisVoice[]): { voice: SpeechSynthesisVoice | null; female: boolean } {
  const ranked = voices
    .map((v) => ({ v, score: voiceScore(v) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.v ?? null;
  return { voice: best, female: Boolean(best && FEMALE_VOICE.test(best.name)) };
}

// Start fetching the voice list the moment the app loads, so it is ready
// before the first thing she says.
if (speechOutputSupported()) void loadVoices();

/**
 * The utterance being spoken, held on purpose.
 *
 * Chrome garbage-collects an utterance nothing references, and when it does
 * its `onend` never fires — which in a hands-free conversation means the
 * assistant stops listening for the reply, silently, forever.
 */
let current: SpeechSynthesisUtterance | null = null;
let endTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bumped by every speak and every stop. Choosing a voice can wait on the
 * browser; if she has been interrupted in the meantime, the sentence that
 * was waiting must not start talking over whatever happened next.
 */
let generation = 0;

/**
 * Speak a reply aloud, and say when it has finished.
 *
 * `onEnd` fires exactly once — when the speech ends, when it errors, when it
 * is cancelled, or when a generous timer runs out, because `onend` is the
 * least reliable event in the Web Speech API and a conversation that waits
 * on it must not wait forever. Where speech is unsupported it fires at once.
 */
export function speak(text: string, onEnd?: () => void): void {
  let finished = false;
  const words = speakable(text ?? '');
  const finish = () => {
    if (finished) return;
    finished = true;
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    if (lastSaid.text === words && lastSaid.endedAt === null) lastSaid.endedAt = Date.now();
    onEnd?.();
  };

  if (!speechOutputSupported() || !words) {
    finish();
    return;
  }

  stopSpeaking();
  const mine = ++generation;

  void loadVoices()
    .then((voices) => {
      if (mine !== generation) return; // interrupted while the voices loaded
      const u = new SpeechSynthesisUtterance(words);
      const { voice, female } = jennyVoice(voices);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else {
        u.lang = LANG;
      }
      // Unhurried and warm. Where no woman's voice exists on this machine, a
      // slightly raised pitch is the nearest thing — never on a voice that
      // already is one, where it only sounds artificial.
      u.rate = 1;
      u.pitch = female ? 1 : 1.15;
      u.onend = finish;
      u.onerror = finish;
      current = u;
      lastSaid = { text: words, endedAt: null };
      // About eleven characters a second, plus room to start.
      endTimer = setTimeout(finish, 4000 + (words.length / 11) * 1000);
      window.speechSynthesis.speak(u);
    })
    .catch(() => {
      /* speech is a nicety; never let it break the page */
      finish();
    });
}

export function stopSpeaking(): void {
  if (!speechOutputSupported()) return;
  generation++;
  try {
    // Detached first: cancelling fires `onend` on the old utterance, and a
    // deliberate stop must not read to a hands-free loop as "finished
    // speaking, start listening".
    if (current) {
      current.onend = null;
      current.onerror = null;
    }
    current = null;
    if (endTimer) clearTimeout(endTimer);
    endTimer = null;
    if (lastSaid.endedAt === null) lastSaid.endedAt = Date.now();
    window.speechSynthesis.cancel();
  } catch {
    /* no-op */
  }
}
