import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlob, apiUpload, NetworkError } from './api';
import type {
  Action, AiSettingsView, AiUsageReport, AssistantAnswer, DashboardSummary, IngestSettingsView,
  Prompt, ProjectStage, PoStatus,
  SelectableModel,
  FollowUpType, Resource, Seat, TaskKind, TaskStatus, UserRole,
} from '@janelle/shared';

// ── View models (what the UI renders) ───────────────────────
export interface ProjectView {
  id: string; name: string; client: string; stage: ProjectStage;
  /** The project's own budget figure; null when never set. */
  budget: number | null;
  install: string; openPOs: number;
  /** Total value of the project's purchase orders. */
  committed: number;
  specGaps: number;
  /** Closed work. Kept, but never mixed in with the live pipeline unasked. */
  archived: boolean;
}
export interface PoView {
  id: string; po: string; vendor: string; project: string;
  amount: number; status: PoStatus; eta: string;
  /** Who the order is with, for filtering by the selected vendor. '' when unlinked. */
  vendorId: string;
}
export interface FollowUpView {
  id: string; type: 'vendor_silence' | 'client_approval_overdue' | 'date_slipping' | 'spec_gap';
  who: string; project: string; reason: string; age: string;
}
export interface VendorView {
  id: string; name: string; category: string;
  openPOs: number;
  /** Total value of those open orders. */
  openValue: number;
  /** The vendor's own site, normalized to a full URL; '' when unknown. */
  website: string;
  /** First contact address on file, for the directory subtitle; '' when none. */
  email: string;
}
export interface EmailView {
  id: string; from: string; subject: string; snippet: string;
  cls: string; project: string; when: string;
  /** Sender split out of the RFC header, so a table can show a name, not an address. */
  fromName: string; fromEmail: string;
  /** The vendor the mail was linked to; '' when none. */
  vendor: string;
  /** Full ISO timestamp, for the exact date on hover. */
  receivedAt: string;
}
export interface DocSource {
  kind: 'gmail' | 'drive';
  /** Display name of the sender (falls back to the address). */
  fromName: string;
  fromEmail: string;
  subject: string;
  /** ISO timestamp the email was received (null for Drive files). */
  sharedAt: string | null;
}
export interface DocView {
  id: string; type: string; vendor: string; project: string;
  total: number; confidence: number; when: string;
  /** Full ISO timestamp of the parse, for the exact date on hover. */
  createdAt: string;
  source: DocSource | null;
}
export interface ActivityView { id: string; action: string; detail: string; when: string }

export function ageFrom(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return days <= 0 ? 'today' : `${days} day${days > 1 ? 's' : ''}`;
}

// ── Health & profile ────────────────────────────────────────
export interface Health {
  integrations: { supabase: string; google: string; anthropic: string };
}
export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/health') });
}

export type GoogleService = 'gmail' | 'drive';
export interface Me {
  profile: { full_name: string | null; role: string } | null;
  google: {
    status: string;
    connected_at?: string | null;
    scopes?: string;
    services: Record<GoogleService, boolean>;
  };
}
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
}

// ── Dashboard ───────────────────────────────────────────────
export type Summary = DashboardSummary;

/** Every card at zero, so the page renders before the first response. */
const ZERO_SUMMARY: DashboardSummary = {
  role: null,
  focus: '',
  cards: [],
  figures: {
    myOpenTasks: 0, myOverdueTasks: 0, unassignedTasks: 0, tasksWithoutNextStep: 0,
    openFollowUps: 0, awaitingClient: 0, draftsPending: 0, specGaps: 0, openPOs: 0,
    activeProjects: 0, installsSoon: 0, emailsRead: 0, documentsParsed: 0, escalations: 0,
  },
  byStage: {},
  vacantSeats: [],
};
export function useDashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardSummary>('/dashboard/summary') });
  return { ...q, data: q.data ?? ZERO_SUMMARY };
}

// ── Projects ────────────────────────────────────────────────
interface ProjectRow {
  id: string; name: string; client_name: string | null; stage: ProjectStage;
  status: string;
  budget: number | null; target_install: string | null;
  open_pos: number; po_total: number; spec_gaps: number;
}
export function useProjects() {
  const q = useQuery({
    queryKey: ['projects'],
    queryFn: async (): Promise<ProjectView[]> => {
      const rows = await api<ProjectRow[]>('/projects');
      return rows.map((r) => ({
        id: r.id, name: r.name, client: r.client_name ?? '—', stage: r.stage,
        budget: r.budget, install: r.target_install ?? '',
        openPOs: r.open_pos ?? 0, committed: r.po_total ?? 0, specGaps: r.spec_gaps ?? 0,
        archived: r.status === 'archived',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

export interface ProjectDetail {
  project: {
    id: string; name: string; client_name: string | null; stage: ProjectStage;
    status: string; budget: number | null; target_install: string | null; notes: string | null;
  };
  purchase_orders: {
    id: string; po_number: string | null; amount: number | null; status: string; eta: string | null;
    vendors: { name: string } | null;
    line_items: { id: string }[] | null;
  }[];
  spec_gaps: { id: string; item: string; missing_fields: string[] }[];
  emails: { id: string; subject: string | null; class: string; received_at: string | null; from_addr: string | null }[];
  documents: { id: string; type: string; parsed_json: { vendor?: string; total?: number } | null; created_at: string }[];
}
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => api<ProjectDetail>(`/projects/${id}`),
    enabled: !!id,
  });
}

// ── Vendors ─────────────────────────────────────────────────
interface VendorRow {
  id: string; name: string; category: string | null; website?: string | null;
  contacts?: { name?: string; email?: string; phone?: string }[] | null;
  open_pos?: number; open_value?: number;
}
export function useVendors() {
  const q = useQuery({
    queryKey: ['vendors'],
    queryFn: async (): Promise<VendorView[]> => {
      const rows = await api<VendorRow[]>('/vendors');
      return rows.map((r) => ({
        id: r.id, name: r.name,
        // '' not '—' now: the row decides whether there is anything to show,
        // and an em dash on its own line was most of what the list displayed.
        category: r.category ?? '',
        openPOs: r.open_pos ?? 0,
        openValue: r.open_value ?? 0,
        website: r.website ?? '',
        email: (r.contacts ?? []).find((c) => c.email)?.email ?? '',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

/** What the signed-in role may do to the vendor directory. */
export function useVendorAbilities() {
  return useQuery({
    queryKey: ['vendors', 'can'],
    queryFn: () => api<{ create: boolean; update: boolean; delete: boolean }>('/vendors/can'),
    staleTime: 60_000,
  });
}

export interface NewVendor {
  name: string; website: string; email: string; phone: string;
  contact_name: string; category: string; notes: string;
}
export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewVendor) => api<VendorRow>('/vendors', { method: 'POST', body: JSON.stringify(v) }),
    // The dashboard counts vendors too, so it goes stale on the same event.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Purchase orders ─────────────────────────────────────────
interface PoRow {
  id: string; po_number: string | null; amount: number | null; status: PoStatus;
  eta: string | null; vendor_id: string | null;
  vendors: { name: string } | null; projects: { name: string } | null;
}
export function usePurchaseOrders() {
  const q = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: async (): Promise<PoView[]> => {
      const rows = await api<PoRow[]>('/purchase-orders');
      return rows.map((r) => ({
        id: r.id, po: r.po_number ?? '', vendor: r.vendors?.name ?? '',
        project: r.projects?.name ?? '', amount: r.amount ?? 0, status: r.status, eta: r.eta ?? '',
        vendorId: r.vendor_id ?? '',
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Follow-ups ──────────────────────────────────────────────
interface FollowUpRow {
  id: string; type: FollowUpView['type']; reason: string | null; created_at: string;
  target: string | null; projects: { name: string } | null; vendors: { name: string } | null;
}
export function useFollowUps() {
  const q = useQuery({
    queryKey: ['follow-ups'],
    queryFn: async (): Promise<FollowUpView[]> => {
      const rows = await api<FollowUpRow[]>('/follow-ups');
      return rows.map((r) => ({
        id: r.id, type: r.type,
        who: r.vendors?.name ?? r.projects?.name ?? r.target ?? '—',
        project: r.projects?.name ?? '—', reason: r.reason ?? '', age: ageFrom(r.created_at),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Tasks ───────────────────────────────────────────────────
export interface TaskView {
  id: string; title: string; detail: string; kind: TaskKind; status: TaskStatus;
  assignedTo: string | null; assignee: string; project: string; due: string | null;
  age: string;
  /** The single concrete action. The studio's SOP fails a task without one. */
  nextStep: string | null;
  seat: Seat | null;
  /** Past its due date and still live — the board tints these. */
  overdue: boolean;
  /**
   * Whether an email raised this task. Every task on the board should have
   * one — they are read out of the studio's mail — so a card without it was
   * added by hand and is worth being able to tell apart.
   */
  fromEmail: boolean;
}
interface TaskRow {
  id: string; title: string; detail: string | null; kind: TaskKind; status: TaskStatus;
  assigned_to: string | null; due_date: string | null; created_at: string;
  source_email_id?: string | null;
  next_step?: string | null; seat?: Seat | null;
  projects: { name: string } | null; vendors: { name: string } | null;
  profiles: { full_name: string | null } | null;
}
export function useTasks() {
  const q = useQuery({
    queryKey: ['tasks'],
    queryFn: async (): Promise<TaskView[]> => {
      const rows = await api<TaskRow[]>('/tasks');
      return rows.map((r) => ({
        id: r.id, title: r.title, detail: r.detail ?? '', kind: r.kind, status: r.status,
        assignedTo: r.assigned_to,
        assignee: r.profiles?.full_name ?? (r.assigned_to ? 'Assigned' : 'Unassigned'),
        project: r.projects?.name ?? r.vendors?.name ?? '—',
        due: r.due_date, age: ageFrom(r.created_at),
        nextStep: r.next_step ?? null,
        seat: r.seat ?? null,
        overdue:
          !!r.due_date &&
          r.due_date < new Date().toISOString().slice(0, 10) &&
          !['done', 'cancelled'].includes(r.status),
        fromEmail: Boolean(r.source_email_id),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

export interface TeamMember {
  id: string; full_name: string | null; email: string | null; role: UserRole;
  /** The named seat from the roles document, where one is assigned. */
  seat?: Seat | null;
  created_at?: string; live_tasks?: number; is_you?: boolean;
}
export function useTeam() {
  const q = useQuery({ queryKey: ['team'], queryFn: () => api<TeamMember[]>('/team') });
  return { ...q, data: q.data ?? [] };
}

/**
 * Change someone's role or their seat. Principal only; the API enforces it.
 *
 * The role is what the software lets them touch; the seat is the outcome the
 * roles document holds them to, and it is what routes work. Either can be
 * sent on its own — `seat: null` takes the seat away.
 */
export function useSetRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; role?: UserRole; seat?: Seat | null }) => {
      const body: Record<string, unknown> = {};
      if (v.role !== undefined) body.role = v.role;
      if (v.seat !== undefined) body.seat = v.seat;
      return api(`/team/${v.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** What the signed-in person may do on Team & roles, per the permission matrix. */
export function useTeamAbilities() {
  return useQuery({
    queryKey: ['team', 'can'],
    queryFn: () => api<{ create: boolean; update: boolean; delete: boolean }>('/team/can'),
    staleTime: 60_000,
  });
}

/** Change someone's name or sign-in email. No email is sent to them either way. */
export function useEditTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; full_name?: string; email?: string }) =>
      api(`/team/${v.id}`, { method: 'PATCH', body: JSON.stringify({ full_name: v.full_name, email: v.email }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

/** Remove someone from the studio. Their open tasks stay on the board, unassigned. */
export function useRemoveTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ id: string; unassigned_tasks: number }>(`/team/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface NewTeamMember {
  email: string; full_name: string; role: UserRole;
  /** True sends them a sign-in email; false just creates the account. */
  invite: boolean;
}
export function useAddTeamMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewTeamMember) =>
      api<{ id: string }>(v.invite ? '/team/invite' : '/team', {
        method: 'POST',
        body: JSON.stringify({ email: v.email, full_name: v.full_name, role: v.role }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  });
}

// ── Morning digest ──────────────────────────────────────────
export interface DigestRow {
  id: string; title: string; kind: TaskKind; status: string;
  owner: string; project: string; age_days: number; due_date: string | null;
}
export interface Digest {
  id: string;
  digest_date: string;
  narrative: string | null;
  escalations: DigestRow[];
  figures: {
    open_tasks: number;
    overdue: DigestRow[];
    unassigned: DigestRow[];
    quote_breaches: DigestRow[];
    client_waiting: DigestRow[];
    by_owner: Record<string, number>;
  } | null;
}
export function useLatestDigest() {
  return useQuery({ queryKey: ['digest'], queryFn: () => api<Digest | null>('/digests/latest') });
}

export function useRunDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/digests/run', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digest'] }),
  });
}

// ── Assistant ───────────────────────────────────────────────
export interface ProposedAction {
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}
export interface AssistantReply {
  /** The answer as one block of text — what the history keeps. */
  reply: string;
  /** The same answer, laid out: a lead, the rows behind it, what was checked. */
  answer: AssistantAnswer;
  proposed: ProposedAction[];
  used: string[];
  /**
   * Earlier proposals the person answered in words — "yes", "cancel that" —
   * keyed as the browser sent them, so their buttons can be settled too.
   */
  settled?: { key: string; decision: 'confirmed' | 'cancelled'; id?: string | null; kind?: 'task' | 'draft' | 'task_update' }[];
}

/** What a confirmed proposal became. */
export type SavedProposal =
  | { kind: 'task'; id: string; title: string; assignee: string | null; project: string | null; due_date: string | null; duplicate: boolean }
  | { kind: 'draft'; id: string; subject: string; to: string | null }
  | { kind: 'task_update'; id: string; title: string; assignee: string | null; due_date: string | null; status: string };

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Commit a proposal the person confirmed. Separate from asking, on purpose. */
export function useConfirmAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tool: string; input: Record<string, unknown> }) =>
      api<SavedProposal>('/assistant/confirm', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: (_data, v) => {
      if (v.tool === 'propose_draft') qc.invalidateQueries({ queryKey: ['drafts'] });
      else if (v.tool === 'propose_task_update') {
        qc.invalidateQueries({ queryKey: ['tasks'] });
        qc.invalidateQueries({ queryKey: ['task'] });
      }
      else qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Inbox / documents / activity ────────────────────────────
interface EmailRow {
  id: string; from_addr: string | null; subject: string | null; snippet: string | null;
  received_at: string | null; class: string;
  projects: { name: string } | null; vendors: { name: string } | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', trade: '™', reg: '®', copy: '©',
};

/**
 * Gmail hands us HTML-escaped snippets, which were being rendered verbatim —
 * "I&#39;d love for you to quote" is what the Inbox actually showed. Decoded
 * by lookup rather than the usual innerHTML round-trip, which would parse
 * untrusted mail as markup just to unescape it.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function useEmails() {
  const q = useQuery({
    queryKey: ['emails'],
    queryFn: async (): Promise<EmailView[]> => {
      const rows = await api<EmailRow[]>('/emails');
      return rows.map((r) => {
        const who = parseAddress(r.from_addr);
        return {
          id: r.id, from: r.from_addr ?? '', subject: decodeEntities(r.subject ?? '(no subject)'),
          snippet: decodeEntities(r.snippet ?? ''), cls: r.class,
          // '' not '—' — the table hides a column nothing fills rather than
          // printing a dash down every row of it.
          project: r.projects?.name ?? '', vendor: r.vendors?.name ?? '',
          fromName: who.name, fromEmail: who.email,
          receivedAt: r.received_at ?? '',
          when: r.received_at ? ageFrom(r.received_at) : '—',
        };
      });
    },
  });
  return { ...q, data: q.data ?? [] };
}

interface DocRow {
  id: string; type: string; confidence: number | null; created_at: string;
  parsed_json: { vendor?: string; total?: number } | null; projects: { name: string } | null;
  source: { kind: 'gmail' | 'drive'; from: string | null; subject: string | null; shared_at: string | null } | null;
}

/** Split an RFC "Name <addr>" header into its parts. */
export function parseAddress(raw: string | null | undefined): { name: string; email: string } {
  const s = (raw ?? '').trim();
  const m = s.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: s, email: s };
}

function toDocSource(src: DocRow['source']): DocSource | null {
  if (!src) return null;
  const { name, email } = parseAddress(src.from);
  return { kind: src.kind, fromName: name, fromEmail: email, subject: src.subject ?? '', sharedAt: src.shared_at };
}
export function useDocuments() {
  const q = useQuery({
    queryKey: ['documents'],
    queryFn: async (): Promise<DocView[]> => {
      const rows = await api<DocRow[]>('/documents');
      return rows.map((r) => ({
        id: r.id, type: r.type,
        // '' not '—' — the table hides a column nothing fills rather than
        // printing a dash down every row of it.
        vendor: r.parsed_json?.vendor ?? '',
        project: r.projects?.name ?? '', total: r.parsed_json?.total ?? 0,
        confidence: r.confidence ?? 0, when: ageFrom(r.created_at),
        createdAt: r.created_at ?? '',
        source: toDocSource(r.source),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

interface ActivityRow { id: string; action: string; meta: Record<string, unknown> | null; created_at: string }
export function useActivity() {
  const q = useQuery({
    queryKey: ['activity'],
    queryFn: async (): Promise<ActivityView[]> => {
      const rows = await api<ActivityRow[]>('/activity');
      return rows.map((r) => ({
        id: r.id, action: r.action,
        detail: r.meta ? Object.entries(r.meta).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
        when: ageFrom(r.created_at),
      }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Prompt library ──────────────────────────────────────────
export function usePromptLibrary() {
  const q = useQuery({ queryKey: ['prompts'], queryFn: () => api<Prompt[]>('/prompts') });
  return { ...q, data: q.data ?? [] };
}

/** A reference picture on its way to a render: uploaded, and named. */
export interface BoardReference {
  token: string;
  name: string;
  label: string;
  mimeType: string;
  /** A local object URL for the thumbnail; revoked when the modal closes. */
  preview: string;
}

export interface RenderedBoard {
  token: string;
  name: string;
  mimeType: string;
  model: string;
  note: string | null;
  references: number;
}

/**
 * Which prompts make a picture, what to attach to each, and whether the
 * studio has an image key at all. Asked once: the answer changes only when
 * someone edits Settings.
 */
export function useRenderable() {
  return useQuery({
    queryKey: ['prompts', 'renderable'],
    queryFn: () =>
      api<{ ready: boolean; prompts: Record<string, { label: string; references: string[] }> }>(
        '/prompts/renderable',
      ),
    staleTime: 60_000,
  });
}

/** Put a reference image in the studio's bucket and get a grant for it back. */
export async function uploadReference(file: File, label: string): Promise<BoardReference> {
  const stored = await apiUpload<{ token: string; name: string; mimeType: string }>(
    `/assistant/upload?name=${encodeURIComponent(file.name)}`,
    file,
  );
  return { ...stored, label, preview: URL.createObjectURL(file) };
}

export function useRenderBoard() {
  return useMutation({
    mutationFn: (v: {
      id: string;
      variables: Record<string, string>;
      files: { token: string; label: string }[];
      projectId?: string;
    }) =>
      api<RenderedBoard>(`/prompts/${v.id}/render`, {
        method: 'POST',
        body: JSON.stringify({ variables: v.variables, files: v.files, projectId: v.projectId }),
      }),
  });
}

/** The rendered board's bytes, as something an <img> can show. */
export function boardImageUrl(token: string): Promise<string> {
  return apiBlob(`/assistant/file?token=${encodeURIComponent(token)}`).then((b) => URL.createObjectURL(b));
}

// ── Reports ─────────────────────────────────────────────────
export interface ReportRow {
  id: string; week_of: string; narrative: string | null;
  generated_json: Record<string, unknown> | null;
  created_at: string | null;
}
export function useReports() {
  return useQuery({ queryKey: ['reports'], queryFn: () => api<ReportRow[]>('/reports') });
}

// ── Mutations ───────────────────────────────────────────────
export function useRunPrompt() {
  return useMutation({
    mutationFn: (vars: { id: string; variables: Record<string, string>; projectId?: string }) =>
      api<{ output: string }>(`/prompts/${vars.id}/run`, {
        method: 'POST',
        body: JSON.stringify({ variables: vars.variables, projectId: vars.projectId }),
      }),
  });
}

/** One /ops/ingest response: a single time-budgeted pass. */
export interface IngestPass {
  ok?: boolean;
  reason?: string;
  emails: number;
  documents: number;
  replies: number;
  tasks?: number;
  /** False when the pass stopped on its time budget with work left. */
  done?: boolean;
  remaining?: number;
}

/** The whole run: every pass summed, plus how the last one ended. */
export interface IngestRun extends IngestPass {
  tasks: number;
  rounds: number;
  /** Set when the run stopped on a dropped connection rather than finishing. */
  interrupted?: string;
}

export interface IngestProgress {
  emails: number;
  documents: number;
  replies: number;
  tasks: number;
  round: number;
}

/**
 * How many passes one click may chain. Reading a message costs up to three
 * Claude calls, so a full inbox batch outlives any single invocation. The
 * cap stops a very large backlog from holding the button forever — what is
 * left is picked up by the next click or the scheduled run.
 *
 * Rounds are deliberately short (the API's budget, ~20s) rather than few:
 * a request held open for most of a minute is the one that gets dropped in
 * transit, and a dropped round used to lose the whole run.
 */
const INGEST_MAX_ROUNDS = 12;

/** How many times a round that never reached the server is re-sent. */
const INGEST_RETRIES = 2;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pass, re-sent if the connection dropped.
 *
 * Only NetworkError is retried. It means no answer came back, so the pass
 * either never ran or ran and its result was lost — and either way asking
 * again is safe: ingestion dedupes on what it already stored. An error the
 * server actually returned (not authorised, not configured) is reported.
 */
async function ingestPass(): Promise<IngestPass> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<IngestPass>('/ops/ingest', { method: 'POST', body: '{}' });
    } catch (err) {
      if (!(err instanceof NetworkError) || attempt >= INGEST_RETRIES) throw err;
      await wait(1000 * (attempt + 1));
    }
  }
}

export function useOps() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['follow-ups'] });
    qc.invalidateQueries({ queryKey: ['reports'] });
    qc.invalidateQueries({ queryKey: ['emails'] });
    qc.invalidateQueries({ queryKey: ['documents'] });
    qc.invalidateQueries({ queryKey: ['activity'] });
  };
  const ingest = useMutation({
    // Each POST reads to a short time budget and reports `done: false` with
    // what it left behind, so keep asking until the queue is clear. Totals
    // are summed across the rounds; the last response is kept for ok/reason.
    mutationFn: async (onProgress?: (p: IngestProgress) => void): Promise<IngestRun> => {
      const total = { emails: 0, documents: 0, replies: 0, tasks: 0 };
      let last: IngestRun = { ...total, done: true, rounds: 0 };

      for (let round = 1; round <= INGEST_MAX_ROUNDS; round++) {
        let r: IngestPass;
        try {
          r = await ingestPass();
        } catch (err) {
          // Every round before this one committed its work server-side, so
          // report what got read and let them carry on — throwing here would
          // show "Failed to fetch" over a run that mostly succeeded.
          if (round === 1) throw err;
          return { ...last, done: false, interrupted: (err as Error).message, rounds: round - 1 };
        }

        // Nothing ran — already busy, or Google/Claude not connected.
        if (r.ok === false) return { ...r, ...total, rounds: round };

        total.emails += r.emails ?? 0;
        total.documents += r.documents ?? 0;
        total.replies += r.replies ?? 0;
        total.tasks += r.tasks ?? 0;
        last = { ...r, ...total, rounds: round };
        onProgress?.({ ...total, round });

        if (r.done !== false) break;
        // Show what has landed without competing with the next round for
        // connections — the full refresh happens once the run finishes.
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      }
      return last;
    },
    onSuccess: invalidate,
  });
  const followUps = useMutation({
    mutationFn: () => api<{ raised: number; drafted: number }>('/follow-ups/run', { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  const report = useMutation({
    mutationFn: () => api<{ weekOf: string }>('/reports/generate', { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
  return { ingest, followUps, report };
}

export function useFollowUpStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: string }) =>
      api(`/follow-ups/${v.id}`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['follow-ups'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Change a task's status, or hand it to someone else. */
/** Raise tasks from email ingested before the tasks table existed. */
export function useBackfillTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ ok: boolean; reason?: string; scanned: number; created: number }>(
        '/ops/backfill-tasks',
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// Duplicate projects are folded together by the server at the end of every
// reading pass, so there is nothing for the web app to ask for. The manual
// route (POST /ops/dedupe-projects) stays for clearing an old backlog.

export interface HouzzImportResult {
  ok: boolean;
  reason?: string;
  created: number;
  updated: number;
  skipped: number;
  /** Which CSV column each field was read from. */
  mapped: Record<string, string>;
  /** Columns in the file nothing was read from. */
  unusedColumns: string[];
}

/**
 * Load a Houzz Pro project export.
 *
 * Houzz has no API for a studio's own projects, so the CSV that
 * pro.houzz.com/manage/projects exports is the only way the list comes
 * across. Safe to run again: rows match on the Houzz id, then on name.
 */
export function useImportHouzz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) =>
      api<HouzzImportResult>('/ops/import-houzz', { method: 'POST', body: JSON.stringify({ csv }) }),
    onSuccess: () => {
      for (const key of ['projects', 'dashboard', 'activity']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/**
 * Change a task's status, or hand it to someone else.
 *
 * Applied to the cache before the request goes out. Dragging a card across
 * the board is a direct manipulation — the card has to land where it was
 * dropped, immediately — and waiting for a round-trip plus a refetch made it
 * hang in the old column long enough to feel broken, or to be dragged twice.
 * The server is still the authority: a failure puts the board back exactly
 * as it was and surfaces the error.
 */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status?: TaskStatus; assigned_to?: string | null; due_date?: string | null; next_step?: string | null }) => {
      const { id, ...patch } = v;
      return api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },

    onMutate: async (v) => {
      // Stop a refetch already in flight from landing on top of this.
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const previous = qc.getQueryData<TaskView[]>(['tasks']);

      qc.setQueryData<TaskView[]>(['tasks'], (old) =>
        (old ?? []).map((t) => {
          if (t.id !== v.id) return t;
          const next: TaskView = { ...t };

          if (v.status !== undefined) {
            next.status = v.status;
            // Finished work is not overdue, whatever its date said.
            next.overdue =
              !!next.due &&
              next.due < new Date().toISOString().slice(0, 10) &&
              !['done', 'cancelled'].includes(v.status);
          }

          if (v.due_date !== undefined) {
            next.due = v.due_date;
            next.overdue =
              !!v.due_date &&
              v.due_date < new Date().toISOString().slice(0, 10) &&
              !['done', 'cancelled'].includes(next.status);
          }

          if (v.next_step !== undefined) next.nextStep = v.next_step;

          if (v.assigned_to !== undefined) {
            next.assignedTo = v.assigned_to;
            // Name it from the roster we already hold, so the card does not
            // flash a placeholder before the refetch catches up.
            const team = qc.getQueryData<TeamMember[]>(['team']) ?? [];
            const who = team.find((m) => m.id === v.assigned_to);
            next.assignee = v.assigned_to
              ? who?.full_name ?? who?.email ?? 'Assigned'
              : 'Unassigned';
          }

          return next;
        }),
      );

      return { previous };
    },

    onError: (_err, _vars, ctx) => {
      // Put the board back; the error is rendered by the page.
      if (ctx?.previous) qc.setQueryData(['tasks'], ctx.previous);
    },

    // Reconcile with the server either way — the optimistic row is a guess
    // at what it stored, not a replacement for it.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * Delete a task outright.
 *
 * Principals and coordinators only, by default — the server decides, this
 * just asks. Optimistic, because a card that lingers after you removed it
 * reads as a failure.
 */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const previous = qc.getQueryData<TaskView[]>(['tasks']);
      qc.setQueryData<TaskView[]>(['tasks'], (old) => (old ?? []).filter((t) => t.id !== id));
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(['tasks'], ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── One task, in full ───────────────────────────────────────

export interface TaskEmail {
  id: string;
  subject: string | null;
  from_addr: string | null;
  to_addr: string | null;
  snippet: string | null;
  received_at: string | null;
  class: string;
  extracted_json: { summary?: string } | null;
}

export interface TaskHistoryEntry {
  id: string;
  type: FollowUpType;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface Subtask {
  id: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  due_date: string | null;
  created_at: string;
  profiles?: { full_name: string | null } | null;
}

export interface TaskDetail {
  task: {
    id: string; title: string; detail: string | null; kind: TaskKind; status: TaskStatus;
    assigned_to: string | null; assigned_role: UserRole | null; seat: Seat | null;
    next_step: string | null; due_date: string | null;
    created_at: string; updated_at: string | null;
    reminded_at: string | null; reminder_count: number;
    projects: { name: string } | null;
    vendors: { name: string } | null;
    profiles: { full_name: string | null; email: string | null } | null;
  };
  email: TaskEmail | null;
  history: TaskHistoryEntry[];
  subtasks: Subtask[];
  /** False until migration 0009 is applied. */
  subtasksAvailable: boolean;
}

/** Everything behind one task — fetched only while its panel is open. */
export function useTaskDetail(id: string | null) {
  return useQuery({
    queryKey: ['task', id],
    queryFn: () => api<TaskDetail>(`/tasks/${id}`),
    enabled: !!id,
  });
}

/** Break a task into a step of its own. */
export function useAddSubtask(parentId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) =>
      api<Subtask>(`/tasks/${parentId}/subtasks`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task', parentId] });
      // A subtask is a task, so it belongs on the board too.
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export interface DraftRow {
  id: string;
  subject: string | null;
  body_preview: string | null;
  follow_up_id: string | null;
  created_at: string;
}
export function useDrafts() {
  const q = useQuery({ queryKey: ['drafts'], queryFn: () => api<DraftRow[]>('/drafts') });
  return { ...q, data: q.data ?? [] };
}

export function useCreateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { to?: string; subject?: string; body: string }) =>
      api<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export interface DraftEdit { to: string; cc: string; subject: string; body: string }
export function useUpdateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...v }: DraftEdit & { id: string }) =>
      api<DraftRow>(`/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drafts'] }),
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/drafts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['drafts'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) =>
      api(`/projects/${v.id}`, { method: 'PATCH', body: JSON.stringify(v.patch) }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['project', v.id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/** Start Google consent for one service (gmail | drive) or both. */
export function useConnectGoogle() {
  return useMutation({
    mutationFn: async (service: GoogleService | 'all' = 'all') => {
      const { url } = await api<{ url: string }>(`/auth/google/url?service=${service}`);
      window.location.href = url;
    },
  });
}

/** Revoke the Google connection (both Gmail and Drive). */
/**
 * Stop using ONE Google service. Google cannot revoke half a grant, so
 * this drops that service’s scopes from the stored integration: the app
 * stops reading it, the other service keeps working, and reconnecting is
 * one consent screen away.
 */
export function useDisconnectGoogleService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (service: GoogleService) =>
      api<{ ok: boolean }>(`/auth/google/${service}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDisconnectGoogle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>('/auth/google', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

// ── Permission matrix (dynamic module access) ───────────────
export interface PermissionCell {
  role: UserRole;
  resource: Resource;
  action: Action;
  /** What the studio default says, before any override. */
  default: boolean;
  /** What is actually true right now. */
  allowed: boolean;
  overridden: boolean;
  /** Cells the studio is not allowed to change, so it cannot lock itself out. */
  locked: boolean;
  updated_at: string | null;
}

export function usePermissionMatrix() {
  return useQuery({
    queryKey: ['permissions'],
    queryFn: () =>
      api<{ cells: PermissionCell[]; canEdit: boolean; storageReady: boolean }>('/permissions'),
  });
}

/**
 * Grant or revoke one module for one role. Invalidates everything: a
 * permission change can add or remove controls anywhere in the app, and
 * the API re-reads the matrix on its next request.
 */
export function useSetPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: UserRole; resource: Resource; action: Action; allowed: boolean }) =>
      api<PermissionCell>('/permissions', { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** Put one cell back to the studio default. */
export function useResetPermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { role: UserRole; resource: Resource; action: Action }) =>
      api<PermissionCell>(
        `/permissions?role=${v.role}&resource=${v.resource}&action=${v.action}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['permissions'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// ── AI configuration ────────────────────────────────────────
export interface AiConfig extends AiSettingsView {
  models: SelectableModel[];
}

export function useAiConfig() {
  return useQuery({ queryKey: ['ai-config'], queryFn: () => api<AiConfig>('/settings/ai') });
}

/** Changing the key or model changes what every AI feature can do. */
function useAiMutation<V>(fn: (v: V) => Promise<AiSettingsView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-config'] });
      qc.invalidateQueries({ queryKey: ['health'] });
    },
  });
}

export function useSetAiKey() {
  return useAiMutation((apiKey: string) =>
    api<AiSettingsView>('/settings/ai/key', { method: 'PUT', body: JSON.stringify({ apiKey }) }),
  );
}

export function useClearAiKey() {
  return useAiMutation(() => api<AiSettingsView>('/settings/ai/key', { method: 'DELETE' }));
}

export function useIngestSettings() {
  return useQuery({
    queryKey: ['ingest-settings'],
    queryFn: () => api<IngestSettingsView>('/settings/ingest'),
  });
}

/** How often email is read, and whether Claude reads it. */
export function useSetIngestSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { intervalMinutes?: number; useAi?: boolean }) =>
      api<IngestSettingsView>('/settings/ingest', { method: 'PUT', body: JSON.stringify(patch) }),
    onSuccess: (data) => qc.setQueryData(['ingest-settings'], data),
  });
}

export function useSetAiModel() {
  return useAiMutation((model: string) =>
    api<AiSettingsView>('/settings/ai/model', { method: 'PUT', body: JSON.stringify({ model }) }),
  );
}

// ── AI usage ────────────────────────────────────────────────
export interface UsageLink {
  token: string | null;
  path: string | null;
  created_at: string | null;
}

export function useAiUsage(days = 30) {
  return useQuery({
    queryKey: ['ai-usage', days],
    queryFn: () => api<AiUsageReport>(`/usage?days=${days}`),
  });
}

export function useUsageLink() {
  return useQuery({ queryKey: ['usage-link'], queryFn: () => api<UsageLink>('/usage/link') });
}

export function useRotateUsageLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UsageLink>('/usage/link/rotate', { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['usage-link'], data),
  });
}

export function useRevokeUsageLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<UsageLink>('/usage/link', { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['usage-link'], data),
  });
}
