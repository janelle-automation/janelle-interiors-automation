import { SEATS, type Seat, type UserRole } from '@janelle/shared';

/**
 * The studio's own people and addresses, as the studio listed them.
 *
 * Accounts (`profiles`) remain the source of truth for who can sign in and
 * who a task can be given to. This list covers what an account cannot:
 *
 * - A teammate with no account yet is still a teammate. Three of them write
 *   from personal Gmail addresses, and without this their mail read as a
 *   client's — their names became client names, their addresses vendor
 *   contacts.
 * - A shared mailbox is the studio, not a person. systems@ signs in and
 *   connects Gmail, but nobody reads a task given to it, and an account named
 *   "Janelle (Admin)" made "give it to Janelle" a coin toss between it and
 *   Janelle herself.
 * - The roles document spells a name one way and the account another.
 *
 * Kept on the server: the Gmail addresses are personal and the web bundle is
 * public. When someone joins or leaves, change it here and on Team & roles.
 */

export interface StudioPerson {
  name: string;
  email: string;
  /** The seat the roles document names them for; null when it names none. */
  seat: Seat | null;
  /** Other spellings people use for them, in documents or aloud. */
  aliases?: string[];
}

/** How the studio names itself on paper. */
export const STUDIO_NAME = 'Janelle Interiors';

/** Any address here is the studio writing, whoever signs it. */
export const STUDIO_DOMAINS = ['janelleinteriors.com'];

/** Shared inboxes: the studio itself — never a person, client, vendor or owner. */
export const STUDIO_MAILBOXES = ['systems@janelleinteriors.com'];

export const STUDIO_TEAM: StudioPerson[] = [
  { name: 'Janelle Kandziora', email: 'janelle@janelleinteriors.com', seat: 'owner' },
  { name: 'Carissa Kolbeck', email: 'carissa@janelleinteriors.com', seat: 'operations' },
  { name: 'Joanna Ramos', email: 'ramos.joannaeve@gmail.com', seat: 'pm_support' },
  { name: 'Victoria Manayan', email: 'manayan.victoriam@gmail.com', seat: 'technical_production' },
  { name: 'Adeleigh McGee', email: 'adeleigh@janelleinteriors.com', seat: 'hotel_ffe', aliases: ['Adelaide McGee'] },
  { name: 'Brianna Johnson', email: 'brianna@janelleinteriors.com', seat: 'design' },
  { name: 'Amanda Neubecker', email: 'amanda.neubecker@gmail.com', seat: 'design' },
  // On the studio's team list with no seat in the roles document.
  { name: 'Taryn Choquette', email: 'taryn@janelleinteriors.com', seat: null },
];

/** The bare address out of "Name <address>", lower-cased; '' when there is none. */
export function addressOf(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  const angled = text.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : text).trim().toLowerCase();
  return address.includes('@') ? address : '';
}

export function isStudioMailbox(raw: string | null | undefined): boolean {
  const address = addressOf(raw);
  return !!address && STUDIO_MAILBOXES.includes(address);
}

/** Written by the studio: its domain, a shared inbox, or a teammate's own address. */
export function isStudioAddress(raw: string | null | undefined): boolean {
  const address = addressOf(raw);
  if (!address) return false;
  return (
    STUDIO_DOMAINS.includes(address.split('@')[1]) ||
    STUDIO_MAILBOXES.includes(address) ||
    STUDIO_TEAM.some((p) => p.email === address)
  );
}

const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The studio's own name or a teammate's full name — never a client, a vendor
 * or a project, however an email or a document puts it.
 */
export function isStudioName(raw: string | null | undefined): boolean {
  const said = plain(raw ?? '');
  if (!said) return false;
  if (said === plain(STUDIO_NAME) || said.startsWith(`${plain(STUDIO_NAME)} `)) return true;
  return STUDIO_TEAM.some((p) => [p.name, ...(p.aliases ?? [])].some((n) => plain(n) === said));
}

/** The teammate an address or a full name belongs to, if the list has them. */
export function studioPerson(said: { email?: string | null; name?: string | null }): StudioPerson | null {
  const address = addressOf(said.email);
  if (address) {
    const byEmail = STUDIO_TEAM.find((p) => p.email === address);
    if (byEmail) return byEmail;
  }
  const name = (said.name ?? '').trim().toLowerCase();
  if (!name) return null;
  return STUDIO_TEAM.find((p) => [p.name, ...(p.aliases ?? [])].some((n) => n.toLowerCase() === name)) ?? null;
}

/** Every name a teammate goes by: the full name first, then the other spellings. */
export function namesFor(person: { full_name: string; email?: string | null }): string[] {
  const known = studioPerson({ email: person.email, name: person.full_name });
  return [person.full_name, ...(known ? [known.name, ...(known.aliases ?? [])] : [])]
    .filter((name, i, all) => all.findIndex((n) => n.toLowerCase() === name.toLowerCase()) === i);
}

/** The access a teammate's seat implies; null when they hold no seat. */
export function seatRole(person: StudioPerson): UserRole | null {
  return person.seat ? SEATS[person.seat].role : null;
}
