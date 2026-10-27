import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { workWindow } from '@/lib/workQueue';
import type {
  AppEvent, Application, ApplicationRow, ApplicationType, AvailableTransition, DirectoryEntry, DocumentRequirement,
  Observation, StageHistory, StageReview, WorkflowStage, WorkflowTransition,
} from '@/types/domain';

export interface ApplicationFilters {
  search?: string;
  status?: string;
  stage?: string;
  type?: string;
  region?: string;
  institutionId?: string;
  assignedTo?: string;
  unassigned?: boolean;
  overdueOnly?: boolean;
  evcThisWeek?: boolean;
  /** open = in process (not draft/completed/closed); closed = completed or closed; action = with the institution */
  group?: 'open' | 'closed' | 'action';
  ageMin?: number;
  ageMax?: number;
  sort?: SortField;
  dir?: 'asc' | 'desc';
}
export type SortField = 'updated' | 'due' | 'age' | 'reference' | 'institution' | 'stage' | 'status';

const SORT_COLUMN: Record<SortField, string> = {
  updated: 'updated_at', due: 'due_at', age: 'age_days', reference: 'reference', institution: 'institution_name',
  stage: 'stage_name', status: 'status',
};
const DEFAULT_DIR: Record<SortField, 'asc' | 'desc'> = {
  updated: 'desc', due: 'asc', age: 'desc', reference: 'asc', institution: 'asc', stage: 'asc', status: 'asc',
};

export const PAGE_SIZE = 15;

export async function listApplications(f: ApplicationFilters, page = 0) {
  let q = supabase.from('v_applications').select('*', { count: 'exact' });
  if (f.evcThisWeek) {
    const time = workWindow();
    const visits = unwrap(await supabase.from('v_evc_queue').select('application_id').in('status', ['scheduled', 'completed']).gte('scheduled_start', time.weekStart).lt('scheduled_start', time.weekEnd)) as { application_id: string }[];
    if (!visits.length) return { rows: [], total: 0 };
    q = q.in('id', [...new Set(visits.map((v) => v.application_id))]);
  }
  if (f.search?.trim()) {
    const s = f.search.trim().replace(/[%,()]/g, ' ');
    q = q.or(`reference.ilike.%${s}%,title.ilike.%${s}%,institution_name.ilike.%${s}%`);
  }
  if (f.status) q = q.eq('status', f.status);
  if (f.stage) q = q.eq('stage_kind', f.stage);
  if (f.type) q = q.eq('application_type_code', f.type);
  if (f.region) q = q.eq('region_code', f.region);
  if (f.institutionId) q = q.eq('institution_id', f.institutionId);
  if (f.assignedTo) q = q.eq('assigned_officer_id', f.assignedTo);
  if (f.unassigned) q = q.is('assigned_officer_id', null);
  if (f.overdueOnly) q = q.eq('is_overdue', true);
  if (f.group === 'open') q = q.not('status', 'in', '(draft,completed,closed,withdrawn)');
  if (f.group === 'closed') q = q.in('status', ['completed', 'closed']);
  // "with the institution" means returned for correction; unsubmitted drafts are counted under Drafts, never here
  if (f.group === 'action') q = q.eq('status', 'returned_for_correction');
  if (f.ageMin !== undefined) q = q.gte('age_days', f.ageMin);
  if (f.ageMax !== undefined) q = q.lte('age_days', f.ageMax);
  const sort = f.sort ?? 'updated';
  const dir = f.dir ?? DEFAULT_DIR[sort];
  q = q.order(SORT_COLUMN[sort], { ascending: dir === 'asc', nullsFirst: false });
  if (sort !== 'reference') q = q.order('reference', { ascending: true });
  const res = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  return { rows: unwrap(res) as ApplicationRow[], total: res.count ?? 0 };
}

export async function getApplicationRow(id: string) {
  return unwrap(await supabase.from('v_applications').select('*').eq('id', id).maybeSingle()) as ApplicationRow | null;
}

export async function getApplication(id: string) {
  return unwrap(await supabase.from('applications').select('*').eq('id', id).maybeSingle()) as Application | null;
}

export async function getApplicationTypes() {
  return unwrap(await supabase.from('application_types').select('*').eq('enabled', true).order('name')) as ApplicationType[];
}

export async function getRequirements(typeCode: string, checklistVersion: number) {
  return unwrap(await supabase.from('document_requirements').select('*')
    .eq('application_type_code', typeCode).eq('checklist_version', checklistVersion)
    .order('is_required', { ascending: false }).order('name')) as DocumentRequirement[];
}

export async function getRoute(versionId: string) {
  const [stages, transitions, reviews] = await Promise.all([
    supabase.from('workflow_stages').select('*').eq('version_id', versionId).order('sequence'),
    supabase.from('workflow_transitions').select('*').eq('version_id', versionId).order('sort_order'),
    supabase.from('workflow_stage_reviews').select('stage_code, code, name, required_capability, description, sort_order').eq('version_id', versionId).order('sort_order'),
  ]);
  const configured = unwrap(reviews) as (StageReview & { stage_code: string })[];
  const rows = (unwrap(stages) as WorkflowStage[]).map((s) => ({
    ...s,
    reviews: configured.filter((r) => r.stage_code === s.code)
      .map((r) => ({ code: r.code, name: r.name, required_capability: r.required_capability, description: r.description, sort_order: r.sort_order })),
  }));
  return { stages: rows, transitions: unwrap(transitions) as WorkflowTransition[] };
}

export async function getActiveRouteForType(definitionId: string) {
  const v = unwrap(await supabase.from('workflow_definition_versions').select('id, version').eq('definition_id', definitionId).eq('status', 'active').maybeSingle()) as { id: string; version: number } | null;
  if (!v) return null;
  return { version: v.version, ...(await getRoute(v.id)) };
}

/** Officers who hold the current stage's responsibility in the case's region (the only ones the server accepts). */
export async function getEligibleCaseOfficers(applicationId: string) {
  return unwrap(await supabase.rpc('eligible_case_officers', { p_application_id: applicationId })) as { officer_id: string; full_name: string; designation: string | null }[];
}

export async function getStageHistory(id: string) {
  return unwrap(await supabase.from('application_stage_history').select('*').eq('application_id', id).order('entered_at')) as StageHistory[];
}

export async function getEvents(id: string) {
  return unwrap(await supabase.from('application_events').select('*').eq('application_id', id).order('created_at', { ascending: false })) as AppEvent[];
}

export async function getObservations(id: string) {
  return unwrap(await supabase.from('application_observations').select('*').eq('application_id', id).order('created_at', { ascending: false })) as Observation[];
}

export async function getDecisions(id: string) {
  return unwrap(await supabase.from('application_decisions').select('*').eq('application_id', id).order('created_at', { ascending: false })) as
    { id: string; decision: string; reason: string; recorded_by: string; created_at: string }[];
}

export async function getAvailableTransitions(id: string) {
  return unwrap(await supabase.rpc('available_transitions', { p_application_id: id })) as AvailableTransition[];
}

export async function getDirectory() {
  return unwrap(await supabase.from('profile_directory').select('*')) as DirectoryEntry[];
}

export async function createDraft(input: { institutionId: string; typeCode: string; title: string; academicYear: string; formData: Record<string, unknown> }) {
  return unwrap(await supabase.rpc('create_application_draft', {
    p_institution_id: input.institutionId, p_type_code: input.typeCode, p_title: input.title,
    p_academic_year: input.academicYear, p_form_data: input.formData,
  })) as Application;
}

export async function updateDraft(input: { id: string; version: number; title: string; academicYear: string; formData: Record<string, unknown> }) {
  return unwrap(await supabase.rpc('update_application_draft', {
    p_application_id: input.id, p_expected_version: input.version, p_title: input.title,
    p_academic_year: input.academicYear, p_form_data: input.formData,
  })) as Application;
}

export async function submitApplication(id: string, version: number) {
  return unwrap(await supabase.rpc('submit_application', { p_application_id: id, p_expected_version: version })) as Application;
}

export interface TransitionResult { ok: boolean; code?: string; message?: string; application?: Application }

export async function performTransition(id: string, code: string, version: number, reason?: string, payload: Record<string, unknown> = {}) {
  return unwrap(await supabase.rpc('perform_transition', {
    p_application_id: id, p_transition_code: code, p_expected_version: version, p_reason: reason ?? null, p_payload: payload,
  })) as TransitionResult;
}

export async function addObservation(id: string, category: string, body: string, visibility: 'internal' | 'shared') {
  return unwrap(await supabase.rpc('add_observation', { p_application_id: id, p_category: category, p_body: body, p_visibility: visibility }));
}

export async function reassignApplication(id: string, officerId: string, reason: string) {
  return unwrap(await supabase.rpc('reassign_application', { p_application_id: id, p_officer_id: officerId, p_reason: reason }));
}
