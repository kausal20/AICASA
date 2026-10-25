// Hand-maintained types mirroring the database views and tables the frontend reads.
export type Role = 'institution' | 'officer' | 'admin';
export type Capability =
  | 'scrutiny' | 'evc' | 'committee' | 'compliance' | 'decision' | 'assignment'
  | 'workflow_config' | 'user_admin' | 'reports' | 'audit' | 'escalation';

export type ApplicationStatus =
  | 'draft' | 'submitted' | 'under_scrutiny' | 'returned_for_correction' | 'correction_submitted'
  | 'awaiting_verification' | 'ready_for_next_stage' | 'evc_required' | 'evc_scheduled' | 'evc_completed'
  | 'committee_review' | 'awaiting_decision' | 'completed' | 'closed' | 'withdrawn';

export type StageKind = 'intake' | 'scrutiny' | 'evc' | 'committee' | 'decision' | 'terminal';

export interface RoleAssignment { id: string; role: Role; region_code: string | null; capabilities: Capability[] }
export interface InstitutionRef { id: string; name: string; code: string; kind?: string; region_code?: string; member_role?: string }

export interface SessionContext {
  profile: { id: string; email: string; full_name: string; designation: string | null; phone: string | null; is_active: boolean; is_demo: boolean };
  roles: RoleAssignment[];
  institutions: InstitutionRef[];
  granted_institutions: InstitutionRef[];
  settings: Record<string, unknown>;
}

export interface ApplicationRow {
  id: string; reference: string; title: string; academic_year: string; status: ApplicationStatus; current_stage: string;
  region_code: string; institution_id: string; institution_name: string; institution_code: string;
  application_type_code: string; application_type_name: string; stage_name: string | null; stage_kind: StageKind | null;
  stage_entered_at: string; stage_due_at: string | null; next_action: string | null; next_actor: string | null;
  assigned_officer_id: string | null; assigned_officer_name: string | null; submitted_at: string | null; closed_at: string | null;
  created_at: string; updated_at: string; row_version: number; is_demo: boolean; workflow_version_id: string;
  route_version: number; route_name: string; age_days: number; stage_age_days: number; is_overdue: boolean;
  open_deficiencies: number; correction_due_at: string | null;
}

export interface Application {
  id: string; reference: string; institution_id: string; region_code: string; application_type_code: string;
  workflow_version_id: string; checklist_version: number; title: string; academic_year: string;
  form_data: Record<string, unknown>; current_stage: string; status: ApplicationStatus; row_version: number;
  stage_due_at: string | null; next_action: string | null; submitted_at: string | null;
}

export interface FormField { key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean'; required: boolean; help?: string }
export interface ApplicationType {
  code: string; name: string; description: string; workflow_definition_id: string; enabled: boolean;
  checklist_version: number; form_schema: FormField[]; route_disclosed: boolean;
}
export interface DocumentRequirement {
  id: string; application_type_code: string; checklist_version: number; doc_type: string; name: string; description: string;
  is_required: boolean; allowed_mime_types: string[]; max_bytes: number; expiry_tracked: boolean; required_fields: string[];
  source_reference: string;
}

export interface WorkflowStage {
  id: string; version_id: string; code: string; name: string; kind: StageKind; sequence: number; sla_days: number | null;
  responsible_capability: string | null; description: string;
  /** Concurrent reviews configured for this stage (route version specific). */
  reviews?: StageReview[];
}
export interface StageReview { code: string; name: string; required_capability: string; description: string; sort_order: number }
export interface WorkflowTransition {
  id: string; version_id: string; code: string; name: string; from_stage: string; to_stage: string; allowed_role: Role | null;
  required_capability: string | null; requires_reason: boolean; is_automatic: boolean; prerequisites: string[];
  records_decision: boolean; sort_order: number;
}
export interface WorkflowVersion {
  id: string; definition_id: string; version: number; status: 'draft' | 'active' | 'retired'; source_reference: string;
  change_summary: string; effective_from: string; effective_to: string | null; authorised_by: string | null; created_at: string;
}
export interface AvailableTransition {
  code: string; name: string; to_stage: string; requires_reason: boolean; records_decision: boolean;
  permitted: boolean; blocked_reason: string | null;
}

export interface StageHistory { id: string; stage_code: string; stage_name: string; entered_at: string; due_at: string | null; exited_at: string | null; exit_transition: string | null }
export interface AppEvent {
  id: string; application_id: string; event_type: string; summary: string; from_stage: string | null; to_stage: string | null;
  from_status: string | null; to_status: string | null; actor_id: string | null; actor_kind: 'user' | 'system';
  reason: string | null; visibility: 'shared' | 'internal'; metadata: Record<string, unknown>; created_at: string;
}
export interface Observation { id: string; stage_code: string; author_id: string; category: string; body: string; visibility: string; created_at: string }

export interface DocumentRecord {
  id: string; institution_id: string; application_id: string | null; doc_type: string; title: string; current_version: number;
  created_at: string; updated_at: string; document_versions?: DocumentVersion[];
}
export interface DocumentVersion {
  id: string; document_id: string; version: number; storage_bucket: string; storage_path: string; file_name: string; mime_type: string;
  size_bytes: number; sha256: string | null; scan_status: string; replaced_reason: string | null; uploaded_by: string | null; uploaded_at: string;
}

export type FindingOutcome = 'passed' | 'potential_issue' | 'missing_information' | 'extraction_failed' | 'manual_review' | 'not_checked';
export interface CheckRun {
  id: string; document_version_id: string; application_id: string | null; institution_id: string; engine: string;
  checklist_version: number | null; status: 'running' | 'completed' | 'failed'; extraction_status: string;
  extraction_method: string | null; steps: { code: string; label: string; status: string; detail?: string }[];
  limitations: string[]; summary: Record<string, number>; error: string | null; started_at: string; completed_at: string | null;
  document_check_findings?: CheckFinding[];
}
export interface CheckFinding {
  id: string; run_id: string; check_code: string; check_name: string; outcome: FindingOutcome; severity: string;
  explanation: string; evidence: string | null; page_ref: string | null; suggestion: string | null; confidence: number | null; sort_order: number;
}

export type DeficiencyStatus = 'open' | 'correction_submitted' | 'still_deficient' | 'needs_clarification' | 'resolved' | 'withdrawn';
export interface Deficiency {
  id: string; application_id: string; stage_code: string; title: string; reason: string; requirement_source: string;
  requested_correction: string; doc_type: string | null; responsible_party: string; due_at: string; status: DeficiencyStatus;
  raised_by: string | null; raised_at: string; resolved_at: string | null; row_version: number;
  /** Raised by a Deficiency Matrix rule (no officer), citing the rule id and version */
  /** Response window of an officer-raised query; null for rule-raised and older deficiencies */
  window_opens_at: string | null; window_closes_at: string | null; window_reopen_count: number;
  auto_generated: boolean; rule_id: string | null; rule_code: string | null; rule_version: number | null;
  affected_document_version_id: string | null;
  /** captured_at_raise = recorded when the memo was raised; inferred_unverified = reconstructed later and not proven; null = none */
  affected_version_basis: 'captured_at_raise' | 'inferred_unverified' | null;
  deficiency_submissions?: DeficiencySubmission[]; deficiency_reviews?: DeficiencyReview[];
  applications?: { reference: string; title: string; institution_id: string; status: ApplicationStatus };
}
export interface DeficiencySubmission { id: string; deficiency_id: string; attempt: number; response_text: string; document_version_id: string | null; submitted_by: string; submitted_at: string }
export interface DeficiencyReview { id: string; deficiency_id: string; submission_id: string; outcome: string; reason: string; reviewed_by: string; reviewed_at: string }

export type EvcStatus = 'awaiting_scheduling' | 'proposed' | 'scheduled' | 'completed' | 'cancelled';
export interface EvcRow {
  id: string; application_id: string; stage_code: string; cycle: number; status: EvcStatus; ready_at: string; schedule_due_at: string | null;
  scheduled_start: string | null; scheduled_end: string | null; coordinator_id: string | null; notes: string | null; outcome: string | null;
  completion_summary: string | null; completed_at: string | null; reschedule_count: number; row_version: number;
  reference: string; application_title: string; institution_id: string; institution_name: string; region_code: string;
  application_status: ApplicationStatus; coordinator_name: string | null; age_days: number; is_overdue: boolean;
}
export interface EvcHistory { id: string; evc_id: string; action: string; from_status: string | null; to_status: string | null; scheduled_start: string | null; scheduled_end: string | null; reason: string | null; actor_id: string | null; created_at: string }

export type ObligationStatus = 'awaiting_submission' | 'submitted' | 'under_verification' | 'verified' | 'correction_required' | 'closed';
export interface ObligationRow {
  id: string; institution_id: string; region_code: string; application_id: string | null; validity_id: string | null;
  parent_obligation_id: string | null; obligation_type: string; title: string; description: string; source_reference: string;
  evidence_required: string; responsible_contact: string | null; effective_date: string; due_at: string; recurrence: string | null;
  status: ObligationStatus; verifying_officer_id: string | null; closed_reason: string | null; row_version: number; created_at: string;
  institution_name: string; application_reference: string | null; effective_status: string; days_to_due: number; submission_count: number;
}
export interface ComplianceSubmission { id: string; obligation_id: string; attempt: number; comment: string; document_version_id: string | null; renewal_expiry_date: string | null; submitted_by: string; submitted_at: string }
export interface ComplianceVerification { id: string; obligation_id: string; submission_id: string; outcome: string; reason: string; verified_by: string; verified_at: string }

export interface ValidityRow {
  id: string; institution_id: string; document_id: string | null; document_version_id: string | null; doc_type: string; title: string;
  issue_date: string | null; expiry_date: string; renewal_state: string; superseded_by: string | null; source_reference: string;
  created_at: string; institution_name: string; region_code: string; days_to_expiry: number; validity_state: 'valid' | 'expiring_soon' | 'expired' | 'superseded';
  renewal_obligation_id: string | null;
}

export interface TaskRow {
  id: string; task_type: string; title: string; application_id: string | null; deficiency_id: string | null; evc_id: string | null;
  obligation_id: string | null; region_code: string; assignee_id: string | null; required_capability: string | null; due_at: string | null;
  status: 'open' | 'done' | 'cancelled'; created_at: string; completed_at: string | null; application_reference: string | null;
  assignee_name: string | null; is_overdue: boolean;
}

export interface NotificationRow {
  id: string; recipient_id: string; kind: string; title: string; body: string; link: string | null; entity_type: string | null;
  entity_id: string | null; created_at: string; read_at: string | null;
}

export interface EscalationRow {
  id: string; rule_id: string; entity_type: string; entity_id: string; application_id: string | null; institution_id: string | null;
  region_code: string | null; repeat_no: number; due_at: string | null; summary: string; status: 'open' | 'acknowledged' | 'resolved';
  triggered_at: string; acknowledged_at: string | null; resolved_at: string | null; resolution_note: string | null;
  rule_code: string; rule_version: number; rule_kind: string; rule_recipient: string; application_reference: string | null; institution_name: string | null;
}

export interface EscalationRule {
  id: string; code: string; version: number; is_active: boolean; rule_kind: 'reminder' | 'escalation'; entity_type: string;
  offset_hours: number; recipient: string; recipient_capability: string | null; channel: string; max_repeats: number;
  repeat_interval_hours: number | null; source_reference: string; change_summary: string; effective_from: string; created_at: string;
}

export interface AuditRow {
  id: number; actor_id: string | null; actor_kind: string; action: string; entity_type: string; entity_id: string | null;
  application_id: string | null; institution_id: string | null; region_code: string | null; reason: string | null;
  before_state: unknown; after_state: unknown; metadata: Record<string, unknown>; created_at: string; actor_name: string | null;
  application_reference: string | null;
}

export interface AnalyticsSummary {
  generated_at: string; region: string | null;
  totals: Record<'all' | 'draft' | 'in_process' | 'awaiting_institution' | 'correction_submitted' | 'under_scrutiny' | 'completed' | 'overdue', number>;
  by_status: { status: string; count: number }[];
  by_stage: { stage: string; kind: string; count: number; avg_stage_age_days: number; overdue: number }[];
  by_region: { region: string; count: number; overdue: number }[];
  ageing: { bucket: string; min_days: number; max_days: number | null; count: number }[];
  workload: { officer_id: string | null; officer: string; open_cases: number; overdue: number }[];
  evc: Record<string, number>; evc_overdue: number;
  compliance: Record<string, number>; validity: Record<string, number>;
  escalations_open: number; tasks_overdue: number;
}

export interface DirectoryEntry { id: string; full_name: string; designation: string | null; roles: string[] | null }

// ---- Deficiency Matrix ----------------------------------------------------
export type MatrixResult = 'passed' | 'potential_issue' | 'failed_validation' | 'extraction_failed' | 'not_checked' | 'manual_review';
export interface MatrixRow {
  section: 'form' | 'documents' | 'duplicates' | 'precheck' | 'rules'; check_code: string; label: string; input_value: string;
  requirement: string; result: MatrixResult; rule_ref: string; source: string; explanation: string; is_synthetic: boolean;
  document_id: string | null; sort_order: number;
}
export interface ComplianceRule {
  id: string; code: string; version: number; label: string; kind: string; applies_to: string[]; params: Record<string, unknown>;
  source_reference: string; is_synthetic: boolean; explanation: string; status: 'active' | 'retired'; created_at: string;
  retired_at: string | null; retired_reason: string | null;
}

// ---- Concurrent review tasks ---------------------------------------------
export type ReviewTaskStatus = 'pending' | 'in_review' | 'completed' | 'returned' | 'cancelled';
export interface ReviewTask {
  id: string; application_id: string; stage_history_id: string; stage_code: string; review_code: string; name: string;
  required_capability: string; region_code: string; assignee_id: string | null; status: ReviewTaskStatus; outcome_note: string | null;
  due_at: string | null; row_version: number; created_at: string; started_at: string | null; completed_at: string | null;
  completed_by: string | null; applications?: { reference: string; title: string } | null;
  review_task_history?: ReviewTaskHistory[];
}
export interface ReviewTaskHistory { id: string; task_id: string; action: string; from_status: string | null; to_status: string | null; actor_id: string | null; reason: string | null; created_at: string }

// ---- EVC assignment checks ------------------------------------------------
export type CheckStatus = 'ok' | 'info' | 'manual_review' | 'blocked';
export interface EvcCheckReason { code: string; status: CheckStatus; overridable?: boolean; detail: string }
export interface EvcPersonCheck { user_id: string; name: string; status: 'eligible' | 'manual_review' | 'blocked'; overridable: boolean; reasons: EvcCheckReason[] }
export interface EvcAssignmentCheck { readiness: EvcCheckReason[]; people: EvcPersonCheck[]; policy: Record<string, unknown> | null; blocked: boolean; needs_override: boolean }
export interface EvcAvailability { id: string; user_id: string; starts_at: string; ends_at: string; kind: 'available' | 'unavailable'; note: string | null; withdrawn_at: string | null; created_at: string }
export interface EvcConflictDeclaration { id: string; user_id: string; institution_id: string; nature: string; declared_at: string; withdrawn_at: string | null; institutions?: { name: string } | null }

// ---- Document version comparison -----------------------------------------
export interface VersionMeta { id: string; version: number; file_name: string; mime_type: string; size_bytes: number; sha256: string | null; uploaded_at: string; replaced_reason: string | null }
export interface VersionComparison {
  document: { id: string; title: string; doc_type: string }; old: VersionMeta; new: VersionMeta; identical_file: boolean;
  metadata_changes: { field: string; old: string | number; new: string | number }[];
  content: { available: boolean; reason: string | null; text_available: boolean; text_reason: string | null; old_text: string | null; new_text: string | null; fields: { check_code: string; label: string; old: string | null; new: string | null; old_outcome: string | null; new_outcome: string | null; changed: boolean }[] };
}
