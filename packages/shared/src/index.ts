// ============================================================
//  @janelle/shared — types shared by the API and the web app.
//  Kept in step with supabase/schema.sql.
// ============================================================

export type UserRole =
  | 'principal'
  | 'designer'
  | 'procurement'
  | 'coordinator'
  | 'assistant';

export type ProjectStage =
  | 'lead'
  | 'concept'
  | 'spec'
  | 'approval'
  | 'po'
  | 'production'
  | 'shipping'
  | 'install'
  | 'complete';

export const PROJECT_STAGES: ProjectStage[] = [
  'lead', 'concept', 'spec', 'approval', 'po',
  'production', 'shipping', 'install', 'complete',
];

export const STAGE_LABELS: Record<ProjectStage, string> = {
  lead: 'Lead',
  concept: 'Concept',
  spec: 'Spec',
  approval: 'Approval',
  po: 'PO',
  production: 'Production',
  shipping: 'Shipping',
  install: 'Install',
  complete: 'Complete',
};

export type PoStatus =
  | 'draft'
  | 'placed'
  | 'confirmed'
  | 'in_production'
  | 'shipped'
  | 'received'
  | 'cancelled';

export type FollowUpType =
  | 'vendor_silence'
  | 'client_approval_overdue'
  | 'date_slipping'
  | 'spec_gap'
  | 'quote_overdue'
  | 'client_waiting';

/**
 * Service levels the studio actually works to, captured from the
 * 2026-09-10 kickoff call. Stored per-org in `organizations.settings`;
 * these are the defaults when nothing is set.
 */
export interface SlaSettings {
  /** A quote request unresolved this long → proactively update the client. */
  quote_response_days: number;
  /** A client left waiting this long → nudge the owner internally. */
  client_waiting_hours: number;
  /** A PO placed but unconfirmed this long → chase the vendor. */
  vendor_silence_days: number;
  /** A project parked in "approval" this long → chase the client. */
  client_approval_days: number;
  /** A task overdue by this much → escalate to the principal. */
  escalation_days: number;
}

export const DEFAULT_SLA: SlaSettings = {
  quote_response_days: 2,
  client_waiting_hours: 24,
  vendor_silence_days: 3,
  client_approval_days: 5,
  escalation_days: 2,
};

export type FollowUpStatus = 'open' | 'drafted' | 'sent' | 'dismissed' | 'done';

export type TaskKind =
  | 'quote_request'
  | 'order_followup'
  | 'client_approval'
  | 'spec_review'
  | 'scheduling'
  | 'admin';

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

export const TASK_KINDS: TaskKind[] = [
  'quote_request', 'order_followup', 'client_approval',
  'spec_review', 'scheduling', 'admin',
];

export const TASK_STATUSES: TaskStatus[] = [
  'open', 'in_progress', 'blocked', 'done', 'cancelled',
];

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  quote_request: 'Quote request',
  order_followup: 'Order follow-up',
  client_approval: 'Client approval',
  spec_review: 'Spec review',
  scheduling: 'Scheduling',
  admin: 'Admin',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

/**
 * Which role owns each kind of task. Claude decides the kind from the
 * email; this table decides the person, so assignment stays explainable.
 */
export const TASK_KIND_ROLE: Record<TaskKind, UserRole> = {
  quote_request: 'procurement',
  order_followup: 'procurement',
  client_approval: 'principal',
  spec_review: 'designer',
  scheduling: 'coordinator',
  admin: 'assistant',
};

export type EmailClass =
  | 'vendor_quote'
  | 'order_confirmation'
  | 'client_approval'
  | 'houzz_notification'
  | 'general'
  | 'unclassified';

export type DocumentType = 'quote' | 'purchase_order' | 'order_confirmation' | 'other';

export type PromptCategory = 'design' | 'procurement' | 'client' | 'admin';

// ── Permissions ─────────────────────────────────────────────

export type Resource =
  | 'projects'
  | 'vendors'
  | 'purchase_orders'
  | 'documents'
  | 'emails'
  | 'tasks'
  | 'follow_ups'
  | 'drafts'
  | 'prompts'
  | 'reports'
  | 'digests'
  | 'team'
  | 'settings'
  | 'ops';

export type Action = 'read' | 'create' | 'update' | 'delete';

/**
 * Who may do what. A five-person studio does not need compartmented
 * reads — everyone can see the org's work, which is the point of the
 * system. What is restricted is *writing*: changing money, changing
 * someone else's assignment, and changing the rules.
 *
 * Mirrored by the RLS policies in supabase/schema.sql. Change both.
 */
const WRITERS: Record<Resource, UserRole[]> = {
  projects: ['principal', 'coordinator', 'designer'],
  vendors: ['principal', 'coordinator', 'procurement'],
  purchase_orders: ['principal', 'coordinator', 'procurement'],
  documents: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  emails: ['principal', 'coordinator'],
  tasks: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  follow_ups: ['principal', 'coordinator'],
  drafts: ['principal', 'coordinator', 'designer', 'procurement', 'assistant'],
  prompts: ['principal', 'coordinator', 'designer'],
  reports: ['principal', 'coordinator'],
  digests: ['principal', 'coordinator'],
  team: ['principal'],
  settings: ['principal'],
  ops: ['principal', 'coordinator'],
};

/** Destructive actions stay with the people accountable for the studio. */
const DELETERS: UserRole[] = ['principal', 'coordinator'];

/** Reassigning someone else's work, and reading the full audit trail. */
export const SUPERVISOR_ROLES: UserRole[] = ['principal', 'coordinator'];

export function can(role: UserRole | null, resource: Resource, action: Action): boolean {
  if (!role) return false;
  // Settings and team membership are never readable by everyone — they are
  // how the studio's rules and people are changed.
  if (resource === 'settings' || resource === 'team') {
    return action === 'read' ? true : WRITERS[resource].includes(role);
  }
  if (action === 'read') return true;
  if (action === 'delete') return DELETERS.includes(role) && WRITERS[resource].includes(role);
  return WRITERS[resource].includes(role);
}

/** True when this person may reassign work that is not their own. */
export function canSupervise(role: UserRole | null): boolean {
  return !!role && SUPERVISOR_ROLES.includes(role);
}

export const ROLE_LABELS: Record<UserRole, string> = {
  principal: 'Principal / Owner',
  designer: 'Designer',
  procurement: 'Procurement / FF&E',
  coordinator: 'Coordinator / Admin',
  assistant: 'Assistant',
};

// ── Entity shapes ───────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Profile {
  id: string;
  org_id: string;
  full_name: string | null;
  email: string | null;
  role: UserRole;
  avatar_url: string | null;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  client_name: string | null;
  stage: ProjectStage;
  status: string;
  budget: number | null;
  start_date: string | null;
  target_install: string | null;
  assigned_to: string | null;
  houzz_ref: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Vendor {
  id: string;
  org_id: string;
  name: string;
  category: string | null;
  contacts: { name?: string; email?: string; phone?: string }[];
  notes: string | null;
}

export interface PurchaseOrder {
  id: string;
  org_id: string;
  po_number: string | null;
  project_id: string | null;
  vendor_id: string | null;
  amount: number | null;
  status: PoStatus;
  order_date: string | null;
  eta: string | null;
  received_date: string | null;
}

export interface FollowUp {
  id: string;
  org_id: string;
  type: FollowUpType;
  project_id: string | null;
  vendor_id: string | null;
  target: string | null;
  reason: string | null;
  due_date: string | null;
  status: FollowUpStatus;
  draft_id: string | null;
  created_at: string;
}

export interface Task {
  id: string;
  org_id: string;
  title: string;
  detail: string | null;
  kind: TaskKind;
  status: TaskStatus;
  assigned_to: string | null;
  assigned_role: UserRole | null;
  project_id: string | null;
  vendor_id: string | null;
  source_email_id: string | null;
  due_date: string | null;
  created_at: string;
}

export interface SpecGap {
  id: string;
  org_id: string;
  project_id: string;
  item: string;
  missing_fields: string[];
  resolved: boolean;
}

export interface PromptVariable {
  key: string;
  label: string;
  required?: boolean;
}

export interface Prompt {
  id: string;
  org_id: string;
  title: string;
  category: PromptCategory;
  description: string | null;
  template: string;
  variables: PromptVariable[];
}

// ── API envelope ────────────────────────────────────────────

export interface ApiError {
  error: string;
  detail?: string;
}

export type ApiResult<T> = { data: T } | ApiError;
