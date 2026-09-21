#!/usr/bin/env node
/**
 * Prove the Grok account before trusting the connector to it.
 *
 * The video API is documented down to its status values. The image API is
 * not: whether it accepts `n`, `response_format` or a reference image
 * under those names, and what its response actually looks like, is worth
 * finding out against a real key rather than from a doc page.
 *
 * Costs real money — about 4c for the image, and 8c a second for the clip.
 * Nothing here touches the database or the app.
 *
 *   node scripts/grok-probe.mjs                      # draw one image
 *   node scripts/grok-probe.mjs --edit sketch.jpeg   # transform a picture
 *   node scripts/grok-probe.mjs --video              # and a 2-second clip
 *   node scripts/grok-probe.mjs --video-only
 *
 * `--edit` is the one worth running first if the studio's real use is
 * "turn this sketch into a visualisation": it is the same call the
 * make_image tool makes, against the same endpoint, with your own file.
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

loadEnv({ path: path.resolve(process.cwd(), '.env') });

const KEY = process.env.XAI_API_KEY;
const IMAGE_MODEL = process.env.XAI_IMAGE_MODEL || 'grok-imagine-image-2.0';
const VIDEO_MODEL = process.env.XAI_VIDEO_MODEL || 'grok-imagine-video-1.5';
const BASE = 'https://api.x.ai/v1';

const wantsVideo = process.argv.includes('--video') || process.argv.includes('--video-only');
const editIndex = process.argv.indexOf('--edit');
const editFile = editIndex === -1 ? null : process.argv[editIndex + 1];
const wantsImage = !process.argv.includes('--video-only') && !editFile;

if (editIndex !== -1 && !editFile) {
  console.error('--edit needs a path: node scripts/grok-probe.mjs --edit sketch.jpeg');
  process.exit(1);
}

if (!KEY) {
  console.error('XAI_API_KEY is not set. Put it in .env at the repo root, then run this again.');
  process.exit(1);
}

/** Print a response without dumping a megabyte of base64 into the terminal. */
function show(label, json) {
  const trimmed = JSON.parse(
    JSON.stringify(json, (_k, v) =>
      typeof v === 'string' && v.length > 200 ? `${v.slice(0, 80)}… (${v.length} chars)` : v,
    ),
  );
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);
  console.log(JSON.stringify(trimmed, null, 2));
}

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => ({})) };
}

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { Authorization: `Bearer ${KEY}` } });
  return { res, json: await res.json().catch(() => ({})) };
}

async function probeImage() {
  const prompt = 'A warm oak kitchen at morning light, brass hardware, honed marble counter';

  // What the connector sends first. If this is refused, the connector
  // retries with the bare pair — so try both here and report which worked.
  console.log(`\nImage · ${IMAGE_MODEL} · asking for b64_json…`);
  let { res, json } = await post('/images/generations', {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'b64_json',
  });

  if (!res.ok) {
    console.log(`  rejected (${res.status}) — retrying with model + prompt only`);
    show('rejection', json);
    ({ res, json } = await post('/images/generations', { model: IMAGE_MODEL, prompt }));
  }

  show(`image response (${res.status})`, json);
  if (!res.ok) return;

  const first = json.data?.[0] ?? {};
  console.log(`\n  keys on data[0]: ${Object.keys(first).join(', ') || '(none)'}`);
  if (first.b64_json) {
    writeFileSync('grok-probe.png', Buffer.from(first.b64_json, 'base64'));
    console.log('  wrote grok-probe.png');
  } else if (first.url) {
    const bytes = Buffer.from(await (await fetch(first.url)).arrayBuffer());
    writeFileSync('grok-probe.png', bytes);
    console.log(`  url returned; fetched ${bytes.length} bytes → grok-probe.png`);
    console.log('  NOTE: record whether this url is still good in an hour.');
  }
}

/**
 * The call `make_image` makes when something is attached.
 *
 * A different endpoint from generation, one source image, and the output
 * keeps the source's aspect ratio — so a sketch's proportions carry into
 * the visualisation.
 */
async function probeEdit(file) {
  const bytes = readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  console.log(`\nEdit · ${IMAGE_MODEL} · ${file} (${(bytes.length / 1024).toFixed(0)} KB, ${mime})`);

  const prompt =
    'Transform this hand-drawn architectural pencil sketch into a hyper-realistic photorealistic ' +
    'architectural visualization of the finished building. Convert the rough sketch into a real modern ' +
    'building with accurate materials (glass, concrete, wood, steel), proper proportions, and architectural ' +
    'details. Place it on a realistic site with landscaping, natural daylight, sky, and subtle people for ' +
    'scale. Professional cinematic architectural rendering style, high-end real estate visualization, ultra-detailed.';

  const { res, json } = await post('/images/edits', {
    model: IMAGE_MODEL,
    prompt,
    image: { url: `data:${mime};base64,${bytes.toString('base64')}`, type: 'image_url' },
    resolution: '2K',
  });

  show(`edit response (${res.status})`, json);
  if (!res.ok) {
    console.log('\n  Record the exact field it objected to — the connector retries without the');
    console.log('  optional ones, but the source image shape is the part that must be right.');
    return;
  }

  const found = json.data?.[0] ?? json.image ?? json;
  if (found.b64_json) {
    writeFileSync('grok-probe-edit.png', Buffer.from(found.b64_json, 'base64'));
    console.log('  wrote grok-probe-edit.png');
  } else if (found.url) {
    const out = Buffer.from(await (await fetch(found.url)).arrayBuffer());
    writeFileSync('grok-probe-edit.png', out);
    console.log(`  url returned; fetched ${(out.length / 1024).toFixed(0)} KB → grok-probe-edit.png`);
  } else {
    console.log('  no picture found on the response — record its shape above.');
  }
}

async function probeVideo() {
  console.log(`\nVideo · ${VIDEO_MODEL} · 2 seconds, no audio…`);
  const { res, json } = await post('/videos/generations', {
    model: VIDEO_MODEL,
    prompt: 'A slow pan across a warm oak kitchen island in morning light',
    duration: 2,
    aspect_ratio: '16:9',
    resolution: '720p',
    generate_audio: false,
  });
  show(`start response (${res.status})`, json);
  if (!res.ok || !json.request_id) return;

  const started = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { res: pollRes, json: poll } = await get(`/videos/${json.request_id}`);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`  ${seconds}s · ${poll.status ?? pollRes.status}`);
    if (poll.status === 'done' || poll.status === 'failed' || poll.status === 'expired') {
      show(`poll response (${poll.status})`, poll);
      if (poll.video?.url) {
        const bytes = Buffer.from(await (await fetch(poll.video.url)).arrayBuffer());
        writeFileSync('grok-probe.mp4', bytes);
        console.log(`  fetched ${(bytes.length / 1024 / 1024).toFixed(1)} MB → grok-probe.mp4`);
        console.log('  NOTE: compare that size against MAX_RELAY_BYTES (4.3 MB on Vercel).');
      }
      return;
    }
  }
  console.log('  still pending after five minutes — record that, it sets MEDIA_GIVE_UP_MS.');
}

console.log(`Probing xAI with the key ending ${KEY.slice(-4)}`);
if (editFile) await probeEdit(editFile);
if (wantsImage) await probeImage();
if (wantsVideo) await probeVideo();
console.log('\nDone. Record the response shapes in docs/GROK-MEDIA-IMPLEMENTATION.md §3.1.\n');
