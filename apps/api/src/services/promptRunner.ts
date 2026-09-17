import type { SupabaseClient } from '@supabase/supabase-js';
import type { PromptVariable } from '@janelle/shared';
import { generate } from './anthropic.js';

/**
 * Running one of the studio's library prompts.
 *
 * Lives apart from the route because Jenny runs them too. The Prompt Studio
 * and the assistant must produce the same work from the same prompt — if the
 * studio's moodboard prompt is the standard, it cannot quietly become a
 * different standard the moment someone asks for a moodboard in the chat.
 */

export const PROMPT_RUN_SYSTEM =
  'You are an assistant for an interior design studio. Write in a warm, precise, professional ' +
  'studio voice. Return only the requested content.';

export interface LibraryPrompt {
  id: string;
  title: string;
  template: string;
  variables: PromptVariable[] | null;
}

/** The library row a name refers to: an id, then an exact title, then a partial one. */
export function matchPrompt<T extends { id: string; title: string }>(rows: T[], wanted: string): T | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  return (
    rows.find((r) => r.id === wanted) ??
    rows.find((r) => r.title.toLowerCase() === needle) ??
    rows.find((r) => r.title.toLowerCase().includes(needle)) ??
    // Last resort, so "moodboard for the primary bath" still finds
    // "Primary bathroom moodboard": every word of the title present.
    rows.find((r) => r.title.toLowerCase().split(/\s+/).every((w) => needle.includes(w))) ??
    null
  );
}

/** The labels of the required inputs that were not supplied. */
export function missingInputs(vars: PromptVariable[] | null, values: Record<string, string>): string[] {
  return (vars ?? []).filter((v) => v.required && !values[v.key]?.trim()).map((v) => v.label);
}

/** `{{key}}` → the value, with anything unfilled left blank rather than printed. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values[key] ?? '');
}

/**
 * Run a prompt and record it. The run is logged wherever it was started
 * from, so `prompt_runs` stays the honest history of what the studio has
 * asked Claude to write.
 */
export async function runLibraryPrompt(
  db: SupabaseClient,
  prompt: LibraryPrompt,
  values: Record<string, string>,
  ctx: { orgId: string | null; userId: string; projectId?: string | null },
): Promise<string> {
  const output = await generate(PROMPT_RUN_SYSTEM, fillTemplate(prompt.template, values), {
    feature: 'prompt.run',
    orgId: ctx.orgId,
    actor: ctx.userId,
    entity: 'prompts',
    entityId: prompt.id,
  });

  await db.from('prompt_runs').insert({
    org_id: ctx.orgId,
    prompt_id: prompt.id,
    project_id: ctx.projectId ?? null,
    user_id: ctx.userId,
    input: values,
    output,
  });

  return output;
}
