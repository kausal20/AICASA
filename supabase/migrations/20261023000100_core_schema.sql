-- AICASA core schema
-- All timestamps are timestamptz stored in UTC. Display timezone is a system setting.
-- Writes from the browser never touch these tables directly: every mutation goes through
-- the SECURITY DEFINER functions in the workflow/operations migrations, which verify the
-- caller, scope, current state and configured rules.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type app.app_role as enum ('institution', 'officer', 'admin');

create type app.application_status as enum (
  'draft', 'submitted', 'under_scrutiny', 'returned_for_correction', 'correction_submitted',
  'awaiting_verification', 'ready_for_next_stage', 'evc_required', 'evc_scheduled', 'evc_completed',
  'committee_review', 'awaiting_decision', 'completed', 'closed', 'withdrawn'
);

create type app.stage_kind as enum ('intake', 'scrutiny', 'evc', 'committee', 'decision', 'terminal');

create type app.deficiency_status as enum (
  'open', 'correction_submitted', 'still_deficient', 'needs_clarification', 'resolved', 'withdrawn'
);

create type app.evc_status as enum ('awaiting_scheduling', 'proposed', 'scheduled', 'completed', 'cancelled');

create type app.obligation_status as enum (
  'awaiting_submission', 'submitted', 'under_verification', 'verified', 'correction_required', 'closed'
);

create type app.finding_outcome as enum (
  'passed', 'potential_issue', 'missing_information', 'extraction_failed', 'manual_review', 'not_checked'
);

-- ---------------------------------------------------------------------------
-- Identity, organisations and scope
-- ---------------------------------------------------------------------------
create table public.regions (
  code text primary key check (code ~ '^[A-Z]{2,4}$'),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  designation text,
  phone text,
  is_active boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Authority lives here, never in a client-editable profile column.
create table public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role app.app_role not null,
  -- null region for officer/admin = national scope. Institution users are scoped by membership instead.
  region_code text references public.regions (code),
  capabilities text[] not null default '{}',
  is_active boolean not null default true,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id),
  revoked_at timestamptz,
  revoke_reason text,
  constraint capabilities_known check (
    capabilities <@ array['scrutiny','evc','committee','compliance','decision','assignment',
                          'workflow_config','user_admin','reports','audit','escalation']::text[]
  ),
  constraint revoked_consistent check ((is_active and revoked_at is null) or (not is_active and revoked_at is not null))
);
create index on public.user_role_assignments (user_id) where is_active;
create unique index user_role_unique_active on public.user_role_assignments (user_id, role, coalesce(region_code, '*')) where is_active;

create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- human-readable demo identifier, not an official AICTE ID
  name text not null,
  kind text not null check (kind in ('college', 'university', 'standalone_institution')),
  region_code text not null references public.regions (code),
  state text not null,
  city text not null,
  address text,
  contact_email text,
  contact_phone text,
  is_demo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.institutions (region_code);

create table public.institution_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  institution_id uuid not null references public.institutions (id) on delete cascade,
  member_role text not null default 'representative' check (member_role in ('representative', 'viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, institution_id)
);

-- A university sees an affiliated college only through an explicit, revocable grant.
create table public.institution_access_grants (
  id uuid primary key default gen_random_uuid(),
  grantee_institution_id uuid not null references public.institutions (id) on delete cascade,
  target_institution_id uuid not null references public.institutions (id) on delete cascade,
  relationship text not null default 'affiliation',
  scope text not null default 'read' check (scope in ('read')),
  is_active boolean not null default true,
  source_reference text not null,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  check (grantee_institution_id <> target_institution_id),
  unique (grantee_institution_id, target_institution_id)
);

-- ---------------------------------------------------------------------------
-- Workflow configuration (versioned)
-- ---------------------------------------------------------------------------
create table public.workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table public.workflow_definition_versions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references public.workflow_definitions (id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'active' check (status in ('draft', 'active', 'retired')),
  source_reference text not null,
  change_summary text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  authorised_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (definition_id, version)
);
create unique index one_active_version_per_definition on public.workflow_definition_versions (definition_id) where status = 'active';

create table public.workflow_stages (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.workflow_definition_versions (id) on delete cascade,
  code text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  kind app.stage_kind not null,
  sequence integer not null,
  sla_days integer check (sla_days is null or sla_days > 0),   -- internal target, not a statutory deadline
  responsible_capability text,
  description text not null default '',
  unique (version_id, code),
  unique (version_id, sequence)
);

create table public.workflow_transitions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.workflow_definition_versions (id) on delete cascade,
  code text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  from_stage text not null,
  to_stage text not null,
  allowed_role app.app_role,            -- null = system/automatic only
  required_capability text,
  requires_reason boolean not null default false,
  is_automatic boolean not null default false,
  prerequisites text[] not null default '{}',
  records_decision boolean not null default false,
  sort_order integer not null default 0,
  unique (version_id, code),
  check (is_automatic or allowed_role is not null)
);

create table public.application_types (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text not null,
  description text not null default '',
  workflow_definition_id uuid not null references public.workflow_definitions (id),
  enabled boolean not null default true,
  checklist_version integer not null default 1,
  -- [{key,label,type,required,help}] — institution-facing form fields for this type
  form_schema jsonb not null default '[]'::jsonb,
  route_disclosed boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.document_requirements (
  id uuid primary key default gen_random_uuid(),
  application_type_code text not null references public.application_types (code) on delete cascade,
  checklist_version integer not null,
  doc_type text not null check (doc_type ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text not null default '',
  is_required boolean not null default true,
  allowed_mime_types text[] not null default array['application/pdf'],
  max_bytes integer not null default 10485760,
  expiry_tracked boolean not null default false,
  -- fields the pre-check looks for in extracted text, e.g. {"institution_name","issue_date","expiry_date"}
  required_fields text[] not null default '{}',
  source_reference text not null default 'Demo checklist — verify against current APH before use',
  unique (application_type_code, checklist_version, doc_type)
);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
create sequence public.application_reference_seq start 1001;

create table public.applications (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  institution_id uuid not null references public.institutions (id) on delete restrict,
  region_code text not null references public.regions (code),
  application_type_code text not null references public.application_types (code),
  workflow_version_id uuid not null references public.workflow_definition_versions (id),
  checklist_version integer not null,
  title text not null,
  academic_year text not null check (academic_year ~ '^[0-9]{4}-[0-9]{2}$'),
  form_data jsonb not null default '{}'::jsonb,
  current_stage text not null,
  status app.application_status not null default 'draft',
  stage_entered_at timestamptz not null default now(),
  stage_due_at timestamptz,
  next_action text,
  next_actor text,
  assigned_officer_id uuid references public.profiles (id),
  submitted_at timestamptz,
  closed_at timestamptz,
  row_version integer not null default 1,
  is_demo boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.applications (institution_id);
create index on public.applications (region_code, status);
create index on public.applications (assigned_officer_id) where assigned_officer_id is not null;
create index on public.applications (current_stage);
create index on public.applications (stage_due_at);

create table public.application_stage_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_code text not null,
  stage_name text not null,
  entered_at timestamptz not null default now(),
  due_at timestamptz,
  exited_at timestamptz,
  exit_transition text,
  entered_by uuid references public.profiles (id)
);
create index on public.application_stage_history (application_id, entered_at);

-- Timeline of everything that happened to a case (workflow_events in the spec).
create table public.application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  event_type text not null,
  summary text not null,
  from_stage text,
  to_stage text,
  from_status app.application_status,
  to_status app.application_status,
  actor_id uuid references public.profiles (id),
  actor_kind text not null default 'user' check (actor_kind in ('user', 'system')),
  reason text,
  visibility text not null default 'shared' check (visibility in ('shared', 'internal')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.application_events (application_id, created_at);

create table public.application_assignments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  officer_id uuid not null references public.profiles (id),
  stage_code text not null,
  assigned_by uuid references public.profiles (id),
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  reason text
);
create index on public.application_assignments (officer_id) where ended_at is null;

create table public.application_observations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_code text not null,
  author_id uuid not null references public.profiles (id),
  category text not null default 'general' check (category in ('general', 'document', 'infrastructure', 'faculty', 'finance', 'legal')),
  body text not null check (length(body) between 3 and 4000),
  visibility text not null default 'internal' check (visibility in ('shared', 'internal')),
  created_at timestamptz not null default now()
);

-- Human decisions only. Nothing in the system writes here without a competent officer's action.
create table public.application_decisions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  decision text not null check (decision in ('approved', 'approved_with_conditions', 'not_approved', 'deferred')),
  reason text not null,
  recorded_by uuid not null references public.profiles (id),
  stage_code text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Documents (private storage, versioned)
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete restrict,
  application_id uuid references public.applications (id) on delete restrict,
  doc_type text not null,
  title text not null,
  current_version integer not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.documents (institution_id);
create index on public.documents (application_id);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete restrict,
  version integer not null,
  storage_bucket text not null default 'institution-documents',
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  scan_status text not null default 'not_scanned' check (scan_status in ('not_scanned', 'clean', 'rejected', 'scanner_unavailable')),
  replaced_reason text,
  uploaded_by uuid references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  unique (document_id, version)
);

create table public.document_check_runs (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.document_versions (id) on delete restrict,
  application_id uuid references public.applications (id) on delete set null,
  institution_id uuid not null references public.institutions (id),
  engine text not null,
  checklist_version integer,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  extraction_status text not null default 'not_attempted'
    check (extraction_status in ('not_attempted', 'succeeded', 'partial', 'failed', 'unavailable')),
  extraction_method text,
  steps jsonb not null default '[]'::jsonb,       -- steps actually performed, in order
  limitations text[] not null default '{}',
  summary jsonb not null default '{}'::jsonb,
  error text,
  run_by uuid references public.profiles (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index on public.document_check_runs (document_version_id);

create table public.document_check_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.document_check_runs (id) on delete cascade,
  check_code text not null,
  check_name text not null,
  outcome app.finding_outcome not null,
  severity text not null check (severity in ('info', 'low', 'medium', 'high')),
  explanation text not null,
  evidence text,
  page_ref text,
  suggestion text,
  confidence numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  sort_order integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Deficiencies
-- ---------------------------------------------------------------------------
create table public.deficiencies (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_code text not null,
  title text not null,
  reason text not null,
  requirement_source text not null,
  requested_correction text not null,
  doc_type text,
  responsible_party text not null default 'institution',
  due_at timestamptz not null,
  status app.deficiency_status not null default 'open',
  raised_by uuid not null references public.profiles (id),
  raised_at timestamptz not null default now(),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  row_version integer not null default 1
);
create index on public.deficiencies (application_id, status);
create index on public.deficiencies (due_at) where status in ('open', 'still_deficient', 'needs_clarification');

create table public.deficiency_submissions (
  id uuid primary key default gen_random_uuid(),
  deficiency_id uuid not null references public.deficiencies (id) on delete cascade,
  attempt integer not null,
  response_text text not null,
  document_version_id uuid references public.document_versions (id),
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  unique (deficiency_id, attempt)
);

create table public.deficiency_reviews (
  id uuid primary key default gen_random_uuid(),
  deficiency_id uuid not null references public.deficiencies (id) on delete cascade,
  submission_id uuid not null references public.deficiency_submissions (id),
  outcome text not null check (outcome in ('resolved', 'still_deficient', 'needs_clarification')),
  reason text not null,
  reviewed_by uuid not null references public.profiles (id),
  reviewed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- EVC
-- ---------------------------------------------------------------------------
create table public.evc_records (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_code text not null,
  cycle integer not null default 1,
  status app.evc_status not null default 'awaiting_scheduling',
  ready_at timestamptz not null default now(),
  schedule_due_at timestamptz,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  coordinator_id uuid references public.profiles (id),
  meeting_mode text not null default 'online' check (meeting_mode in ('online')),
  notes text,
  outcome text check (outcome in ('satisfactory', 'deficiencies_noted', 'not_conducted')),
  completion_summary text,
  completed_by uuid references public.profiles (id),
  completed_at timestamptz,
  reschedule_count integer not null default 0,
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (application_id, stage_code, cycle),
  check (scheduled_end is null or scheduled_end > scheduled_start),
  check (status <> 'completed' or (outcome is not null and completion_summary is not null and completed_by is not null))
);
create index on public.evc_records (status);

create table public.evc_participants (
  evc_id uuid not null references public.evc_records (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  participant_role text not null default 'panel_member' check (participant_role in ('coordinator', 'panel_member')),
  primary key (evc_id, user_id)
);

create table public.evc_history (
  id uuid primary key default gen_random_uuid(),
  evc_id uuid not null references public.evc_records (id) on delete cascade,
  action text not null,
  from_status app.evc_status,
  to_status app.evc_status,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  reason text,
  actor_id uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Compliance and document validity
-- ---------------------------------------------------------------------------
create table public.document_validities (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete restrict,
  document_id uuid references public.documents (id),
  document_version_id uuid references public.document_versions (id),
  doc_type text not null,
  title text not null,
  issue_date date,
  expiry_date date not null,
  renewal_state text not null default 'current' check (renewal_state in ('current', 'renewal_requested', 'renewal_submitted', 'renewed', 'lapsed_recorded')),
  superseded_by uuid references public.document_validities (id),
  source_reference text not null default 'Demo configuration',
  recorded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (issue_date is null or issue_date < expiry_date)
);
create index on public.document_validities (expiry_date) where superseded_by is null;

create table public.compliance_obligations (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete restrict,
  region_code text not null references public.regions (code),
  application_id uuid references public.applications (id) on delete set null,
  validity_id uuid references public.document_validities (id),
  parent_obligation_id uuid references public.compliance_obligations (id),
  obligation_type text not null check (obligation_type in ('undertaking', 'condition', 'document_renewal', 'periodic_report')),
  title text not null,
  description text not null,
  source_reference text not null,
  evidence_required text not null,
  responsible_contact text,
  effective_date date not null default current_date,
  due_at timestamptz not null,
  -- 'P1Y', 'P6M' or null; recurrence is created only after verification
  recurrence text check (recurrence is null or recurrence in ('P1M', 'P3M', 'P6M', 'P1Y')),
  status app.obligation_status not null default 'awaiting_submission',
  verifying_officer_id uuid references public.profiles (id),
  closed_reason text,
  row_version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.compliance_obligations (institution_id, status);
create index on public.compliance_obligations (due_at) where status not in ('verified', 'closed');
create unique index one_renewal_obligation_per_validity on public.compliance_obligations (validity_id) where validity_id is not null;
create unique index one_recurrence_per_parent on public.compliance_obligations (parent_obligation_id) where parent_obligation_id is not null;

create table public.compliance_submissions (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.compliance_obligations (id) on delete cascade,
  attempt integer not null,
  comment text not null default '',
  document_version_id uuid references public.document_versions (id),
  renewal_expiry_date date,
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  unique (obligation_id, attempt)
);

create table public.compliance_verifications (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid not null references public.compliance_obligations (id) on delete cascade,
  submission_id uuid not null references public.compliance_submissions (id),
  outcome text not null check (outcome in ('verified', 'correction_required', 'more_information')),
  reason text not null,
  verified_by uuid not null references public.profiles (id),
  verified_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tasks (work items for officers; history lives in audit_logs)
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  task_type text not null check (task_type in ('scrutiny', 'committee_review', 'decision', 'deficiency_review',
                                               'evc_schedule', 'evc_complete', 'compliance_verification', 'escalation_followup')),
  title text not null,
  application_id uuid references public.applications (id) on delete cascade,
  deficiency_id uuid references public.deficiencies (id) on delete cascade,
  evc_id uuid references public.evc_records (id) on delete cascade,
  obligation_id uuid references public.compliance_obligations (id) on delete cascade,
  region_code text not null references public.regions (code),
  assignee_id uuid references public.profiles (id),
  required_capability text,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references public.profiles (id)
);
create index on public.tasks (assignee_id) where status = 'open';
create index on public.tasks (region_code, required_capability) where status = 'open';

-- ---------------------------------------------------------------------------
-- Notifications, reminders and escalations
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  link text,
  entity_type text,
  entity_id uuid,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index on public.notifications (recipient_id, created_at desc);

create table public.notification_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  status text not null check (status in ('pending', 'sent', 'failed', 'skipped_unconfigured', 'skipped_preference')),
  attempt integer not null default 1,
  error text,
  attempted_at timestamptz not null default now()
);

create table public.notification_preferences (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  in_app boolean not null default true,
  email boolean not null default false,
  primary key (user_id, kind)
);

-- Versioned reminder and escalation policy. Rows are never edited in place; a change inserts a
-- new version and retires the old one so past alerts remain explainable.
create table public.escalation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version integer not null,
  is_active boolean not null default true,
  rule_kind text not null check (rule_kind in ('reminder', 'escalation')),
  entity_type text not null check (entity_type in ('application_stage', 'deficiency', 'evc_schedule', 'obligation', 'document_validity')),
  -- negative = hours before due, positive = hours after due
  offset_hours integer not null,
  recipient text not null check (recipient in ('institution', 'assigned_officer', 'capability_officers', 'regional_admin', 'national_admin')),
  recipient_capability text,
  channel text not null default 'in_app' check (channel in ('in_app', 'in_app_and_email')),
  max_repeats integer not null default 1 check (max_repeats between 1 and 10),
  repeat_interval_hours integer check (repeat_interval_hours is null or repeat_interval_hours >= 1),
  source_reference text not null,
  change_summary text not null,
  effective_from timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (code, version)
);
create unique index one_active_rule_version on public.escalation_rules (code) where is_active;

create table public.escalation_events (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.escalation_rules (id),
  entity_type text not null,
  entity_id uuid not null,
  application_id uuid references public.applications (id) on delete cascade,
  institution_id uuid references public.institutions (id),
  region_code text references public.regions (code),
  repeat_no integer not null default 1,
  due_at timestamptz,
  summary text not null,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  idempotency_key text not null unique,
  triggered_at timestamptz not null default now(),
  acknowledged_by uuid references public.profiles (id),
  acknowledged_at timestamptz,
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  resolution_note text
);
create index on public.escalation_events (status, region_code);

create table public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  trigger_source text not null default 'scheduler' check (trigger_source in ('scheduler', 'manual', 'test')),
  triggered_by uuid references public.profiles (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  stats jsonb not null default '{}'::jsonb,
  error text
);

-- ---------------------------------------------------------------------------
-- Audit, settings, integrations, reports
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id),
  actor_kind text not null default 'user' check (actor_kind in ('user', 'system')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  application_id uuid,
  institution_id uuid,
  region_code text,
  reason text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.audit_logs (entity_type, entity_id);
create index on public.audit_logs (application_id);
create index on public.audit_logs (created_at desc);

create table public.system_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

-- Status only. Secrets live in Edge Function secrets, never in a table.
create table public.integration_settings (
  code text primary key,
  name text not null,
  status text not null check (status in ('unconfigured', 'mock', 'configured', 'error')),
  notes text not null default '',
  last_checked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.report_exports (
  id uuid primary key default gen_random_uuid(),
  report_code text not null,
  filters jsonb not null default '{}'::jsonb,
  row_count integer not null,
  generated_by uuid not null references public.profiles (id),
  generated_at timestamptz not null default now()
);
