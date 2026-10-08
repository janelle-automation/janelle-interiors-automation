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
  onstart: (() => void) | null;
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

/** Android and iOS: one microphone, and a platform speech stack of its own. */
function isHandheld(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Whether this device lets only one thing hold the microphone at a time.
 *
 * A desktop browser is happy to let the level meter's `getUserMedia` stream
 * and the recogniser share it. Android Chrome is not: with a stream already
 * open the recogniser is handed audio but returns no transcript at all —
 * you speak, the meter draws your voice perfectly, and nothing is ever
 * heard. So on a phone the meter is opened only far enough to settle the
 * permission and then released, and the one microphone goes to the
 * recogniser, which is the part that cannot be done without.
 */
function micIsExclusive(): boolean {
  return isHandheld();
}

/**
 * Whether `continuous` can be relied on to hold a session open.
 *
 * Android's speech provider does not implement continuous recognition, and
 * Chrome ends a session on its own regardless of the flag — after a stretch
 * of silence, and periodically even mid-sentence. Asked for a continuous
 * session on a phone it can return nothing at all, rather than the one
 * utterance it would otherwise have heard.
 *
 * Turned off, the recogniser itself decides when a sentence has ended and
 * `onend` delivers what it heard. Nothing else has to change: the
 * hands-free loop already listens again from there, which is the restart
 * the platform needs either way.
 */
function continuousIsReliable(): boolean {
  return !isHandheld();
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
  /**
   * The microphone is live and words will now be caught.
   *
   * Fired from the recogniser's own `onstart`, never guessed at. Everything
   * before it — waiting out her voice, the permission grant, and on a
   * Bluetooth headset the 1–8s switch from A2DP to the SCO link — is time
   * in which the screen used to say "Listening" and nothing was being
   * recorded. A caller that shows a different state until this arrives is
   * telling the truth about when to start talking.
   */
  onStart?: () => void;
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
  /** What the microphone is hearing, so the screen can show it. */
  onLevel?: (level: MicLevel) => void;
}

/**
 * Stop listening from outside. By default what was heard so far is delivered
 * — pressing the microphone again means "that's everything". `discard`
 * throws it away, for leaving hands-free or closing the panel.
 */
export type StopListening = (how?: { discard?: boolean }) => void;

/**
 * Resolves once nothing is being spoken, plus a moment for the room to go
 * quiet.
 *
 * The cap is deliberately short. Chrome can leave `speaking` — and
 * `pending` — true after `cancel()`, a flag that then never clears on its
 * own, and every path into listening cancels first: entering hands-free
 * calls `stopSpeaking()` before it calls this. Polling a stuck flag for
 * twenty seconds meant pressing Talk put "Listening" on screen and then did
 * nothing whatsoever — no microphone, no error, no way to tell it had hung.
 * Past the cap the microphone opens regardless; if she somehow were still
 * talking, `soundsLikeEcho` already drops her own words out of what comes
 * back, which is the same protection this wait was reaching for.
 */
function silence(maxWaitMs = 1_200): Promise<void> {
  return new Promise((resolve) => {
    if (!speechOutputSupported()) return resolve();
    /*
     * Nothing is being said, so there is no last syllable to wait out.
     *
     * The 350ms below is for the tail of HER voice still crossing the room.
     * It was paid on every start, including pressing the microphone button
     * in a silent room, where it bought nothing and cost the first word.
     */
    const idle = window.speechSynthesis;
    if (!idle.speaking && !idle.pending) return resolve();
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
/**
 * The same, where the microphone may not exist yet when the recogniser
 * starts.
 *
 * A Bluetooth headset plays through A2DP, which cannot capture and render
 * at once, so asking for a microphone makes the device drop it and bring up
 * the SCO link instead — 1–2 seconds on a Pixel, 5–8 on some others. At
 * eight seconds the backstop could fire before the microphone had
 * connected at all: "I did not catch that", about a sentence the hardware
 * was not yet able to hear.
 */
const NO_SPEECH_HANDHELD_MS = 20_000;
/** Longest we hold the recogniser back waiting on a microphone grant. */
const MIC_GRANT_MS = 10_000;

/**
 * The ways "nothing was transcribed" is reported.
 *
 * All three mean the same thing to a caller — try again — and differ only in
 * what they tell the person to do about it. A hands-free loop has to be able
 * to tell them apart from a real fault like a blocked microphone, and it used
 * to do that by comparing against one of these strings, which quietly stopped
 * working the moment there was more than one of them.
 */
export const UNHEARD = {
  silence: 'I did not catch that.',
  faint: 'You are coming through very faintly — move closer to the microphone or speak up.',
  unclear: 'I heard you but could not make out the words. Try again a little slower.',
} as const;

const UNHEARD_MESSAGES: string[] = Object.values(UNHEARD);

/** Whether an error means "say that again", rather than a fault worth stopping for. */
export function isUnheard(message: string): boolean {
  return UNHEARD_MESSAGES.includes(message);
}

/** Words a sentence does not end on: a pause after one is a breath, not the end. */
const HANGING = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'with', 'about', 'from', 'in', 'on', 'at', 'by', 'into', 'as',
  'and', 'or', 'but', 'so', 'if', 'because', 'than', 'then', 'also',
  'me', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'that', 'these', 'those', 'some', 'any',
  'is', 'are', 'was', 'were', 'be', 'can', 'could', 'would', 'will', 'should', 'do', 'does', 'did', 'have', 'has',
  'please', 'give', 'show', 'tell', 'find', 'send', 'get', 'make', 'add', 'create', 'put', 'move', 'assign',
  'what', 'which', 'who', 'where', 'when', 'how', 'why', 'um', 'uh', 'er', 'like',
]);

// ── How loud the room actually is ───────────────────────────

/**
 * What the microphone is picking up, as the person is talking.
 *
 * The Web Speech API says nothing about volume: it reports words, or it
 * reports `no-speech`, and a quiet talker gets the second one with no hint
 * why. Meanwhile the orb pulsed away as though it were hearing them. So the
 * microphone is opened separately, purely to measure — the recogniser keeps
 * its own stream, and this one only ever looks at the level.
 */
export interface MicLevel {
  /** 0..1, for something on screen to move with the voice. Per frame. */
  level: number;
  /**
   * Loud enough for the recogniser to work with.
   *
   * Unlike `level`, a judgement about the last second or so rather than
   * about this frame — it holds through the gaps between words instead of
   * dropping out on every one of them. Anything shown to a person belongs
   * on this and not on the raw level.
   */
  speaking: boolean;
  /** Sound has been arriving too quietly to transcribe, and keeps being. */
  faint: boolean;
}

/** Speech sits around -35..-15 dBFS; a quiet room floor is below -55. */
const FAINT_DB = -52;
const CLEAR_DB = -38;
/**
 * How far back across a threshold the level must fall before the state it
 * opened is allowed to close.
 *
 * A voice is not a tone. Within one sentence the level crosses any single
 * line many times a second — between syllables, on the tail of a word, in
 * the gap before a plosive. Read frame by frame against one threshold,
 * `speaking` and `faint` therefore flickered at something like 10Hz, and
 * the sentence under the orb rewrote itself just as fast: "go ahead",
 * "hearing you", "I can barely hear you", and back. Every flip was also
 * announced, because that line is an `aria-live` region.
 */
const RELEASE_DB = 6;
/** Syllable gaps and the pause between words: ridden over, not reported. */
const HANGOVER_MS = 700;
/**
 * How long the level must hold above the clear line before it counts as a
 * voice. A door, a cough or a keyboard clears it for a frame or two; a
 * vowel holds it far longer. Without this, one click in an otherwise too
 * quiet room cancels the "move closer" hint for most of a second — and
 * sets `sawSpeech`, so the recogniser then blames the words rather than
 * the distance.
 */
const CLEAR_ATTACK_MS = 80;
/** Quiet speech must keep being quiet this long before anyone is told so. */
const FAINT_AFTER_MS = 1_200;
/** And once told, told for long enough to read. */
const FAINT_HOLD_MS = 2_500;
/**
 * The orb follows the voice frame by frame; React does not need to. The
 * level is a number on a CSS transform with an 80ms transition over it, so
 * 20Hz looks identical and costs a third of the renders — this used to set
 * state in the assistant's context on every animation frame, re-rendering
 * the whole panel 60 times a second.
 */
const LEVEL_EMIT_MS = 50;
/** Below this, a new level is not a visible move. */
const LEVEL_STEP = 0.02;

/**
 * Whether the microphone has already been granted for this origin.
 *
 * Only ever used to decide whether a permission PROMPT is still possible.
 * Firefox and Safari do not answer for 'microphone' — they throw, or report
 * nothing useful — and the honest answer there is "cannot tell", which
 * takes the careful path. Never used to decide whether to ask: that is
 * getUserMedia's own job, and it is allowed to say no.
 */
async function micAlreadyGranted(): Promise<boolean> {
  try {
    const perms = navigator.permissions as
      | { query?: (d: { name: string }) => Promise<{ state: string }> }
      | undefined;
    if (!perms?.query) return false;
    const status = await perms.query({ name: 'microphone' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * Open the microphone with the browser's own cleanup turned on.
 *
 * `autoGainControl` is the one that matters here — it lifts a quiet voice
 * toward a usable level before anything tries to read words out of it.
 * Chrome applies the processing per device, so holding this stream open
 * while the recogniser runs improves what the recogniser gets too. That
 * last part is undocumented browser behaviour rather than a guarantee,
 * which is why the meter is worth having on its own: if it turns out not to
 * help, the person can at least SEE that they are too quiet.
 */
export async function openMicMeter(onLevel: (l: MicLevel) => void): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return () => {};
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let raf = 0;
  let stopped = false;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        noiseSuppression: true,
        echoCancellation: true,
      },
    });
  } catch {
    // Blocked or unavailable: the recogniser will report that itself.
    return () => {};
  }
  if (stopped) {
    stream.getTracks().forEach((t) => t.stop());
    return () => {};
  }

  try {
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error('no AudioContext');
    ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Long enough to ride over the gaps between syllables, short enough to
    // still look like it is responding to a voice.
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);

    // What the room has been doing, rather than what this frame caught.
    let speaking = false;
    let faint = false;
    let clearUntil = 0;
    let clearSince = 0;
    let audibleUntil = 0;
    let faintSince = 0;
    let faintUntil = 0;
    let emittedAt = 0;
    let emittedLevel = -1;
    let emitted: MicLevel | null = null;

    const tick = () => {
      if (stopped) return;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const v of buffer) sum += v * v;
      const rms = Math.sqrt(sum / buffer.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const now = performance.now();

      // Rise as soon as the level has held above the line for longer than a
      // click. Fall only once the voice has stayed down past both the
      // release margin and the gap between words.
      if (db >= CLEAR_DB) {
        if (!clearSince) clearSince = now;
        if (speaking || now - clearSince >= CLEAR_ATTACK_MS) {
          speaking = true;
          clearUntil = now + HANGOVER_MS;
        }
      } else {
        clearSince = 0;
        if (speaking && db < CLEAR_DB - RELEASE_DB && now > clearUntil) speaking = false;
      }

      if (db >= FAINT_DB) audibleUntil = now + HANGOVER_MS;

      if (speaking) {
        // Audible now: whatever they were doing before, the advice is stale.
        faint = false;
        faintSince = 0;
        faintUntil = 0;
      } else if (now <= audibleUntil) {
        // Sound is arriving and not getting there. Worth saying — but only
        // once it has been true for longer than a quiet syllable.
        if (!faintSince) faintSince = now;
        if (!faint && now - faintSince >= FAINT_AFTER_MS) {
          faint = true;
          faintUntil = now + FAINT_HOLD_MS;
        }
      } else if (now > faintUntil) {
        // Silence. Nothing to advise about: that is the other hint's job.
        faint = false;
        faintSince = 0;
      }

      // -60 dB is the bottom of the meter, -10 the top.
      const level = Math.max(0, Math.min(1, (db + 60) / 50));
      const flipped = !emitted || emitted.speaking !== speaking || emitted.faint !== faint;
      if (flipped || (now - emittedAt >= LEVEL_EMIT_MS && Math.abs(level - emittedLevel) >= LEVEL_STEP)) {
        emittedAt = now;
        emittedLevel = level;
        emitted = { level, speaking, faint };
        onLevel(emitted);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    /* metering is a nicety; never let it stop the microphone working */
  }

  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => {});
  };
}

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
  let closeMic: (() => void) | null = null;

  // What the room sounded like while we were listening, so silence can be
  // told apart from a voice the recogniser could not make out.
  let sawSpeech = false;
  let sawFaint = false;

  const end = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    closeMic?.();
    closeMic = null;
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

  /**
   * Why nothing was transcribed, in terms of what the room sounded like.
   *
   * "I did not catch that" was said to three different people with three
   * different problems: one whose microphone was muted, one sitting too far
   * from it, and one who simply had not spoken yet. Only the third was
   * being told anything true, and the first two had nothing to act on.
   */
  const unheardReason = () => {
    if (sawSpeech) return UNHEARD.unclear;
    if (sawFaint) return UNHEARD.faint;
    return UNHEARD.silence;
  };

  if (opts.interrupt) stopSpeaking();

  void silence().then(async () => {
    if (cancelled) {
      end();
      return;
    }
    /*
     * Opened — and waited for — before the recogniser, for two reasons.
     *
     * The browser must have applied its gain and noise handling to the
     * device by the time words start arriving. And neither this nor the
     * recogniser holds microphone permission the first time an installed
     * app runs: a tab inherits the grant the site already had, a freshly
     * installed app has a permission scope of its own and starts with
     * nothing. Firing both in the same tick then puts two requests up at
     * once and the second is dismissed unanswered, which reads on screen as
     * Talk simply doing nothing. Waiting means the grant is in hand before
     * the recogniser asks for it.
     *
     * `openMicMeter` resolves even when it was refused, so a blocked or
     * missing meter still falls through to the recogniser, which reports
     * the problem in its own words.
     */
    /*
     * On a handheld the meter is not opened at all.
     *
     * Its readings were already being thrown away there — one microphone,
     * and the recogniser is the part that cannot do without it — so what
     * remained was the cost of taking it and handing it back. Over
     * Bluetooth that cost is not free: every open and close drags the
     * device between A2DP and the SCO link that carries a microphone, and
     * that switch runs 1–2 seconds on a Pixel and 5–8 on some others.
     * Opening the meter and closing it again spent that twice before the
     * recogniser had asked for anything, and it then had to wait for a
     * third switch to finish before it could hear a word.
     *
     * Leaving the recogniser as the only thing that wants the microphone
     * also leaves one permission request rather than two, which is what
     * waiting here was for in the first place.
     */
    if (!micIsExclusive()) {
      const meter = openMicMeter((l) => {
        if (l.speaking) sawSpeech = true;
        else if (l.faint) sawFaint = true;
        opts.onLevel?.(l);
      });

      /*
       * Waited for ONLY while the grant is still in question.
       *
       * Everything above is about the first run, when two requests in the
       * same tick put up two prompts and the second is dismissed unanswered.
       * Once the grant exists there is no prompt to collide with — and
       * waiting anyway put a whole getUserMedia round trip between pressing
       * the button and the recogniser starting, on top of the wait in
       * `silence`. The screen said "Listening" throughout, so anyone who
       * pressed and spoke straight away lost their opening words to a
       * microphone that was not running yet.
       *
       * The meter still opens, just alongside rather than in front. What is
       * given up is the chance that the browser has finished applying gain
       * to the device before the first syllable — which the comment above
       * flags as undocumented behaviour rather than a guarantee. A certain
       * loss of the first words is the worse of the two.
       */
      if (await micAlreadyGranted()) {
        void meter.then((c) => { if (ended || finished) c(); else closeMic = c; });
      } else {
        // Never indefinitely: a prompt nobody answers leaves getUserMedia
        // pending for good, and the recogniser still deserves its own chance
        // to ask rather than the whole thing hanging in silence.
        const close = await Promise.race([
          meter,
          new Promise<null>((r) => { setTimeout(() => r(null), MIC_GRANT_MS); }),
        ]);
        if (close) closeMic = close;
        else void meter.then((c) => { if (ended || finished) c(); else closeMic = c; });
      }
    }
    if (cancelled || ended || finished) {
      closeMic?.();
      closeMic = null;
      end();
      return;
    }

    const r = new Ctor();
    rec = r;
    r.lang = LANG;
    r.continuous = continuousIsReliable();
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
    r.onstart = () => {
      if (!finished && !ended) opts.onStart?.();
    };

    r.onerror = (e) => {
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') {
        // Silence after something was said is only the end of it.
        if (heard.length) return;
        finished = true;
        clearTimeout(timer);
        opts.onError(unheardReason());
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
        opts.onError(unheardReason());
        finish(false);
      }, isHandheld() ? NO_SPEECH_HANDHELD_MS : NO_SPEECH_MS);
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
 * Ordinary English that a studio name must never be allowed to overwrite.
 *
 * The correction below rewrites what it believes is a mangled name. Left
 * unguarded it would also rewrite real words that happen to sound like one,
 * and a wrong "correction" is worse than the mishearing: the mishearing is
 * visibly wrong, whereas a confident substitution reads as what was said.
 */
const EVERYDAY = new Set([
  ...HANGING,
  'all', 'any', 'are', 'ask', 'back', 'been', 'both', 'call', 'car', 'come', 'cost', 'date', 'day',
  'days', 'due', 'each', 'email', 'end', 'few', 'file', 'first', 'from', 'go', 'good', 'got', 'here',
  'job', 'just', 'know', 'last', 'late', 'left', 'let', 'list', 'look', 'lot', 'made', 'many', 'more',
  'most', 'much', 'must', 'need', 'new', 'next', 'no', 'not', 'now', 'off', 'old', 'one', 'only',
  'open', 'order', 'other', 'out', 'over', 'own', 'part', 'past', 'pay', 'quote', 'read', 'ready',
  'right', 'same', 'say', 'see', 'sent', 'set', 'still', 'stop', 'sure', 'take', 'task', 'tasks',
  'team', 'than', 'thanks', 'there', 'they', 'thing', 'time', 'today', 'told', 'too', 'top', 'try',
  'two', 'up', 'us', 'use', 'very', 'want', 'was', 'way', 'we', 'week', 'well', 'went', 'were',
  'work', 'yes', 'yet', 'you',
]);

/**
 * Roughly what a word sounds like, with the detail a recogniser loses.
 *
 * Not a real phonetic algorithm — a deliberately coarse one. Vowels go
 * (after the first letter, which a recogniser rarely gets wrong), spellings
 * that sound alike collapse together, and doubles fold. "Bernthal" and
 * "Burn Thal" land on the same key; so do "Pollick" and "Pollock".
 */
function soundKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return '';
  s = s
    .replace(/^(?:kn|gn|pn|wr)/, 'n')
    .replace(/ph/g, 'f')
    .replace(/sch/g, 'sk')
    .replace(/(?:sh|ch)/g, 'x')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/(?:ck|cq|c|q|k)/g, 'k')
    .replace(/gh/g, '')
    .replace(/z/g, 's')
    .replace(/v/g, 'f')
    .replace(/[hwy]/g, '');
  if (!s) return '';
  const key = s[0] + s.slice(1).replace(/[aeiou]/g, '');
  return key.replace(/(.)\1+/g, '$1');
}

/** Whether two sound keys are the same, or one letter apart on a long key. */
function keysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // A single slip is only forgiven on a key long enough for it to mean
  // something; on short keys almost everything is one letter from everything.
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++slips > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
}

/** The studio's names, indexed by what they sound like. Built once per vocabulary. */
function soundIndex(vocabulary: string[]): Map<string, string> {
  const index = new Map<string, string>();
  const add = (key: string, proper: string) => {
    if (!key || key.length < 4) return;
    // First writer wins, so a one-word name is not shadowed by a longer one
    // that happens to collide with it.
    if (!index.has(key)) index.set(key, proper);
  };
  for (const name of vocabulary) {
    // The original spelling, so "ZAK+FOX" comes back punctuated as it is on file.
    const parts = name.split(/\s+/).filter(Boolean);
    const plain = parts.map((p) => p.replace(/[^\p{L}\p{N}']/gu, ''));
    for (let i = 0; i < parts.length; i++) {
      const word = plain[i];
      if (word.length >= 4 && !COMMON.has(word.toLowerCase())) add(soundKey(word), parts[i]);
      // Pairs and triples: a recogniser splits one name into two words as
      // often as it mangles the letters — "Topa" becomes "toe pa".
      if (i + 1 < parts.length) add(soundKey(plain[i] + plain[i + 1]), `${parts[i]} ${parts[i + 1]}`);
      if (i + 2 < parts.length) {
        add(soundKey(plain[i] + plain[i + 1] + plain[i + 2]), `${parts[i]} ${parts[i + 1]} ${parts[i + 2]}`);
      }
    }
  }
  return index;
}

/**
 * Put the studio's own names back into what was heard.
 *
 * The recogniser knows English and this studio is not written in it: OVIS,
 * Ojai, Topa, Bernthal, Ditchfield, Pollick, Schumacher. Ranking whole
 * alternatives cannot help when all five of them mangle the same name, so
 * the words themselves are repaired — the longest window first, because
 * "Ojai Valley Inn" should be recognised as one name rather than three.
 *
 * Conservative on purpose. A window is only replaced when it sounds like a
 * real name AND is not ordinary English, so "the car is late" survives
 * intact even in a studio with a client called Carr.
 */
export function correctNames(text: string, vocabulary: string[]): { text: string; fixed: number } {
  if (!text.trim() || !vocabulary.length) return { text, fixed: 0 };
  const index = soundIndex(vocabulary);
  if (!index.size) return { text, fixed: 0 };

  // Kept with their separators, so punctuation and spacing come back out.
  const tokens = text.match(/[\p{L}\p{N}']+|[^\p{L}\p{N}']+/gu) ?? [];
  const isWord = (t: string) => /[\p{L}\p{N}]/u.test(t);
  const wordAt: number[] = [];
  tokens.forEach((t, i) => {
    if (isWord(t)) wordAt.push(i);
  });

  let fixed = 0;
  const out = [...tokens];
  const done = new Set<number>();

  for (let w = 0; w < wordAt.length; w++) {
    if (done.has(w)) continue;
    for (let span = Math.min(3, wordAt.length - w); span >= 1; span--) {
      const idx = wordAt.slice(w, w + span);
      if (idx.some((_, k) => done.has(w + k))) continue;
      const words = idx.map((i) => tokens[i]);
      const joined = words.join('');
      // Ordinary English is left alone. A multi-word window is safe when any
      // ONE of its words is unusual; a single word has to be unusual itself.
      if (words.every((x) => EVERYDAY.has(x.toLowerCase()))) continue;
      if (span === 1 && (EVERYDAY.has(words[0].toLowerCase()) || words[0].length < 4)) continue;

      const key = soundKey(joined);
      if (key.length < 4) continue;
      let proper = index.get(key);
      if (!proper) {
        for (const [k, v] of index) {
          if (keysMatch(k, key)) {
            proper = v;
            break;
          }
        }
      }
      if (!proper) continue;
      // Already right — nothing to say.
      if (proper.toLowerCase() === words.join(' ').toLowerCase()) break;

      out[idx[0]] = proper;
      for (let k = 1; k < idx.length; k++) out[idx[k]] = '';
      // The separators inside the window go with the words they joined.
      for (let i = idx[0] + 1; i < idx[idx.length - 1]; i++) if (!isWord(tokens[i])) out[i] = '';
      for (let k = 0; k < span; k++) done.add(w + k);
      fixed++;
      break;
    }
  }

  return { text: out.join('').replace(/\s+/g, ' ').trim(), fixed };
}

/**
 * The hearings, best first, with the studio's names put back into them.
 *
 * A recogniser's confidence knows English, not this studio: it is sure of
 * "Danish" and unsure of "Denish". So a hearing that contains a real name —
 * a person, a project, a client, a vendor — is preferred over one that does
 * not, and confidence breaks the tie.
 *
 * Ranking now happens on the CORRECTED text, which is what makes the two
 * halves work together: an alternative whose only fault was spelling a name
 * the way it sounded is repaired first, and then wins on having the name in
 * it, instead of losing to a worse hearing that got one word right.
 */
export function bestHearing(hearings: Hearing[], vocabulary: string[]): Hearing[] {
  const known = new Set(
    vocabulary.flatMap((name) => wordsOf(name)).filter((w) => w.length >= 3 && !COMMON.has(w)),
  );
  const repaired = hearings.map((h) => {
    const { text, fixed } = correctNames(h.transcript, vocabulary);
    return { hearing: { transcript: text, confidence: h.confidence }, fixed };
  });
  const score = ({ hearing, fixed }: (typeof repaired)[number]) => {
    const names = wordsOf(hearing.transcript).filter((w) => known.has(w)).length;
    // A hearing that had to be repaired is very slightly behind one that was
    // already right, so an alternative that named the job correctly first
    // time still wins its tie.
    return names * 0.35 + (hearing.confidence || 0) - fixed * 0.01;
  };
  return repaired
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r.hearing);
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
  /*
   * Her voice is only in the air for a moment after the engine stops, and
   * `listen()` already waits for that moment to pass before it opens the
   * microphone. Ten seconds was never about audio still playing — it was a
   * content filter left switched on while the person was talking, and it
   * threw their words away. Past this window there is nothing left to echo,
   * so whatever arrives is theirs.
   */
  const since = lastSaid.endedAt === null ? 0 : Date.now() - lastSaid.endedAt;
  if (since > 2_500) return false;

  /*
   * Judged on word PAIRS, not on a bag of single words.
   *
   * Counting single words sounded reasonable until she read a briefing out
   * loud: nineteen tasks put several hundred words into the comparison, and
   * after that almost any sentence about the studio was seventy per cent
   * "words she just said". Asking "what is late on the Lemon Residence"
   * scored as an echo and was thrown away — silently, with the microphone
   * listening again as though nothing had been said. Which is exactly what
   * it looked like from the other side.
   *
   * An echo reproduces her phrasing, so it repeats her pairs. A question of
   * your own about the same project borrows her words but not the order she
   * put them in.
   */
  const pairs = (words: string[]) => words.slice(1).map((w, i) => `${words[i]} ${w}`);
  const heardPairs = pairs(wordsOf(heard));
  // Shorter than this and a repeated pair is a coincidence, not an echo.
  if (heardPairs.length < 3) return false;

  /*
   * Set high on purpose. Repeating a task back to her — "schedule a call
   * with Carissa today" — borrows most of a line she just read, and at a
   * looser bar that question was discarded as her own voice. Only a near
   * copy counts, because the cost of the two mistakes is not symmetric:
   * passing an echo through gives one odd answer, while dropping real words
   * gives no answer and no reason, which is what this was doing.
   */
  const saidPairs = new Set(pairs(wordsOf(lastSaid.text)));
  return heardPairs.filter((p) => saidPairs.has(p)).length / heardPairs.length >= 0.85;
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
