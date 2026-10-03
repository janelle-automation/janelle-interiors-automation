import { SlackError, joinChannel, listChannels, normalizeChannelName, type SlackChannel } from './slack.js';

/**
 * Which channel a project's updates belong in.
 *
 *   1. The channel an admin assigned to the project, if any.
 *   2. A channel whose name matches the project's — only one Slack has told
 *      us exists, never a guess posted blind into the workspace.
 *   3. The studio's default channel.
 *
 * Reading the channel list needs scopes the bot may not have been given
 * (channels:read, groups:read). Without them step 2 is skipped and the
 * result says so, so the settings screen can tell the admin what to add
 * rather than leaving every project quietly on the default channel.
 */

export interface ProjectRef {
  name: string;
  slack_channel?: string | null;
}

export interface ChannelDirectory {
  channels: SlackChannel[];
  /** The bot could not read the channel list; matching by name is off. */
  missingScope: boolean;
}

const EMPTY: ChannelDirectory = { channels: [], missingScope: false };

export async function loadDirectory(token: string): Promise<ChannelDirectory> {
  try {
    return { channels: await listChannels(token), missingScope: false };
  } catch (err) {
    if (err instanceof SlackError && err.code === 'missing_scope') return { channels: [], missingScope: true };
    // Rate limit, network: carry on with explicit assignments only for this run.
    console.error('[slack] channel list unavailable:', (err as Error).message);
    return EMPTY;
  }
}

/** Slack channel IDs: C public, G older private. */
const isChannelId = (s: string) => /^[CG][A-Z0-9]{8,}$/.test(s);

/** One word of a name, without a plural "s" — "lemons" and "Lemon" are the same word. */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const words = (name: string) => normalizeChannelName(name).split('-').filter(Boolean).map(stem);

/** Same word, allowing one slipped letter in a longer one ("lamons" for "lemons"). */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return true;
}

/**
 * The automatic match for a project name, or null when no channel's name agrees.
 * An exact match wins. Otherwise a channel matches when every word in its name
 * is a word of the project's — #lemons for "Lemon Residence Mudroom" — and the
 * channel with the most such words is taken; a tie is no match, not a guess.
 */
export function matchChannel(projectName: string, dir: ChannelDirectory): SlackChannel | null {
  const want = normalizeChannelName(projectName);
  if (!want) return null;
  const exact = dir.channels.find((c) => normalizeChannelName(c.name) === want);
  if (exact) return exact;

  const pw = words(projectName);
  let best: SlackChannel | null = null;
  let bestN = 0;
  let tie = false;
  for (const c of dir.channels) {
    const cw = words(c.name);
    if (!cw.length || !cw.every((w) => pw.some((p) => sameWord(w, p)))) continue;
    if (cw.length > bestN) { best = c; bestN = cw.length; tie = false; }
    else if (cw.length === bestN) tie = true;
  }
  return tie ? null : best;
}

/**
 * The channel to post a project's update to. `fallback` is the studio's
 * default and is returned for no project, no match, or a blank assignment.
 */
export function channelFor(project: ProjectRef | null, dir: ChannelDirectory, fallback: string): string {
  if (!project) return fallback;
  const assigned = (project.slack_channel ?? '').trim().replace(/^#/, '');
  if (assigned) {
    if (isChannelId(assigned)) return assigned;
    // Assigned by name: use the ID when the list knows it, the name when it
    // does not (the bot may simply lack the scope to see it).
    const known = dir.channels.find((c) => normalizeChannelName(c.name) === normalizeChannelName(assigned));
    return known?.id ?? assigned;
  }
  return matchChannel(project.name, dir)?.id ?? fallback;
}

/** Errors that mean "this channel will not take the bot's post", where the default channel still can. */
export const ROUTE_FALLBACK_CODES = ['channel_not_found', 'not_in_channel', 'is_archived'];

export type JoinResult = 'joined' | 'already' | 'private' | 'unknown' | 'missing_scope' | 'failed';

/**
 * Put the bot in a public channel it is not in yet, so a new project channel
 * needs no /invite. Private channels cannot be joined by a bot and stay an
 * invite; a channel the list does not know is left to the post to report.
 */
export async function joinIfNeeded(token: string, channel: string, dir: ChannelDirectory): Promise<JoinResult> {
  const name = normalizeChannelName(channel.replace(/^#/, ''));
  const ch = dir.channels.find((c) => c.id === channel || normalizeChannelName(c.name) === name);
  if (!ch) return 'unknown';
  if (ch.isMember) return 'already';
  if (ch.isPrivate) return 'private';
  try {
    await joinChannel(token, ch.id);
    ch.isMember = true;
    return 'joined';
  } catch (err) {
    if (err instanceof SlackError && err.code === 'missing_scope') return 'missing_scope';
    console.error('[slack] could not join channel', ch.name, (err as Error).message);
    return 'failed';
  }
}

export const JOIN_SCOPE_HINT = 'Add the channels:join permission to the Slack app and reinstall it so the bot can join new project channels by itself.';
