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
  | 'spec_gap';

export type FollowUpStatus = 'open' | 'drafted' | 'sent' | 'dismissed' | 'done';

export type EmailClass =
  | 'vendor_quote'
  | 'order_confirmation'
  | 'client_approval'
  | 'houzz_notification'
  | 'general'
  | 'unclassified';

export type DocumentType = 'quote' | 'purchase_order' | 'order_confirmation' | 'other';

export type PromptCategory = 'design' | 'procurement' | 'client' | 'admin';

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
