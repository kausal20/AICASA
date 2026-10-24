-- Differentiation upgrade:
--   A. Deficiency Matrix: a versioned registry of configured rules and a server-side evaluator that combines form,
--      document, duplicate, pre-check and configured-rule results. It never rejects an application.
--   B. Concurrent review tasks configured per route version and stage, with a "review_tasks_complete" prerequisite.
--   C. EVC assignment checks: recorded availability, declared conflicts of interest and a configurable policy.
--   D. Version-controlled corrections: affected document version, mandatory new version, version comparison,
--      configured default correction period.
-- All writes go through SECURITY DEFINER functions; browser roles only read through RLS.

create or replace function app.try_numeric(p text) returns numeric
language plpgsql immutable set search_path = public, app as $$
begin
  if p is null or trim(p) = '' then return null; end if;
  return trim(p)::numeric;
exception when others then return null;
end $$;

-- ---------------------------------------------------------------------------
-- A. Configured rule registry
-- ---------------------------------------------------------------------------
create table public.compliance_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  version integer not null default 1,
  label text not null,
  -- not constrained here on purpose: a kind this engine does not support is reported as "manual review required"
  kind text not null,
  applies_to text[] not null check (cardinality(applies_to) > 0),
  params jsonb not null default '{}'::jsonb,
  source_reference text not null check (length(trim(source_reference)) >= 5),
  is_synthetic boolean not null default true,
  explanation text not null default '',
  status text not null default 'active' check (status in ('active', 'retired')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_reason text,
  unique (code, version)
);
create unique index one_active_rule_per_code on public.compliance_rules (code) where status = 'active';

alter table public.compliance_rules enable row level security;
create policy read_compliance_rules on public.compliance_rules for select to authenticated using (app.is_active_user());
revoke all on public.compliance_rules from anon, authenticated;
grant select on public.compliance_rules to authenticated, service_role;

create or replace function public.publish_compliance_rule(
  p_code text, p_label text, p_kind text, p_applies_to text[], p_params jsonb, p_source_reference text,
  p_is_synthetic boolean, p_explanation text, p_change_reason text
) returns public.compliance_rules
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_old compliance_rules; v_new compliance_rules; v_type text; v_f text; v_fields text[];
begin
  if not app.is_national_admin() or not app.has_capability('workflow_config') then
    perform app.fail('forbidden', 'Only national administrators with workflow-configuration responsibility can publish rules.');
  end if;
  if coalesce(p_code, '') !~ '^[a-z][a-z0-9_]*$' then perform app.fail('validation', 'Rule code must be lower-case letters, digits and underscores.'); end if;
  if length(trim(coalesce(p_label, ''))) < 3 then perform app.fail('validation', 'A rule label is required.'); end if;
  if length(trim(coalesce(p_source_reference, ''))) < 5 then perform app.fail('validation', 'A source reference is required for every rule.'); end if;
  if length(trim(coalesce(p_change_reason, ''))) < 10 then perform app.fail('reason_required', 'Describe why this rule is being published (at least 10 characters).'); end if;
  if p_kind not in ('min', 'max', 'ratio_max', 'consistency_gt') then
    perform app.fail('validation', 'Unsupported rule kind "' || coalesce(p_kind, '') || '". Supported: min, max, ratio_max, consistency_gt.');
  end if;
  if coalesce(cardinality(p_applies_to), 0) = 0 then perform app.fail('validation', 'State the application types this rule applies to.'); end if;

  v_fields := case p_kind
    when 'ratio_max' then array[p_params ->> 'numerator', p_params ->> 'denominator']
    when 'consistency_gt' then array[p_params ->> 'field', p_params ->> 'other']
    else array[p_params ->> 'field'] end;
  if p_kind in ('min', 'max', 'ratio_max') and app.try_numeric(p_params ->> 'threshold') is null then
    perform app.fail('validation', 'A numeric threshold is required for this rule kind.');
  end if;
  foreach v_type in array p_applies_to loop
    if not exists (select 1 from application_types where code = v_type) then
      perform app.fail('validation', 'Unknown application type ' || v_type || '.');
    end if;
    foreach v_f in array v_fields loop
      if v_f is null or not exists (select 1 from application_types t, jsonb_array_elements(t.form_schema) f
                                    where t.code = v_type and f ->> 'key' = v_f) then
        perform app.fail('validation', 'Field "' || coalesce(v_f, '?') || '" is not on the ' || v_type || ' form, so the rule could never be evaluated.');
      end if;
    end loop;
  end loop;

  select * into v_old from compliance_rules where code = p_code and status = 'active' for update;
  if v_old.id is not null then
    update compliance_rules set status = 'retired', retired_at = now(), retired_reason = 'Superseded by a new version' where id = v_old.id;
  end if;
  insert into compliance_rules (code, version, label, kind, applies_to, params, source_reference, is_synthetic, explanation, created_by)
  values (p_code, coalesce((select max(version) from compliance_rules where code = p_code), 0) + 1, trim(p_label), p_kind, p_applies_to,
          coalesce(p_params, '{}'::jsonb), trim(p_source_reference), coalesce(p_is_synthetic, true), coalesce(trim(p_explanation), ''), v_uid)
  returning * into v_new;
  perform app.audit('compliance_rule_published', 'compliance_rule', v_new.id, null, null, null, trim(p_change_reason),
    case when v_old.id is null then null else jsonb_build_object('version', v_old.version, 'params', v_old.params) end,
    jsonb_build_object('code', v_new.code, 'version', v_new.version, 'params', v_new.params, 'synthetic', v_new.is_synthetic));
  return v_new;
end $$;

create or replace function public.retire_compliance_rule(p_code text, p_reason text) returns public.compliance_rules
language plpgsql security definer set search_path = public, app as $$
declare v_rule compliance_rules;
begin
  perform app.require_user();
  if not app.is_national_admin() or not app.has_capability('workflow_config') then
    perform app.fail('forbidden', 'Only national administrators with workflow-configuration responsibility can retire rules.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason (at least 10 characters) is required.'); end if;
  update compliance_rules set status = 'retired', retired_at = now(), retired_reason = trim(p_reason)
  where code = p_code and status = 'active' returning * into v_rule;
  if v_rule.id is null then perform app.fail('not_found', 'No active rule with that code.'); end if;
  perform app.audit('compliance_rule_retired', 'compliance_rule', v_rule.id, null, null, null, trim(p_reason));
  return v_rule;
end $$;

-- The handbook thresholds previously held in system_settings move into the rule registry (seed.sql).
delete from public.system_settings where key = 'compliance.handbook_criteria';

-- ---------------------------------------------------------------------------
-- A. Deficiency Matrix evaluator. Result values:
--    passed | potential_issue | failed_validation | extraction_failed | not_checked | manual_review
-- Nothing here changes the case; it is advisory for the institution and the scrutinising officer.
-- ---------------------------------------------------------------------------
create or replace function public.deficiency_matrix(p_application_id uuid)
returns table (section text, check_code text, label text, input_value text, requirement text, result text,
               rule_ref text, source text, explanation text, is_synthetic boolean, document_id uuid, sort_order integer)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare
  v_app applications; v_type application_types; v_f jsonb; v_val text; v_n integer := 0;
  v_req document_requirements; v_doc record; v_run document_check_runs; v_find document_check_findings; v_rule compliance_rules;
  a numeric; b numeric; t numeric; v_missing_hash text; v_docs integer; v_has_findings boolean; v_unit text;
begin
  perform app.require_user();
  select * into v_app from applications where id = p_application_id;
  if v_app.id is null or not app.can_read_application(v_app.id) then
    perform app.fail('not_found', 'Application not found or you do not have access.');
  end if;
  select * into v_type from application_types where code = v_app.application_type_code;

  -- 1. Form fields: required values present and of the declared type
  for v_f in select * from jsonb_array_elements(v_type.form_schema) loop
    v_val := nullif(trim(coalesce(v_app.form_data ->> (v_f ->> 'key'), '')), '');
    if v_val is null and not coalesce((v_f ->> 'required')::boolean, false) then continue; end if;
    v_n := v_n + 1;
    section := 'form'; check_code := 'field:' || (v_f ->> 'key'); label := v_f ->> 'label'; input_value := coalesce(v_val, 'Not provided');
    requirement := case when coalesce((v_f ->> 'required')::boolean, false) then 'Required' else 'Optional' end
                   || case when v_f ->> 'type' in ('number', 'date') then ', ' || (v_f ->> 'type') else '' end;
    rule_ref := 'form_schema:' || v_type.code; source := 'Application form configuration (' || v_type.name || ')';
    is_synthetic := false; document_id := null; sort_order := 100 + v_n;
    if v_val is null then
      result := 'failed_validation'; explanation := 'A required field is empty.';
    elsif v_f ->> 'type' = 'number' and app.try_numeric(v_val) is null then
      result := 'failed_validation'; explanation := 'The value is not a number.';
    elsif v_f ->> 'type' = 'date' and v_val !~ '^\d{4}-\d{2}-\d{2}$' then
      result := 'failed_validation'; explanation := 'The value is not a date in YYYY-MM-DD form.';
    else
      result := 'passed'; explanation := 'Provided.';
    end if;
    return next;
  end loop;

  -- 2. Required documents for this checklist version
  v_n := 0;
  for v_req in select * from document_requirements
               where application_type_code = v_app.application_type_code and checklist_version = v_app.checklist_version
               order by is_required desc, name loop
    v_n := v_n + 1;
    select d.id, d.current_version, v.file_name into v_doc from documents d
      left join document_versions v on v.document_id = d.id and v.version = d.current_version
      where d.application_id = v_app.id and d.doc_type = v_req.doc_type;
    section := 'documents'; check_code := 'document:' || v_req.doc_type; label := v_req.name;
    requirement := case when v_req.is_required then 'Required' else 'Optional' end || ' · ' || array_to_string(v_req.allowed_mime_types, ', ');
    rule_ref := 'checklist:' || v_req.application_type_code || ':v' || v_req.checklist_version;
    source := v_req.source_reference; is_synthetic := v_req.source_reference ilike '%demo%'; sort_order := 200 + v_n;
    document_id := v_doc.id;
    if v_doc.id is null or coalesce(v_doc.current_version, 0) = 0 then
      input_value := 'Not uploaded';
      result := case when v_req.is_required then 'failed_validation' else 'not_checked' end;
      explanation := case when v_req.is_required then 'This checklist document has not been uploaded.' else 'Optional document not uploaded.' end;
    else
      input_value := 'v' || v_doc.current_version || ' · ' || coalesce(v_doc.file_name, '');
      result := 'passed'; explanation := 'A current version is on file. Content is checked separately by the pre-check.';
    end if;
    return next;
  end loop;

  -- 3. Duplicate files (same SHA-256 fingerprint) among current versions
  select count(*), string_agg(d.title, ', ' order by d.title) filter (where v.sha256 is null)
    into v_docs, v_missing_hash
  from documents d join document_versions v on v.document_id = d.id and v.version = d.current_version
  where d.application_id = v_app.id;
  if v_docs > 0 then
    v_n := 0;
    for v_doc in
      select d.id, d.title, v.sha256,
             (select string_agg(d2.title, ', ') from documents d2 join document_versions v2 on v2.document_id = d2.id and v2.version = d2.current_version
              where d2.application_id = d.application_id and d2.id <> d.id and v2.sha256 = v.sha256) as same_as
      from documents d join document_versions v on v.document_id = d.id and v.version = d.current_version
      where d.application_id = v_app.id and v.sha256 is not null order by d.title
    loop
      if v_doc.same_as is null then continue; end if;
      v_n := v_n + 1;
      section := 'duplicates'; check_code := 'duplicate:' || v_doc.id; label := 'Duplicate file: ' || v_doc.title;
      input_value := 'sha256 ' || left(v_doc.sha256, 12) || '…'; requirement := 'Each document is a distinct file';
      result := 'potential_issue'; rule_ref := 'integrity:sha256'; source := 'File fingerprint recorded at upload';
      explanation := 'Identical file to: ' || v_doc.same_as || '. The same file may have been uploaded under two document types.';
      is_synthetic := false; document_id := v_doc.id; sort_order := 300 + v_n;
      return next;
    end loop;
    if v_n = 0 then
      section := 'duplicates'; check_code := 'duplicates'; label := 'Duplicate files'; document_id := null;
      requirement := 'Each document is a distinct file'; rule_ref := 'integrity:sha256'; source := 'File fingerprint recorded at upload';
      is_synthetic := false; sort_order := 300;
      if v_missing_hash is null then
        input_value := v_docs || ' current documents'; result := 'passed'; explanation := 'No two current documents share a fingerprint.';
      else
        input_value := 'Fingerprint missing'; result := 'manual_review';
        explanation := 'No fingerprint was recorded for: ' || v_missing_hash || '. Duplicates among these cannot be ruled out.';
      end if;
      return next;
    end if;
  end if;

  -- 4. Latest pre-check of each current document version
  v_n := 0;
  for v_doc in
    select d.id, d.title, v.id as vid, v.version from documents d
    join document_versions v on v.document_id = d.id and v.version = d.current_version
    where d.application_id = v_app.id order by d.title
  loop
    select * into v_run from document_check_runs where document_version_id = v_doc.vid order by started_at desc limit 1;
    section := 'precheck'; document_id := v_doc.id; is_synthetic := false;
    source := 'Document pre-check' || case when v_run.engine is not null and v_run.engine <> 'pending' then ' (' || v_run.engine || ')' else '' end;
    if v_run.id is null or v_run.status = 'running' then
      v_n := v_n + 1;
      check_code := 'precheck:' || v_doc.id; label := v_doc.title || ' — pre-check'; input_value := 'Version ' || v_doc.version;
      requirement := 'Deterministic pre-check on the current version'; rule_ref := 'precheck';
      result := 'not_checked';
      explanation := case when v_run.id is null then 'The pre-check has not been run on this version.' else 'The pre-check is still running.' end;
      sort_order := 400 + v_n; return next; continue;
    end if;
    if v_run.status = 'failed' then
      v_n := v_n + 1;
      check_code := 'precheck:' || v_doc.id; label := v_doc.title || ' — pre-check'; input_value := 'Version ' || v_doc.version;
      requirement := 'Deterministic pre-check on the current version'; rule_ref := 'precheck';
      result := 'manual_review'; explanation := 'The pre-check could not complete: ' || coalesce(v_run.error, 'unknown error') || '. An officer must review the document.';
      sort_order := 400 + v_n; return next; continue;
    end if;
    v_has_findings := false;
    for v_find in select * from document_check_findings where run_id = v_run.id order by sort_order loop
      v_has_findings := true; v_n := v_n + 1;
      check_code := 'precheck:' || v_doc.id || ':' || v_find.check_code; label := v_doc.title || ' — ' || v_find.check_name;
      input_value := coalesce(v_find.evidence, '—'); requirement := v_find.check_name; rule_ref := 'precheck:' || v_find.check_code;
      result := case v_find.outcome::text when 'missing_information' then 'potential_issue' else v_find.outcome::text end;
      explanation := v_find.explanation || coalesce(' ' || v_find.suggestion, '');
      sort_order := 400 + v_n; return next;
    end loop;
    if not v_has_findings and v_run.extraction_status in ('failed', 'unavailable') then
      v_n := v_n + 1;
      check_code := 'precheck:' || v_doc.id || ':extraction'; label := v_doc.title || ' — text extraction'; input_value := v_run.extraction_status;
      requirement := 'Readable text'; rule_ref := 'precheck:readability';
      result := 'extraction_failed'; explanation := 'The document text could not be read; content checks were not performed. An officer must review it manually.';
      sort_order := 400 + v_n; return next;
    end if;
  end loop;

  -- 5. Configured rules that apply to this application type
  v_n := 0;
  for v_rule in select * from compliance_rules where status = 'active' and v_app.application_type_code = any (applies_to) order by code loop
    v_n := v_n + 1;
    section := 'rules'; check_code := 'rule:' || v_rule.code; label := v_rule.label; rule_ref := v_rule.code || ' v' || v_rule.version;
    source := v_rule.source_reference; is_synthetic := v_rule.is_synthetic; document_id := null; sort_order := 500 + v_n;
    t := app.try_numeric(v_rule.params ->> 'threshold'); v_unit := coalesce(' ' || (v_rule.params ->> 'unit'), '');
    if v_rule.kind in ('min', 'max') then
      a := app.try_numeric(v_app.form_data ->> (v_rule.params ->> 'field'));
      requirement := case v_rule.kind when 'min' then 'Min ' else 'Max ' end || coalesce(t::text, '?') || v_unit;
      input_value := coalesce(a::text || v_unit, 'Not declared');
      if t is null then result := 'manual_review'; explanation := 'The rule has no usable threshold; not evaluated.';
      elsif a is null then result := 'not_checked'; explanation := 'The institution has not declared this figure on the form.';
      elsif (v_rule.kind = 'min' and a >= t) or (v_rule.kind = 'max' and a <= t) then result := 'passed'; explanation := 'Declared figure meets the configured rule.';
      else result := 'potential_issue'; explanation := 'Declared figure does not meet the configured rule. The officer verifies the evidence; this does not reject the application.';
      end if;
    elsif v_rule.kind = 'ratio_max' then
      a := app.try_numeric(v_app.form_data ->> (v_rule.params ->> 'numerator'));
      b := app.try_numeric(v_app.form_data ->> (v_rule.params ->> 'denominator'));
      requirement := 'Target ' || coalesce(v_rule.params ->> 'target', '1:' || coalesce(t::text, '?'));
      if t is null then input_value := '—'; result := 'manual_review'; explanation := 'The rule has no usable threshold; not evaluated.';
      elsif a is null or b is null or b <= 0 then input_value := 'Not declared'; result := 'not_checked';
        explanation := 'One or both figures needed for this ratio are not declared.';
      else
        input_value := '1:' || rtrim(rtrim(round(a / b, 2)::text, '0'), '.');
        if a / b <= t then result := 'passed'; explanation := 'Calculated from declared figures; meets the configured target.';
        else result := 'potential_issue'; explanation := 'Calculated from declared figures; exceeds the configured target. The officer verifies the evidence; this does not reject the application.';
        end if;
      end if;
    elsif v_rule.kind = 'consistency_gt' then
      a := app.try_numeric(v_app.form_data ->> (v_rule.params ->> 'field'));
      b := app.try_numeric(v_app.form_data ->> (v_rule.params ->> 'other'));
      requirement := coalesce(v_rule.params ->> 'field', '?') || ' > ' || coalesce(v_rule.params ->> 'other', '?')
                     || coalesce(' when ' || (v_rule.params ->> 'when_flag') || ' is declared', '');
      if v_rule.params ->> 'when_flag' is not null and not coalesce((v_app.form_data ->> (v_rule.params ->> 'when_flag'))::boolean, false) then
        input_value := 'Not applicable'; result := 'not_checked'; explanation := 'The condition for this check is not declared on this application.';
      elsif a is null or b is null then input_value := 'Not declared'; result := 'not_checked'; explanation := 'One or both values are not declared.';
      else
        input_value := a::text || ' vs ' || b::text;
        if a > b then result := 'passed'; explanation := 'The declared values are consistent.';
        else result := 'failed_validation'; explanation := 'The declared values contradict each other; the institution should correct the form.';
        end if;
      end if;
    else
      requirement := '—'; input_value := '—'; result := 'manual_review';
      explanation := 'Rule kind "' || v_rule.kind || '" is not supported by this engine, so it was not evaluated.';
    end if;
    if v_rule.explanation <> '' then explanation := explanation || ' ' || v_rule.explanation; end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- B. Concurrent review tasks
-- ---------------------------------------------------------------------------
create table public.workflow_stage_reviews (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.workflow_definition_versions (id) on delete cascade,
  stage_code text not null,
  code text not null check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  required_capability text not null check (required_capability in ('scrutiny', 'evc', 'committee', 'compliance', 'decision')),
  description text not null default '',
  sort_order integer not null default 0,
  unique (version_id, stage_code, code)
);

create table public.review_tasks (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications (id) on delete cascade,
  stage_history_id uuid not null references public.application_stage_history (id) on delete cascade,
  stage_code text not null,
  review_code text not null,
  name text not null,
  required_capability text not null,
  region_code text not null references public.regions (code),
  assignee_id uuid references public.profiles (id),
  status text not null default 'pending' check (status in ('pending', 'in_review', 'completed', 'returned', 'cancelled')),
  outcome_note text,
  due_at timestamptz,
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references public.profiles (id),
  unique (stage_history_id, review_code)
);
create index on public.review_tasks (application_id, status);
create index on public.review_tasks (assignee_id) where status in ('pending', 'in_review', 'returned');

create table public.review_task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.review_tasks (id) on delete cascade,
  action text not null,
  from_status text,
  to_status text,
  actor_id uuid references public.profiles (id),
  reason text,
  created_at timestamptz not null default now()
);
create trigger review_task_history_append_only before update or delete on public.review_task_history
  for each row execute function app.block_mutation();

alter table public.workflow_stage_reviews enable row level security;
alter table public.review_tasks enable row level security;
alter table public.review_task_history enable row level security;
create policy read_stage_reviews on public.workflow_stage_reviews for select to authenticated using (app.is_active_user());
create policy read_review_tasks on public.review_tasks for select to authenticated
  using (app.is_staff() and (assignee_id = auth.uid() or app.can_read_application(application_id)));
create policy read_review_task_history on public.review_task_history for select to authenticated
  using (exists (select 1 from review_tasks t where t.id = task_id and app.is_staff() and (t.assignee_id = auth.uid() or app.can_read_application(t.application_id))));
revoke all on public.workflow_stage_reviews, public.review_tasks, public.review_task_history from anon, authenticated;
grant select on public.workflow_stage_reviews, public.review_tasks, public.review_task_history to authenticated, service_role;

-- When a case enters a stage: cancel unfinished reviews from the previous stage entry and create the configured ones.
create or replace function app.on_stage_entered() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare v_app applications; v_r workflow_stage_reviews; v_officer uuid; v_task review_tasks; v_old record;
begin
  select * into v_app from applications where id = new.application_id;
  for v_old in select id, status, stage_code from review_tasks
               where application_id = new.application_id and stage_history_id <> new.id and status in ('pending', 'in_review', 'returned')
               for update loop
    update review_tasks set status = 'cancelled', completed_at = now(), row_version = row_version + 1 where id = v_old.id;
    insert into review_task_history (task_id, action, from_status, to_status, actor_id, reason)
    values (v_old.id, 'cancelled', v_old.status, 'cancelled', auth.uid(), 'Case left the ' || v_old.stage_code || ' stage');
  end loop;
  for v_r in select * from workflow_stage_reviews where version_id = v_app.workflow_version_id and stage_code = new.stage_code
             order by sort_order, code loop
    v_officer := app.pick_officer(v_app.region_code, v_r.required_capability, null);
    insert into review_tasks (application_id, stage_history_id, stage_code, review_code, name, required_capability, region_code,
                              assignee_id, due_at)
    values (v_app.id, new.id, new.stage_code, v_r.code, v_r.name, v_r.required_capability, v_app.region_code, v_officer, new.due_at)
    returning * into v_task;
    insert into review_task_history (task_id, action, to_status, actor_id, reason)
    values (v_task.id, 'created', 'pending', auth.uid(),
            'Created from route configuration' || case when v_officer is null then '; no eligible officer found, awaiting assignment' else '' end);
    perform app.audit('review_task_created', 'review_task', v_task.id, v_app.id, v_app.institution_id, v_app.region_code, null, null,
      jsonb_build_object('review', v_r.code, 'stage', new.stage_code, 'assignee_id', v_officer));
    if v_officer is not null then
      perform app.notify(v_officer, 'assignment', 'Review task: ' || v_app.reference, v_r.name || ' is assigned to you.',
        '/app/applications/' || v_app.id, 'review_task', v_task.id, 'reviewtask:' || v_task.id);
    end if;
  end loop;
  return new;
end $$;
create trigger stage_entered_reviews after insert on public.application_stage_history
  for each row execute function app.on_stage_entered();

-- Locks the case first and then the task (the same order perform_transition uses) so that concurrent reviewers
-- and a concurrent transition serialise instead of interleaving.
create or replace function app.lock_review_task(p_task_id uuid) returns public.review_tasks
language plpgsql security definer set search_path = public, app as $$
declare v_app_id uuid; v_task review_tasks;
begin
  select application_id into v_app_id from review_tasks where id = p_task_id;
  if v_app_id is null then perform app.fail('not_found', 'Review task not found.'); end if;
  perform 1 from applications where id = v_app_id for update;
  select * into v_task from review_tasks where id = p_task_id for update;
  if not exists (select 1 from application_stage_history h where h.id = v_task.stage_history_id and h.exited_at is null) then
    perform app.fail('invalid_state', 'The case has moved on from the stage this review belongs to.');
  end if;
  return v_task;
end $$;

create or replace function app.review_event(p_task public.review_tasks, p_app public.applications, p_action text, p_from text, p_to text, p_reason text, p_summary text)
returns void
language plpgsql security definer set search_path = public, app as $$
begin
  insert into review_task_history (task_id, action, from_status, to_status, actor_id, reason)
  values (p_task.id, p_action, p_from, p_to, auth.uid(), p_reason);
  insert into application_events (application_id, event_type, summary, actor_id, reason, visibility, metadata)
  values (p_app.id, 'review_task_' || p_action, p_summary, auth.uid(), p_reason, 'internal',
          jsonb_build_object('review_task_id', p_task.id, 'review', p_task.review_code, 'from', p_from, 'to', p_to));
  perform app.audit('review_task_' || p_action, 'review_task', p_task.id, p_app.id, p_app.institution_id, p_app.region_code, p_reason,
    jsonb_build_object('status', p_from), jsonb_build_object('status', p_to, 'assignee_id', p_task.assignee_id));
end $$;

create or replace function public.start_review_task(p_task_id uuid, p_expected_version integer) returns public.review_tasks
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_task review_tasks; v_app applications; v_from text;
begin
  v_task := app.lock_review_task(p_task_id);
  select * into v_app from applications where id = v_task.application_id;
  if not app.has_role('officer') or not app.has_capability_in(v_task.required_capability, v_task.region_code) then
    perform app.fail('forbidden', 'This review needs an officer holding the "' || v_task.required_capability || '" responsibility for region ' || v_task.region_code || '.');
  end if;
  if v_task.assignee_id is not null and v_task.assignee_id <> v_uid then
    perform app.fail('forbidden', 'This review is assigned to another officer. An officer with the assignment responsibility can reassign it.');
  end if;
  if v_task.row_version <> p_expected_version then perform app.fail('stale', 'This review task changed since you opened it. Refresh first.'); end if;
  if v_task.status not in ('pending', 'returned') then
    perform app.fail('invalid_state', 'This review cannot be started in status ' || replace(v_task.status, '_', ' ') || '.');
  end if;
  if v_app.status in ('draft', 'completed', 'closed', 'withdrawn') then perform app.fail('invalid_state', 'The case is not under processing.'); end if;
  v_from := v_task.status;
  update review_tasks set status = 'in_review', assignee_id = v_uid, started_at = now(), row_version = row_version + 1
  where id = v_task.id returning * into v_task;
  perform app.review_event(v_task, v_app, 'started', v_from, 'in_review', null, 'Review started: ' || v_task.name);
  return v_task;
end $$;

create or replace function public.complete_review_task(p_task_id uuid, p_expected_version integer, p_outcome text, p_note text)
returns public.review_tasks
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_task review_tasks; v_app applications; v_left integer;
begin
  v_task := app.lock_review_task(p_task_id);
  select * into v_app from applications where id = v_task.application_id;
  if not app.has_role('officer') or not app.has_capability_in(v_task.required_capability, v_task.region_code) then
    perform app.fail('forbidden', 'This review needs an officer holding the "' || v_task.required_capability || '" responsibility for region ' || v_task.region_code || '.');
  end if;
  if v_task.assignee_id is distinct from v_uid then perform app.fail('forbidden', 'Only the officer conducting this review can record its outcome.'); end if;
  if v_task.row_version <> p_expected_version then perform app.fail('stale', 'This review task changed since you opened it. Refresh first.'); end if;
  if v_task.status <> 'in_review' then
    perform app.fail('invalid_state', 'Only a review in progress can be completed (current status: ' || replace(v_task.status, '_', ' ') || ').');
  end if;
  if p_outcome not in ('completed', 'returned') then perform app.fail('validation', 'Choose completed or returned.'); end if;
  if length(trim(coalesce(p_note, ''))) < 10 then perform app.fail('reason_required', 'Record the basis of this outcome (at least 10 characters).'); end if;

  update review_tasks set status = p_outcome, outcome_note = trim(p_note),
    completed_at = case when p_outcome = 'completed' then now() end,
    completed_by = case when p_outcome = 'completed' then v_uid end,
    row_version = row_version + 1
  where id = v_task.id returning * into v_task;
  perform app.review_event(v_task, v_app, p_outcome, 'in_review', p_outcome, trim(p_note),
    case when p_outcome = 'completed' then 'Review completed: ' else 'Review returned with issues: ' end || v_task.name);

  select count(*) into v_left from review_tasks where stage_history_id = v_task.stage_history_id and status not in ('completed', 'cancelled');
  if v_left = 0 then
    insert into application_events (application_id, event_type, summary, actor_id, visibility, metadata)
    values (v_app.id, 'reviews_completed', 'All configured reviews completed for ' || v_task.stage_code, v_uid, 'internal',
            jsonb_build_object('stage', v_task.stage_code));
    if v_app.assigned_officer_id is not null and v_app.assigned_officer_id <> v_uid then
      perform app.notify(v_app.assigned_officer_id, 'assignment', 'Reviews complete: ' || v_app.reference,
        'All configured reviews for this stage are complete; the case can be routed.', '/app/applications/' || v_app.id,
        'application', v_app.id, 'reviewsdone:' || v_task.stage_history_id);
    end if;
    perform app.try_auto_advance(v_app.id);
  end if;
  return v_task;
end $$;

create or replace function public.reassign_review_task(p_task_id uuid, p_officer_id uuid, p_reason text, p_expected_version integer)
returns public.review_tasks
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_task review_tasks; v_app applications; v_prev uuid;
begin
  v_task := app.lock_review_task(p_task_id);
  select * into v_app from applications where id = v_task.application_id;
  if not app.has_capability_in('assignment', v_task.region_code) then
    perform app.fail('forbidden', 'You do not hold the assignment responsibility for region ' || v_task.region_code || '.');
  end if;
  if v_task.row_version <> p_expected_version then perform app.fail('stale', 'This review task changed since you opened it. Refresh first.'); end if;
  if v_task.status in ('completed', 'cancelled') then perform app.fail('invalid_state', 'A finished review cannot be reassigned.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  if not exists (select 1 from user_role_assignments r join profiles p on p.id = r.user_id and p.is_active
                 where r.user_id = p_officer_id and r.is_active and r.role = 'officer' and v_task.required_capability = any (r.capabilities)
                   and (r.region_code is null or r.region_code = v_task.region_code)) then
    perform app.fail('validation', 'The selected officer does not hold the "' || v_task.required_capability || '" responsibility for this region.');
  end if;
  v_prev := v_task.assignee_id;
  update review_tasks set assignee_id = p_officer_id, status = case when status = 'in_review' then 'pending' else status end,
    row_version = row_version + 1
  where id = v_task.id returning * into v_task;
  perform app.review_event(v_task, v_app, 'reassigned', null, v_task.status, trim(p_reason), 'Review reassigned: ' || v_task.name);
  perform app.notify(p_officer_id, 'assignment', 'Review task: ' || v_app.reference, v_task.name || ' has been assigned to you.',
    '/app/applications/' || v_app.id, 'review_task', v_task.id, 'reviewreassign:' || v_task.id || ':' || v_task.row_version);
  return v_task;
end $$;

-- prerequisite_unmet gains "review_tasks_complete"; everything else is unchanged.
create or replace function app.prerequisite_unmet(p_app public.applications, p_prereqs text[]) returns text
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_code text;
  v_key text;
  v_missing text;
begin
  foreach v_code in array coalesce(p_prereqs, '{}') loop
    if v_code = 'no_open_deficiencies' then
      if exists (select 1 from deficiencies where application_id = p_app.id and status not in ('resolved', 'withdrawn')) then
        return 'All deficiencies must be resolved before this action.';
      end if;
    elsif v_code = 'has_open_deficiency' then
      if not exists (select 1 from deficiencies where application_id = p_app.id and status in ('open', 'still_deficient', 'needs_clarification')) then
        return 'Record at least one open deficiency first.';
      end if;
    elsif v_code = 'evc_completed' then
      if not exists (select 1 from evc_records where application_id = p_app.id and stage_code = p_app.current_stage and status = 'completed') then
        return 'The EVC for this stage has not been completed and recorded.';
      end if;
    elsif v_code = 'evc_satisfactory' then
      if not exists (select 1 from evc_records where application_id = p_app.id and stage_code = p_app.current_stage
                     and status = 'completed' and outcome = 'satisfactory') then
        return 'The recorded EVC outcome is not satisfactory; an officer must review it.';
      end if;
    elsif v_code = 'required_documents' then
      select string_agg(r.name, ', ' order by r.name) into v_missing
      from document_requirements r
      where r.application_type_code = p_app.application_type_code and r.checklist_version = p_app.checklist_version
        and r.is_required
        and not exists (select 1 from documents d where d.application_id = p_app.id and d.doc_type = r.doc_type and d.current_version > 0);
      if v_missing is not null then return 'Required documents missing: ' || v_missing || '.'; end if;
    elsif v_code = 'review_tasks_complete' then
      select string_agg(t.name || ' (' || replace(t.status, '_', ' ') || ')', ', ' order by t.name) into v_missing
      from review_tasks t join application_stage_history h on h.id = t.stage_history_id
      where t.application_id = p_app.id and h.exited_at is null and h.stage_code = p_app.current_stage
        and t.status not in ('completed', 'cancelled');
      if v_missing is not null then return 'Configured reviews not yet completed: ' || v_missing || '.'; end if;
    elsif v_code like 'form_flag:%' then
      v_key := substr(v_code, 11);
      if coalesce((p_app.form_data ->> v_key)::boolean, false) is not true then
        return 'Route condition not met: ' || v_key || ' is not declared for this application.';
      end if;
    elsif v_code like 'not_form_flag:%' then
      v_key := substr(v_code, 15);
      if coalesce((p_app.form_data ->> v_key)::boolean, false) then
        return 'Route condition not met: ' || v_key || ' is declared, so the alternate route applies.';
      end if;
    elsif v_code = 'actor_is_assigned' then
      if p_app.assigned_officer_id is distinct from auth.uid() then
        return 'Only the officer assigned to this stage can take this action.';
      end if;
    else
      return 'Configuration error: unknown prerequisite "' || v_code || '". Action blocked.';
    end if;
  end loop;
  return null;
end $$;

-- publish_workflow_version: unchanged except that stages may carry "reviews" and the new prerequisite is known.
create or replace function public.publish_workflow_version(
  p_definition_id uuid, p_stages jsonb, p_transitions jsonb, p_source_reference text, p_change_summary text
) returns public.workflow_definition_versions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_old workflow_definition_versions; v_new workflow_definition_versions;
  v_codes text[]; v_s jsonb; v_t jsonb; v_p text; v_r jsonb;
  v_known_prereqs text[] := array['no_open_deficiencies', 'has_open_deficiency', 'evc_completed', 'evc_satisfactory',
                                  'required_documents', 'actor_is_assigned', 'review_tasks_complete'];
begin
  if not app.is_national_admin() or not app.has_capability('workflow_config') then
    perform app.fail('forbidden', 'Only national administrators with workflow-configuration responsibility can publish routes.');
  end if;
  if length(trim(coalesce(p_source_reference, ''))) < 5 then perform app.fail('validation', 'A source reference for the rule is required.'); end if;
  if length(trim(coalesce(p_change_summary, ''))) < 10 then perform app.fail('validation', 'Describe the change (at least 10 characters).'); end if;
  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) < 2 then perform app.fail('validation', 'A route needs at least two stages.'); end if;

  select array_agg(s ->> 'code') into v_codes from jsonb_array_elements(p_stages) s;
  if (select count(distinct c) from unnest(v_codes) c) <> array_length(v_codes, 1) then
    perform app.fail('validation', 'Stage codes must be unique.');
  end if;
  if (select count(*) from jsonb_array_elements(p_stages) s where s ->> 'kind' = 'intake') <> 1 then
    perform app.fail('validation', 'A route must have exactly one intake stage.');
  end if;
  if (select (s ->> 'kind') from jsonb_array_elements(p_stages) s order by (s ->> 'sequence')::int limit 1) <> 'intake' then
    perform app.fail('validation', 'The intake stage must come first.');
  end if;
  if not exists (select 1 from jsonb_array_elements(p_stages) s where s ->> 'kind' = 'terminal') then
    perform app.fail('validation', 'A route must end in a terminal stage.');
  end if;
  for v_s in select * from jsonb_array_elements(p_stages) loop
    if jsonb_typeof(v_s -> 'reviews') = 'array' and jsonb_array_length(v_s -> 'reviews') > 0 then
      if v_s ->> 'kind' not in ('scrutiny', 'committee') then
        perform app.fail('validation', 'Concurrent reviews can be configured only on scrutiny or committee stages (stage ' || (v_s ->> 'code') || ').');
      end if;
      if (select count(distinct r ->> 'code') from jsonb_array_elements(v_s -> 'reviews') r) <> jsonb_array_length(v_s -> 'reviews') then
        perform app.fail('validation', 'Review codes must be unique within stage ' || (v_s ->> 'code') || '.');
      end if;
      for v_r in select * from jsonb_array_elements(v_s -> 'reviews') loop
        if coalesce(v_r ->> 'code', '') !~ '^[a-z][a-z0-9_]*$' or length(trim(coalesce(v_r ->> 'name', ''))) < 3
           or coalesce(v_r ->> 'required_capability', '') not in ('scrutiny', 'evc', 'committee', 'compliance', 'decision') then
          perform app.fail('validation', 'Each review needs a code, a name and a valid responsibility (stage ' || (v_s ->> 'code') || ').');
        end if;
      end loop;
    end if;
  end loop;
  for v_t in select * from jsonb_array_elements(p_transitions) loop
    if not (v_t ->> 'from_stage' = any (v_codes)) or not (v_t ->> 'to_stage' = any (v_codes)) then
      perform app.fail('validation', 'Transition ' || coalesce(v_t ->> 'code', '?') || ' refers to an unknown stage.');
    end if;
    for v_p in select jsonb_array_elements_text(coalesce(v_t -> 'prerequisites', '[]'::jsonb)) loop
      if not (v_p = any (v_known_prereqs) or v_p ~ '^(not_)?form_flag:[a-z_]+$') then
        perform app.fail('validation', 'Unknown prerequisite "' || v_p || '".');
      end if;
    end loop;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_stages) s
             where s ->> 'kind' <> 'terminal'
               and not exists (select 1 from jsonb_array_elements(p_transitions) t where t ->> 'from_stage' = s ->> 'code')) then
    perform app.fail('validation', 'Every non-terminal stage needs at least one outgoing transition.');
  end if;

  select * into v_old from workflow_definition_versions where definition_id = p_definition_id and status = 'active' for update;
  update workflow_definition_versions set status = 'retired', effective_to = now() where id = v_old.id;
  insert into workflow_definition_versions (definition_id, version, status, source_reference, change_summary, authorised_by)
  values (p_definition_id, coalesce((select max(version) from workflow_definition_versions where definition_id = p_definition_id), 0) + 1,
          'active', trim(p_source_reference), trim(p_change_summary), v_uid)
  returning * into v_new;

  for v_s in select * from jsonb_array_elements(p_stages) loop
    insert into workflow_stages (version_id, code, name, kind, sequence, sla_days, responsible_capability, description)
    values (v_new.id, v_s ->> 'code', v_s ->> 'name', (v_s ->> 'kind')::app.stage_kind, (v_s ->> 'sequence')::int,
            nullif(v_s ->> 'sla_days', '')::int, nullif(v_s ->> 'responsible_capability', ''), coalesce(v_s ->> 'description', ''));
    for v_r in select * from jsonb_array_elements(coalesce(v_s -> 'reviews', '[]'::jsonb)) loop
      insert into workflow_stage_reviews (version_id, stage_code, code, name, required_capability, description, sort_order)
      values (v_new.id, v_s ->> 'code', v_r ->> 'code', trim(v_r ->> 'name'), v_r ->> 'required_capability',
              coalesce(v_r ->> 'description', ''), coalesce((v_r ->> 'sort_order')::int, 0));
    end loop;
  end loop;
  for v_t in select * from jsonb_array_elements(p_transitions) loop
    insert into workflow_transitions (version_id, code, name, from_stage, to_stage, allowed_role, required_capability,
      requires_reason, is_automatic, prerequisites, records_decision, sort_order)
    values (v_new.id, v_t ->> 'code', v_t ->> 'name', v_t ->> 'from_stage', v_t ->> 'to_stage',
            nullif(v_t ->> 'allowed_role', '')::app.app_role, nullif(v_t ->> 'required_capability', ''),
            coalesce((v_t ->> 'requires_reason')::boolean, false), coalesce((v_t ->> 'is_automatic')::boolean, false),
            coalesce(array(select jsonb_array_elements_text(v_t -> 'prerequisites')), '{}'),
            coalesce((v_t ->> 'records_decision')::boolean, false), coalesce((v_t ->> 'sort_order')::int, 0));
  end loop;

  perform app.audit('workflow_version_published', 'workflow_definition', p_definition_id, null, null, null, trim(p_change_summary),
    jsonb_build_object('version', v_old.version), jsonb_build_object('version', v_new.version, 'source', v_new.source_reference));
  return v_new;
end $$;

-- ---------------------------------------------------------------------------
-- C. EVC availability, declared conflicts of interest and assignment checks
-- ---------------------------------------------------------------------------
create table public.evc_availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null check (kind in ('available', 'unavailable')),
  note text,
  recorded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  check (ends_at > starts_at)
);
create index on public.evc_availability (user_id) where withdrawn_at is null;

create table public.evc_conflict_declarations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  institution_id uuid not null references public.institutions (id),
  nature text not null,
  declared_by uuid references public.profiles (id),
  declared_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles (id),
  withdrawn_reason text
);
create unique index one_active_conflict_declaration on public.evc_conflict_declarations (user_id, institution_id) where withdrawn_at is null;

alter table public.evc_availability enable row level security;
alter table public.evc_conflict_declarations enable row level security;
create policy read_evc_availability on public.evc_availability for select to authenticated using (app.is_staff());
create policy read_evc_conflicts on public.evc_conflict_declarations for select to authenticated using (app.is_staff());
revoke all on public.evc_availability, public.evc_conflict_declarations from anon, authenticated;
grant select on public.evc_availability, public.evc_conflict_declarations to authenticated, service_role;

create or replace function app.is_evc_officer_in(p_user uuid, p_region text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from user_role_assignments r join profiles p on p.id = r.user_id and p.is_active
                 where r.user_id = p_user and r.is_active and r.role = 'officer' and 'evc' = any (r.capabilities)
                   and (r.region_code is null or r.region_code = p_region))
$$;

create or replace function public.record_evc_availability(p_user_id uuid, p_start timestamptz, p_end timestamptz, p_kind text, p_note text)
returns public.evc_availability
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row evc_availability;
begin
  if not ((p_user_id = v_uid and app.has_capability('evc')) or (app.has_capability('assignment') and app.is_staff())) then
    perform app.fail('forbidden', 'You can record availability for yourself (EVC responsibility) or, with the assignment responsibility, for others.');
  end if;
  if not exists (select 1 from user_role_assignments where user_id = p_user_id and is_active and role = 'officer' and 'evc' = any (capabilities)) then
    perform app.fail('validation', 'Availability is recorded only for officers with the EVC responsibility.');
  end if;
  if p_kind not in ('available', 'unavailable') then perform app.fail('validation', 'Choose available or unavailable.'); end if;
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '62 days' then
    perform app.fail('validation', 'Give a start and an end; a single window can cover at most 62 days.');
  end if;
  if p_end <= now() then perform app.fail('validation', 'The window must end in the future.'); end if;
  insert into evc_availability (user_id, starts_at, ends_at, kind, note, recorded_by)
  values (p_user_id, p_start, p_end, p_kind, nullif(trim(coalesce(p_note, '')), ''), v_uid) returning * into v_row;
  perform app.audit('evc_availability_recorded', 'evc_availability', v_row.id, null, null, null, v_row.note, null,
    jsonb_build_object('user_id', p_user_id, 'kind', p_kind, 'start', p_start, 'end', p_end));
  return v_row;
end $$;

create or replace function public.withdraw_evc_availability(p_id uuid, p_reason text) returns public.evc_availability
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row evc_availability;
begin
  select * into v_row from evc_availability where id = p_id for update;
  if v_row.id is null then perform app.fail('not_found', 'Availability entry not found.'); end if;
  if not (v_row.user_id = v_uid or (app.has_capability('assignment') and app.is_staff())) then
    perform app.fail('forbidden', 'You cannot withdraw this availability entry.');
  end if;
  if v_row.withdrawn_at is not null then perform app.fail('invalid_state', 'Already withdrawn.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then perform app.fail('reason_required', 'Give a short reason.'); end if;
  update evc_availability set withdrawn_at = now(), withdrawn_reason = trim(p_reason) where id = p_id returning * into v_row;
  perform app.audit('evc_availability_withdrawn', 'evc_availability', v_row.id, null, null, null, trim(p_reason));
  return v_row;
end $$;

create or replace function public.declare_evc_conflict(p_user_id uuid, p_institution_id uuid, p_nature text)
returns public.evc_conflict_declarations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row evc_conflict_declarations; v_inst institutions;
begin
  if not (p_user_id = v_uid and app.is_staff()) and not (app.has_capability('assignment') and app.is_staff()) then
    perform app.fail('forbidden', 'Declare conflicts for yourself, or hold the assignment responsibility to record one for another officer.');
  end if;
  select * into v_inst from institutions where id = p_institution_id;
  if v_inst.id is null then perform app.fail('not_found', 'Institution not found.'); end if;
  if length(trim(coalesce(p_nature, ''))) < 10 then perform app.fail('validation', 'Describe the nature of the conflict (at least 10 characters).'); end if;
  if exists (select 1 from evc_conflict_declarations where user_id = p_user_id and institution_id = p_institution_id and withdrawn_at is null) then
    perform app.fail('invalid_state', 'A conflict with this institution is already on record for this officer.');
  end if;
  insert into evc_conflict_declarations (user_id, institution_id, nature, declared_by)
  values (p_user_id, p_institution_id, trim(p_nature), v_uid) returning * into v_row;
  perform app.audit('evc_conflict_declared', 'evc_conflict_declaration', v_row.id, null, p_institution_id, v_inst.region_code, trim(p_nature),
    null, jsonb_build_object('user_id', p_user_id));
  return v_row;
end $$;

create or replace function public.withdraw_evc_conflict(p_id uuid, p_reason text) returns public.evc_conflict_declarations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row evc_conflict_declarations;
begin
  select * into v_row from evc_conflict_declarations where id = p_id for update;
  if v_row.id is null then perform app.fail('not_found', 'Declaration not found.'); end if;
  -- an officer cannot clear their own declared conflict; another authorised person has to
  if not app.has_capability('assignment') or v_row.user_id = v_uid then
    perform app.fail('forbidden', 'Only another officer or administrator with the assignment responsibility can withdraw a declared conflict.');
  end if;
  if v_row.withdrawn_at is not null then perform app.fail('invalid_state', 'Already withdrawn.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  update evc_conflict_declarations set withdrawn_at = now(), withdrawn_by = v_uid, withdrawn_reason = trim(p_reason)
  where id = p_id returning * into v_row;
  perform app.audit('evc_conflict_withdrawn', 'evc_conflict_declaration', v_row.id, null, v_row.institution_id, null, trim(p_reason));
  return v_row;
end $$;

-- One person's checks for a proposed EVC slot. Each reason: {code, status: ok|info|manual_review|blocked, overridable, detail}
create or replace function app.evc_person_checks(p_app public.applications, p_evc_id uuid, p_start timestamptz, p_end timestamptz,
                                                 p_user uuid, p_policy jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_reasons jsonb := '[]'::jsonb; v_status text := 'eligible'; v_txt text; v_n integer; v_max numeric; v_has_windows boolean;
  v_name text;
begin
  select full_name into v_name from profiles where id = p_user;
  if app.is_evc_officer_in(p_user, p_app.region_code) then
    v_reasons := v_reasons || jsonb_build_object('code', 'authorised', 'status', 'ok', 'overridable', false,
      'detail', 'Active officer with the EVC responsibility for region ' || p_app.region_code || '.');
  else
    v_reasons := v_reasons || jsonb_build_object('code', 'authorised', 'status', 'blocked', 'overridable', false,
      'detail', 'Not an active officer with the EVC responsibility for region ' || p_app.region_code || '.');
  end if;

  select string_agg(nature, '; ') into v_txt from evc_conflict_declarations
  where user_id = p_user and institution_id = p_app.institution_id and withdrawn_at is null;
  if v_txt is not null then
    v_reasons := v_reasons || jsonb_build_object('code', 'conflict_of_interest',
      'status', case when coalesce((p_policy ->> 'block_declared_conflicts')::boolean, false) then 'blocked' else 'manual_review' end,
      'overridable', false, 'detail', 'Declared conflict with this institution: ' || v_txt);
  else
    v_reasons := v_reasons || jsonb_build_object('code', 'conflict_of_interest', 'status', 'ok', 'overridable', false,
      'detail', 'No conflict of interest declared for this institution.');
  end if;

  select string_agg(a.reference || ' (' || to_char(e.scheduled_start at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST)', ', ')
    into v_txt
  from evc_records e join applications a on a.id = e.application_id
  where e.id <> p_evc_id and e.status in ('proposed', 'scheduled')
    and tstzrange(e.scheduled_start, e.scheduled_end) && tstzrange(p_start, p_end)
    and (e.coordinator_id = p_user or exists (select 1 from evc_participants x where x.evc_id = e.id and x.user_id = p_user));
  if v_txt is not null then
    v_reasons := v_reasons || jsonb_build_object('code', 'schedule_overlap', 'status', 'blocked', 'overridable', true,
      'detail', 'Already on an overlapping EVC: ' || v_txt || '.');
  end if;

  select string_agg(to_char(starts_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || '–' ||
                    to_char(ends_at at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || coalesce(' (' || note || ')', ''), '; ')
    into v_txt
  from evc_availability where user_id = p_user and kind = 'unavailable' and withdrawn_at is null
    and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end);
  if v_txt is not null then
    v_reasons := v_reasons || jsonb_build_object('code', 'unavailable', 'status', 'blocked', 'overridable', true,
      'detail', 'Recorded as unavailable: ' || v_txt || ' IST.');
  end if;

  select exists (select 1 from evc_availability where user_id = p_user and kind = 'available' and withdrawn_at is null and ends_at > now())
    into v_has_windows;
  if v_has_windows then
    if exists (select 1 from evc_availability where user_id = p_user and kind = 'available' and withdrawn_at is null
               and starts_at <= p_start and ends_at >= p_end) then
      v_reasons := v_reasons || jsonb_build_object('code', 'availability', 'status', 'ok', 'overridable', false,
        'detail', 'The slot falls inside a recorded availability window.');
    else
      v_reasons := v_reasons || jsonb_build_object('code', 'availability', 'status', 'manual_review', 'overridable', false,
        'detail', 'The slot is outside the availability windows this officer recorded. Confirm with them.');
    end if;
  elsif coalesce((p_policy ->> 'require_availability_window')::boolean, false) then
    v_reasons := v_reasons || jsonb_build_object('code', 'availability', 'status', 'manual_review', 'overridable', false,
      'detail', 'No availability recorded and the policy asks for it. Confirm availability directly.');
  else
    v_reasons := v_reasons || jsonb_build_object('code', 'availability', 'status', 'info', 'overridable', false,
      'detail', 'No availability windows recorded; availability cannot be checked automatically.');
  end if;

  v_max := app.try_numeric(p_policy ->> 'max_open_evcs_per_member');
  if v_max is not null then
    select count(*) into v_n from evc_records e
    where e.id <> p_evc_id and e.status in ('proposed', 'scheduled') and e.scheduled_end > now()
      and (e.coordinator_id = p_user or exists (select 1 from evc_participants x where x.evc_id = e.id and x.user_id = p_user));
    v_reasons := v_reasons || jsonb_build_object('code', 'workload',
      'status', case when v_n >= v_max then 'manual_review' else 'ok' end, 'overridable', false,
      'detail', v_n || ' upcoming EVC' || case when v_n = 1 then '' else 's' end || ' already assigned; policy limit ' || v_max || '.');
  end if;

  if exists (select 1 from jsonb_array_elements(v_reasons) r where r ->> 'status' = 'blocked') then v_status := 'blocked';
  elsif exists (select 1 from jsonb_array_elements(v_reasons) r where r ->> 'status' = 'manual_review') then v_status := 'manual_review';
  end if;
  return jsonb_build_object('user_id', p_user, 'name', coalesce(v_name, 'Officer'), 'status', v_status,
    'overridable', v_status = 'blocked' and not exists (select 1 from jsonb_array_elements(v_reasons) r
                                                        where r ->> 'status' = 'blocked' and not (r ->> 'overridable')::boolean),
    'reasons', v_reasons);
end $$;

create or replace function app.evc_check(p_evc public.evc_records, p_app public.applications, p_start timestamptz, p_end timestamptz,
                                         p_people uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  v_policy jsonb := (select value from system_settings where key = 'evc.assignment_policy');
  v_people jsonb := '[]'::jsonb; v_ready jsonb := '[]'::jsonb; v_p uuid; v_open integer; v_kind app.stage_kind;
begin
  select kind into v_kind from workflow_stages where version_id = p_app.workflow_version_id and code = p_evc.stage_code;
  v_ready := v_ready || jsonb_build_object('code', 'stage',
    'status', case when p_evc.status in ('awaiting_scheduling', 'proposed', 'scheduled') and p_app.current_stage = p_evc.stage_code then 'ok' else 'blocked' end,
    'detail', 'Case is at stage ' || p_app.current_stage || '; EVC cycle ' || p_evc.cycle || ' is ' || replace(p_evc.status::text, '_', ' ') || '.');
  select count(*) into v_open from deficiencies where application_id = p_app.id and status not in ('resolved', 'withdrawn');
  v_ready := v_ready || jsonb_build_object('code', 'deficiencies', 'status', case when v_open = 0 then 'ok' else 'manual_review' end,
    'detail', case when v_open = 0 then 'No open deficiencies.'
                   else v_open || ' open deficienc' || case when v_open = 1 then 'y' else 'ies' end || '; routing after the visit needs them resolved.' end);
  v_ready := v_ready || jsonb_build_object('code', 'documents',
    'status', case when app.prerequisite_unmet(p_app, array['required_documents']) is null then 'ok' else 'blocked' end,
    'detail', coalesce(app.prerequisite_unmet(p_app, array['required_documents']), 'All required documents are on file.'));
  if p_start is not null and p_end is not null then
    v_ready := v_ready || jsonb_build_object('code', 'slot',
      'status', case when p_start > now() and p_end > p_start and p_end - p_start <= interval '10 hours' then 'ok' else 'blocked' end,
      'detail', case when p_start > now() and p_end > p_start and p_end - p_start <= interval '10 hours' then 'Future slot within 10 hours.'
                     else 'Choose a future start and an end within 10 hours of the start.' end);
  end if;
  v_ready := v_ready || jsonb_build_object('code', 'policy', 'status', case when v_policy is null then 'info' else 'ok' end,
    'detail', case when v_policy is null then 'No EVC assignment policy is configured; only role, overlap, availability and declared-conflict checks apply.'
                   else 'Policy: ' || coalesce(v_policy ->> 'source_reference', 'configured by an administrator') end);
  v_ready := v_ready || jsonb_build_object('code', 'external_sources', 'status', 'info',
    'detail', 'No external calendar, expert registry or affiliation register is connected; undeclared relationships cannot be detected.');

  if p_start is not null and p_end is not null then
    foreach v_p in array coalesce(p_people, '{}') loop
      v_people := v_people || app.evc_person_checks(p_app, p_evc.id, p_start, p_end, v_p, coalesce(v_policy, '{}'::jsonb));
    end loop;
  end if;
  return jsonb_build_object(
    'readiness', v_ready, 'people', v_people, 'policy', v_policy,
    'blocked', exists (select 1 from jsonb_array_elements(v_people) x where x ->> 'status' = 'blocked')
               or exists (select 1 from jsonb_array_elements(v_ready) x where x ->> 'status' = 'blocked'),
    'needs_override', exists (select 1 from jsonb_array_elements(v_people) x where x ->> 'status' = 'blocked')
                      and not exists (select 1 from jsonb_array_elements(v_people) x where x ->> 'status' = 'blocked' and not (x ->> 'overridable')::boolean)
                      and not exists (select 1 from jsonb_array_elements(v_ready) x where x ->> 'status' = 'blocked'));
end $$;

create or replace function public.evc_assignment_check(p_evc_id uuid, p_start timestamptz, p_end timestamptz, p_participant_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_people uuid[];
begin
  select * into v_evc from evc_records where id = p_evc_id;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  if not app.is_staff() or not app.can_read_application(v_app.id) then perform app.fail('forbidden', 'EVC assignment checks are for authorised staff.'); end if;
  v_people := array(select distinct x from unnest(coalesce(p_participant_ids, '{}') ||
                    case when app.has_role('officer') then array[v_uid] else '{}'::uuid[] end) x);
  return app.evc_check(v_evc, v_app, p_start, p_end, v_people);
end $$;

-- schedule_evc gains assignment checks and an explicit, recorded override.
drop function public.schedule_evc(uuid, timestamptz, timestamptz, uuid[], boolean, text, integer, text);
create or replace function public.schedule_evc(
  p_evc_id uuid, p_start timestamptz, p_end timestamptz, p_participant_ids uuid[], p_confirm boolean,
  p_notes text, p_expected_version integer, p_reason text default null, p_override_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_people uuid[]; v_new app.evc_status;
  v_is_reschedule boolean; v_p uuid; v_conflicts jsonb; v_check jsonb; v_blocked text; v_override boolean := false;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id for update;
  perform app.require_evc_officer(v_evc, v_app);
  if v_evc.row_version <> p_expected_version then perform app.fail('stale', 'This EVC record changed. Refresh first.'); end if;
  if v_evc.status not in ('awaiting_scheduling', 'proposed', 'scheduled') then
    perform app.fail('invalid_state', 'This EVC cannot be scheduled in status ' || v_evc.status || '.');
  end if;
  if p_start is null or p_end is null or p_start <= now() or p_end <= p_start or p_end - p_start > interval '10 hours' then
    perform app.fail('validation', 'Choose a future start and an end within 10 hours of the start.');
  end if;
  v_is_reschedule := v_evc.status = 'scheduled'
                     or (v_evc.status = 'proposed' and v_evc.scheduled_start is distinct from p_start and not p_confirm);
  if v_evc.status = 'scheduled' and length(trim(coalesce(p_reason, ''))) < 10 then
    perform app.fail('reason_required', 'Rescheduling a confirmed EVC needs a reason (at least 10 characters).');
  end if;

  v_people := array(select distinct x from unnest(coalesce(p_participant_ids, '{}') || v_uid) x);
  foreach v_p in array v_people loop
    if not app.is_evc_officer_in(v_p, v_app.region_code) then
      perform app.fail('validation', 'Every participant must be an active officer with EVC responsibility for this region.');
    end if;
  end loop;

  v_check := app.evc_check(v_evc, v_app, p_start, p_end, v_people);
  select string_agg((x ->> 'name') || ': ' || (r ->> 'detail'), ' ')
    into v_blocked
  from jsonb_array_elements(v_check -> 'people') x, jsonb_array_elements(x -> 'reasons') r
  where r ->> 'status' = 'blocked';
  if v_blocked is not null then
    if not coalesce((v_check ->> 'needs_override')::boolean, false) then
      perform app.fail('blocked', 'Assignment blocked: ' || v_blocked);
    end if;
    if length(trim(coalesce(p_override_reason, ''))) < 10 then
      perform app.fail('conflict', 'Assignment blocked: ' || v_blocked || ' Record an override reason (at least 10 characters) to proceed.');
    end if;
    v_override := true;
  end if;

  v_new := case when p_confirm then 'scheduled'::app.evc_status else 'proposed'::app.evc_status end;
  v_conflicts := app.evc_conflicts(v_evc.id, p_start, p_end, v_people);

  update evc_records set status = v_new, scheduled_start = p_start, scheduled_end = p_end, coordinator_id = v_uid,
    notes = nullif(trim(coalesce(p_notes, '')), ''),
    reschedule_count = reschedule_count + case when v_evc.status = 'scheduled' then 1 else 0 end,
    row_version = row_version + 1
  where id = v_evc.id returning * into v_evc;
  delete from evc_participants where evc_id = v_evc.id;
  insert into evc_participants (evc_id, user_id, participant_role)
  select v_evc.id, x, case when x = v_uid then 'coordinator' else 'panel_member' end from unnest(v_people) x;

  if v_override then
    insert into evc_history (evc_id, action, to_status, scheduled_start, scheduled_end, reason, actor_id)
    values (v_evc.id, 'override', v_new, p_start, p_end, trim(p_override_reason) || ' [blocked: ' || v_blocked || ']', v_uid);
    perform app.audit('evc_assignment_override', 'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, trim(p_override_reason),
      null, jsonb_build_object('blocked', v_blocked, 'people', v_check -> 'people'));
  end if;

  insert into evc_history (evc_id, action, from_status, to_status, scheduled_start, scheduled_end, reason, actor_id)
  values (v_evc.id, case when v_is_reschedule then 'rescheduled' when p_confirm then 'confirmed' else 'proposed' end,
          (select to_status from evc_history where evc_id = v_evc.id and action <> 'override' order by created_at desc limit 1), v_new, p_start, p_end,
          nullif(trim(coalesce(p_reason, '')), ''), v_uid);

  if p_confirm then
    update applications set status = 'evc_scheduled', next_action = 'Conduct EVC on ' ||
      to_char(p_start at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST', row_version = row_version + 1, updated_at = now()
    where id = v_app.id and status in ('evc_required', 'evc_scheduled');
    update tasks set status = 'done', completed_at = now(), completed_by = v_uid where evc_id = v_evc.id and task_type = 'evc_schedule' and status = 'open';
    update tasks set status = 'cancelled', completed_at = now() where evc_id = v_evc.id and task_type = 'evc_complete' and status = 'open';
    insert into tasks (task_type, title, application_id, evc_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
    values ('evc_complete', 'Record EVC outcome — ' || v_app.reference, v_app.id, v_evc.id, v_app.region_code, v_uid, 'evc',
            p_end + interval '2 days', 'evccomplete:' || v_evc.id || ':' || v_evc.row_version);
  end if;

  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'evc_' || case when v_is_reschedule then 'rescheduled' when p_confirm then 'scheduled' else 'proposed' end,
          'EVC ' || case when v_is_reschedule then 'rescheduled' when p_confirm then 'scheduled' else 'proposed' end || ' for '
          || to_char(p_start at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST',
          v_uid, nullif(trim(coalesce(p_reason, '')), ''), jsonb_build_object('evc_id', v_evc.id, 'conflicts', v_conflicts, 'override', v_override));
  perform app.audit('evc_' || case when v_is_reschedule then 'rescheduled' when p_confirm then 'scheduled' else 'proposed' end,
    'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, nullif(trim(coalesce(p_reason, '')), ''), null,
    jsonb_build_object('start', p_start, 'end', p_end, 'participants', v_people, 'override', v_override,
                       'manual_review', (select coalesce(jsonb_agg(x -> 'name'), '[]'::jsonb) from jsonb_array_elements(v_check -> 'people') x
                                         where x ->> 'status' = 'manual_review')));

  perform app.notify_institution(v_app.institution_id, 'evc', 'EVC ' || case when p_confirm then 'scheduled' else 'proposed' end || ': ' || v_app.reference,
    'Expert visit ' || case when p_confirm then 'scheduled' else 'proposed' end || ' for ' ||
    to_char(p_start at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST.',
    '/app/applications/' || v_app.id, 'evc', v_evc.id, 'evc:' || v_evc.id || ':' || v_evc.row_version);
  foreach v_p in array v_people loop
    if v_p <> v_uid then
      perform app.notify(v_p, 'evc', 'EVC panel: ' || v_app.reference, 'You are on the EVC panel for ' ||
        to_char(p_start at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST.',
        '/app/evc', 'evc', v_evc.id, 'evcpanel:' || v_evc.id || ':' || v_evc.row_version);
    end if;
  end loop;
  return jsonb_build_object('evc', to_jsonb(v_evc), 'conflicts', v_conflicts, 'checks', v_check, 'override', v_override);
end $$;

-- ---------------------------------------------------------------------------
-- D. Version-controlled corrections
-- ---------------------------------------------------------------------------
alter table public.deficiencies add column affected_document_version_id uuid references public.document_versions (id);
-- existing memos: link the version that was on file when the memo was raised
update public.deficiencies f set affected_document_version_id = (
  select v.id from public.documents d join public.document_versions v on v.document_id = d.id
  where d.application_id = f.application_id and d.doc_type = f.doc_type and v.uploaded_at <= f.raised_at
    and v.version < coalesce((select min(sv.version) from public.deficiency_submissions s
                              join public.document_versions sv on sv.id = s.document_version_id where s.deficiency_id = f.id), 2147483647)
  order by v.version desc limit 1)
where f.doc_type is not null and f.affected_document_version_id is null;

create or replace function app.capture_affected_version() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.doc_type is not null and new.affected_document_version_id is null then
    select v.id into new.affected_document_version_id
    from documents d join document_versions v on v.document_id = d.id and v.version = d.current_version
    where d.application_id = new.application_id and d.doc_type = new.doc_type;
  end if;
  return new;
end $$;
create trigger deficiencies_capture_version before insert on public.deficiencies
  for each row execute function app.capture_affected_version();

-- raise_deficiency: a deadline left empty uses the configured default correction period; none configured = error.
create or replace function public.raise_deficiency(
  p_application_id uuid, p_title text, p_reason text, p_requirement_source text,
  p_requested_correction text, p_doc_type text, p_due_at timestamptz
) returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_app applications; v_def deficiencies; v_kind app.stage_kind;
  v_due timestamptz := p_due_at; v_days numeric; v_due_source text := 'officer';
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null then perform app.fail('not_found', 'Application not found or you do not have access.'); end if;
  perform app.require_case_officer(v_app);
  select kind into v_kind from workflow_stages where version_id = v_app.workflow_version_id and code = v_app.current_stage;
  if v_kind not in ('scrutiny', 'evc', 'committee', 'decision') then
    perform app.fail('invalid_state', 'Deficiencies can be recorded only during a review stage.');
  end if;
  if length(trim(coalesce(p_title, ''))) < 5 or length(trim(coalesce(p_reason, ''))) < 10
     or length(trim(coalesce(p_requested_correction, ''))) < 10 or length(trim(coalesce(p_requirement_source, ''))) < 3 then
    perform app.fail('validation', 'Title, reason, requirement/source and requested correction are all required.');
  end if;
  if v_due is null then
    v_days := app.try_numeric((select value #>> '{days}' from system_settings where key = 'deficiency.correction_period'));
    if v_days is null or v_days < 1 then
      perform app.fail('validation', 'Set a correction due date: no default correction period is configured.');
    end if;
    v_due := app.end_of_day(current_date + v_days::integer);
    v_due_source := 'configured_default';
  end if;
  if v_due <= now() then perform app.fail('validation', 'The correction due date must be in the future.'); end if;

  insert into deficiencies (application_id, stage_code, title, reason, requirement_source, requested_correction, doc_type,
                            due_at, raised_by)
  values (v_app.id, v_app.current_stage, trim(p_title), trim(p_reason), trim(p_requirement_source), trim(p_requested_correction),
          nullif(p_doc_type, ''), v_due, v_uid)
  returning * into v_def;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'deficiency_raised', 'Deficiency recorded: ' || v_def.title, v_uid, v_def.reason,
          jsonb_build_object('deficiency_id', v_def.id, 'due_at', v_def.due_at, 'due_source', v_due_source,
                             'affected_document_version_id', v_def.affected_document_version_id));
  perform app.audit('deficiency_raised', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code, v_def.reason,
    null, jsonb_build_object('title', v_def.title, 'due_at', v_def.due_at, 'due_source', v_due_source,
                             'affected_document_version_id', v_def.affected_document_version_id));
  return v_def;
end $$;

-- submit_deficiency_correction: when the memo concerns a document, a newer version of that document is required.
create or replace function public.submit_deficiency_correction(
  p_deficiency_id uuid, p_response_text text, p_document_version_id uuid default null
) returns public.deficiency_submissions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_sub deficiency_submissions;
  v_attempt integer; v_remaining integer; v_ver record; v_floor integer;
begin
  select * into v_def from deficiencies where id = p_deficiency_id for update;
  if v_def.id is null then perform app.fail('not_found', 'Deficiency not found.'); end if;
  select * into v_app from applications where id = v_def.application_id for update;
  if not app.is_representative_of(v_app.institution_id) then
    perform app.fail('forbidden', 'Only the institution concerned can respond to this deficiency.');
  end if;
  if v_def.status not in ('open', 'still_deficient', 'needs_clarification') then
    perform app.fail('invalid_state', 'This deficiency is not awaiting a response.');
  end if;
  if v_app.status <> 'returned_for_correction' then
    perform app.fail('invalid_state', 'The case has not been returned to the institution for correction.');
  end if;
  if length(trim(coalesce(p_response_text, ''))) < 10 then
    perform app.fail('validation', 'Describe the correction made (at least 10 characters).');
  end if;
  if p_document_version_id is not null and not exists (
      select 1 from document_versions v join documents d on d.id = v.document_id
      where v.id = p_document_version_id and d.institution_id = v_app.institution_id) then
    perform app.fail('validation', 'The attached document does not belong to this institution.');
  end if;
  if v_def.doc_type is not null then
    if p_document_version_id is null then
      perform app.fail('validation', 'This memo concerns a document: upload a new version of it and attach that version.');
    end if;
    select v.version, d.doc_type, d.application_id into v_ver
    from document_versions v join documents d on d.id = v.document_id where v.id = p_document_version_id;
    if v_ver.application_id is distinct from v_app.id or v_ver.doc_type <> v_def.doc_type then
      perform app.fail('validation', 'Attach a version of the ' || replace(v_def.doc_type, '_', ' ') || ' document for this application.');
    end if;
    select greatest(coalesce((select version from document_versions where id = v_def.affected_document_version_id), 0),
                    coalesce(max(v.version), 0))
      into v_floor
    from deficiency_submissions s join document_versions v on v.id = s.document_version_id where s.deficiency_id = v_def.id;
    if v_ver.version <= v_floor then
      perform app.fail('validation', 'Attach a new version: version ' || v_ver.version || ' was already on file for this memo. Earlier versions stay preserved.');
    end if;
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt from deficiency_submissions where deficiency_id = v_def.id;
  insert into deficiency_submissions (deficiency_id, attempt, response_text, document_version_id, submitted_by)
  values (v_def.id, v_attempt, trim(p_response_text), p_document_version_id, v_uid) returning * into v_sub;
  update deficiencies set status = 'correction_submitted', row_version = row_version + 1 where id = v_def.id;

  insert into application_events (application_id, event_type, summary, actor_id, metadata)
  values (v_app.id, 'correction_submitted', 'Correction submitted for: ' || v_def.title || ' (attempt ' || v_attempt || ')', v_uid,
          jsonb_build_object('deficiency_id', v_def.id, 'submission_id', v_sub.id, 'document_version_id', p_document_version_id));
  perform app.audit('correction_submitted', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, jsonb_build_object('status', v_def.status),
    jsonb_build_object('status', 'correction_submitted', 'attempt', v_attempt, 'document_version_id', p_document_version_id));

  insert into tasks (task_type, title, application_id, deficiency_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
  values ('deficiency_review', 'Review correction — ' || v_app.reference, v_app.id, v_def.id, v_app.region_code,
          v_def.raised_by, null, now() + interval '7 days', 'defreview:' || v_def.id || ':' || v_attempt)
  on conflict (dedupe_key) do nothing;
  perform app.notify(coalesce(v_app.assigned_officer_id, v_def.raised_by), 'correction_received',
    'Correction received: ' || v_app.reference, 'The institution responded to "' || v_def.title || '".',
    '/app/applications/' || v_app.id, 'deficiency', v_def.id, 'correction:' || v_def.id || ':' || v_attempt);

  select count(*) into v_remaining from deficiencies
  where application_id = v_app.id and status in ('open', 'still_deficient', 'needs_clarification');
  if v_remaining = 0 then
    update applications set status = 'correction_submitted', next_action = 'Officer to review submitted corrections',
      next_actor = 'officer', row_version = row_version + 1, updated_at = now() where id = v_app.id;
    insert into application_events (application_id, event_type, summary, from_status, to_status, actor_id)
    values (v_app.id, 'status_changed', 'All requested corrections submitted', 'returned_for_correction', 'correction_submitted', v_uid);
  end if;
  return v_sub;
end $$;

-- Metadata of two versions of the same document, and a field comparison only where both texts were read reliably.
create or replace function public.compare_document_versions(p_old_version_id uuid, p_new_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  o document_versions; n document_versions; d documents; ro document_check_runs; rn document_check_runs;
  v_reason text; v_fields jsonb := '[]'::jsonb; v_meta jsonb := '[]'::jsonb;
begin
  perform app.require_user();
  select * into o from document_versions where id = p_old_version_id;
  select * into n from document_versions where id = p_new_version_id;
  if o.id is null or n.id is null or o.document_id <> n.document_id then
    perform app.fail('validation', 'Both versions must belong to the same document.');
  end if;
  select * into d from documents where id = n.document_id;
  if not app.can_read_institution(d.institution_id) then perform app.fail('not_found', 'Document not found or you do not have access.'); end if;

  if o.file_name <> n.file_name then v_meta := v_meta || jsonb_build_object('field', 'File name', 'old', o.file_name, 'new', n.file_name); end if;
  if o.mime_type <> n.mime_type then v_meta := v_meta || jsonb_build_object('field', 'File type', 'old', o.mime_type, 'new', n.mime_type); end if;
  if o.size_bytes <> n.size_bytes then v_meta := v_meta || jsonb_build_object('field', 'Size (bytes)', 'old', o.size_bytes, 'new', n.size_bytes); end if;
  if o.sha256 is distinct from n.sha256 then
    v_meta := v_meta || jsonb_build_object('field', 'SHA-256', 'old', coalesce(left(o.sha256, 16) || '…', 'not recorded'),
                                           'new', coalesce(left(n.sha256, 16) || '…', 'not recorded'));
  end if;

  select * into ro from document_check_runs where document_version_id = o.id and status = 'completed' order by completed_at desc limit 1;
  select * into rn from document_check_runs where document_version_id = n.id and status = 'completed' order by completed_at desc limit 1;
  v_reason := case
    when ro.id is null then 'Version ' || o.version || ' has no completed pre-check, so its content was never read.'
    when rn.id is null then 'Version ' || n.version || ' has no completed pre-check, so its content was never read.'
    when ro.extraction_status <> 'succeeded' then 'The text of version ' || o.version || ' could not be read reliably (' || ro.extraction_status || ').'
    when rn.extraction_status <> 'succeeded' then 'The text of version ' || n.version || ' could not be read reliably (' || rn.extraction_status || ').'
  end;
  if v_reason is null then
    select coalesce(jsonb_agg(jsonb_build_object('check_code', c.code, 'label', coalesce(fn.check_name, fo.check_name),
             'old', fo.evidence, 'old_outcome', fo.outcome, 'new', fn.evidence, 'new_outcome', fn.outcome,
             'changed', fo.evidence is distinct from fn.evidence or fo.outcome is distinct from fn.outcome) order by c.code), '[]'::jsonb)
      into v_fields
    from (select check_code as code from document_check_findings where run_id in (ro.id, rn.id)
          and (check_code like 'field:%' or check_code in ('expiry', 'academic_year_match')) group by check_code) c
    left join document_check_findings fo on fo.run_id = ro.id and fo.check_code = c.code
    left join document_check_findings fn on fn.run_id = rn.id and fn.check_code = c.code;
  end if;

  return jsonb_build_object(
    'document', jsonb_build_object('id', d.id, 'title', d.title, 'doc_type', d.doc_type),
    'old', jsonb_build_object('id', o.id, 'version', o.version, 'file_name', o.file_name, 'mime_type', o.mime_type, 'size_bytes', o.size_bytes,
                              'sha256', o.sha256, 'uploaded_at', o.uploaded_at, 'replaced_reason', o.replaced_reason),
    'new', jsonb_build_object('id', n.id, 'version', n.version, 'file_name', n.file_name, 'mime_type', n.mime_type, 'size_bytes', n.size_bytes,
                              'sha256', n.sha256, 'uploaded_at', n.uploaded_at, 'replaced_reason', n.replaced_reason),
    'identical_file', o.sha256 is not null and o.sha256 = n.sha256,
    'metadata_changes', v_meta,
    'content', jsonb_build_object('available', v_reason is null, 'reason', v_reason, 'fields', v_fields));
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.publish_compliance_rule(text, text, text, text[], jsonb, text, boolean, text, text),
  public.retire_compliance_rule(text, text),
  public.deficiency_matrix(uuid),
  public.start_review_task(uuid, integer),
  public.complete_review_task(uuid, integer, text, text),
  public.reassign_review_task(uuid, uuid, text, integer),
  public.record_evc_availability(uuid, timestamptz, timestamptz, text, text),
  public.withdraw_evc_availability(uuid, text),
  public.declare_evc_conflict(uuid, uuid, text),
  public.withdraw_evc_conflict(uuid, text),
  public.evc_assignment_check(uuid, timestamptz, timestamptz, uuid[]),
  public.schedule_evc(uuid, timestamptz, timestamptz, uuid[], boolean, text, integer, text, text),
  public.compare_document_versions(uuid, uuid)
from public, anon;
grant execute on function
  public.publish_compliance_rule(text, text, text, text[], jsonb, text, boolean, text, text),
  public.retire_compliance_rule(text, text),
  public.deficiency_matrix(uuid),
  public.start_review_task(uuid, integer),
  public.complete_review_task(uuid, integer, text, text),
  public.reassign_review_task(uuid, uuid, text, integer),
  public.record_evc_availability(uuid, timestamptz, timestamptz, text, text),
  public.withdraw_evc_availability(uuid, text),
  public.declare_evc_conflict(uuid, uuid, text),
  public.withdraw_evc_conflict(uuid, text),
  public.evc_assignment_check(uuid, timestamptz, timestamptz, uuid[]),
  public.schedule_evc(uuid, timestamptz, timestamptz, uuid[], boolean, text, integer, text, text),
  public.compare_document_versions(uuid, uuid)
to authenticated, service_role;

revoke execute on function
  app.try_numeric(text),
  app.on_stage_entered(),
  app.lock_review_task(uuid),
  app.review_event(public.review_tasks, public.applications, text, text, text, text, text),
  app.is_evc_officer_in(uuid, text),
  app.evc_person_checks(public.applications, uuid, timestamptz, timestamptz, uuid, jsonb),
  app.evc_check(public.evc_records, public.applications, timestamptz, timestamptz, uuid[]),
  app.capture_affected_version()
from public, anon, authenticated;
