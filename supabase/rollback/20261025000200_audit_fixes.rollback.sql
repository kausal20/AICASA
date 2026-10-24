-- ROLLBACK for 20261025000200_audit_fixes.sql (NOT a migration; keep outside supabase/migrations).
-- Restores the function bodies from 20261025000100_differentiation.sql, which matched the hosted database
-- (23 of 25 hashes identical; the other two differed only by SQL comments).
-- Data effects of the forward migration that this script cannot undo automatically:
--   * deficiencies.affected_version_basis is dropped (the two backfilled rows were marked 'inferred_unverified').
--   * Memo deadlines changed through change_deficiency_deadline() keep their new value; their history stays in audit_logs.
-- Run only if the forward migration was applied and must be reversed.

drop function if exists public.change_deficiency_deadline(uuid, timestamptz, text, integer);
drop function if exists app.can_manage_officer(uuid);

create or replace function app.try_numeric(p text) returns numeric
language plpgsql immutable set search_path = public, app as $$
begin
  if p is null or trim(p) = '' then return null; end if;
  return trim(p)::numeric;
exception when others then return null;
end $$;

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


alter table public.deficiencies drop column if exists affected_version_basis;
-- grants: CREATE OR REPLACE keeps the existing ACLs, so none are changed here.
