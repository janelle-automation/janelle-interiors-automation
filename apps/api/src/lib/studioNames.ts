import { SEATS, type Seat } from '@janelle/shared';
import { supabaseAdmin } from './supabase.js';
import { profileColumns } from './columns.js';
import { STUDIO_DOMAINS, STUDIO_MAILBOXES, STUDIO_TEAM, isStudioMailbox, isStudioName, studioPerson } from './studioTeam.js';

/**
 * The names the studio already has on file: its projects and their clients,
 * its vendors, and its own people.
 *
 * Extraction used to read every email blind. Asked for "the project", Claude
 * wrote down the email's own wording — "Lemon's", "Lemon's Project" — and
 * that wording became a project row, a task title and a board column. Given
 * the list, it can say "this is Lemon Residence" instead, and tell a client
 * from a vendor from a colleague, which the email alone often cannot.
 */

export interface StudioNames {
  /** Archived jobs included, so mail about an old job files to it instead of opening a new one. */
  projects: { id: string; name: string; client_name: string | null; archived?: boolean }[];
  vendors: { id: string; name: string }[];
  /**
   * The studio's people: every account, plus anyone on the studio's own list
   * who has no account yet (id null). Shared inboxes are not people and are
   * never here.
   */
  team: { id: string | null; full_name: string; email: string | null; seat: Seat | null; aliases: string[] }[];
}

const EMPTY: StudioNames = { projects: [], vendors: [], team: [] };

/**
 * A reading pass classifies many emails in a row; the names barely change
 * between them. Kept for a minute, and forgotten the moment a new project or
 * vendor is created, so the next email in the same pass sees it.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; names: StudioNames }>();

export function forgetStudioNames(orgId: string): void {
  cache.delete(orgId);
}

export async function loadStudioNames(orgId: string): Promise<StudioNames> {
  if (!supabaseAdmin) return EMPTY;
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;

  const [projects, vendors, team] = await Promise.all([
    supabaseAdmin.from('projects').select('id, name, client_name, status').eq('org_id', orgId),
    supabaseAdmin.from('vendors').select('id, name').eq('org_id', orgId),
    supabaseAdmin.from('profiles').select(await profileColumns('id, full_name, email')).eq('org_id', orgId),
  ]);

  const names: StudioNames = {
    projects: ((projects.data ?? []) as { id: string; name: string; client_name: string | null; status: string }[])
      .filter((p) => p.name)
      .map(({ id, name, client_name, status }) => ({ id, name, client_name, archived: status === 'archived' })),
    vendors: ((vendors.data ?? []) as { id: string; name: string }[]).filter((v) => v.name),
    team: teamOf((team.data ?? []) as unknown as Account[]),
  };
  cache.set(orgId, { at: Date.now(), names });
  return names;
}

type Account = { id: string; full_name: string | null; email: string | null; seat?: Seat | null };

/**
 * Accounts first, then the listed teammates who have none.
 *
 * Three of the team write from personal Gmail addresses. Until each has an
 * account, the studio's own list is the only thing that says their mail is
 * a colleague's and not a client's.
 */
function teamOf(accounts: Account[]): StudioNames['team'] {
  const people = accounts
    .filter((p) => p.full_name && !isStudioMailbox(p.email))
    .map((p) => {
      const known = studioPerson({ email: p.email, name: p.full_name });
      return {
        id: p.id,
        full_name: p.full_name as string,
        email: p.email ?? known?.email ?? null,
        seat: p.seat ?? known?.seat ?? null,
        aliases: known ? [known.name, ...(known.aliases ?? [])].filter((n) => n !== p.full_name) : [],
      };
    });
  const missing = STUDIO_TEAM.filter((t) => !people.some((p) => p.email?.toLowerCase() === t.email)).map((t) => ({
    id: null,
    full_name: t.name,
    email: t.email,
    seat: t.seat,
    aliases: t.aliases ?? [],
  }));
  return [...people, ...missing];
}

/** Enough to recognise a name by; a studio's lists are short, but not unbounded. */
const LIMIT = { projects: 120, vendors: 120, team: 40 };

/**
 * The lists, as a block a prompt can carry.
 *
 * Plain lines rather than JSON: a model copies a name out of a line exactly,
 * and exact copying is the whole point — the name it returns is matched back
 * against these rows.
 */
export function studioNamesBlock(names: StudioNames): string {
  // A client recorded as the studio itself is a mistake, and repeating it here
  // taught the model to repeat it: the Lemon job came back as the studio's own.
  const projects = names.projects
    .slice(0, LIMIT.projects)
    .map(
      (p) =>
        `- ${p.name}${p.client_name && !isStudioName(p.client_name) ? ` — client: ${p.client_name}` : ''}${p.archived ? ' (archived, finished job)' : ''}`,
    );
  const vendors = names.vendors.slice(0, LIMIT.vendors).map((v) => `- ${v.name}`);
  const team = names.team.slice(0, LIMIT.team).map((p) =>
    [
      `- ${p.full_name}`,
      p.email ? ` <${p.email}>` : '',
      p.seat ? ` — ${SEATS[p.seat].label}` : '',
      p.aliases.length ? ` (also written ${p.aliases.map((a) => `"${a}"`).join(', ')})` : '',
    ].join(''),
  );
  const domains = STUDIO_DOMAINS.map((d) => `@${d}`).join(' or ');
  return [
    'THE STUDIO\'S OWN RECORDS — use these names exactly as written wherever the email refers to one of them.',
    '',
    'Existing projects:',
    projects.length ? projects.join('\n') : '- (none yet)',
    '',
    'Known vendors:',
    vendors.length ? vendors.join('\n') : '- (none yet)',
    '',
    'The studio team — these people are never a client and never a vendor, whichever address they write from:',
    team.length ? team.join('\n') : '- (unknown)',
    '',
    `The studio itself: any address ending ${domains}. The shared inbox ${STUDIO_MAILBOXES.join(', ')} is the studio, not a person — never a client, never a vendor, never the one asked to do the work.`,
  ].join('\n');
}
