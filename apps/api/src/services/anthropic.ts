import Anthropic from '@anthropic-ai/sdk';
import { env, isAnthropicConfigured } from '../env.js';

/**
 * Single Anthropic client for the intelligence layer. Null until an
 * API key is configured, so callers degrade gracefully.
 */
export const anthropic: Anthropic | null = isAnthropicConfigured()
  ? new Anthropic({ apiKey: env.anthropic.apiKey })
  : null;

export class AnthropicNotConfigured extends Error {
  constructor() {
    super('Claude API is not configured (set ANTHROPIC_API_KEY).');
    this.name = 'AnthropicNotConfigured';
  }
}

/** Concatenate the text blocks of a Claude response. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** Pull the first balanced JSON object/array out of a string. */
export function firstJson<T>(text: string): T | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

type UserContent = string | Anthropic.ContentBlockParam[];

/**
 * Ask Claude for a JSON object matching a described shape. The prompt
 * must instruct the required fields; this returns the parsed object or
 * null if nothing parseable came back.
 */
export async function extractJson<T>(system: string, user: UserContent): Promise<T | null> {
  if (!anthropic) throw new AnthropicNotConfigured();
  const message = await anthropic.messages.create({
    model: env.anthropic.model,
    max_tokens: 4096,
    system: `${system}\n\nRespond with ONLY a single JSON object. No prose, no code fences.`,
    messages: [{ role: 'user', content: user }],
  });
  return firstJson<T>(textOf(message));
}

/** Free-form generation (prompt runner, report narrative). */
export async function generate(system: string, user: string, maxTokens = 8000): Promise<string> {
  if (!anthropic) throw new AnthropicNotConfigured();
  const message = await anthropic.messages.create({
    model: env.anthropic.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return textOf(message);
}
