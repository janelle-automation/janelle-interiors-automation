import crypto from 'node:crypto';
import { env } from '../env.js';

/**
 * AES-256-GCM encryption for Google OAuth tokens at rest.
 * TOKEN_ENCRYPTION_KEY must be a 32-byte base64 string.
 */

function key(): Buffer {
  const raw = Buffer.from(env.tokenEncryptionKey, 'base64');
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes (base64). Generate: openssl rand -base64 32');
  }
  return raw;
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.ciphertext, all base64
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}
