import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type {
  AnalyticsSummary, ComplianceSubmission, ComplianceVerification, Deficiency, EscalationRow, EvcHistory, EvcRow,
  NotificationRow, ObligationRow, TaskRow, ValidityRow,
} from '@/types/domain';

// ---- Deficiencies ---------------------------------------------------------
export async function listDeficiencies(opts: { applicationId?: string; openOnly?: boolean } = {}) {
  let q = supabase.from('deficiencies')
    .select('*, deficiency_submissions(*), deficiency_reviews(*), applications(reference, title, institution_id, status)')
    .order('raised_at', { ascending: false });
  if (opts.applicationId) q = q.eq('application_id', opts.applicationId);
  if (opts.openOnly) q = q.not('status', 'in', '(resolved,withdrawn)');
  const rows = unwrap(await q) as Deficiency[];
  for (const d of rows) {
    d.deficiency_submissions?.sort((a, b) => a.attempt - b.attempt);
    d.deficiency_reviews?.sort((a, b) => a.reviewed_at.localeCompare(b.reviewed_at));
  }
  return rows;
}

export async function raiseDeficiency(input: { applicationId: string; title: string; reason: string; source: string; correction: string; docType?: string; dueAt: string }) {
  return unwrap(await supabase.rpc('raise_deficiency', {
    p_application_id: input.applicationId, p_title: input.title, p_reason: input.reason, p_requirement_source: input.source,
    p_requested_correction: input.correction, p_doc_type: input.docType ?? null, p_due_at: input.dueAt,
  }));
}

export async function returnForCorrection(applicationId: string, version: number, reason: string) {
  return unwrap(await supabase.rpc('return_for_correction', { p_application_id: applicationId, p_expected_version: version, p_reason: reason }));
}

export async function submitCorrection(deficiencyId: string, response: string, documentVersionId?: string | null) {
  return unwrap(await supabase.rpc('submit_deficiency_correction', {
    p_deficiency_id: deficiencyId, p_response_text: response, p_document_version_id: documentVersionId ?? null,
  }));
}

export async function reviewCorrection(deficiencyId: string, outcome: 'resolved' | 'still_deficient' | 'needs_clarification', reason: string) {
  return unwrap(await supabase.rpc('review_deficiency_correction', { p_deficiency_id: deficiencyId, p_outcome: outcome, p_reason: reason }));
}

// ---- EVC ------------------------------------------------------------------
export async function listEvc(opts: { applicationId?: string; status?: string } = {}) {
  let q = supabase.from('v_evc_queue').select('*').order('ready_at', { ascending: true });
  if (opts.applicationId) q = q.eq('application_id', opts.applicationId);
  if (opts.status) q = q.eq('status', opts.status);
  return unwrap(await q) as EvcRow[];
}

export async function getEvcHistory(evcId: string) {
  return unwrap(await supabase.from('evc_history').select('*').eq('evc_id', evcId).order('created_at')) as EvcHistory[];
}

export async function getEvcParticipants(evcId: string) {
  return unwrap(await supabase.from('evc_participants').select('*').eq('evc_id', evcId)) as { user_id: string; participant_role: string }[];
}

export async function scheduleEvc(input: { evcId: string; start: string; end: string; participants: string[]; confirm: boolean; notes?: string; version: number; reason?: string }) {
  return unwrap(await supabase.rpc('schedule_evc', {
    p_evc_id: input.evcId, p_start: input.start, p_end: input.end, p_participant_ids: input.participants, p_confirm: input.confirm,
    p_notes: input.notes ?? null, p_expected_version: input.version, p_reason: input.reason ?? null,
  })) as { evc: EvcRow; conflicts: { evc_id: string; reference: string; start: string; end: string }[] };
}

export async function cancelEvc(evcId: string, reason: string, version: number) {
  return unwrap(await supabase.rpc('cancel_evc', { p_evc_id: evcId, p_reason: reason, p_expected_version: version }));
}

export async function completeEvc(evcId: string, outcome: 'satisfactory' | 'deficiencies_noted', summary: string, version: number) {
  return unwrap(await supabase.rpc('complete_evc', { p_evc_id: evcId, p_outcome: outcome, p_summary: summary, p_expected_version: version }));
}

export async function listEvcOfficers() {
  return unwrap(await supabase.from('user_role_assignments').select('user_id, region_code, capabilities').eq('role', 'officer').eq('is_active', true)
    .contains('capabilities', ['evc'])) as { user_id: string; region_code: string | null }[];
}

// ---- Compliance -----------------------------------------------------------
export async function listObligations(opts: { institutionId?: string; status?: string } = {}) {
  let q = supabase.from('v_obligations').select('*').order('due_at', { ascending: true });
  if (opts.institutionId) q = q.eq('institution_id', opts.institutionId);
  if (opts.status) q = q.eq('effective_status', opts.status);
  return unwrap(await q) as ObligationRow[];
}

export async function getObligationHistory(id: string) {
  const [subs, vers] = await Promise.all([
    supabase.from('compliance_submissions').select('*').eq('obligation_id', id).order('attempt'),
    supabase.from('compliance_verifications').select('*').eq('obligation_id', id).order('verified_at'),
  ]);
  return { submissions: unwrap(subs) as ComplianceSubmission[], verifications: unwrap(vers) as ComplianceVerification[] };
}

export async function createObligation(input: {
  institutionId: string; applicationId?: string | null; type: string; title: string; description: string; source: string;
  evidence: string; contact?: string; dueDate: string; recurrence?: string | null;
}) {
  return unwrap(await supabase.rpc('create_obligation', {
    p_institution_id: input.institutionId, p_application_id: input.applicationId ?? null, p_type: input.type, p_title: input.title,
    p_description: input.description, p_source_reference: input.source, p_evidence_required: input.evidence,
    p_responsible_contact: input.contact ?? null, p_due_date: input.dueDate, p_recurrence: input.recurrence ?? null,
  }));
}

export async function submitEvidence(obligationId: string, documentVersionId: string, comment: string, renewalExpiry: string | null, version: number) {
  return unwrap(await supabase.rpc('submit_compliance_evidence', {
    p_obligation_id: obligationId, p_document_version_id: documentVersionId, p_comment: comment,
    p_renewal_expiry_date: renewalExpiry, p_expected_version: version,
  }));
}

export async function verifyCompliance(obligationId: string, outcome: 'verified' | 'correction_required' | 'more_information', reason: string, version: number) {
  return unwrap(await supabase.rpc('verify_compliance', { p_obligation_id: obligationId, p_outcome: outcome, p_reason: reason, p_expected_version: version }));
}

export async function closeObligation(obligationId: string, reason: string) {
  return unwrap(await supabase.rpc('close_obligation', { p_obligation_id: obligationId, p_reason: reason }));
}

export async function listValidities(opts: { institutionId?: string } = {}) {
  let q = supabase.from('v_document_validity').select('*').order('expiry_date', { ascending: true });
  if (opts.institutionId) q = q.eq('institution_id', opts.institutionId);
  return unwrap(await q) as ValidityRow[];
}

export async function recordValidity(input: { institutionId: string; versionId: string | null; docType: string; title: string; issueDate: string | null; expiryDate: string; source: string }) {
  return unwrap(await supabase.rpc('record_document_validity', {
    p_institution_id: input.institutionId, p_document_version_id: input.versionId, p_doc_type: input.docType, p_title: input.title,
    p_issue_date: input.issueDate, p_expiry_date: input.expiryDate, p_source_reference: input.source,
  }));
}

// ---- Tasks, notifications, escalations, analytics -------------------------
export async function listTasks(opts: { mine?: string; status?: string } = {}) {
  let q = supabase.from('v_tasks').select('*').order('due_at', { ascending: true, nullsFirst: false });
  if (opts.mine) q = q.eq('assignee_id', opts.mine);
  q = q.eq('status', opts.status ?? 'open');
  return unwrap(await q.limit(300)) as TaskRow[];
}

export async function listNotifications(limit = 50) {
  return unwrap(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(limit)) as NotificationRow[];
}

export async function unreadCount() {
  const r = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
  if (r.error) throw r.error;
  return r.count ?? 0;
}

export async function markRead(ids: string[] | null) {
  return unwrap(await supabase.rpc('mark_notifications_read', { p_ids: ids }));
}

export async function getPreferences() {
  return unwrap(await supabase.from('notification_preferences').select('*')) as { kind: string; in_app: boolean; email: boolean }[];
}

export async function setPreference(kind: string, inApp: boolean, email: boolean) {
  return unwrap(await supabase.rpc('set_notification_preference', { p_kind: kind, p_in_app: inApp, p_email: email }));
}

export async function listEscalations(status?: string) {
  let q = supabase.from('v_escalations').select('*').order('triggered_at', { ascending: false });
  if (status) q = q.eq('status', status);
  return unwrap(await q.limit(200)) as EscalationRow[];
}

export async function updateEscalation(id: string, action: 'acknowledge' | 'resolve', note: string) {
  return unwrap(await supabase.rpc('update_escalation_event', { p_event_id: id, p_action: action, p_note: note }));
}

export async function getAnalytics(region?: string | null) {
  return unwrap(await supabase.rpc('analytics_summary', { p_region: region ?? null })) as AnalyticsSummary;
}
