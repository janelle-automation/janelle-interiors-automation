import { SlackError, listChannels, normalizeChannelName, type SlackChannel } from './slack.js';

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

/** The automatic match for a project name, or null when no channel's name agrees. */
export function matchChannel(projectName: string, dir: ChannelDirectory): SlackChannel | null {
  const want = normalizeChannelName(projectName);
  if (!want) return null;
  return dir.channels.find((c) => normalizeChannelName(c.name) === want) ?? null;
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
