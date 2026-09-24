import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_IMAGE_MODEL,
  imageModelKind,
  canWith,
  videoCostUsd,
  type PermissionOverrides,
  type UserRole,
} from '@janelle/shared';
import { UPLOAD_GRANT_TTL_MS, sealFileGrant } from '../lib/fileTokens.js';
import { storeUpload, type UploadType } from '../lib/uploads.js';
import { RenderTimeout, clampSeconds, generateImage, grokModels, isGrokReady, startVideo } from './grok.js';
import { isImageReady, isSketchReady, renderImage, sketchWithClaude, type ImageReference } from './images.js';
import { createJob, jobsTableReady } from './mediaJobs.js';
import { boardSpecs, composeBoard, studioName } from './board.js';
import { resolveImageAi, resolvePictureEngine } from '../lib/aiSettings.js';
import { editWithCloudflare, isCloudflareReady, renderWithCloudflare } from './cloudflare.js';
import { isFloorPlan, readPlanRooms, renderFloorPlan, renderPlanRooms, type RoomRender } from './floorPlan.js';

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
  image: { ready: boolean; provider: 'grok' | 'gemini' | 'cloudflare' | 'claude' | null };
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
  const [grok, gemini, claude, cloudflare, models, spent, jobsReady] = await Promise.all([
    isGrokReady(actor.orgId),
    isImageReady(actor.orgId),
    isSketchReady(actor.orgId),
    isCloudflareReady(actor.orgId),
    grokModels(actor.orgId),
    videoSpentToday(actor.db),
    jobsTableReady(),
  ]);

  const seconds = clampSeconds(undefined, models.video);
  return {
    image: {
      ready: grok || gemini || cloudflare || claude,
      provider: grok ? 'grok' : gemini ? 'gemini' : cloudflare ? 'cloudflare' : claude ? 'claude' : null,
    },
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
  /** Laid out as a presentation board rather than handed over bare. */
  board: boolean;
  /** The picture is an illustrated sketch, not a photoreal render. */
  sketch: boolean;
  /** A floor plan rendered furnished, the drawing's own labels on top. */
  plan: boolean;
  /** With a floor plan: its key rooms in perspective, each its own file. */
  rooms: { name: string; mimeType: string; size: number; token: string; room: string; roomSize: string | null }[];
}

/**
 * The brief leads.
 *
 * Nothing is prepended about the studio's usual subject matter: an
 * instruction to make "interior design imagery" fights a brief asking for
 * a building on its site. Only the one thing a render always wants is
 * added, because models scribble invented text into pictures.
 */
/** Less than this left in the request and a Claude sketch cannot finish. */
const SKETCH_MIN_MS = 12_000;

const NO_TEXT ='Do not draw any text, labels, watermarks or dimension figures into the image.';

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
  /**
   * Lay a picture drawn from words out as a presentation board. Default on;
   * a transformed attachment always comes back as the picture itself.
   */
  board?: boolean;
}): Promise<Made<MadePicture>> {
  const { actor } = input;
  if (!mayImagine(actor)) return { ok: false, reason: 'Drawing is not something this role may do.' };

  const brief = input.brief.trim();
  if (!brief) return { ok: false, reason: 'Say what you would like to see.' };

  // Who draws, in order, each tried in turn until one produces a picture.
  //
  // Settings → "Drawn by" decides who goes first. After that the order is
  // always the same: a real photograph from whoever can make one, and the
  // Claude sketch last — it cannot photograph, but it beats an error.
  const started = Date.now();
  const [grok, gemini, claude, cloudflare, engine, geminiAi] = await Promise.all([
    isGrokReady(actor.orgId),
    isImageReady(actor.orgId),
    isSketchReady(actor.orgId),
    isCloudflareReady(actor.orgId),
    resolvePictureEngine(actor.orgId),
    resolveImageAi(actor.orgId),
  ]);

  const aspect = (input.aspectRatio ?? '16:9').trim() || '16:9';
  const resolution = input.resolution === '1K' ? '1K' : '2K';
  const ignored: string[] = [];

  let picture: { bytes: Buffer; mimeType: string; model: string; note: string | null; plan?: boolean } | null = null;
  /** A floor plan's rooms in perspective, made alongside the plan itself. */
  let roomRenders: RoomRender[] = [];
  let mode: 'edit' | 'generate' = input.sources.length ? 'edit' : 'generate';

  // The brief first, then how to treat the attachment, then the one rule
  // every render wants. Built once so every provider is told the same.
  const editing = input.sources.length > 0;
  const instructions = [brief, editing ? HOLD_THE_FRAME : '', NO_TEXT].filter(Boolean).join('\n\n');

  const budgetMs = input.timeoutMs ?? 30_000;
  const ctx = { feature: 'image.render' as const, orgId: actor.orgId, actor: actor.userId, entity: 'media_jobs', entityId: null };

  type Attempt = { name: string; minMs: number; run: (left: number) => Promise<NonNullable<typeof picture>> };

  const viaGrok: Attempt = {
    name: 'Grok',
    minMs: 5_000,
    run: async (left) => {
      // The edit endpoint takes exactly one picture, so the first wins and
      // the rest are named in the reply rather than dropped quietly.
      const drawn = await generateImage(
        { prompt: instructions, source: input.sources[0] ?? null, aspectRatio: editing ? undefined : aspect, resolution, timeoutMs: left },
        ctx,
      );
      ignored.push(...input.sources.slice(1).map((r) => r.label ?? 'an attachment'));
      mode = drawn.mode;
      return drawn;
    },
  };
  // Gemini takes up to fourteen references, so every attachment goes in;
  // aspect ratio has to be said in words, having no field of its own.
  const viaGemini: Attempt = {
    name: 'Gemini',
    minMs: 5_000,
    run: (left) => renderImage(`${instructions}\n\nAspect ratio ${aspect}.`, input.sources, ctx, { timeoutMs: left, vectorStyle: 'scene' }),
  };
  // From words, FLUX.1. From a photograph, FLUX.2 [klein], which keeps the
  // room — its walls, window, floor and camera — and changes only what the
  // brief asks. It works from one photo; any others are named in the reply.
  const viaCloudflare: Attempt = {
    name: 'Cloudflare',
    minMs: 3_000,
    run: async (left) => {
      if (!editing) return renderWithCloudflare(`${brief}\n\n${NO_TEXT}`, ctx, { timeoutMs: left });
      // A floor plan is not a room to redecorate: it is rendered as a
      // furnished plan, with the drawing's own labels laid back on top.
      if (await isFloorPlan(brief, input.sources[0], ctx)) {
        const source = input.sources[0];
        const deadline = started + budgetMs;
        // The key rooms in perspective, alongside the furnished plan: Claude
        // reads the drawing while the plan renders, then every room is drawn
        // at once. Whatever finishes in time comes back with the plan.
        const rooms = (async () => {
          const reading = await readPlanRooms(brief, source, ctx, Math.min(20_000, Math.max(3_000, deadline - Date.now())));
          const left = deadline - Date.now();
          return reading && left > 4_000 ? renderPlanRooms(reading, ctx, left) : [];
        })().catch((err) => {
          console.warn('[imagine] room renders unavailable:', (err as Error).message);
          return [] as RoomRender[];
        });
        const [plan, renders] = await Promise.all([
          renderFloorPlan(brief, source, ctx, { timeoutMs: Math.max(3_000, deadline - Date.now()) }),
          rooms,
        ]);
        roomRenders = renders;
        ignored.push(...input.sources.slice(1).map((r) => r.label ?? 'an attachment'));
        mode = 'edit';
        return plan;
      }
      const drawn = await editWithCloudflare(instructions, input.sources[0], ctx, { timeoutMs: left });
      ignored.push(...input.sources.slice(1).map((r) => r.label ?? 'an attachment'));
      mode = 'edit';
      return drawn;
    },
  };
  const viaClaude = (model?: string): Attempt => ({
    name: 'Claude',
    minMs: SKETCH_MIN_MS,
    run: (left) => sketchWithClaude(`${instructions}\n\nAspect ratio ${aspect}.`, input.sources, ctx, { timeoutMs: left, model }),
  });

  const geminiPhotographs = gemini && imageModelKind(geminiAi.model || DEFAULT_IMAGE_MODEL) === 'raster';
  const chain: Attempt[] = [];
  if (engine.startsWith('claude') && claude) {
    chain.push(viaClaude(engine));
  } else {
    // Cloudflare first when chosen, or whenever Gemini cannot photograph —
    // it edits an attached photo as well as drawing from words.
    const cloudflareFirst = cloudflare && (engine === 'cloudflare' || !geminiPhotographs);
    if (cloudflareFirst) chain.push(viaCloudflare);
    if (grok) chain.push(viaGrok);
    if (geminiPhotographs) chain.push(viaGemini);
    if (cloudflare && !cloudflareFirst) chain.push(viaCloudflare);
    // Flash Lite draws rather than photographs: after every photo source.
    if (gemini && !geminiPhotographs) chain.push(viaGemini);
    if (claude) chain.push(viaClaude());
  }

  if (!chain.length) {
    return {
      ok: false,
      reason:
        'Picture-making needs an image source — Cloudflare (free), Gemini or xAI — or a Claude key for sketches, which the principal adds in Settings.',
    };
  }

  // The board's words, pulled from the brief while the picture renders —
  // in parallel, so the board costs no extra wall-clock. A failure here
  // only means the picture comes back bare.
  const wantBoard = input.board !== false && !editing && claude;
  const specsPending = wantBoard
    ? Promise.all([boardSpecs(brief, ctx, Math.min(20_000, budgetMs)), studioName(actor.orgId)]).catch((err) => {
        console.warn('[imagine] board specs unavailable:', (err as Error).message);
        return null;
      })
    : Promise.resolve(null);

  const failures: string[] = [];
  let timedOut = false;
  for (const attempt of chain) {
    const left = budgetMs - (Date.now() - started);
    if (left < attempt.minMs) {
      timedOut = true;
      continue;
    }
    try {
      picture = await attempt.run(left);
      break;
    } catch (err) {
      failures.push(`${attempt.name}: ${(err as Error).message}`);
      if (err instanceof RenderTimeout || (err as Error)?.name === 'AbortError' || /time limit|timed? ?out/i.test((err as Error).message)) {
        timedOut = true;
      }
      console.warn(`[imagine] ${attempt.name} could not draw it:`, (err as Error).message);
    }
  }

  if (!picture) {
    return {
      ok: false,
      reason: failures.length ? failures.join(' · ') : 'There was not enough time left to draw it.',
      timedOut,
    };
  }
  // A photo source failed before this one worked: worth a word, not a fuss.
  if (failures.length && picture.mimeType.includes('svg')) {
    picture.note = `${picture.note ?? ''} (${failures.map((f) => f.slice(0, 120)).join(' · ')})`.trim();
  }

  // A vector-only Gemini model (Flash Lite) answers with SVG rather than a
  // photograph. That is a sketch, not a render — delivered as one, and said
  // plainly, rather than refused.
  // A rendered floor plan is SVG only because it layers the drawing over the
  // rendering; it is a finished picture, not a sketch.
  const sketch = picture.mimeType.includes('svg') && !picture.plan;
  if (sketch && !picture.note?.includes('sketch')) {
    picture.note = 'An illustrated sketch, not a photoreal render — choose a raster Gemini model with billing, or add an xAI key, for photographs.';
  }

  // Into the studio's board format: the picture large, the specifications
  // beside it, the materials beneath, the studio at the foot.
  const specs = await specsPending;
  let board = false;
  if (specs?.[0]) {
    picture = {
      ...picture,
      bytes: composeBoard({ photo: picture, specs: specs[0], studio: specs[1] }),
      mimeType: 'image/svg+xml',
    };
    board = true;
  }

  const extension = picture.mimeType.includes('svg')
    ? 'svg'
    : picture.mimeType.includes('jpeg')
      ? 'jpg'
      : 'png';
  const stem =
    (picture.plan ? 'Furnished Floor Plan' : '') ||
    (board && specs?.[0]?.title ? `${specs[0].title} Board` : '') ||
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

  // The plan's rooms, each stored and filed like any other picture, so each
  // can be opened, downloaded and found again on its own.
  const day = new Date().toISOString().slice(0, 10);
  const rooms: MadePicture['rooms'] = [];
  for (const render of roomRenders) {
    try {
      const ext = render.mimeType.includes('png') ? 'png' : 'jpg';
      const roomName = `${render.room.name}${render.room.size ? ` ${render.room.size.replace(/"/g, '')}` : ''} — ${day}.${ext}`;
      const stored = await storeUpload({
        orgId: actor.orgId,
        userId: actor.userId,
        name: roomName,
        mimeType: render.mimeType as UploadType,
        bytes: render.bytes,
      });
      rooms.push({
        name: roomName,
        mimeType: render.mimeType,
        size: render.bytes.length,
        token: sealFileGrant(
          { source: 'upload', orgId: actor.orgId, path: stored.path, mimeType: render.mimeType, name: roomName, size: render.bytes.length },
          UPLOAD_GRANT_TTL_MS,
        ),
        room: render.room.name,
        roomSize: render.room.size,
      });
      await createJob({
        orgId: actor.orgId,
        userId: actor.userId,
        kind: 'image',
        model: render.model,
        prompt: `${render.room.name} — from the floor plan: ${brief}`.slice(0, 2000),
        projectId: input.projectId ?? null,
        status: 'done',
        storagePath: stored.path,
        mimeType: render.mimeType,
        bytes: render.bytes.length,
      }).catch(() => null);
    } catch (err) {
      console.warn('[imagine] could not store a room render:', (err as Error).message);
    }
  }

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
      board,
      sketch,
      plan: Boolean(picture.plan),
      rooms,
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
