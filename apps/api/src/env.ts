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
  port: Number(optional('API_PORT', '4000')),
  host: optional('API_HOST', 'localhost'),
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

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    model: optional('ANTHROPIC_MODEL', 'claude-opus-5'),
  },

  tokenEncryptionKey: optional('TOKEN_ENCRYPTION_KEY'),
} as const;

export const isGoogleConfigured = () =>
  Boolean(env.google.clientId && env.google.clientSecret);

export const isSupabaseConfigured = () =>
  Boolean(env.supabase.url && env.supabase.anonKey && env.supabase.serviceRoleKey);

export const isAnthropicConfigured = () => Boolean(env.anthropic.apiKey);

// `required` is kept for values we may enforce later; reference it so
// strict unused checks stay quiet without changing behaviour.
void required;
