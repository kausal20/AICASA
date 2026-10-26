-- One pure evaluator; every public matrix read reconciles its rule queries under a case lock.
create or replace function app.evaluate_deficiency_matrix(p_application_id uuid)
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
  select * into v_app from applications where id = p_application_id;
  if v_app.id is null then
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
      result := case when v_req.is_required then 'failed_validation' else 'not_applicable' end;
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
      result := 'manual_review';
      explanation := case when v_run.id is null then 'Content extraction is pending; an officer must review this document until its pre-check completes.' else 'The pre-check is still running; an officer must review this document until it completes.' end;
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
  for v_rule in select * from compliance_rules where status = 'active' order by code loop
    v_n := v_n + 1;
    section := 'rules'; check_code := 'rule:' || v_rule.code; label := v_rule.label; rule_ref := v_rule.code || ' v' || v_rule.version;
    source := v_rule.source_reference; is_synthetic := v_rule.is_synthetic; document_id := null; sort_order := 500 + v_n;
    if not (v_app.application_type_code = any(v_rule.applies_to)) then
      input_value := 'Not applicable'; requirement := 'Applies to ' || array_to_string(v_rule.applies_to, ', ');
      result := 'not_applicable'; explanation := 'This rule applies to ' || array_to_string(v_rule.applies_to, ', ') || ' applications only.';
      return next; continue;
    end if;
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
        input_value := 'Not applicable'; result := 'not_applicable'; explanation := 'Applies only when ' || replace(v_rule.params ->> 'when_flag', '_', ' ') || ' is declared; it is not declared on this application.';
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
      check_code := 'rule:' || v_rule.code || ':principal'; label := v_rule.label || ' — Principal'; requirement := 'Plus 1 Principal';
      b := app.try_numeric(v_app.form_data ->> 'principal_count'); input_value := coalesce(b::text, 'Not declared');
      result := case when b is null then 'not_checked' when b >= 1 then 'passed' else 'potential_issue' end;
      explanation := case when b is null then 'Declare the number of Principals.' when b >= 1 then 'A Principal is declared.' else 'One Principal is required.' end; sort_order := 500 + v_n * 10 + 4;
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
    from app.evaluate_deficiency_matrix(p_application_id) m where m.section = 'rules' group by 1
  loop
    v_codes := v_codes || g.code;
    select * into v_rule from compliance_rules where code = g.code and version = g.ver;
    select * into d from deficiencies where application_id = p_application_id and auto_generated and rule_code = g.code
      and status in ('open', 'still_deficient', 'needs_clarification', 'correction_submitted') for update;
    if g.failing then
      v_reason := g.detail;
      v_src := 'Deficiency Matrix rule ' || g.code || ' v' || g.ver || ' (rule id ' || v_rule.id || ') — ' || v_rule.source_reference;
      if d.id is null then
        -- Historical records, including resolved and manually raised rule queries, prevent resurrection.
        if exists(select 1 from deficiencies where application_id = p_application_id and rule_code = g.code) then continue; end if;
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

create or replace function public.deficiency_matrix(p_application_id uuid)
returns table (section text, check_code text, label text, input_value text, requirement text, result text,
               rule_ref text, source text, explanation text, is_synthetic boolean, document_id uuid, sort_order integer)
language plpgsql volatile security definer set search_path = public, app as $$
begin
  perform app.require_user();
  if not app.can_read_application(p_application_id) then perform app.fail('not_found', 'Application not found or you do not have access.'); end if;
  perform app.sync_matrix_deficiencies(p_application_id);
  return query select * from app.evaluate_deficiency_matrix(p_application_id);
end $$;

create or replace function public.start_document_check(p_document_version_id uuid) returns public.document_check_runs
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_doc documents; v_app applications; v_run document_check_runs;
begin
  select d.* into v_doc from documents d join document_versions v on v.document_id = d.id where v.id = p_document_version_id;
  if v_doc.id is null or not (app.is_representative_of(v_doc.institution_id) or (v_doc.application_id is not null and app.can_read_application(v_doc.application_id) and app.has_capability('scrutiny'))) then
    perform app.fail('forbidden', 'Only the institution or an authorised scrutiny officer can run a pre-check.');
  end if;
  if v_doc.application_id is not null then select * into v_app from applications where id = v_doc.application_id; end if;
  insert into document_check_runs (document_version_id, application_id, institution_id, engine, checklist_version, run_by)
  values (p_document_version_id, v_doc.application_id, v_doc.institution_id, 'pending', v_app.checklist_version, v_uid)
  returning * into v_run;
  return v_run;
end $$;

revoke all on function app.evaluate_deficiency_matrix(uuid) from public, anon, authenticated;

-- Preserve all declared figures; fill only missing fields on the six named demonstration fixtures.
create or replace function app.complete_hero_demo_inputs() returns void
language plpgsql security definer set search_path = public, app as $$
begin
  -- Cases are found by title (references differ between a fresh seed and the deployed demo). 01002 keeps its two deliberate rule failures.
  update applications a set form_data = jsonb_build_object(
    'land_area_acres', case when a.title = 'Extension of approval with intake increase 2027-28' then 2 else 4 end, 'built_up_area_sqm', 4800, 'programme_level', 'ug_engg',
    'student_count', case when a.title = 'Extension of approval with intake increase 2027-28' then 900 else coalesce(app.try_numeric(a.form_data->>'approved_intake'),480) end,
    'faculty_count', case when a.title = 'Extension of approval with intake increase 2027-28' then 40 else 90 end, 'computer_count', 450, 'lab_count', 5,
    'library_book_count', coalesce(app.try_numeric(a.form_data->>'student_count'), case when a.title = 'Extension of approval with intake increase 2027-28' then 900 else 480 end) * 10,
    'faculty_professors', 10, 'faculty_associate_professors', 20, 'faculty_assistant_professors', 60,
    'principal_count', 1
  ) || a.form_data
  where a.is_demo and (
    a.title in ('Extension of approval with intake increase 2027-28', 'Extension of approval — University Department of Technology',
                'Change of site — Sahyadri College to the Survey 310 campus',
                'Extension of approval — computing capacity review (demo)', 'Extension of approval — faculty cadre review (demo)')
    or (a.title = 'Extension of approval 2027-28' and exists (select 1 from institutions i where i.id = a.institution_id and i.code = 'DEMO-WR-002')));
end $$;
revoke all on function app.complete_hero_demo_inputs() from public, anon, authenticated;

update application_types set form_schema = form_schema ||
  '[{"key":"principal_count","label":"Number of Principals","type":"number","required":false}]'::jsonb
where code = 'EOA' and not form_schema @> '[{"key":"principal_count"}]'::jsonb;

-- Verified against APH 2024–27, Annexure 5, pp. 95–96 (PDF pages 111–112).
-- Government-hosted original: https://cdnbbsr.s3waas.gov.in/s35938b4d054136e5d59ada6ec9c295d7a/uploads/2025/03/2025031399.pdf
update compliance_rules set source_reference = 'AICTE Approval Process Handbook 2024–27 — Annexure 5, sections 5.1–5.3 (faculty/student ratios)', is_synthetic = false
where code = 'student_faculty_ratio' and params->'threshold_by_level' = '{"ug_engg":20,"pg_engg":15,"diploma":25}'::jsonb;
update compliance_rules set source_reference = 'AICTE Approval Process Handbook 2024–27 — Annexure 5.2, UG Engineering cadre ratio 1:2:6 plus Principal. Prototype uses declared approved intake and whole-person rounding; PG/Diploma cadre allocation is not verified.', is_synthetic = false
where code = 'faculty_cadre_ratio' and params->'ratios' = '[1,2,6]'::jsonb;
update compliance_rules set source_reference = 'Demonstration configuration', explanation = ''
where is_synthetic and code in ('land_area_min','built_up_min','labs_min','library_books_min','computers_required');

-- These two version-one links are proven by the explicit fixture sequence in seed.sql:
-- upload N2_fire/S1_fire, then raise the matching named query, then upload any correction.
-- Do not promote arbitrary timestamp-based legacy guesses to proven provenance.
alter table deficiencies drop constraint if exists deficiencies_affected_version_basis_check;
alter table deficiencies add constraint deficiencies_affected_version_basis_check
  check (affected_version_basis in ('captured_at_raise','seed_fixture_verified','inferred_unverified'));
update deficiencies q set affected_document_version_id = v.id, affected_version_basis = 'seed_fixture_verified'
from applications a, documents d, document_versions v
where q.application_id = a.id and a.is_demo and d.application_id = a.id
  and d.doc_type = q.doc_type and v.document_id = d.id and v.version = 1
  and q.affected_version_basis is distinct from 'captured_at_raise'
  and ((right(a.reference,5) = '01002' and q.title = 'Fire safety certificate validity not stated' and v.file_name = 'fire_safety_certificate.pdf')
    or (right(a.reference,5) = '01005' and v.file_name = 'fire_certificate_2023.pdf' and q.doc_type = 'fire_safety_certificate'));

select app.complete_hero_demo_inputs();
do $$ declare a record; begin
  for a in select id from applications order by id loop perform app.sync_matrix_deficiencies(a.id); end loop;
end $$;

-- Keep server-side assignment consistent with the recommendation UI.
create or replace function public.assign_evc_expert(p_evc_id uuid, p_expert_id uuid, p_expected_version integer)
returns public.evc_panel_experts
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_exp experts; v_row evc_panel_experts; v_ex text[]; v_programmes text[]; v_programme_text text;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  perform app.require_evc_officer(v_evc, v_app);
  if v_evc.row_version <> p_expected_version then perform app.fail('stale', 'This EVC record changed. Refresh first.'); end if;
  if v_evc.status not in ('awaiting_scheduling', 'proposed', 'scheduled') then perform app.fail('invalid_state', 'Experts can be added only before the session is completed or cancelled.'); end if;
  select * into v_exp from experts where id = p_expert_id;
  if v_exp.id is null or not v_exp.is_active then perform app.fail('not_found', 'Expert not found or not active.'); end if;
  v_ex := app.expert_exclusions(v_exp.id, v_app.institution_id);
  if cardinality(v_ex) > 0 then perform app.fail('conflict_of_interest', app.expert_exclusion_text(v_ex) || '. ' || v_exp.full_name || ' cannot be assigned to this institute''s panel.'); end if;
  select programmes into v_programmes from institutions where id = v_app.institution_id;
  v_programme_text := lower(coalesce(v_app.form_data ->> 'programme', v_app.form_data ->> 'proposed_programmes', ''));
  if v_programme_text ~ 'architect|b\.arch' then v_programmes := v_programmes || ARRAY['Architecture']; end if;
  if v_programme_text ~ 'computer|\bcse\b|\bcs\b' then v_programmes := v_programmes || ARRAY['CSE']; end if;
  if v_programme_text ~ 'mechanical|\bmech\b' then v_programmes := v_programmes || ARRAY['Mechanical']; end if;
  if v_programme_text ~ 'civil' then v_programmes := v_programmes || ARRAY['Civil']; end if;
  if v_programme_text ~ 'pharm' then v_programmes := v_programmes || ARRAY['Pharmacy']; end if;
  if not exists (select 1 from unnest(v_exp.specializations) s join unnest(coalesce(v_programmes,'{}')) p on lower(trim(s)) = lower(trim(p))) then
    perform app.fail('no_specialization_match', 'Excluded — no specialization match. ' || v_exp.full_name || ' cannot be assigned to this institute''s panel.');
  end if;
  if exists (select 1 from evc_panel_experts where evc_id = p_evc_id and expert_id = p_expert_id) then perform app.fail('invalid_state', 'This expert is already on the panel.'); end if;
  insert into evc_panel_experts (evc_id, expert_id, assigned_by) values (p_evc_id, p_expert_id, v_uid) returning * into v_row;
  insert into evc_history (evc_id, action, reason, actor_id) values (p_evc_id, 'expert_assigned', v_exp.full_name, v_uid);
  insert into application_events (application_id, event_type, summary, actor_id, visibility, metadata)
  values (v_app.id, 'evc_expert_assigned', 'Expert added to the EVC panel: ' || v_exp.full_name, v_uid, 'internal', jsonb_build_object('evc_id', v_evc.id, 'expert_id', p_expert_id));
  perform app.audit('evc_expert_assigned', 'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, null, null, jsonb_build_object('expert_id', p_expert_id, 'expert', v_exp.full_name));
  return v_row;
end $$;

create or replace function public.submit_deficiency_correction(
  p_deficiency_id uuid, p_response_text text, p_document_version_id uuid default null
) returns public.deficiency_submissions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_sub deficiency_submissions;
  v_attempt integer; v_remaining integer; v_ver record; v_floor integer; v_sha text; v_same integer;
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
  if v_def.window_closes_at is not null and v_def.window_closes_at <= now() then
    perform app.fail('window_expired', 'The response window for this query closed on ' || to_char(v_def.window_closes_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST. Ask the officer to reopen it.');
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
    select v.version, v.sha256, v.document_id, d.doc_type, d.application_id into v_ver
    from document_versions v join documents d on d.id = v.document_id where v.id = p_document_version_id;
    if v_ver.application_id is distinct from v_app.id or v_ver.doc_type <> v_def.doc_type then
      perform app.fail('validation', 'Attach a version of the ' || replace(v_def.doc_type, '_', ' ') || ' document for this application.');
    end if;
    -- only a link captured when the memo was raised is trusted as the floor; an inferred link is not used
    select greatest(case when v_def.affected_version_basis in ('captured_at_raise','seed_fixture_verified')
                         then coalesce((select version from document_versions where id = v_def.affected_document_version_id), 0) else 0 end,
                    coalesce(max(v.version), 0))
      into v_floor
    from deficiency_submissions s join document_versions v on v.id = s.document_version_id where s.deficiency_id = v_def.id;
    if v_ver.version <= v_floor then
      perform app.fail('validation', 'Attach a new version: version ' || v_ver.version || ' was already on file for this memo. Earlier versions stay preserved.');
    end if;
    if coalesce(v_def.affected_version_basis,'') not in ('captured_at_raise','seed_fixture_verified')
       and v_ver.version <> (select current_version from documents where id = v_ver.document_id) then
      perform app.fail('validation', 'The version on file when this memo was raised could not be established, so attach the latest version of the document.');
    end if;
    v_sha := v_ver.sha256;
    if v_sha is not null then
      select min(x.version) into v_same from document_versions x
      where x.document_id = v_ver.document_id and x.version < v_ver.version and x.sha256 = v_sha;
      if v_same is not null then
        perform app.fail('validation', 'This file has identical content to version ' || v_same || ' of the same document, so it is not a correction. Upload the corrected file.');
      end if;
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
    jsonb_build_object('status', 'correction_submitted', 'attempt', v_attempt, 'document_version_id', p_document_version_id,
                       'fingerprint_recorded', v_sha is not null));

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
