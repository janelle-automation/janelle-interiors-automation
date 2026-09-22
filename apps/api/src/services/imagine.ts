import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canWith,
  videoCostUsd,
  type PermissionOverrides,
  type UserRole,
} from '@janelle/shared';
import { UPLOAD_GRANT_TTL_MS, sealFileGrant } from '../lib/fileTokens.js';
import { storeUpload, type UploadType } from '../lib/uploads.js';
import { RenderTimeout, clampSeconds, generateImage, grokModels, isGrokReady, startVideo } from './grok.js';
import { isImageReady, renderImage, type ImageReference } from './images.js';
import { createJob, jobsTableReady } from './mediaJobs.js';

/**
 * Making a picture or a clip, in one place.
 *
 * Two callers need exactly this and must not drift apart: Jenny's
 * `make_image` / `make_video` tools, and the Create buttons in the chat
 * composer. The buttons exist because the tools are expensive in a way
 * that has nothing to do with the picture — reaching them costs a whole
 * assistant turn, which is the system prompt, the studio snapshot and the
 * entire tool block sent to Claude just to decide that the person who
 * pressed "Image" wants an image.
 *
 * So the direct path spends NO model tokens at all. The provider is called
 * with the brief as written, and what comes back is shaped into an answer
 * here rather than by a model. Same permissions, same caps, same storage,
 * same spend row — only the deciding is skipped, because the person
 * already decided.
 */

export interface ImagineActor {
  /** The caller's own client, so row-level security still decides what is seen. */
  db: SupabaseClient;
  orgId: string;
  userId: string;
  role: UserRole | null;
  permissions?: PermissionOverrides | null;
}

export type Made<T> =
  | { ok: true; value: T }
  /** `timedOut`: the provider was slow, not unwilling — the same brief is worth another go. */
  | { ok: false; reason: string; timedOut?: boolean };

/**
 * What the studio may spend on video in one day.
 *
 * The one guard that holds whatever anyone — or any model — asks for,
 * because it is counted from what has actually been billed rather than
 * from what was requested.
 */
export const MEDIA_DAILY_USD_CAP = Number(process.env.MEDIA_DAILY_USD_CAP || 5);

/** Whether a role may make pictures at all. Renders are studio work. */
export function mayImagine(actor: ImagineActor): boolean {
  return canWith(actor.permissions, actor.role, 'prompts', 'update');
}

/**
 * What video has cost this studio since midnight.
 *
 * Read from the same activity_log rows the usage report uses. Never
 * throws: a budget that cannot be read must not take the feature down —
 * it reports zero, and the per-clip cap still holds.
 */
export async function videoSpentToday(db: SupabaseClient): Promise<number> {
  try {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { data } = await db
      .from('activity_log')
      .select('meta')
      .eq('action', 'ai.usage')
      .gte('created_at', since.toISOString())
      .limit(500);
    return ((data ?? []) as { meta: { feature?: string; cost_usd?: number } | null }[])
      .filter((row) => row.meta?.feature === 'video.render')
      .reduce((sum, row) => sum + Number(row.meta?.cost_usd ?? 0), 0);
  } catch {
    return 0;
  }
}

/** What each mode can do right now, for the composer and for a quote. */
export interface ImagineOptions {
  image: { ready: boolean; provider: 'grok' | 'gemini' | null };
  video: {
    ready: boolean;
    model: string;
    defaultSeconds: number;
    maxSeconds: number;
    usdPerSecond: number;
    spentTodayUsd: number;
    dailyCapUsd: number;
  };
}

export async function imagineOptions(actor: ImagineActor): Promise<ImagineOptions> {
  const [grok, gemini, models, spent, jobsReady] = await Promise.all([
    isGrokReady(actor.orgId),
    isImageReady(actor.orgId),
    grokModels(actor.orgId),
    videoSpentToday(actor.db),
    jobsTableReady(),
  ]);

  const seconds = clampSeconds(undefined, models.video);
  return {
    image: { ready: grok || gemini, provider: grok ? 'grok' : gemini ? 'gemini' : null },
    video: {
      // Video is Grok only, and needs somewhere to write the job down.
      ready: grok && jobsReady,
      model: models.video,
      defaultSeconds: seconds,
      maxSeconds: clampSeconds(999, models.video),
      usdPerSecond: videoCostUsd(models.video, 1),
      spentTodayUsd: spent,
      dailyCapUsd: MEDIA_DAILY_USD_CAP,
    },
  };
}

export interface MadePicture {
  name: string;
  mimeType: string;
  size: number;
  token: string;
  model: string;
  /** Whether a supplied picture was transformed, or one was drawn from words. */
  mode: 'edit' | 'generate';
  note: string | null;
  /** Attachments that could not be used, named rather than dropped quietly. */
  ignored: string[];
}

/**
 * The brief leads.
 *
 * Nothing is prepended about the studio's usual subject matter: an
 * instruction to make "interior design imagery" fights a brief asking for
 * a building on its site. Only the one thing a render always wants is
 * added, because models scribble invented text into pictures.
 */
const NO_TEXT = 'Do not draw any text, labels, watermarks or dimension figures into the image.';

/**
 * What an edit must hold on to.
 *
 * "Render what it depicts" was wrong for the commonest request of all:
 * asked to furnish an empty room, a model that renders what the photograph
 * depicts gives back an empty room. The room is the part to keep; the
 * brief is the part to change. Matching the source's realism is said here
 * rather than assumed, because a photograph edited into an illustration is
 * not what anyone attaching a photograph is asking for.
 */
const HOLD_THE_FRAME =
  'Work from the attached picture. Keep its architecture, proportions, window positions, floor and ' +
  'camera viewpoint exactly as they are, and change only what the brief describes. Match the source ' +
  "photograph's realism, lighting and lens, so the result reads as the same room photographed again.";

export async function makePicture(input: {
  actor: ImagineActor;
  brief: string;
  sources: ImageReference[];
  aspectRatio?: string;
  resolution?: '1K' | '2K';
  projectId?: string | null;
  /** How long the render may take; see ImageRequest.timeoutMs. */
  timeoutMs?: number;
}): Promise<Made<MadePicture>> {
  const { actor } = input;
  if (!mayImagine(actor)) return { ok: false, reason: 'Drawing is not something this role may do.' };

  const brief = input.brief.trim();
  if (!brief) return { ok: false, reason: 'Say what you would like to see.' };

  // Grok is preferred — its edit endpoint holds a supplied picture rather
  // than being loosely guided by it — but the studio's Gemini key draws
  // and edits perfectly well, and refusing while a working image key sits
  // in the environment is the wrong answer.
  const viaGrok = await isGrokReady(actor.orgId);
  const viaGemini = viaGrok ? false : await isImageReady(actor.orgId);
  if (!viaGrok && !viaGemini) {
    return {
      ok: false,
      reason:
        'Picture-making needs an image key — either xAI or Gemini — which the principal adds in Settings.',
    };
  }

  const aspect = (input.aspectRatio ?? '16:9').trim() || '16:9';
  const resolution = input.resolution === '1K' ? '1K' : '2K';
  const ignored: string[] = [];

  let picture: { bytes: Buffer; mimeType: string; model: string; note: string | null };
  let mode: 'edit' | 'generate' = input.sources.length ? 'edit' : 'generate';

  // The brief first, then how to treat the attachment, then the one rule
  // every render wants. Built once so both providers are told the same.
  const editing = input.sources.length > 0;
  const instructions = [brief, editing ? HOLD_THE_FRAME : '', NO_TEXT].filter(Boolean).join('\n\n');

  try {
    if (viaGrok) {
      // The edit endpoint takes exactly one picture, so the first wins and
      // the rest are named in the reply rather than dropped quietly.
      ignored.push(...input.sources.slice(1).map((r) => r.label ?? 'an attachment'));
      const drawn = await generateImage(
        {
          prompt: instructions,
          source: input.sources[0] ?? null,
          aspectRatio: input.sources.length ? undefined : aspect,
          resolution,
          timeoutMs: input.timeoutMs,
        },
        { feature: 'image.render', orgId: actor.orgId, actor: actor.userId, entity: 'media_jobs', entityId: null },
      );
      picture = drawn;
      mode = drawn.mode;
    } else {
      // Gemini takes up to fourteen references, so every attachment goes
      // in; aspect ratio has to be said in words, having no field of its own.
      picture = await renderImage(
        `${instructions}

Aspect ratio ${aspect}.`,
        input.sources,
        { feature: 'image.render', orgId: actor.orgId, actor: actor.userId, entity: 'media_jobs', entityId: null },
        // Bounded well inside a request: the board default is three
        // minutes, which outlives the function it runs in.
        { timeoutMs: input.timeoutMs ?? 30_000 },
      );
    }
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      timedOut: err instanceof RenderTimeout || (err as Error)?.name === 'AbortError',
    };
  }

  /**
   * A rendering is a photograph or it is nothing.
   *
   * `renderImage` falls back to SVG when the model writes vector markup
   * instead of drawing, which is right for a specification board — the
   * typography is exact and the studio gets a usable page. It is the wrong
   * answer here. Asked to show a room furnished, that fallback returns a
   * flat cartoon with the furniture labelled in text, and handing it over
   * as though it were the render is worse than admitting the studio has no
   * model that can photograph: it looks like the feature works.
   */
  if (picture.mimeType.includes('svg')) {
    return {
      ok: false,
      reason:
        `The image model in use ("${picture.model}") cannot produce a photograph — it drew a flat diagram instead. ` +
        'For a photoreal rendering the studio needs billing enabled on its Google image key, or an xAI key in Settings.',
    };
  }

  const extension = picture.mimeType.includes('svg')
    ? 'svg'
    : picture.mimeType.includes('jpeg')
      ? 'jpg'
      : 'png';
  const stem =
    brief.replace(/[^\w\s-]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ') ||
    'Rendering';
  const name = `${stem} — ${new Date().toISOString().slice(0, 10)}.${extension}`;

  const { path } = await storeUpload({
    orgId: actor.orgId,
    userId: actor.userId,
    name,
    mimeType: picture.mimeType as UploadType,
    bytes: picture.bytes,
  });
  const token = sealFileGrant(
    { source: 'upload', orgId: actor.orgId, path, mimeType: picture.mimeType, name, size: picture.bytes.length },
    UPLOAD_GRANT_TTL_MS,
  );

  // Filed as a finished job, so "what have we made this month" has one
  // place to look whether it was a still or a clip.
  await createJob({
    orgId: actor.orgId,
    userId: actor.userId,
    kind: 'image',
    model: picture.model,
    prompt: brief,
    projectId: input.projectId ?? null,
    status: 'done',
    storagePath: path,
    mimeType: picture.mimeType,
    bytes: picture.bytes.length,
  }).catch(() => null);

  return {
    ok: true,
    value: {
      name,
      mimeType: picture.mimeType,
      size: picture.bytes.length,
      token,
      model: picture.model,
      mode,
      note: picture.note,
      ignored,
    },
  };
}

export interface StartedClip {
  jobId: string;
  seconds: number;
  costUsd: number;
  model: string;
}

export async function startClip(input: {
  actor: ImagineActor;
  brief: string;
  seconds?: number;
  aspectRatio?: string;
  still?: { mimeType: string; bytes: Buffer } | null;
  projectId?: string | null;
}): Promise<Made<StartedClip>> {
  const { actor } = input;
  if (!mayImagine(actor)) return { ok: false, reason: 'Making video is not something this role may do.' };

  const brief = input.brief.trim();
  if (!brief) return { ok: false, reason: 'Say what should happen in the clip.' };

  if (!(await isGrokReady(actor.orgId))) {
    return { ok: false, reason: 'Video needs an xAI key, which the principal adds in Settings.' };
  }

  // Before a penny is spent, not after: a clip that cannot be written down
  // is one nobody can ever fetch, and the provider bills for it regardless.
  if (!(await jobsTableReady())) {
    return {
      ok: false,
      reason: 'Video is not ready on this deployment yet — migration 0014 has not been applied.',
    };
  }

  const models = await grokModels(actor.orgId);
  const seconds = clampSeconds(input.seconds, models.video);
  const costUsd = videoCostUsd(models.video, seconds);

  const spent = await videoSpentToday(actor.db);
  if (spent + costUsd > MEDIA_DAILY_USD_CAP) {
    return {
      ok: false,
      reason: `Today's video budget is used up — $${spent.toFixed(2)} of $${MEDIA_DAILY_USD_CAP.toFixed(2)}. A still costs a few cents instead.`,
    };
  }

  let started;
  try {
    started = await startVideo(
      {
        prompt: brief,
        image: input.still ?? null,
        seconds,
        aspectRatio: (input.aspectRatio ?? '16:9').trim() || '16:9',
        withAudio: false,
      },
      { feature: 'video.render', orgId: actor.orgId, actor: actor.userId, entity: 'media_jobs', entityId: null },
    );
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const job = await createJob({
    orgId: actor.orgId,
    userId: actor.userId,
    kind: 'video',
    model: started.model,
    prompt: brief,
    requestId: started.requestId,
    projectId: input.projectId ?? null,
    seconds: started.seconds,
  });

  return { ok: true, value: { jobId: job.id, seconds: started.seconds, costUsd, model: started.model } };
}
