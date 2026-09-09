import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Prompt, ProjectStage, PoStatus } from '@janelle/shared';

// ── View models (what the UI renders) ───────────────────────
export interface ProjectView {
  id: string; name: string; client: string; stage: ProjectStage;
  budget: number; install: string; openPOs: number;
}
export interface PoView {
  id: string; po: string; vendor: string; project: string;
  amount: number; status: PoStatus; eta: string;
}
export interface FollowUpView {
  id: string; type: 'vendor_silence' | 'client_approval_overdue' | 'date_slipping' | 'spec_gap';
  who: string; project: string; reason: string; age: string;
}
export interface VendorView { id: string; name: string; category: string; openPOs: number }
export interface EmailView {
  id: string; from: string; subject: string; snippet: string;
  cls: string; project: string; when: string;
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
export interface Summary {
  activeProjects: number; openPOs: number; awaitingClient: number;
  specGaps: number; installsSoon: number; openFollowUps: number;
  emailsRead: number; documentsParsed: number; draftsPending: number;
  byStage: Record<string, number>;
}
const ZERO_SUMMARY: Summary = {
  activeProjects: 0, openPOs: 0, awaitingClient: 0, specGaps: 0,
  installsSoon: 0, openFollowUps: 0, emailsRead: 0, documentsParsed: 0, draftsPending: 0, byStage: {},
};
export function useDashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Summary>('/dashboard/summary') });
  return { ...q, data: q.data ?? ZERO_SUMMARY };
}

// ── Projects ────────────────────────────────────────────────
interface ProjectRow {
  id: string; name: string; client_name: string | null; stage: ProjectStage;
  budget: number | null; target_install: string | null;
}
export function useProjects() {
  const q = useQuery({
    queryKey: ['projects'],
    queryFn: async (): Promise<ProjectView[]> => {
      const rows = await api<ProjectRow[]>('/projects');
      return rows.map((r) => ({
        id: r.id, name: r.name, client: r.client_name ?? '—', stage: r.stage,
        budget: r.budget ?? 0, install: r.target_install ?? '', openPOs: 0,
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
  purchase_orders: { id: string; po_number: string | null; amount: number | null; status: string; eta: string | null }[];
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
interface VendorRow { id: string; name: string; category: string | null }
export function useVendors() {
  const q = useQuery({
    queryKey: ['vendors'],
    queryFn: async (): Promise<VendorView[]> => {
      const rows = await api<VendorRow[]>('/vendors');
      return rows.map((r) => ({ id: r.id, name: r.name, category: r.category ?? '—', openPOs: 0 }));
    },
  });
  return { ...q, data: q.data ?? [] };
}

// ── Purchase orders ─────────────────────────────────────────
interface PoRow {
  id: string; po_number: string | null; amount: number | null; status: PoStatus;
  eta: string | null; vendors: { name: string } | null; projects: { name: string } | null;
}
export function usePurchaseOrders() {
  const q = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: async (): Promise<PoView[]> => {
      const rows = await api<PoRow[]>('/purchase-orders');
      return rows.map((r) => ({
        id: r.id, po: r.po_number ?? '—', vendor: r.vendors?.name ?? '—',
        project: r.projects?.name ?? '—', amount: r.amount ?? 0, status: r.status, eta: r.eta ?? '',
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

// ── Inbox / documents / activity ────────────────────────────
interface EmailRow {
  id: string; from_addr: string | null; subject: string | null; snippet: string | null;
  received_at: string | null; class: string; projects: { name: string } | null;
}
export function useEmails() {
  const q = useQuery({
    queryKey: ['emails'],
    queryFn: async (): Promise<EmailView[]> => {
      const rows = await api<EmailRow[]>('/emails');
      return rows.map((r) => ({
        id: r.id, from: r.from_addr ?? '—', subject: r.subject ?? '(no subject)',
        snippet: r.snippet ?? '', cls: r.class, project: r.projects?.name ?? '—',
        when: r.received_at ? ageFrom(r.received_at) : '—',
      }));
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
        id: r.id, type: r.type, vendor: r.parsed_json?.vendor ?? '—',
        project: r.projects?.name ?? '—', total: r.parsed_json?.total ?? 0,
        confidence: r.confidence ?? 0, when: ageFrom(r.created_at),
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
    mutationFn: () => api<{ ok?: boolean; reason?: string; emails: number; documents: number; replies: number }>('/ops/ingest', { method: 'POST', body: '{}' }),
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
