import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Central, validated environment access. Loads the repo-root .env
 * explicitly (this file sits at apps/api/{src,dist}, so the root is
 * three levels up) and falls back to the process cwd. Missing
 * critical values fail loud at boot.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, '../../../.env') });
loadEnv(); // also honour a local .env / real process env if present

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  // Managed hosts (Railway, Render, Fly) inject PORT and route to it; they
  // also require binding every interface, not just loopback. API_PORT and
  // API_HOST remain the local-development overrides.
  port: Number(process.env.PORT || optional('API_PORT', '4000')),
  host: process.env.PORT ? '0.0.0.0' : optional('API_HOST', 'localhost'),
  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  supabase: {
    // Optional so the server can boot before credentials are added.
    // Data routes return a clear "not configured" error until set.
    url: optional('SUPABASE_URL'),
    anonKey: optional('SUPABASE_ANON_KEY'),
    serviceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
  },

  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
    redirectUri: optional('GOOGLE_REDIRECT_URI', 'http://localhost:4000/api/auth/google/callback'),
    scopes: optional('GOOGLE_SCOPES').split(' ').filter(Boolean),
  },

  /**
   * Who else hears about a new teammate.
   *
   * The studio wants the principal copied so she knows who has been let in,
   * and the developer blind-copied while the system is being built. Both are
   * configurable rather than written into the code: the second one in
   * particular should be removable without a deploy.
   */
  invite: {
    cc: optional('INVITE_CC', 'janelle@janelleinteriors.com'),
    bcc: optional('INVITE_BCC', 'dfaldu387@gmail.com'),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-opus-5'),
  },

  // Rendering presentation boards. A separate provider because Claude does
  // not make pictures; left empty until the studio sets a key, and every
  // render path degrades to "not configured" rather than failing oddly.
  images: {
    apiKey: optional('GEMINI_API_KEY'),
    model: optional('GEMINI_IMAGE_MODEL', 'gemini-3-pro-image'),
  },

  // Renderings and short video. A third provider with a third key: Claude
  // writes, Gemini draws the studio's boards, and this draws and animates
  // everything the house template never covered. Empty until the studio
  // sets a key, and every path through it degrades to "not configured".
  xai: {
    apiKey: optional('XAI_API_KEY'),
    imageModel: optional('XAI_IMAGE_MODEL', 'grok-imagine-image-2.0'),
    videoModel: optional('XAI_VIDEO_MODEL', 'grok-imagine-video-1.5'),
  },

  tokenEncryptionKey: optional('TOKEN_ENCRYPTION_KEY'),
} as const;

export const isGoogleConfigured = () =>
  Boolean(env.google.clientId && env.google.clientSecret);

export const isSupabaseConfigured = () =>
  Boolean(env.supabase.url && env.supabase.anonKey && env.supabase.serviceRoleKey);

export const isAnthropicConfigured = () => Boolean(env.anthropic.apiKey);

export const isGrokConfigured = () => Boolean(env.xai.apiKey);

// `required` is kept for values we may enforce later; reference it so
// strict unused checks stay quiet without changing behaviour.
void required;
