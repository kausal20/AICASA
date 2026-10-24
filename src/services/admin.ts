import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type { AuditRow, EscalationRule, Role, WorkflowVersion } from '@/types/domain';

export async function listWorkflowDefinitions() {
  return unwrap(await supabase.from('workflow_definitions').select('*, workflow_definition_versions(*)').order('name')) as
    { id: string; code: string; name: string; description: string; workflow_definition_versions: WorkflowVersion[] }[];
}

export async function publishWorkflowVersion(definitionId: string, stages: unknown[], transitions: unknown[], source: string, summary: string) {
  return unwrap(await supabase.rpc('publish_workflow_version', {
    p_definition_id: definitionId, p_stages: stages, p_transitions: transitions, p_source_reference: source, p_change_summary: summary,
  })) as WorkflowVersion;
}

export interface UserRow {
  id: string; email: string; full_name: string; designation: string | null; is_active: boolean; is_demo: boolean;
  user_role_assignments: { id: string; role: Role; region_code: string | null; capabilities: string[]; is_active: boolean; granted_at: string }[];
  institution_memberships: { institution_id: string; member_role: string; is_active: boolean; institutions: { name: string } | null }[];
}

export async function listUsers() {
  return unwrap(await supabase.from('profiles')
    .select('id, email, full_name, designation, is_active, is_demo, user_role_assignments!user_role_assignments_user_id_fkey(id, role, region_code, capabilities, is_active, granted_at), institution_memberships(institution_id, member_role, is_active, institutions(name))')
    .order('full_name')) as unknown as UserRow[];
}

export async function assignRole(input: { userId: string; role: Role; region: string | null; capabilities: string[]; reason: string; institutionId?: string | null }) {
  return unwrap(await supabase.rpc('assign_role', {
    p_user_id: input.userId, p_role: input.role, p_region_code: input.region, p_capabilities: input.capabilities,
    p_reason: input.reason, p_institution_id: input.institutionId ?? null,
  }));
}

export async function revokeRole(assignmentId: string, reason: string) {
  return unwrap(await supabase.rpc('revoke_role', { p_assignment_id: assignmentId, p_reason: reason }));
}

export async function listRules() {
  return unwrap(await supabase.from('escalation_rules').select('*').order('code').order('version', { ascending: false })) as EscalationRule[];
}

export async function updateRule(input: {
  code: string; offsetHours: number; recipient: string; recipientCapability: string | null; channel: string;
  maxRepeats: number; repeatIntervalHours: number | null; active: boolean; source: string | null; summary: string;
}) {
  return unwrap(await supabase.rpc('update_escalation_rule', {
    p_code: input.code, p_offset_hours: input.offsetHours, p_recipient: input.recipient, p_recipient_capability: input.recipientCapability,
    p_channel: input.channel, p_max_repeats: input.maxRepeats, p_repeat_interval_hours: input.repeatIntervalHours,
    p_active: input.active, p_source_reference: input.source, p_change_summary: input.summary,
  })) as EscalationRule;
}

export interface AuditFilters { action?: string; entityType?: string; search?: string; from?: string; to?: string }

export async function listAudit(f: AuditFilters, page = 0, pageSize = 25) {
  let q = supabase.from('v_audit_logs').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  if (f.action) q = q.eq('action', f.action);
  if (f.entityType) q = q.eq('entity_type', f.entityType);
  if (f.search?.trim()) q = q.ilike('application_reference', `%${f.search.trim().replace(/[%,]/g, '')}%`);
  if (f.from) q = q.gte('created_at', `${f.from}T00:00:00+05:30`);
  if (f.to) q = q.lte('created_at', `${f.to}T23:59:59+05:30`);
  const res = await q.range(page * pageSize, page * pageSize + pageSize - 1);
  return { rows: unwrap(res) as AuditRow[], total: res.count ?? 0 };
}

export async function listAuditForApplication(applicationId: string) {
  return unwrap(await supabase.from('v_audit_logs').select('*').eq('application_id', applicationId).order('created_at', { ascending: false }).limit(200)) as AuditRow[];
}

export async function listJobRuns() {
  return unwrap(await supabase.from('scheduled_job_runs').select('*').order('started_at', { ascending: false }).limit(20)) as
    { id: string; job_name: string; trigger_source: string; started_at: string; finished_at: string | null; status: string; stats: Record<string, number>; error: string | null }[];
}

export async function runScanNow() {
  return unwrap(await supabase.rpc('run_deadline_scan_now')) as { status: string; stats: Record<string, number>; error: string | null };
}

export async function listIntegrations() {
  return unwrap(await supabase.from('integration_settings').select('*').order('name')) as { code: string; name: string; status: string; notes: string; last_checked_at: string | null }[];
}

export async function listDeliveryAttempts() {
  return unwrap(await supabase.from('notification_delivery_attempts').select('*, notifications(title, kind)').order('attempted_at', { ascending: false }).limit(50)) as
    { id: string; channel: string; status: string; attempt: number; error: string | null; attempted_at: string; notifications: { title: string; kind: string } | null }[];
}

export async function recordExport(code: string, filters: Record<string, unknown>, rows: number) {
  return unwrap(await supabase.rpc('record_report_export', { p_report_code: code, p_filters: filters, p_row_count: rows }));
}

export async function listRegions() {
  return unwrap(await supabase.from('regions').select('*').order('code')) as { code: string; name: string }[];
}

export async function listInstitutions() {
  return unwrap(await supabase.from('institutions').select('*').order('name')) as
    { id: string; code: string; name: string; kind: string; region_code: string; state: string; city: string; address: string | null; contact_email: string | null; contact_phone: string | null; is_demo: boolean }[];
}
