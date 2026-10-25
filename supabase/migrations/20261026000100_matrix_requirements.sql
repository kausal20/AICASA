-- Matrix requirements upgrade:
--  * new application fields (library books, laboratories, faculty cadre counts, programme level) for EOA and NEW_INST
--  * new rule kinds "required_count" and "cadre_ratio"; ratio rules can take programme-level thresholds
--  * a failing Deficiency Matrix rule becomes an open deficiency linked to the rule id/version; a passing re-check resolves it
-- Numeric values seeded below are DEMONSTRATION values unless stated otherwise in the rule's source reference.

-- 1. Form fields (skipped on a fresh database: the seed adds them after the application types exist)
update public.application_types
set form_schema = form_schema || '[
  {"key":"library_book_count","label":"Library books / volumes (total)","type":"number","required":false,"help":"Total books and volumes in the central library."},
  {"key":"lab_count","label":"Number of laboratories","type":"number","required":false},
  {"key":"faculty_professors","label":"Faculty: Professors","type":"number","required":false},
  {"key":"faculty_associate_professors","label":"Faculty: Associate Professors","type":"number","required":false},
  {"key":"faculty_assistant_professors","label":"Faculty: Assistant Professors","type":"number","required":false},
  {"key":"programme_level","label":"Programme level","type":"text","required":false,"help":"ug_engg, pg_engg or diploma. Used by programme-dependent rules."}
]'::jsonb
where code in ('EOA', 'NEW_INST') and not (form_schema @> '[{"key":"library_book_count"}]'::jsonb);

-- 2. Deficiencies raised by rules
alter table public.deficiencies alter column raised_by drop not null;
alter table public.deficiencies add column if not exists auto_generated boolean not null default false;
alter table public.deficiencies add column if not exists rule_id uuid references public.compliance_rules (id);
alter table public.deficiencies add column if not exists rule_code text;
alter table public.deficiencies add column if not exists rule_version integer;
create unique index if not exists one_open_auto_deficiency_per_rule on public.deficiencies (application_id, rule_code)
  where auto_generated and status in ('open', 'still_deficient', 'needs_clarification', 'correction_submitted');

create or replace function public.publish_compliance_rule(
  p_code text, p_label text, p_kind text, p_applies_to text[], p_params jsonb, p_source_reference text,
  p_is_synthetic boolean, p_explanation text, p_change_reason text
) returns public.compliance_rules
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_old compliance_rules; v_new compliance_rules; v_type text; v_f text; v_fields text[]; v_map jsonb;
begin
  if not app.is_national_admin() or not app.has_capability('workflow_config') then
    perform app.fail('forbidden', 'Only national administrators with workflow-configuration responsibility can publish rules.');
  end if;
  if coalesce(p_code, '') !~ '^[a-z][a-z0-9_]*$' then perform app.fail('validation', 'Rule code must be lower-case letters, digits and underscores.'); end if;
  if length(trim(coalesce(p_label, ''))) < 3 then perform app.fail('validation', 'A rule label is required.'); end if;
  if length(trim(coalesce(p_source_reference, ''))) < 5 then perform app.fail('validation', 'A source reference is required for every rule.'); end if;
  if length(trim(coalesce(p_change_reason, ''))) < 10 then perform app.fail('reason_required', 'Describe why this rule is being published (at least 10 characters).'); end if;
  if p_kind not in ('min', 'max', 'ratio_max', 'consistency_gt', 'required_count', 'cadre_ratio') then
    perform app.fail('validation', 'Unsupported rule kind "' || coalesce(p_kind, '') || '". Supported: min, max, ratio_max, consistency_gt, required_count, cadre_ratio.');
  end if;
  if coalesce(cardinality(p_applies_to), 0) = 0 then perform app.fail('validation', 'State the application types this rule applies to.'); end if;

  v_map := coalesce(p_params -> 'threshold_by_level', p_params -> 'divisor_by_level');
  if v_map is not null then
    if jsonb_typeof(v_map) <> 'object' or not exists (select 1 from jsonb_each_text(v_map)) then
      perform app.fail('validation', 'Programme-level values must be an object such as {"ug_engg": 20}.');
    end if;
    if exists (select 1 from jsonb_each_text(v_map) e where app.try_numeric(e.value) is null or app.try_numeric(e.value) <= 0) then
      perform app.fail('validation', 'Every programme-level value must be a finite number greater than zero.');
    end if;
    if p_params ->> 'default_level' is not null and not (v_map ? (p_params ->> 'default_level')) then
      perform app.fail('validation', 'The default programme level must be one of the configured levels.');
    end if;
  end if;

  v_fields := case p_kind
    when 'ratio_max' then array[p_params ->> 'numerator', p_params ->> 'denominator']
    when 'consistency_gt' then array[p_params ->> 'field', p_params ->> 'other']
    when 'required_count' then array[p_params ->> 'base_field', p_params ->> 'declared_field']
    when 'cadre_ratio' then array[p_params ->> 'base_field'] || array(select jsonb_array_elements_text(coalesce(p_params -> 'fields', '[]'::jsonb)))
    else array[p_params ->> 'field'] end;
  if v_map is not null and p_params ->> 'level_field' is not null then v_fields := v_fields || (p_params ->> 'level_field'); end if;

  if p_kind in ('min', 'max') or (p_kind = 'ratio_max' and v_map is null) then
    if app.try_numeric(p_params ->> 'threshold') is null then
      perform app.fail('validation', 'A finite numeric threshold is required for this rule kind.');
    end if;
    if app.try_numeric(p_params ->> 'threshold') < 0 then perform app.fail('validation', 'The threshold cannot be negative.'); end if;
    if p_kind = 'ratio_max' and app.try_numeric(p_params ->> 'threshold') = 0 then
      perform app.fail('validation', 'A ratio threshold must be greater than zero.');
    end if;
  end if;
  if p_kind = 'ratio_max' and v_map is not null and p_params ->> 'level_field' is null then
    perform app.fail('validation', 'Programme-level thresholds need the form field that holds the programme level.');
  end if;
  if p_kind = 'required_count' then
    if (app.try_numeric(p_params ->> 'factor') is null) = (app.try_numeric(p_params ->> 'divisor') is null) then
      perform app.fail('validation', 'Give exactly one of "factor" (required = base x factor) or "divisor" (required = base / divisor).');
    end if;
    if coalesce(app.try_numeric(p_params ->> 'factor'), app.try_numeric(p_params ->> 'divisor')) <= 0 then
      perform app.fail('validation', 'The factor or divisor must be greater than zero.');
    end if;
    if length(trim(coalesce(p_params ->> 'noun', ''))) < 2 then perform app.fail('validation', 'Name the counted item (for example "computers").'); end if;
  end if;
  if p_kind = 'cadre_ratio' then
    if jsonb_typeof(p_params -> 'fields') is distinct from 'array' or jsonb_array_length(p_params -> 'fields') <> 3
       or jsonb_typeof(p_params -> 'ratios') is distinct from 'array' or jsonb_array_length(p_params -> 'ratios') <> 3
       or jsonb_typeof(p_params -> 'names') is distinct from 'array' or jsonb_array_length(p_params -> 'names') <> 3 then
      perform app.fail('validation', 'A cadre rule needs three cadre fields, names and ratio parts.');
    end if;
    if exists (select 1 from jsonb_array_elements_text(p_params -> 'ratios') r where app.try_numeric(r) is null or app.try_numeric(r) <= 0 or app.try_numeric(r) <> floor(app.try_numeric(r))) then
      perform app.fail('validation', 'Cadre ratio parts must be positive whole numbers.');
    end if;
    if v_map is null and (app.try_numeric(p_params ->> 'divisor') is null or app.try_numeric(p_params ->> 'divisor') <= 0) then
      perform app.fail('validation', 'A cadre rule needs a positive divisor (students per faculty) or programme-level divisors.');
    end if;
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
  a numeric; b numeric; t numeric; v_missing_hash text; v_docs integer; v_has_findings boolean; v_unit text; v_raw text; v_raw2 text;
  v_level text; v_map jsonb; v_div numeric; v_need numeric; v_total integer; v_sum integer; v_left integer; v_i integer; v_j integer; v_best integer;
  v_ratios integer[]; v_floor integer[]; v_rem integer[]; v_fields text[]; v_names text[]; v_noun text; v_subj text; v_assumed boolean;
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
    v_level := null; v_assumed := false; v_div := null;
    v_map := coalesce(v_rule.params -> 'threshold_by_level', v_rule.params -> 'divisor_by_level');
    if v_map is not null and jsonb_typeof(v_map) = 'object' then
      v_level := lower(nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'level_field'), '')), ''));
      if v_level is null then v_level := v_rule.params ->> 'default_level'; v_assumed := true; end if;
      if v_rule.kind = 'ratio_max' then t := app.try_numeric(v_map ->> v_level); else v_div := app.try_numeric(v_map ->> v_level); end if;
    end if;
    if v_rule.kind in ('min', 'max') then
      v_raw := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'field'), '')), '');
      a := app.try_numeric(v_raw);
      requirement := case v_rule.kind when 'min' then 'Min ' else 'Max ' end || coalesce(t::text, '?') || v_unit;
      input_value := coalesce(a::text || v_unit, v_raw, 'Not declared');
      if t is null then result := 'manual_review'; explanation := 'The rule has no usable threshold; not evaluated.';
      elsif v_raw is not null and a is null then result := 'failed_validation'; explanation := 'The declared value is not a valid finite number.';
      elsif a is null then result := 'not_checked'; explanation := 'The institution has not declared this figure on the form.';
      elsif a < 0 then result := 'failed_validation'; explanation := 'The declared value is negative, which is not a valid figure.';
      elsif (v_rule.kind = 'min' and a >= t) or (v_rule.kind = 'max' and a <= t) then result := 'passed'; explanation := 'Declared figure meets the configured rule.';
      else result := 'potential_issue'; explanation := 'Declared figure does not meet the configured rule. The officer verifies the evidence; this does not reject the application.';
      end if;
    elsif v_rule.kind = 'ratio_max' then
      v_raw := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'numerator'), '')), '');
      v_raw2 := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'denominator'), '')), '');
      a := app.try_numeric(v_raw); b := app.try_numeric(v_raw2);
      requirement := 'Target ' || case when v_level is not null then '1:' || coalesce(trim_scale(t)::text, '?') || ' (' || v_level || case when v_assumed then ', assumed from rule configuration' else '' end || ')'
                                      else coalesce(v_rule.params ->> 'target', '1:' || coalesce(t::text, '?')) end;
      if t is null then input_value := '—'; result := 'manual_review'; explanation := 'The rule has no usable threshold; not evaluated.';
      elsif (v_raw is not null and a is null) or (v_raw2 is not null and b is null) then
        input_value := coalesce(v_raw, 'Not declared') || ' ÷ ' || coalesce(v_raw2, 'Not declared'); result := 'failed_validation';
        explanation := 'A declared figure is not a valid finite number.';
      elsif a is null or b is null then input_value := 'Not declared'; result := 'not_checked';
        explanation := 'One or both figures needed for this ratio are not declared.';
      elsif a < 0 or b < 0 then input_value := a::text || ' ÷ ' || b::text; result := 'failed_validation';
        explanation := 'A declared figure is negative, which is not a valid figure.';
      elsif b = 0 then input_value := a::text || ' ÷ 0'; result := 'failed_validation';
        explanation := 'The declared denominator is zero, so the ratio cannot be calculated.';
      else
        input_value := '1:' || rtrim(rtrim(round(a / b, 2)::text, '0'), '.');
        if a / b <= t then result := 'passed'; explanation := 'Calculated from declared figures; meets the configured target.';
        else result := 'potential_issue'; explanation := 'Calculated from declared figures; exceeds the configured target. The officer verifies the evidence; this does not reject the application.';
        end if;
      end if;
    elsif v_rule.kind = 'consistency_gt' then
      v_raw := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'field'), '')), '');
      v_raw2 := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'other'), '')), '');
      a := app.try_numeric(v_raw); b := app.try_numeric(v_raw2);
      requirement := coalesce(v_rule.params ->> 'field', '?') || ' > ' || coalesce(v_rule.params ->> 'other', '?')
                     || coalesce(' when ' || (v_rule.params ->> 'when_flag') || ' is declared', '');
      if v_rule.params ->> 'when_flag' is not null and not coalesce((v_app.form_data ->> (v_rule.params ->> 'when_flag'))::boolean, false) then
        input_value := 'Not applicable'; result := 'not_checked'; explanation := 'The condition for this check is not declared on this application.';
      elsif (v_raw is not null and a is null) or (v_raw2 is not null and b is null) then
        input_value := coalesce(v_raw, 'Not declared') || ' vs ' || coalesce(v_raw2, 'Not declared'); result := 'failed_validation';
        explanation := 'A declared value is not a valid finite number.';
      elsif a is null or b is null then input_value := 'Not declared'; result := 'not_checked'; explanation := 'One or both values are not declared.';
      else
        input_value := a::text || ' vs ' || b::text;
        if a > b then result := 'passed'; explanation := 'The declared values are consistent.';
        else result := 'failed_validation'; explanation := 'The declared values contradict each other; the institution should correct the form.';
        end if;
      end if;
    elsif v_rule.kind = 'required_count' then
      v_raw := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'base_field'), '')), '');
      v_raw2 := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'declared_field'), '')), '');
      a := app.try_numeric(v_raw); b := app.try_numeric(v_raw2);
      v_div := app.try_numeric(v_rule.params ->> 'divisor'); t := app.try_numeric(v_rule.params ->> 'factor');
      v_noun := coalesce(v_rule.params ->> 'noun', 'items'); v_subj := coalesce(v_rule.params ->> 'subject', 'Sanctioned intake');
      requirement := 'Required ' || v_noun || ' = ' || case when v_div is not null then 'ceil(' || (v_rule.params ->> 'base_field') || ' ÷ ' || trim_scale(v_div)::text || ')'
                                                         else 'ceil(' || (v_rule.params ->> 'base_field') || ' × ' || coalesce(trim_scale(t)::text, '?') || ')' end;
      input_value := coalesce(trim_scale(b)::text || ' declared', v_raw2, 'Not declared');
      if coalesce(v_div, t) is null or coalesce(v_div, t) <= 0 then result := 'manual_review'; explanation := 'The rule has no usable factor or divisor; not evaluated.';
      elsif (v_raw is not null and a is null) or (v_raw2 is not null and b is null) then result := 'failed_validation'; explanation := 'A declared figure is not a valid finite number.';
      elsif a is null or b is null then result := 'not_checked'; explanation := 'The institution has not declared ' || case when a is null then (v_rule.params ->> 'base_field') else (v_rule.params ->> 'declared_field') end || ', so the requirement cannot be calculated.';
      elsif a < 0 or b < 0 then result := 'failed_validation'; explanation := 'A declared figure is negative, which is not a valid figure.';
      else
        v_need := ceil(case when v_div is not null then a / v_div else a * t end);
        requirement := 'Required ' || trim_scale(v_need)::text || ' ' || v_noun || ' (' || requirement || ')';
        if b >= v_need then result := 'passed'; explanation := v_subj || ' requires ' || trim_scale(v_need)::text || ' ' || v_noun || '; ' || trim_scale(b)::text || ' declared.';
        else result := 'potential_issue'; explanation := v_subj || ' requires ' || trim_scale(v_need)::text || ' ' || v_noun || ', only ' || trim_scale(b)::text || ' declared — Deficiency detected.';
        end if;
      end if;
    elsif v_rule.kind = 'cadre_ratio' then
      -- Required faculty R = ceil(S / divisor); split by the configured cadre ratio with largest-remainder rounding so the parts sum to R.
      v_raw := nullif(trim(coalesce(v_app.form_data ->> (v_rule.params ->> 'base_field'), '')), '');
      a := app.try_numeric(v_raw);
      if v_div is null then v_div := app.try_numeric(v_rule.params ->> 'divisor'); end if;
      v_names := array(select jsonb_array_elements_text(v_rule.params -> 'names'));
      v_fields := array(select jsonb_array_elements_text(v_rule.params -> 'fields'));
      v_ratios := array(select jsonb_array_elements_text(v_rule.params -> 'ratios')::numeric::integer);
      requirement := 'Faculty = ceil(' || coalesce(v_rule.params ->> 'base_field', '?') || ' ÷ ' || coalesce(trim_scale(v_div)::text, '?') || ')'
                     || case when v_level is not null then ' (' || v_level || case when v_assumed then ', assumed from rule configuration' else '' end || ')' else '' end
                     || ', cadre ratio ' || array_to_string(v_ratios, ':');
      input_value := coalesce(v_raw, 'Not declared');
      if v_div is null or v_div <= 0 or cardinality(v_ratios) <> 3 or cardinality(v_fields) <> 3 or cardinality(v_names) <> 3 then
        result := 'manual_review'; explanation := 'The cadre rule is not fully configured for programme level "' || coalesce(v_level, '?') || '"; not evaluated.'; return next; continue;
      elsif v_raw is not null and a is null then result := 'failed_validation'; explanation := 'The declared base figure is not a valid finite number.'; return next; continue;
      elsif a is null then result := 'not_checked'; explanation := 'The institution has not declared ' || (v_rule.params ->> 'base_field') || ', so the cadre requirement cannot be calculated.'; return next; continue;
      elsif a < 0 then result := 'failed_validation'; explanation := 'The declared base figure is negative.'; return next; continue;
      end if;
      v_total := ceil(a / v_div)::integer;
      v_sum := v_ratios[1] + v_ratios[2] + v_ratios[3];
      v_floor := array[(v_total * v_ratios[1]) / v_sum, (v_total * v_ratios[2]) / v_sum, (v_total * v_ratios[3]) / v_sum];
      v_rem := array[(v_total * v_ratios[1]) % v_sum, (v_total * v_ratios[2]) % v_sum, (v_total * v_ratios[3]) % v_sum];
      v_left := v_total - (v_floor[1] + v_floor[2] + v_floor[3]);
      while v_left > 0 loop
        v_best := 1;
        for v_j in 2..3 loop
          if v_rem[v_j] > v_rem[v_best] or (v_rem[v_j] = v_rem[v_best] and v_ratios[v_j] > v_ratios[v_best]) then v_best := v_j; end if;
        end loop;
        v_floor[v_best] := v_floor[v_best] + 1; v_rem[v_best] := -1; v_left := v_left - 1;
      end loop;
      for v_i in 1..3 loop
        v_raw2 := nullif(trim(coalesce(v_app.form_data ->> v_fields[v_i], '')), '');
        b := app.try_numeric(v_raw2);
        check_code := 'rule:' || v_rule.code || ':' || v_fields[v_i]; label := v_rule.label || ' — ' || v_names[v_i];
        requirement := 'Required ' || v_floor[v_i] || ' ' || v_names[v_i] || ' (of ' || v_total || ' faculty for ' || trim_scale(a)::text || ' intake)';
        sort_order := 500 + v_n * 10 + v_i;
        if v_raw2 is not null and b is null then input_value := v_raw2; result := 'failed_validation'; explanation := 'The declared ' || v_names[v_i] || ' count is not a valid finite number.';
        elsif b is null then input_value := 'Not declared'; result := 'not_checked'; explanation := 'The institution has not declared the number of ' || v_names[v_i] || '.';
        elsif b < 0 then input_value := trim_scale(b)::text; result := 'failed_validation'; explanation := 'The declared ' || v_names[v_i] || ' count is negative.';
        elsif b < v_floor[v_i] then input_value := trim_scale(b)::text || ' declared'; result := 'potential_issue'; explanation := trim_scale(b)::text || ' of ' || v_floor[v_i] || ' ' || v_names[v_i] || ' — cadre violation.';
        else input_value := trim_scale(b)::text || ' declared'; result := 'passed'; explanation := trim_scale(b)::text || ' of ' || v_floor[v_i] || ' ' || v_names[v_i] || ' — meets the requirement.';
        end if;
        return next;
      end loop;
      check_code := 'rule:' || v_rule.code || ':principal'; label := v_rule.label || ' — Principal'; requirement := 'Plus 1 Principal'; input_value := 'Not on the form';
      result := 'not_checked'; explanation := 'One Principal is also required; the application form does not capture it, so it was not checked.'; sort_order := 500 + v_n * 10 + 4;
      return next;
      continue;
    else
      requirement := '—'; input_value := '—'; result := 'manual_review';
      explanation := 'Rule kind "' || v_rule.kind || '" is not supported by this engine, so it was not evaluated.';
    end if;
    if v_rule.explanation <> '' then explanation := explanation || ' ' || v_rule.explanation; end if;
    return next;
  end loop;
end $$;


-- Statuses that count as "unresolved" for rule-raised deficiencies
create or replace function app.auto_resolve_deficiency(p_def public.deficiencies, p_why text) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  update deficiencies set status = 'resolved', resolved_at = now(), resolved_by = null, row_version = row_version + 1 where id = p_def.id;
  update tasks set status = 'cancelled', completed_at = now() where deficiency_id = p_def.id and status = 'open';
  insert into application_events (application_id, event_type, summary, actor_kind, reason, metadata)
  values (p_def.application_id, 'deficiency_auto_resolved', 'Deficiency resolved automatically: ' || p_def.title, 'system', p_why,
          jsonb_build_object('deficiency_id', p_def.id, 'rule_code', p_def.rule_code, 'rule_version', p_def.rule_version));
  perform app.audit('deficiency_auto_resolved', 'deficiency', p_def.id, p_def.application_id,
    (select institution_id from applications where id = p_def.application_id), (select region_code from applications where id = p_def.application_id),
    p_why, jsonb_build_object('status', p_def.status), jsonb_build_object('status', 'resolved'),
    jsonb_build_object('rule_code', p_def.rule_code, 'rule_version', p_def.rule_version, 'auto', true));
end $$;

-- Reconciles the Deficiency Matrix rule results of one case with its deficiencies:
--   failing rule -> open (or updated) deficiency citing the rule id and version; passing rule (or rule no longer applying) -> resolved.
-- Rules whose inputs are not declared / need manual review neither create nor resolve anything.
create or replace function app.sync_matrix_deficiencies(p_application_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_app applications; v_days numeric; v_due timestamptz; g record; d deficiencies; v_created integer := 0; v_updated integer := 0;
  v_resolved integer := 0; v_open integer; v_pending integer; v_kind app.stage_kind; v_reason text; v_src text; v_codes text[] := '{}';
  v_skipped boolean := false; v_rule compliance_rules; v_new deficiencies;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null then perform app.fail('not_found', 'Application not found or you do not have access.'); end if;
  if v_app.status in ('draft', 'completed', 'closed', 'withdrawn') then
    return jsonb_build_object('skipped', 'The case is not under processing.', 'created', 0, 'updated', 0, 'resolved', 0);
  end if;
  v_days := app.try_numeric((select value #>> '{days}' from system_settings where key = 'deficiency.correction_period'));

  for g in
    select split_part(m.rule_ref, ' ', 1) as code, max(substring(m.rule_ref from ' v([0-9]+)$')::integer) as ver,
           bool_or(m.result in ('potential_issue', 'failed_validation')) as failing,
           bool_and(m.result = 'passed') as all_passed,
           string_agg(case when m.result in ('potential_issue', 'failed_validation')
                           then m.label || ' (' || m.input_value || ' vs ' || m.requirement || '): ' || m.explanation end, ' ' order by m.sort_order) as detail,
           string_agg(case when m.result in ('potential_issue', 'failed_validation') then m.explanation end, ' ' order by m.sort_order) as messages
    from public.deficiency_matrix(p_application_id) m where m.section = 'rules' group by 1
  loop
    v_codes := v_codes || g.code;
    select * into v_rule from compliance_rules where code = g.code and version = g.ver;
    select * into d from deficiencies where application_id = p_application_id and auto_generated and rule_code = g.code
      and status in ('open', 'still_deficient', 'needs_clarification', 'correction_submitted') for update;
    if g.failing then
      v_reason := case when v_rule.kind in ('required_count', 'cadre_ratio') then g.messages else g.detail end;
      v_src := 'Deficiency Matrix rule ' || g.code || ' v' || g.ver || ' (rule id ' || v_rule.id || ') — ' || v_rule.source_reference;
      if d.id is null then
        if v_days is null or v_days < 1 then v_skipped := true; continue; end if;
        v_due := app.end_of_day(((now() at time zone coalesce((select value #>> '{}' from system_settings where key = 'display_timezone'), 'Asia/Kolkata'))::date) + v_days::integer);
        insert into deficiencies (application_id, stage_code, title, reason, requirement_source, requested_correction, due_at, raised_by,
                                  auto_generated, rule_id, rule_code, rule_version)
        values (p_application_id, v_app.current_stage, 'Matrix rule not met: ' || v_rule.label, v_reason, v_src,
                'Correct the declared figures, or provide evidence that the requirement is met.', v_due, null, true, v_rule.id, g.code, g.ver)
        returning * into v_new;
        insert into application_events (application_id, event_type, summary, actor_kind, reason, metadata)
        values (p_application_id, 'deficiency_raised', 'Deficiency recorded by rule: ' || v_new.title, 'system', v_reason,
                jsonb_build_object('deficiency_id', v_new.id, 'rule_code', g.code, 'rule_version', g.ver, 'due_at', v_due));
        perform app.audit('deficiency_auto_raised', 'deficiency', v_new.id, p_application_id, v_app.institution_id, v_app.region_code, v_reason,
          null, jsonb_build_object('title', v_new.title, 'due_at', v_due),
          jsonb_build_object('rule_code', g.code, 'rule_version', g.ver, 'rule_id', v_rule.id, 'auto', true));
        v_created := v_created + 1;
      elsif d.status in ('open', 'still_deficient', 'needs_clarification')
            and (d.reason is distinct from v_reason or d.rule_version is distinct from g.ver) then
        update deficiencies set reason = v_reason, requirement_source = v_src, rule_id = v_rule.id, rule_version = g.ver,
          title = 'Matrix rule not met: ' || v_rule.label, row_version = row_version + 1 where id = d.id;
        perform app.audit('deficiency_auto_updated', 'deficiency', d.id, p_application_id, v_app.institution_id, v_app.region_code, v_reason,
          jsonb_build_object('reason', d.reason, 'rule_version', d.rule_version), jsonb_build_object('reason', v_reason, 'rule_version', g.ver),
          jsonb_build_object('rule_code', g.code, 'auto', true));
        v_updated := v_updated + 1;
      end if;
    elsif g.all_passed and d.id is not null then
      perform app.auto_resolve_deficiency(d, 'The rule is now satisfied (' || g.code || ' v' || g.ver || ').');
      v_resolved := v_resolved + 1;
    end if;
  end loop;

  -- rule retired, or no longer applies to this case
  for d in select * from deficiencies where application_id = p_application_id and auto_generated
           and status in ('open', 'still_deficient', 'needs_clarification', 'correction_submitted') and not (rule_code = any (v_codes)) for update loop
    perform app.auto_resolve_deficiency(d, 'The rule (' || d.rule_code || ') no longer applies to this case.');
    v_resolved := v_resolved + 1;
  end loop;

  if v_resolved > 0 and v_app.status in ('returned_for_correction', 'correction_submitted') then
    select count(*) filter (where status in ('open', 'still_deficient', 'needs_clarification')), count(*) filter (where status = 'correction_submitted')
      into v_open, v_pending from deficiencies where application_id = p_application_id;
    if v_open = 0 and v_pending = 0 then
      select kind into v_kind from workflow_stages where version_id = v_app.workflow_version_id and code = v_app.current_stage;
      update applications set status = app.status_for_stage(v_kind), next_actor = 'officer',
        next_action = 'Deficiencies cleared — ' || coalesce(app.next_action_for_stage(v_kind, current_stage), 'continue processing'),
        row_version = row_version + 1, updated_at = now() where id = p_application_id;
      perform app.try_auto_advance(p_application_id);
    elsif v_open > 0 and v_pending = 0 then
      update applications set status = 'returned_for_correction', next_actor = 'institution', row_version = row_version + 1, updated_at = now()
      where id = p_application_id;
    end if;
  end if;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'resolved', v_resolved,
    'skipped', case when v_skipped then 'Some rule breaches were not recorded because no default correction period is configured.' end);
end $$;

create or replace function public.recheck_matrix_deficiencies(p_application_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare v_app applications;
begin
  perform app.require_user();
  select * into v_app from applications where id = p_application_id;
  if v_app.id is null then perform app.fail('not_found', 'Application not found or you do not have access.'); end if;
  perform app.require_case_officer(v_app);
  return app.sync_matrix_deficiencies(p_application_id);
end $$;

revoke execute on function public.recheck_matrix_deficiencies(uuid) from public, anon;
grant execute on function public.recheck_matrix_deficiencies(uuid) to authenticated, service_role;
revoke execute on function app.sync_matrix_deficiencies(uuid), app.auto_resolve_deficiency(public.deficiencies, text) from public, anon, authenticated;

create or replace function public.submit_application(p_application_id uuid, p_expected_version integer)
returns public.applications
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user();
  v_app applications;
  v_type application_types;
  v_field jsonb;
  v_missing text[] := '{}';
  v_unmet text;
  v_first workflow_stages;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null or not app.is_representative_of(v_app.institution_id) then
    perform app.fail('not_found', 'Application not found or you do not have access.');
  end if;
  if v_app.status <> 'draft' then perform app.fail('invalid_state', 'This application has already been submitted.'); end if;
  if v_app.row_version <> p_expected_version then
    perform app.fail('stale', 'This draft was changed elsewhere. Refresh before submitting.');
  end if;

  select * into v_type from application_types where code = v_app.application_type_code;
  for v_field in select * from jsonb_array_elements(v_type.form_schema) loop
    if coalesce((v_field ->> 'required')::boolean, false)
       and coalesce(trim(v_app.form_data ->> (v_field ->> 'key')), '') = '' then
      v_missing := v_missing || (v_field ->> 'label');
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    perform app.fail('validation', 'Required fields missing: ' || array_to_string(v_missing, ', ') || '.');
  end if;

  v_unmet := app.prerequisite_unmet(v_app, array['required_documents']);
  if v_unmet is not null then perform app.fail('prerequisite', v_unmet); end if;

  update applications set submitted_at = now(), row_version = row_version + 1, updated_at = now() where id = v_app.id;
  insert into application_events (application_id, event_type, summary, from_status, to_status, actor_id)
  values (v_app.id, 'submitted', 'Application submitted by institution', 'draft', 'submitted', v_uid);
  perform app.audit('application_submitted', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'submitted'));
  perform app.notify_institution(v_app.institution_id, 'submitted', 'Submitted: ' || v_app.reference,
    'Application "' || v_app.title || '" was submitted. Keep the reference ' || v_app.reference || ' for follow-up.',
    '/app/applications/' || v_app.id, 'application', v_app.id, 'submitted:' || v_app.id);

  select * into v_first from workflow_stages where version_id = v_app.workflow_version_id order by sequence limit 1;
  perform app.enter_stage(v_app.id, v_first.code, 'submit');
  perform app.try_auto_advance(v_app.id);
  -- rule breaches in the declared figures become deficiencies the officer sees at once
  perform app.sync_matrix_deficiencies(v_app.id);

  select * into v_app from applications where id = p_application_id;
  return v_app;
end $$;


-- 7. Upgrade path for an existing project. A fresh database receives the same rules from seed.sql.
do $$
declare v_sfr compliance_rules;
begin
  if not exists (select 1 from application_types where code = 'EOA') then return; end if;
  update compliance_rules set status = 'retired', retired_at = now(), retired_reason = 'Replaced by the required-count rule computers_required'
  where code = 'student_computer_ratio' and status = 'active';
  select * into v_sfr from compliance_rules where code = 'student_faculty_ratio' and status = 'active';
  if v_sfr.id is not null and not (v_sfr.params ? 'threshold_by_level') then
    update compliance_rules set status = 'retired', retired_at = now(), retired_reason = 'Superseded by a programme-dependent version' where id = v_sfr.id;
    insert into compliance_rules (code, version, label, kind, applies_to, params, source_reference, is_synthetic, explanation)
    values ('student_faculty_ratio', v_sfr.version + 1, 'Student-to-faculty ratio (declared figures)', 'ratio_max', v_sfr.applies_to,
      '{"numerator": "student_count", "denominator": "faculty_count", "level_field": "programme_level", "default_level": "ug_engg",
        "threshold_by_level": {"ug_engg": 20, "pg_engg": 15, "diploma": 25}}',
      'Ratios 1:20 (UG Engg), 1:15 (PG Engg), 1:25 (Diploma) as supplied by the project team from APH 2024-27; not verified against the handbook', true, '');
  end if;
  insert into compliance_rules (code, version, label, kind, applies_to, params, source_reference, is_synthetic, explanation) values
    ('computers_required', 1, 'Computers for the sanctioned intake', 'required_count', array['EOA', 'NEW_INST'],
     '{"base_field": "student_count", "divisor": 4, "declared_field": "computer_count", "noun": "computers", "subject": "Sanctioned intake"}',
     'Existing 1:4 student-to-computer norm used by the prototype (required computers = ceil(students / 4)); not verified against the current APH', true, ''),
    ('library_books_min', 1, 'Library books for the sanctioned intake', 'required_count', array['EOA', 'NEW_INST'],
     '{"base_field": "student_count", "factor": 10, "declared_field": "library_book_count", "noun": "library books", "subject": "Sanctioned intake"}',
     'DEMO VALUE (10 books per student) until the real APH figure is entered; not an AICTE requirement', true, ''),
    ('labs_min', 1, 'Minimum laboratories for the programme', 'min', array['EOA', 'NEW_INST'],
     '{"field": "lab_count", "threshold": 4, "unit": "laboratories"}',
     'DEMO VALUE (4 laboratories) until the real APH figure is entered; not an AICTE requirement', true, ''),
    ('faculty_cadre_ratio', 1, 'Faculty cadre ratio', 'cadre_ratio', array['EOA'],
     '{"base_field": "approved_intake", "level_field": "programme_level", "default_level": "ug_engg",
       "divisor_by_level": {"ug_engg": 20, "pg_engg": 15, "diploma": 25}, "ratios": [1, 2, 6],
       "names": ["Professors", "Associate Professors", "Assistant Professors"],
       "fields": ["faculty_professors", "faculty_associate_professors", "faculty_assistant_professors"]}',
     'Faculty = intake / 20 split Professor : Associate : Assistant = 1 : 2 : 6 (plus 1 Principal) as supplied by the project team from APH 2024-27 (UG Engineering); not verified against the handbook. The intake is read from approved_intake, which only the EOA form has, so the rule applies to EOA only.', true, '')
  on conflict do nothing;
end $$;
