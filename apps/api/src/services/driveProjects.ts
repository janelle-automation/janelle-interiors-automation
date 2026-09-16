import type { drive_v3 } from 'googleapis';
import { PROJECT_STAGES, type ProjectStage } from '@janelle/shared';
import { supabaseAdmin } from '../lib/supabase.js';
import { forgetStudioNames } from '../lib/studioNames.js';
import { isStudioName } from '../lib/studioTeam.js';
import { extractJson } from './anthropic.js';
import { readDriveText, type DriveFile } from './drive.js';
import { cleanProjectName, matchProjectId } from './promote.js';

/**
 * The studio's projects, as it keeps them in Google Drive.
 *
 * The studio files every job in a folder of its own under one parent —
 * "Design Department › CLIENTS/Projects › 3. Bernthal" — and keeps finished
 * jobs under "Archived Client Project". That folder list is the studio's own
 * record of what its projects are, so it is read as such:
 *
 * - every project folder is a project, and an archived one is an archived
 *   project, so mail about an old job files to it rather than inventing one;
 * - a PDF is read only when it sits inside a project folder, and it belongs
 *   to that project by where it is filed, not by what the reader guessed —
 *   an estimate in the Bernthal folder is the Bernthal job's, whatever it
 *   calls itself;
 * - the studio's status document in that folder ("Janelle Interiors
 *   Projects") gives each job its client, stage, who is on it and what is
 *   blocking it.
 *
 * Files anywhere else in Drive are not read at all. Reading "the fifteen
 * newest PDFs in Drive" picked up whatever had been opened last, and made a
 * project of it.
 */

const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';

/** Where the studio keeps its project folders. */
export const PROJECTS_FOLDER_NAME = 'CLIENTS/Projects';
const SETTINGS_FOLDER_KEY = 'drive_projects_folder';
const SETTINGS_DOC_KEY = 'drive_projects_doc_read';

/** A top-level folder holding finished jobs, one sub-folder each. */
const ARCHIVE_PARENT = /\barchiv/i;
/** Superseded paperwork inside a job: old bids would become live purchase orders. */
const SKIP_INSIDE = /archiv|supersed|old bids|declined|do not use|obsolete/i;

/** How far back Drive PDFs are read. Older paperwork is history, and reading it costs. */
export const DRIVE_LOOKBACK_DAYS = 30;

/**
 * Vendor paperwork, by its name: what becomes a vendor, a purchase order or a
 * price. A project folder also holds drawings, renderings, moodboards and
 * spec books — two hundred of them in a month here — and reading each one
 * costs a Claude call while adding nothing the folder does not already say:
 * which project it belongs to.
 */
export const PAPERWORK =
  /quot|estimate|proposal|invoice|\bp\.?o\.?\b|purchase|order|confirm|\bbids?\b|sales|reserve|receipt|contract|agreement|pricing|budget|\bbill\b/i;

interface FolderNode {
  id: string;
  name: string;
  parent: string | null;
}

export interface ProjectFolder {
  folderId: string;
  /** The folder's own name, "1. Lemon's Project". */
  folderName: string;
  /** The project name it stands for, "Lemon". */
  name: string;
  archived: boolean;
}

export interface DriveProjects {
  rootId: string;
  driveId: string | null;
  folders: Map<string, FolderNode>;
  projects: ProjectFolder[];
  statusDoc: { id: string; name: string; modifiedTime: string } | null;
}

async function listAll(
  drive: drive_v3.Drive,
  q: string,
  fields: string,
  driveId: string | null,
): Promise<drive_v3.Schema$File[]> {
  const out: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q,
      fields: `nextPageToken, files(${fields})`,
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(driveId ? { corpora: 'drive', driveId } : { corpora: 'allDrives' }),
    });
    out.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

/** "1. Lemon's Project" → "Lemon"; "11. OVIS Oak, Ballroom and Bathrooms FF&E" keeps its words. */
export function projectNameFromFolder(folderName: string): string {
  const unnumbered = folderName.replace(/^\s*\d+\s*[.)\-:]\s*/, '').trim();
  return cleanProjectName(unnumbered) || unnumbered;
}

/** The folder the studio names in settings, or the usual one. */
async function folderNameFor(orgId: string): Promise<string> {
  if (!supabaseAdmin) return PROJECTS_FOLDER_NAME;
  const { data } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  const setting = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {})[SETTINGS_FOLDER_KEY];
  return typeof setting === 'string' && setting.trim() ? setting.trim() : PROJECTS_FOLDER_NAME;
}

/**
 * The project folders, every folder beneath them, and the status document.
 * Null when the studio has no such folder — Drive is then read as before.
 */
export async function loadDriveProjects(orgId: string, drive: drive_v3.Drive): Promise<DriveProjects | null> {
  const folderName = await folderNameFor(orgId);
  const escaped = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const roots = await listAll(drive, `name = '${escaped}' and mimeType = '${FOLDER}' and trashed = false`, 'id, name, driveId', null);
  const root = roots[0];
  if (!root?.id) return null;
  const driveId = root.driveId ?? null;

  // Every folder at once when the projects live in a shared drive — a few
  // calls, however deep the job folders go. Outside one, walk down instead.
  const folders = new Map<string, FolderNode>();
  if (driveId) {
    const all = await listAll(drive, `mimeType = '${FOLDER}' and trashed = false`, 'id, name, parents', driveId);
    for (const f of all) if (f.id) folders.set(f.id, { id: f.id, name: f.name ?? '', parent: f.parents?.[0] ?? null });
  } else {
    const queue = [root.id];
    while (queue.length && folders.size < 2000) {
      const parent = queue.shift()!;
      const kids = await listAll(drive, `'${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`, 'id, name', null);
      for (const k of kids) {
        if (!k.id) continue;
        folders.set(k.id, { id: k.id, name: k.name ?? '', parent });
        queue.push(k.id);
      }
    }
  }

  const children = (id: string) => [...folders.values()].filter((f) => f.parent === id);
  const projects: ProjectFolder[] = [];
  for (const top of children(root.id)) {
    if (ARCHIVE_PARENT.test(top.name)) {
      for (const old of children(top.id)) {
        projects.push({ folderId: old.id, folderName: old.name, name: projectNameFromFolder(old.name), archived: true });
      }
    } else {
      projects.push({ folderId: top.id, folderName: top.name, name: projectNameFromFolder(top.name), archived: false });
    }
  }

  const docs = await listAll(drive, `'${root.id}' in parents and mimeType = '${GOOGLE_DOC}' and trashed = false`, 'id, name, modifiedTime', null);
  const status = docs.find((d) => /project/i.test(d.name ?? '')) ?? null;

  return {
    rootId: root.id,
    driveId,
    folders,
    projects: projects.filter((p) => p.name.length >= 2),
    statusDoc: status?.id ? { id: status.id, name: status.name ?? 'Projects', modifiedTime: status.modifiedTime ?? '' } : null,
  };
}

/**
 * The project folder something in Drive is filed under, or null — for files
 * outside every project folder, and for files in a job's archive or
 * superseded folders.
 */
export function projectFolderOf(dp: DriveProjects, parents: string[] | null | undefined): ProjectFolder | null {
  let id = parents?.[0] ?? null;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const project = dp.projects.find((p) => p.folderId === id);
    if (project) return project;
    const node = dp.folders.get(id);
    if (!node) return null;
    // Inside a job, its archive and superseded folders hold paperwork that no
    // longer stands. (An archived JOB is found above, before its parent.)
    if (SKIP_INSIDE.test(node.name)) return null;
    id = node.parent;
  }
  return null;
}

/**
 * Make sure every project folder has its project, and say which is which.
 *
 * Matched by name — exact first, so "OVIS Cabana" is never taken for "OVIS
 * Spa Cabana" — and created when missing. A folder moved into the archive
 * archives its project; one moved back out makes it active again. Names are
 * left alone once a project exists: a better name found in its paperwork
 * ("Lemon Residence") is kept over the folder's shorthand.
 */
export async function syncProjectsFromDrive(orgId: string, dp: DriveProjects): Promise<{ map: Map<string, string>; created: number }> {
  const map = new Map<string, string>();
  if (!supabaseAdmin) return { map, created: 0 };
  const { data } = await supabaseAdmin.from('projects').select('id, name, status').eq('org_id', orgId);
  const rows = (data ?? []) as { id: string; name: string; status: string }[];
  let created = 0;

  // Exact names claim their projects first, so a looser match cannot take a
  // project that another folder names exactly.
  const ordered = [...dp.projects].sort((a, b) => Number(Boolean(matchExact(rows, b.name))) - Number(Boolean(matchExact(rows, a.name))));
  const claimed = new Set<string>();
  for (const folder of ordered) {
    const free = rows.filter((r) => !claimed.has(r.id));
    const id = matchExact(free, folder.name) ?? matchProjectId(free, folder.name);
    const status = folder.archived ? 'archived' : 'active';
    if (id) {
      claimed.add(id);
      map.set(folder.folderId, id);
      const row = rows.find((r) => r.id === id)!;
      if ((row.status === 'archived') !== folder.archived) {
        await supabaseAdmin.from('projects').update({ status }).eq('id', id);
      }
      continue;
    }
    const { data: inserted } = await supabaseAdmin
      .from('projects')
      .insert({ org_id: orgId, name: folder.name, stage: 'concept', status })
      .select('id')
      .maybeSingle();
    const newId = (inserted as { id?: string } | null)?.id;
    if (newId) {
      created++;
      claimed.add(newId);
      rows.push({ id: newId, name: folder.name, status });
      map.set(folder.folderId, newId);
    }
  }
  if (created) forgetStudioNames(orgId);
  return { map, created };
}

function matchExact(rows: { id: string; name: string }[], name: string): string | null {
  const key = (s: string) => cleanProjectName(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hits = rows.filter((r) => key(r.name) === key(name));
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * Vendor paperwork (PAPERWORK) filed in project folders, changed in the last
 * DRIVE_LOOKBACK_DAYS, newest first, each with the project folder it sits
 * in. Active projects only: an archived job's paperwork is history.
 */
export async function listProjectPdfs(
  drive: drive_v3.Drive,
  dp: DriveProjects,
): Promise<{ file: DriveFile; folder: ProjectFolder }[]> {
  const since = new Date(Date.now() - DRIVE_LOOKBACK_DAYS * 86400_000).toISOString();
  const q = `mimeType = 'application/pdf' and trashed = false and modifiedTime > '${since}'`;
  const files = dp.driveId
    ? await listAll(drive, q, 'id, name, mimeType, modifiedTime, size, parents', dp.driveId)
    : await listAll(drive, q, 'id, name, mimeType, modifiedTime, size, parents', null);
  return files
    .map((f) => ({ f, folder: projectFolderOf(dp, f.parents) }))
    .filter((x): x is { f: drive_v3.Schema$File; folder: ProjectFolder } => Boolean(x.folder && !x.folder.archived && x.f.id))
    .filter((x) => PAPERWORK.test(x.f.name ?? ''))
    .sort((a, b) => (b.f.modifiedTime ?? '').localeCompare(a.f.modifiedTime ?? ''))
    .map(({ f, folder }) => ({
      file: {
        id: f.id!,
        name: f.name ?? 'untitled.pdf',
        mimeType: f.mimeType ?? 'application/pdf',
        modifiedTime: f.modifiedTime ?? '',
        size: Number(f.size ?? 0) || 0,
      },
      folder,
    }));
}

// ── The studio's status document ──────────────────────────────

interface StatusRow {
  project: string;
  client: string | null;
  location: string | null;
  stage: ProjectStage | null;
  who: string | null;
  blocking: string | null;
  urgency: string | null;
}

const STATUS_SYSTEM = `You are reading an interior design studio's own project status document. For each project it
describes, return what it says. Match each to ONE project from the studio's folder list given with the
document, by meaning ("Lemon Project" is "Lemon", "Ojai Valley Inn — Golf Shop" is "OVIS GOLF", "Cabanas —
OVIS Indigo Pool" is "OVIS Cabana"); skip anything that is not one of those projects.

Return JSON: { "as_of": the document's date as written, or null,
  "projects": [ { "project": the folder-list name EXACTLY,
    "client": who the job is for — the homeowner or the hotel (Ojai Valley Inn), never the studio — or null,
    "location": the address or place, or null,
    "stage": one of ${PROJECT_STAGES.map((s) => `"${s}"`).join(', ')} that best fits what the document says, or null,
    "who": who is on it, as written, or null,
    "blocking": what is blocking it or needed next, as written, or null,
    "urgency": as written, or null } ] }`;

const NOTES_MARK = '— From the studio’s project document';

/**
 * Give each project what the studio's status document says about it.
 *
 * Read only when the document has changed since the last read, so it costs
 * one Claude call per edit, not per pass. The client is filled when missing
 * or when it was wrongly recorded as the studio; the stage only ever moves
 * forward; the document's lines go into the project's notes under a heading
 * of their own, replaced on each read, so notes people wrote stay untouched.
 */
export async function syncProjectStatusDoc(
  orgId: string,
  drive: drive_v3.Drive,
  dp: DriveProjects,
  map: Map<string, string>,
): Promise<{ read: boolean; updated: number }> {
  if (!supabaseAdmin || !dp.statusDoc) return { read: false, updated: 0 };
  const { data: org } = await supabaseAdmin.from('organizations').select('settings').eq('id', orgId).maybeSingle();
  const settings = ((org as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const stamp = `${dp.statusDoc.id}@${dp.statusDoc.modifiedTime}`;
  if (settings[SETTINGS_DOC_KEY] === stamp) return { read: false, updated: 0 };

  const text = await readDriveText(drive, { id: dp.statusDoc.id, mimeType: GOOGLE_DOC }, 30_000);
  if (!text?.trim()) return { read: false, updated: 0 };

  const active = dp.projects.filter((p) => !p.archived && map.has(p.folderId));
  const result = await extractJson<{ as_of: string | null; projects: StatusRow[] }>(
    STATUS_SYSTEM,
    `The studio's project folders:\n${active.map((p) => `- ${p.name}`).join('\n')}\n\n— THE DOCUMENT: ${dp.statusDoc.name} —\n\n${text}`,
    { feature: 'document.extract', orgId, entity: 'projects' },
  );
  if (!result?.projects?.length) return { read: true, updated: 0 };

  let updated = 0;
  for (const row of result.projects) {
    const folder = active.find((p) => p.name.toLowerCase() === String(row.project ?? '').toLowerCase());
    const projectId = folder ? map.get(folder.folderId) : null;
    if (!projectId) continue;
    const { data: current } = await supabaseAdmin
      .from('projects')
      .select('client_name, stage, notes')
      .eq('id', projectId)
      .maybeSingle();
    const p = current as { client_name: string | null; stage: ProjectStage; notes: string | null } | null;
    if (!p) continue;

    const patch: Record<string, unknown> = {};
    if (row.client && !isStudioName(row.client) && (!p.client_name || isStudioName(p.client_name))) patch.client_name = row.client;
    if (row.stage && PROJECT_STAGES.includes(row.stage) && PROJECT_STAGES.indexOf(row.stage) > PROJECT_STAGES.indexOf(p.stage)) {
      patch.stage = row.stage;
    }
    const lines = [
      `${NOTES_MARK}${result.as_of ? ` (${result.as_of})` : ''}:`,
      row.location ? `Location: ${row.location}` : null,
      row.who ? `Who's on it: ${row.who}` : null,
      row.blocking ? `What's blocking it: ${row.blocking}` : null,
      row.urgency ? `Urgency: ${row.urgency}` : null,
    ].filter(Boolean);
    const own = (p.notes ?? '').split(NOTES_MARK)[0].trim();
    const notes = [own, lines.join('\n')].filter(Boolean).join('\n\n');
    if (notes !== (p.notes ?? '')) patch.notes = notes;

    if (Object.keys(patch).length) {
      await supabaseAdmin.from('projects').update(patch).eq('id', projectId);
      updated++;
    }
  }

  await supabaseAdmin.from('organizations').update({ settings: { ...settings, [SETTINGS_DOC_KEY]: stamp } }).eq('id', orgId);
  if (updated) forgetStudioNames(orgId);
  return { read: true, updated };
}
