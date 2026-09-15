import { hasColumn } from './columns.js';

/**
 * Where an email's body and links live.
 *
 * Migration 0010 gives them columns of their own, which is where they
 * belong. Until it is applied they go into `extracted_json`, which is
 * already a jsonb column on `emails` and needs no DDL — and DDL is the one
 * thing this deployment cannot do for itself, because the migration runner
 * needs a Postgres connection string that has to be pasted in by hand.
 *
 * The alternative was leaving the body unstored until somebody ran the
 * migration, and an assistant that cannot read the mail is the whole
 * problem this was meant to solve. The keys are underscore-prefixed to mark
 * them as stored verbatim rather than written by the model, so they are
 * obvious in the data and easy to drop once the columns exist.
 */
const BODY_KEY = '_body';
const LINKS_KEY = '_links';

export interface StoredLink {
  url: string;
  host: string;
}

export async function bodyColumnsReady(): Promise<boolean> {
  return hasColumn('emails', 'body_text');
}

/**
 * The fields to write for a message's text, shaped for wherever they go.
 * `extracted` is whatever the classifier produced, so the fallback keeps it.
 */
export async function bodyFields(
  body: string,
  links: StoredLink[],
  extracted: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  if (await bodyColumnsReady()) {
    return { body_text: body, links, extracted_json: extracted };
  }
  return {
    extracted_json: { ...(extracted ?? {}), [BODY_KEY]: body, [LINKS_KEY]: links },
  };
}

/** A stored row, whichever way round it was written. */
export interface StoredEmailText {
  body: string | null;
  links: StoredLink[];
}

export function readStoredText(row: {
  body_text?: string | null;
  links?: StoredLink[] | null;
  extracted_json?: Record<string, unknown> | null;
}): StoredEmailText {
  const extracted = row.extracted_json ?? {};
  const body = row.body_text ?? (typeof extracted[BODY_KEY] === 'string' ? (extracted[BODY_KEY] as string) : null);
  const stored = row.links ?? (Array.isArray(extracted[LINKS_KEY]) ? (extracted[LINKS_KEY] as StoredLink[]) : null);
  return { body: body || null, links: stored ?? [] };
}

/**
 * The extraction as the assistant should see it — without the raw text we
 * tucked inside it, which would otherwise be handed back as though the
 * model had written it, and would double the tokens of every summary.
 */
export function withoutStoredText(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted) return null;
  const { [BODY_KEY]: _b, [LINKS_KEY]: _l, ...rest } = extracted;
  void _b;
  void _l;
  return rest;
}
