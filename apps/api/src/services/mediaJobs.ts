import type { AssistantItem, MediaJobView } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { UPLOAD_BUCKET, storeUpload, type UploadType } from '../lib/uploads.js';
import { UPLOAD_GRANT_TTL_MS, sealFileGrant } from '../lib/fileTokens.js';
import { fetchMedia, pollVideo, recordVideo, type VideoStatus } from './grok.js';

/**
 * The waiting room for media that cannot be made inside a request.
 *
 * An image is drawn and handed back in the answer that asked for it. A
 * video is not: xAI takes the job, returns an id, and finishes a minute or
 * two later — long after the serverless function that started it has been
 * killed. So the request is written down here, and two different things
 * finish it:
 *
 *   1. the browser, while someone is watching — it polls this job, which
 *      polls the provider, so the clip appears without a reload;
 *   2. the cron sweep, for everyone who closed the tab — because the
 *      provider's finished URL is temporary, and a job nobody ever polls
 *      ends with the work paid for and thrown away.
 *
 * Both go through `finishJob`, so there is exactly one place that fetches
 * the bytes, stores them and books the cost. They are made safe against
 * each other by a conditional update: the first to claim a pending row
 * wins, and the second finds the work already done.
 */

/** A job left pending longer than this is written off. */
const GIVE_UP_MS = Number(process.env.MEDIA_GIVE_UP_MS || 10 * 60_000);

/** How long a playable URL lasts. Long enough to watch, short enough to leak safely. */
const STREAM_TTL_SECONDS = Number(process.env.MEDIA_STREAM_TTL_SECONDS || 3600);

export interface MediaJobRow {
  id: string;
  org_id: string;
  user_id: string;
  kind: 'image' | 'video';
  status: 'pending' | 'done' | 'failed' | 'expired';
  provider: string;
  model: string;
  request_id: string | null;
  prompt: string;
  project_id: string | null;
  seconds: number | null;
  storage_path: string | null;
  mime_type: string | null;
  bytes: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  polled_at: string | null;
}

function db() {
  if (!supabaseAdmin) throw new Error('Storage is not configured');
  return supabaseAdmin;
}

/** Write down a job before anything can go wrong with it. */
export async function createJob(input: {
  orgId: string;
  userId: string;
  kind: 'image' | 'video';
  model: string;
  prompt: string;
  requestId?: string | null;
  projectId?: string | null;
  seconds?: number | null;
  status?: 'pending' | 'done';
  storagePath?: string | null;
  mimeType?: string | null;
  bytes?: number | null;
}): Promise<MediaJobRow> {
  const { data, error } = await db()
    .from('media_jobs')
    .insert({
      org_id: input.orgId,
      user_id: input.userId,
      kind: input.kind,
      status: input.status ?? 'pending',
      provider: 'xai',
      model: input.model,
      request_id: input.requestId ?? null,
      prompt: input.prompt.slice(0, 4000),
      project_id: input.projectId ?? null,
      seconds: input.seconds ?? null,
      storage_path: input.storagePath ?? null,
      mime_type: input.mimeType ?? null,
      bytes: input.bytes ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as MediaJobRow;
}

/**
 * Whether the table this feature needs actually exists yet.
 *
 * Checked BEFORE a clip is started, never after: the provider bills for a
 * video the moment it draws one, and a job that cannot be written down is
 * a video nobody can ever fetch. Cheap, and cached once it succeeds —
 * migration 0014 does not un-apply itself.
 */
let tableReady: boolean | null = null;

export async function jobsTableReady(): Promise<boolean> {
  if (tableReady !== null) return tableReady;
  if (!supabaseAdmin) return false;
  const { error } = await supabaseAdmin.from('media_jobs').select('id').limit(1);
  // 42P01 is "relation does not exist"; anything else (an empty table, a
  // permissions quirk) means the table is there.
  const missing = error?.code === '42P01' || /media_jobs.*does not exist/i.test(error?.message ?? '');
  if (!missing) tableReady = true;
  return !missing;
}

export async function readJob(id: string, orgId: string): Promise<MediaJobRow | null> {
  const { data, error } = await db()
    .from('media_jobs')
    .select('*')
    .eq('id', id)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MediaJobRow | null) ?? null;
}

/** This person's recent jobs, so a reopened conversation catches up. */
export async function recentJobs(orgId: string, userId: string, limit = 10): Promise<MediaJobRow[]> {
  const { data, error } = await db()
    .from('media_jobs')
    .select('*')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));
  if (error) throw new Error(error.message);
  return (data ?? []) as MediaJobRow[];
}

/**
 * Take a pending job, if it is still pending.
 *
 * The `.eq('status','pending')` in the WHERE is what makes two pollers
 * safe: whoever updates first gets a row back, and the loser gets none and
 * leaves the work alone.
 */
async function claim(id: string): Promise<MediaJobRow | null> {
  const { data, error } = await db()
    .from('media_jobs')
    .update({ polled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MediaJobRow | null) ?? null;
}

async function settle(
  id: string,
  patch: Partial<Pick<MediaJobRow, 'status' | 'storage_path' | 'mime_type' | 'bytes' | 'seconds' | 'error'>>,
): Promise<void> {
  const { error } = await db()
    .from('media_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Move one job as far along as it will go, and report where it got to.
 *
 * Never throws for a provider answer: a refused clip is a finished job
 * with a sentence on it, not an outage. A transport failure does throw,
 * because the next poll should try again rather than write the job off.
 */
export async function finishJob(id: string, orgId: string): Promise<MediaJobRow | null> {
  const current = await readJob(id, orgId);
  if (!current) return null;
  if (current.status !== 'pending') return current;

  // Nothing to poll: a job with no request id was never started properly.
  if (!current.request_id) {
    await settle(id, { status: 'failed', error: 'This job was never started with the provider.' });
    return readJob(id, orgId);
  }

  if (Date.now() - new Date(current.created_at).getTime() > GIVE_UP_MS) {
    await settle(id, {
      status: 'expired',
      error: 'The clip took too long and was given up on. Nothing was charged for it.',
    });
    return readJob(id, orgId);
  }

  const claimed = await claim(id);
  if (!claimed) return readJob(id, orgId); // someone else is on it

  // Read into a const before it is examined: a `let` assigned inside a try
  // keeps its declared union everywhere after it, so every narrowing below
  // would be thrown away.
  let polled: VideoStatus | null = null;
  try {
    polled = await pollVideo(current.request_id, orgId);
  } catch (err) {
    // Auth, network, rate limit: leave it pending and let the next poll try.
    console.warn('[media] poll failed, leaving the job pending:', (err as Error).message);
    return current;
  }

  const state = polled;
  if (state.status === 'pending') return current;

  // Tested against 'done' rather than for failed-or-expired: two literal
  // comparisons joined by || leave the union un-narrowed on the way out,
  // and everything below depends on this having been narrowed.
  if (state.status !== 'done') {
    await settle(id, { status: state.status, error: state.message });
    await recordVideo(
      { feature: 'video.render', orgId, actor: current.user_id, entity: 'media_jobs', entityId: id },
      current.model,
      0,
      Date.now() - new Date(current.created_at).getTime(),
      new Error(state.message),
    );
    return readJob(id, orgId);
  }

  const finished = state;

  // The provider's URL is temporary, so the bytes come into the studio's
  // own bucket now — not when someone next opens the conversation.
  try {
    const fetched = await fetchMedia(finished.url, 'video/mp4');
    const name = `${clipName(current.prompt)}.${fetched.mimeType.includes('mp4') ? 'mp4' : 'bin'}`;
    const stored = await storeUpload({
      orgId,
      userId: current.user_id,
      name,
      mimeType: fetched.mimeType as UploadType,
      bytes: fetched.bytes,
    });
    await settle(id, {
      status: 'done',
      storage_path: stored.path,
      mime_type: fetched.mimeType,
      bytes: fetched.bytes.length,
      seconds: finished.seconds || current.seconds,
      error: null,
    });
    await recordVideo(
      { feature: 'video.render', orgId, actor: current.user_id, entity: 'media_jobs', entityId: id },
      finished.model || current.model,
      finished.seconds || current.seconds || 0,
      Date.now() - new Date(current.created_at).getTime(),
      null,
    );
  } catch (err) {
    // The clip exists and was paid for; we just could not keep it. Say so
    // rather than reporting a failure the studio will be billed for anyway.
    await settle(id, {
      status: 'failed',
      error: `The clip was made but could not be saved: ${(err as Error).message}`,
    });
    await recordVideo(
      { feature: 'video.render', orgId, actor: current.user_id, entity: 'media_jobs', entityId: id },
      finished.model || current.model,
      finished.seconds || current.seconds || 0,
      Date.now() - new Date(current.created_at).getTime(),
      null,
    );
  }

  return readJob(id, orgId);
}

/**
 * Finish everything still pending for one studio.
 *
 * This is the half that makes the feature trustworthy: someone asks for a
 * clip, closes the laptop, and it is waiting for them. Never throws — a
 * sweep that dies on one job must still reach the next.
 */
export async function sweepJobs(orgId: string, limit = 20): Promise<{ checked: number; finished: number }> {
  if (!supabaseAdmin) return { checked: 0, finished: 0 };
  const { data } = await supabaseAdmin
    .from('media_jobs')
    .select('id')
    .eq('org_id', orgId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  let finished = 0;
  for (const row of (data ?? []) as { id: string }[]) {
    try {
      const after = await finishJob(row.id, orgId);
      if (after && after.status !== 'pending') finished++;
    } catch (err) {
      console.warn('[media] sweep could not finish a job:', (err as Error).message);
    }
  }
  return { checked: (data ?? []).length, finished };
}

/** A filename a person would recognise, from the brief they gave. */
function clipName(prompt: string): string {
  const stem = prompt
    .replace(/[^\w\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
  return `${stem || 'Clip'} — ${new Date().toISOString().slice(0, 10)}`;
}

/**
 * A short-lived URL the browser can play from.
 *
 * Not the download endpoint: that relays through the API, which caps at a
 * few megabytes on the host, and an mp4 is bigger than that. Signed
 * straight off storage instead, on Supabase's own origin.
 */
export async function streamUrlFor(path: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(UPLOAD_BUCKET)
    .createSignedUrl(path, STREAM_TTL_SECONDS);
  if (error || !data) return null;
  return data.signedUrl;
}

/** The finished clip as an answer row — the same shape a found file takes. */
export async function itemFor(job: MediaJobRow): Promise<AssistantItem | null> {
  if (job.status !== 'done' || !job.storage_path || !job.mime_type) return null;

  const name = job.storage_path.split('/').pop() || 'Clip.mp4';
  const token = sealFileGrant(
    {
      source: 'upload',
      orgId: job.org_id,
      path: job.storage_path,
      mimeType: job.mime_type,
      name,
      size: job.bytes ?? 0,
    },
    UPLOAD_GRANT_TTL_MS,
  );

  return {
    kind: 'file',
    title: name,
    detail: job.seconds ? `${job.seconds} seconds` : null,
    preview: job.kind === 'video' ? 'video' : 'image',
    file: {
      name,
      mimeType: job.mime_type,
      size: job.bytes ?? 0,
      source: 'upload',
      token,
      // A clip is usually past what the API will relay; it plays from the
      // signed URL instead, and the download button says so honestly.
      downloadable: job.kind !== 'video',
      webUrl: null,
      streamUrl: await streamUrlFor(job.storage_path),
    },
  };
}

/** What the browser is told about a job. */
export async function viewOf(job: MediaJobRow): Promise<MediaJobView> {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    prompt: job.prompt,
    seconds: job.seconds,
    createdAt: job.created_at,
    item: await itemFor(job),
    error: job.error,
  };
}
