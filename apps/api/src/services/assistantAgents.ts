import { AGENT_KEYS, type AgentKey } from '@janelle/shared';

/**
 * Tool gating by named agent — a second, independent axis alongside the
 * role/permission checks `runTool` already does. Picking no agent leaves
 * every tool reachable, exactly as before this existed; picking one or
 * more narrows `runTool` to just their tools (plus the ones below, which
 * are never worth gating).
 */

/**
 * Available no matter what is picked.
 *
 * `answer` and `respond_to_proposal` are the loop's own plumbing, not a
 * studio capability. `read_document` hands over whatever attachment a
 * person is already looking at, regardless of which domain it came from.
 * `make_image`/`make_video` are reachable ungated through the composer's
 * Image/Video mode (POST /assistant/imagine, outside this tool loop
 * entirely) — gating them only here would restrict nothing real.
 *
 * `get_today` and `list_team` are deliberately NOT here — each bot is meant
 * to do one job the way the studio's other bots do, and "what does my day
 * look like" is specifically Chief of Staff's job, not every agent's.
 */
export const ALWAYS_ON_TOOLS: string[] = [
  'answer',
  'respond_to_proposal',
  'read_document',
  'make_image',
  'make_video',
];

export const AGENT_TOOLS: Record<AgentKey, string[]> = {
  inbox: [
    'search_email',
    'read_email',
    'list_drafts',
    'propose_draft',
    'find_attachments',
    'gmail_search',
    'gmail_read',
    'drive_search',
    'drive_read',
    // Pulls from Drive and email attachments as much as from procurement or
    // project files — an equally natural ask under more than one persona.
    'search_documents',
  ],
  vendors: [
    'list_vendors',
    'list_purchase_orders',
    'list_follow_ups',
    'search_documents',
  ],
  projects: [
    'list_projects',
    'get_project_status',
    'list_tasks',
    'propose_task',
    'propose_task_update',
    'list_spec_gaps',
    'list_studio_prompts',
    'render_board',
    'run_studio_prompt',
    'search_documents',
    // Assigning a task needs to know who is on the team.
    'list_team',
  ],
  // Capture only, on purpose: George's whole job is turning free text into a
  // task with nothing else — no lookups, no digest, just the one write.
  george: ['propose_task'],
  chief: [
    'get_today',
    'get_weekly_report',
    'get_studio_rules',
    'get_recent_activity',
    'get_ai_spend',
    'list_team',
  ],
};

/** Whether the active agent selection permits this tool. Empty = unrestricted. */
export function agentAllows(activeAgents: AgentKey[], toolName: string): boolean {
  if (!activeAgents.length) return true;
  if (ALWAYS_ON_TOOLS.includes(toolName)) return true;
  return activeAgents.some((key) => AGENT_TOOLS[key].includes(toolName));
}

/** Which agent(s) own a tool — for naming the right one in a refusal. */
export function agentsFor(toolName: string): AgentKey[] {
  return AGENT_KEYS.filter((key) => AGENT_TOOLS[key].includes(toolName));
}
