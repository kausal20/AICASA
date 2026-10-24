-- Documents, pre-check persistence, deficiencies, EVC, compliance, notifications and deadline scanning.

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
-- The browser uploads to private storage under "<institution_id>/<random uuid>.<ext>", then registers
-- the object here. Size and MIME type are read from storage metadata, not from the client.
create or replace function public.register_document_version(
  p_institution_id uuid, p_application_id uuid, p_doc_type text, p_title text,
  p_storage_path text, p_file_name text, p_sha256 text default null, p_replaced_reason text default null
) returns public.document_versions
language plpgsql security definer set search_path = public, app, storage as $$
declare
  v_uid uuid := app.require_user();
  v_app applications;
  v_req document_requirements;
  v_doc documents;
  v_ver document_versions;
  v_obj record;
  v_size bigint;
  v_mime text;
  v_allowed text[] := array['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
  v_max bigint := 10485760;
begin
  if not app.is_representative_of(p_institution_id) then
    perform app.fail('forbidden', 'You are not an authorised representative of this institution.');
  end if;
  if p_storage_path !~ ('^' || p_institution_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]{1,5})?$') then
    perform app.fail('validation', 'Storage key is not in the expected institution folder format.');
  end if;
  if coalesce(p_doc_type, '') !~ '^[a-z][a-z0-9_]*$' then perform app.fail('validation', 'Invalid document type.'); end if;

  select o.name, (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_obj
  from storage.objects o where o.bucket_id = 'institution-documents' and o.name = p_storage_path;
  if v_obj.name is null then perform app.fail('upload_missing', 'The uploaded file was not found in private storage. Retry the upload.'); end if;
  v_size := v_obj.size; v_mime := v_obj.mimetype;

  if p_application_id is not null then
    select * into v_app from applications where id = p_application_id for update;
    if v_app.id is null or v_app.institution_id <> p_institution_id then
      perform app.fail('not_found', 'Application not found for this institution.');
    end if;
    if v_app.status not in ('draft', 'returned_for_correction') then
      perform app.fail('invalid_state', 'Documents can be added only to drafts or to cases returned for correction.');
    end if;
    select * into v_req from document_requirements
    where application_type_code = v_app.application_type_code and checklist_version = v_app.checklist_version and doc_type = p_doc_type;
    if v_req.id is not null then v_allowed := v_req.allowed_mime_types; v_max := v_req.max_bytes; end if;
  end if;

  if v_mime is null or not (v_mime = any (v_allowed)) then
    perform app.fail('file_type', 'File type ' || coalesce(v_mime, 'unknown') || ' is not accepted. Allowed: ' || array_to_string(v_allowed, ', ') || '.');
  end if;
  if v_size is null or v_size <= 0 or v_size > v_max then
    perform app.fail('file_size', 'File size must be between 1 byte and ' || (v_max / 1048576) || ' MB.');
  end if;

  if p_application_id is not null then
    select * into v_doc from documents where application_id = p_application_id and doc_type = p_doc_type for update;
  end if;
  if v_doc.id is null then
    insert into documents (institution_id, application_id, doc_type, title, created_by)
    values (p_institution_id, p_application_id, p_doc_type, coalesce(nullif(trim(p_title), ''), coalesce(v_req.name, p_doc_type)), v_uid)
    returning * into v_doc;
  elsif v_doc.current_version > 0 and length(trim(coalesce(p_replaced_reason, ''))) < 5 then
    perform app.fail('reason_required', 'Explain briefly why this document is being replaced.');
  end if;

  insert into document_versions (document_id, version, storage_path, file_name, mime_type, size_bytes, sha256,
                                 replaced_reason, uploaded_by, scan_status)
  values (v_doc.id, v_doc.current_version + 1, p_storage_path, left(p_file_name, 200), v_mime, v_size,
          nullif(lower(p_sha256), ''), nullif(trim(coalesce(p_replaced_reason, '')), ''), v_uid, 'scanner_unavailable')
  returning * into v_ver;
  update documents set current_version = v_ver.version, updated_at = now() where id = v_doc.id;

  if p_application_id is not null then
    insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
    values (p_application_id, case when v_ver.version = 1 then 'document_uploaded' else 'document_replaced' end,
            v_doc.title || ' — version ' || v_ver.version, v_uid, v_ver.replaced_reason,
            jsonb_build_object('document_id', v_doc.id, 'version_id', v_ver.id, 'doc_type', p_doc_type));
  end if;
  perform app.audit(case when v_ver.version = 1 then 'document_uploaded' else 'document_replaced' end, 'document', v_doc.id,
    p_application_id, p_institution_id, null, v_ver.replaced_reason, null,
    jsonb_build_object('version', v_ver.version, 'file_name', v_ver.file_name, 'size', v_size, 'mime', v_mime, 'sha256', v_ver.sha256));
  return v_ver;
end $$;

-- Pre-check runs. The Edge Function opens a run as the user (authorisation), then completes it with the
-- service role after extraction and deterministic checks.
create or replace function public.start_document_check(p_document_version_id uuid) returns public.document_check_runs
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_doc documents; v_app applications; v_run document_check_runs;
begin
  select d.* into v_doc from documents d join document_versions v on v.document_id = d.id where v.id = p_document_version_id;
  if v_doc.id is null or not app.is_representative_of(v_doc.institution_id) then
    perform app.fail('forbidden', 'Only the institution that owns this document can run a pre-check.');
  end if;
  if v_doc.application_id is not null then select * into v_app from applications where id = v_doc.application_id; end if;
  insert into document_check_runs (document_version_id, application_id, institution_id, engine, checklist_version, run_by)
  values (p_document_version_id, v_doc.application_id, v_doc.institution_id, 'pending', v_app.checklist_version, v_uid)
  returning * into v_run;
  return v_run;
end $$;

create or replace function public.complete_document_check(
  p_run_id uuid, p_engine text, p_status text, p_extraction_status text, p_extraction_method text,
  p_steps jsonb, p_limitations text[], p_summary jsonb, p_findings jsonb, p_error text default null
) returns public.document_check_runs
language plpgsql security definer set search_path = public, app as $$
declare v_run document_check_runs; v_f jsonb; v_i integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    perform app.fail('forbidden', 'Check results can only be recorded by the document-check service.');
  end if;
  select * into v_run from document_check_runs where id = p_run_id for update;
  if v_run.id is null or v_run.status <> 'running' then perform app.fail('invalid_state', 'Check run is not open.'); end if;
  update document_check_runs set engine = p_engine, status = p_status, extraction_status = p_extraction_status,
    extraction_method = p_extraction_method, steps = coalesce(p_steps, '[]'::jsonb), limitations = coalesce(p_limitations, '{}'),
    summary = coalesce(p_summary, '{}'::jsonb), error = p_error, completed_at = now()
  where id = p_run_id returning * into v_run;
  for v_f in select * from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) loop
    v_i := v_i + 1;
    insert into document_check_findings (run_id, check_code, check_name, outcome, severity, explanation, evidence,
                                         page_ref, suggestion, confidence, sort_order)
    values (p_run_id, v_f ->> 'check_code', v_f ->> 'check_name', (v_f ->> 'outcome')::app.finding_outcome,
            v_f ->> 'severity', v_f ->> 'explanation', v_f ->> 'evidence', v_f ->> 'page_ref', v_f ->> 'suggestion',
            (v_f ->> 'confidence')::numeric, v_i);
  end loop;
  perform app.audit('document_check_completed', 'document_check_run', v_run.id, v_run.application_id, v_run.institution_id,
    null, null, null, jsonb_build_object('status', p_status, 'extraction', p_extraction_status, 'findings', v_i));
  return v_run;
end $$;

-- ---------------------------------------------------------------------------
-- Deficiency → correction → review loop
-- ---------------------------------------------------------------------------
create or replace function app.require_case_officer(p_app public.applications) returns void
language plpgsql stable security definer set search_path = public, app as $$
declare v_cap text;
begin
  select responsible_capability into v_cap from workflow_stages
  where version_id = p_app.workflow_version_id and code = p_app.current_stage;
  if not app.has_role('officer') or not app.has_capability_in(coalesce(v_cap, 'scrutiny'), p_app.region_code) then
    perform app.fail('forbidden', 'Only an officer holding the "' || coalesce(v_cap, 'scrutiny') || '" responsibility for region '
      || p_app.region_code || ' can do this.');
  end if;
end $$;

create or replace function public.raise_deficiency(
  p_application_id uuid, p_title text, p_reason text, p_requirement_source text,
  p_requested_correction text, p_doc_type text, p_due_at timestamptz
) returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_app applications; v_def deficiencies; v_kind app.stage_kind;
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
  if p_due_at is null or p_due_at <= now() then perform app.fail('validation', 'The correction due date must be in the future.'); end if;

  insert into deficiencies (application_id, stage_code, title, reason, requirement_source, requested_correction, doc_type,
                            due_at, raised_by)
  values (v_app.id, v_app.current_stage, trim(p_title), trim(p_reason), trim(p_requirement_source), trim(p_requested_correction),
          nullif(p_doc_type, ''), p_due_at, v_uid)
  returning * into v_def;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'deficiency_raised', 'Deficiency recorded: ' || v_def.title, v_uid, v_def.reason,
          jsonb_build_object('deficiency_id', v_def.id, 'due_at', v_def.due_at));
  perform app.audit('deficiency_raised', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code, v_def.reason,
    null, jsonb_build_object('title', v_def.title, 'due_at', v_def.due_at));
  return v_def;
end $$;

create or replace function public.return_for_correction(p_application_id uuid, p_expected_version integer, p_reason text)
returns public.applications
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_app applications; v_due timestamptz; v_count integer;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null then perform app.fail('not_found', 'Application not found or you do not have access.'); end if;
  perform app.require_case_officer(v_app);
  if v_app.row_version <> p_expected_version then perform app.fail('stale', 'This case changed since you opened it. Refresh first.'); end if;
  if v_app.status in ('returned_for_correction', 'draft', 'completed', 'closed', 'withdrawn') then
    perform app.fail('invalid_state', 'The case cannot be returned in status ' || v_app.status || '.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  select count(*), min(due_at) into v_count, v_due from deficiencies
  where application_id = v_app.id and status in ('open', 'still_deficient', 'needs_clarification');
  if v_count = 0 then perform app.fail('prerequisite', 'Record at least one open deficiency before returning the case.'); end if;

  update applications set status = 'returned_for_correction', next_action = 'Institution to submit corrections for '
    || v_count || ' deficienc' || case when v_count = 1 then 'y' else 'ies' end,
    next_actor = 'institution', row_version = row_version + 1, updated_at = now()
  where id = v_app.id returning * into v_app;
  insert into application_events (application_id, event_type, summary, to_status, actor_id, reason, metadata)
  values (v_app.id, 'returned', 'Returned to institution for correction', 'returned_for_correction', v_uid, trim(p_reason),
          jsonb_build_object('open_deficiencies', v_count, 'earliest_due', v_due));
  perform app.audit('returned_for_correction', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
    trim(p_reason), null, jsonb_build_object('status', 'returned_for_correction', 'deficiencies', v_count));
  perform app.notify_institution(v_app.institution_id, 'deficiency', 'Correction required: ' || v_app.reference,
    v_count || ' deficienc' || case when v_count = 1 then 'y needs' else 'ies need' end || ' your response by '
    || to_char(v_due at time zone 'Asia/Kolkata', 'DD Mon YYYY') || '.',
    '/app/deficiencies', 'application', v_app.id, 'returned:' || v_app.id || ':' || v_app.row_version);
  return v_app;
end $$;

create or replace function public.submit_deficiency_correction(
  p_deficiency_id uuid, p_response_text text, p_document_version_id uuid default null
) returns public.deficiency_submissions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_sub deficiency_submissions;
  v_attempt integer; v_remaining integer;
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

  select coalesce(max(attempt), 0) + 1 into v_attempt from deficiency_submissions where deficiency_id = v_def.id;
  insert into deficiency_submissions (deficiency_id, attempt, response_text, document_version_id, submitted_by)
  values (v_def.id, v_attempt, trim(p_response_text), p_document_version_id, v_uid) returning * into v_sub;
  update deficiencies set status = 'correction_submitted', row_version = row_version + 1 where id = v_def.id;

  insert into application_events (application_id, event_type, summary, actor_id, metadata)
  values (v_app.id, 'correction_submitted', 'Correction submitted for: ' || v_def.title || ' (attempt ' || v_attempt || ')', v_uid,
          jsonb_build_object('deficiency_id', v_def.id, 'submission_id', v_sub.id, 'document_version_id', p_document_version_id));
  perform app.audit('correction_submitted', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, jsonb_build_object('status', v_def.status), jsonb_build_object('status', 'correction_submitted', 'attempt', v_attempt));

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

create or replace function public.review_deficiency_correction(p_deficiency_id uuid, p_outcome text, p_reason text)
returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_sub deficiency_submissions;
  v_kind app.stage_kind; v_open integer; v_pending integer;
begin
  select * into v_def from deficiencies where id = p_deficiency_id for update;
  if v_def.id is null then perform app.fail('not_found', 'Deficiency not found.'); end if;
  select * into v_app from applications where id = v_def.application_id for update;
  perform app.require_case_officer(v_app);
  if v_def.status <> 'correction_submitted' then perform app.fail('invalid_state', 'There is no submitted correction to review.'); end if;
  if p_outcome not in ('resolved', 'still_deficient', 'needs_clarification') then perform app.fail('validation', 'Choose a review outcome.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'Record the reason for this outcome (at least 10 characters).'); end if;

  select * into v_sub from deficiency_submissions where deficiency_id = v_def.id order by attempt desc limit 1;
  insert into deficiency_reviews (deficiency_id, submission_id, outcome, reason, reviewed_by)
  values (v_def.id, v_sub.id, p_outcome, trim(p_reason), v_uid);
  update deficiencies set status = p_outcome::app.deficiency_status,
    resolved_by = case when p_outcome = 'resolved' then v_uid end,
    resolved_at = case when p_outcome = 'resolved' then now() end,
    row_version = row_version + 1
  where id = v_def.id returning * into v_def;
  update tasks set status = 'done', completed_at = now(), completed_by = v_uid
  where deficiency_id = v_def.id and status = 'open';

  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'correction_reviewed', 'Correction review: ' || v_def.title || ' — ' || replace(p_outcome, '_', ' '), v_uid,
          trim(p_reason), jsonb_build_object('deficiency_id', v_def.id, 'outcome', p_outcome, 'attempt', v_sub.attempt));
  perform app.audit('correction_reviewed', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code,
    trim(p_reason), jsonb_build_object('status', 'correction_submitted'), jsonb_build_object('status', p_outcome));

  select count(*) filter (where status in ('open', 'still_deficient', 'needs_clarification')),
         count(*) filter (where status = 'correction_submitted')
    into v_open, v_pending
  from deficiencies where application_id = v_app.id;

  if p_outcome <> 'resolved' then
    perform app.notify_institution(v_app.institution_id, 'deficiency', 'Further correction required: ' || v_app.reference,
      '"' || v_def.title || '" was reviewed: ' || replace(p_outcome, '_', ' ') || '. ' || trim(p_reason),
      '/app/deficiencies', 'deficiency', v_def.id, 'review:' || v_def.id || ':' || v_sub.attempt);
  end if;

  if v_open > 0 and v_pending = 0 then
    update applications set status = 'returned_for_correction', next_actor = 'institution',
      next_action = 'Institution to submit corrections for ' || v_open || ' deficienc' || case when v_open = 1 then 'y' else 'ies' end,
      row_version = row_version + 1, updated_at = now()
    where id = v_app.id;
  elsif v_open = 0 and v_pending = 0 then
    select kind into v_kind from workflow_stages where version_id = v_app.workflow_version_id and code = v_app.current_stage;
    update applications set status = app.status_for_stage(v_kind),
      next_action = 'Corrections accepted — ' || coalesce(app.next_action_for_stage(v_kind, current_stage), 'continue processing'),
      next_actor = 'officer', row_version = row_version + 1, updated_at = now()
    where id = v_app.id;
    insert into application_events (application_id, event_type, summary, from_status, to_status, actor_id)
    values (v_app.id, 'corrections_resolved', 'All deficiencies resolved; case returns to ' || v_app.current_stage,
            v_app.status, app.status_for_stage(v_kind), v_uid);
    perform app.notify_institution(v_app.institution_id, 'deficiency', 'Corrections accepted: ' || v_app.reference,
      'All recorded deficiencies are resolved. Processing continues.', '/app/applications/' || v_app.id,
      'application', v_app.id, 'resolved:' || v_app.id || ':' || v_def.id);
    perform app.try_auto_advance(v_app.id);
  end if;
  return v_def;
end $$;

-- ---------------------------------------------------------------------------
-- EVC scheduling
-- ---------------------------------------------------------------------------
create or replace function app.evc_conflicts(p_evc_id uuid, p_start timestamptz, p_end timestamptz, p_people uuid[])
returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object(
           'evc_id', e.id, 'reference', a.reference, 'start', e.scheduled_start, 'end', e.scheduled_end)), '[]'::jsonb)
  from evc_records e
  join applications a on a.id = e.application_id
  left join evc_participants p on p.evc_id = e.id
  where e.id <> p_evc_id and e.status in ('proposed', 'scheduled')
    and tstzrange(e.scheduled_start, e.scheduled_end) && tstzrange(p_start, p_end)
    and (p.user_id = any (p_people) or e.coordinator_id = any (p_people))
$$;

create or replace function app.require_evc_officer(p_evc public.evc_records, p_app public.applications) returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not app.has_role('officer') or not app.has_capability_in('evc', p_app.region_code) then
    perform app.fail('forbidden', 'Only officers holding the EVC responsibility for region ' || p_app.region_code || ' can do this.');
  end if;
end $$;

create or replace function public.schedule_evc(
  p_evc_id uuid, p_start timestamptz, p_end timestamptz, p_participant_ids uuid[], p_confirm boolean,
  p_notes text, p_expected_version integer, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_people uuid[]; v_new app.evc_status;
  v_is_reschedule boolean; v_p uuid; v_conflicts jsonb;
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
    if not exists (select 1 from user_role_assignments r where r.user_id = v_p and r.is_active and r.role = 'officer'
                   and 'evc' = any (r.capabilities) and (r.region_code is null or r.region_code = v_app.region_code)) then
      perform app.fail('validation', 'Every participant must be an active officer with EVC responsibility for this region.');
    end if;
  end loop;

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

  insert into evc_history (evc_id, action, from_status, to_status, scheduled_start, scheduled_end, reason, actor_id)
  values (v_evc.id, case when v_is_reschedule then 'rescheduled' when p_confirm then 'confirmed' else 'proposed' end,
          (select to_status from evc_history where evc_id = v_evc.id order by created_at desc limit 1), v_new, p_start, p_end,
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
          v_uid, nullif(trim(coalesce(p_reason, '')), ''), jsonb_build_object('evc_id', v_evc.id, 'conflicts', v_conflicts));
  perform app.audit('evc_' || case when v_is_reschedule then 'rescheduled' when p_confirm then 'scheduled' else 'proposed' end,
    'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, nullif(trim(coalesce(p_reason, '')), ''), null,
    jsonb_build_object('start', p_start, 'end', p_end, 'participants', v_people));

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
  return jsonb_build_object('evc', to_jsonb(v_evc), 'conflicts', v_conflicts);
end $$;

create or replace function public.cancel_evc(p_evc_id uuid, p_reason text, p_expected_version integer)
returns public.evc_records
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_new evc_records;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id for update;
  perform app.require_evc_officer(v_evc, v_app);
  if v_evc.row_version <> p_expected_version then perform app.fail('stale', 'This EVC record changed. Refresh first.'); end if;
  if v_evc.status not in ('proposed', 'scheduled') then perform app.fail('invalid_state', 'Only proposed or scheduled EVCs can be cancelled.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A cancellation reason (at least 10 characters) is required.'); end if;

  update evc_records set status = 'cancelled', row_version = row_version + 1 where id = v_evc.id;
  insert into evc_history (evc_id, action, from_status, to_status, reason, actor_id)
  values (v_evc.id, 'cancelled', v_evc.status, 'cancelled', trim(p_reason), v_uid);
  update tasks set status = 'cancelled', completed_at = now() where evc_id = v_evc.id and status = 'open';

  -- the case still needs an EVC: open a fresh cycle in the queue
  insert into evc_records (application_id, stage_code, cycle, status, schedule_due_at, coordinator_id)
  values (v_evc.application_id, v_evc.stage_code, v_evc.cycle + 1, 'awaiting_scheduling', now() + interval '7 days', v_evc.coordinator_id)
  returning * into v_new;
  insert into evc_history (evc_id, action, to_status, actor_id, reason)
  values (v_new.id, 'queued', 'awaiting_scheduling', v_uid, 'Re-queued after cancellation of cycle ' || v_evc.cycle);
  insert into tasks (task_type, title, application_id, evc_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
  values ('evc_schedule', 'Schedule EVC — ' || v_app.reference, v_app.id, v_new.id, v_app.region_code, v_evc.coordinator_id, 'evc',
          v_new.schedule_due_at, 'evcschedule:' || v_new.id);
  update applications set status = 'evc_required', next_action = 'Re-schedule the expert visit (EVC)', row_version = row_version + 1,
    updated_at = now() where id = v_app.id;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'evc_cancelled', 'EVC cancelled and re-queued', v_uid, trim(p_reason), jsonb_build_object('evc_id', v_evc.id));
  perform app.audit('evc_cancelled', 'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, trim(p_reason));
  perform app.notify_institution(v_app.institution_id, 'evc', 'EVC cancelled: ' || v_app.reference,
    'The scheduled expert visit was cancelled and will be rescheduled. Reason: ' || trim(p_reason),
    '/app/applications/' || v_app.id, 'evc', v_evc.id, 'evccancel:' || v_evc.id);
  return v_new;
end $$;

create or replace function public.complete_evc(p_evc_id uuid, p_outcome text, p_summary text, p_expected_version integer)
returns public.evc_records
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_evc evc_records; v_app applications;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id for update;
  perform app.require_evc_officer(v_evc, v_app);
  if not exists (select 1 from evc_participants where evc_id = v_evc.id and user_id = v_uid) then
    perform app.fail('forbidden', 'Only a member of this EVC panel can record its outcome.');
  end if;
  if v_evc.row_version <> p_expected_version then perform app.fail('stale', 'This EVC record changed. Refresh first.'); end if;
  if v_evc.status <> 'scheduled' then perform app.fail('invalid_state', 'Only a confirmed (scheduled) EVC can be completed.'); end if;
  if v_evc.scheduled_start > now() then perform app.fail('invalid_state', 'The EVC has not started yet; it cannot be marked complete.'); end if;
  if p_outcome not in ('satisfactory', 'deficiencies_noted') then
    perform app.fail('validation', 'Choose the authorised outcome. If the EVC did not take place, cancel and reschedule it.');
  end if;
  if length(trim(coalesce(p_summary, ''))) < 20 then
    perform app.fail('validation', 'A completion summary of at least 20 characters is required.');
  end if;

  update evc_records set status = 'completed', outcome = p_outcome, completion_summary = trim(p_summary),
    completed_by = v_uid, completed_at = now(), row_version = row_version + 1
  where id = v_evc.id returning * into v_evc;
  insert into evc_history (evc_id, action, from_status, to_status, reason, actor_id)
  values (v_evc.id, 'completed', 'scheduled', 'completed', p_outcome, v_uid);
  update tasks set status = 'done', completed_at = now(), completed_by = v_uid where evc_id = v_evc.id and status = 'open';
  update applications set status = 'evc_completed',
    next_action = case when p_outcome = 'satisfactory' then 'Route to next configured stage'
                       else 'Officer to record deficiencies noted during the EVC' end,
    next_actor = 'officer', row_version = row_version + 1, updated_at = now()
  where id = v_app.id;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'evc_completed', 'EVC completed — ' || replace(p_outcome, '_', ' '), v_uid, null,
          jsonb_build_object('evc_id', v_evc.id, 'outcome', p_outcome));
  perform app.audit('evc_completed', 'evc', v_evc.id, v_app.id, v_app.institution_id, v_app.region_code, null,
    jsonb_build_object('status', 'scheduled'), jsonb_build_object('status', 'completed', 'outcome', p_outcome));
  perform app.try_auto_advance(v_app.id);
  return v_evc;
end $$;

-- ---------------------------------------------------------------------------
-- Compliance obligations and document validity
-- ---------------------------------------------------------------------------
create or replace function app.add_interval(p_ts timestamptz, p_iso text) returns timestamptz
language sql immutable as $$
  select p_ts + case p_iso when 'P1M' then interval '1 month' when 'P3M' then interval '3 months'
                           when 'P6M' then interval '6 months' when 'P1Y' then interval '1 year' end
$$;

create or replace function app.end_of_day(p_date date) returns timestamptz
language sql stable security definer set search_path = public, app as $$
  select ((p_date + 1)::timestamp at time zone coalesce(
            (select value #>> '{}' from system_settings where key = 'display_timezone'), 'Asia/Kolkata')) - interval '1 second'
$$;

create or replace function public.create_obligation(
  p_institution_id uuid, p_application_id uuid, p_type text, p_title text, p_description text, p_source_reference text,
  p_evidence_required text, p_responsible_contact text, p_due_date date, p_recurrence text default null
) returns public.compliance_obligations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_inst institutions; v_obl compliance_obligations;
begin
  select * into v_inst from institutions where id = p_institution_id;
  if v_inst.id is null or not app.has_capability_in('compliance', v_inst.region_code) then
    perform app.fail('forbidden', 'You do not hold the compliance responsibility for this institution''s region.');
  end if;
  if p_application_id is not null and not exists (select 1 from applications where id = p_application_id and institution_id = p_institution_id) then
    perform app.fail('validation', 'The linked application belongs to a different institution.');
  end if;
  if length(trim(coalesce(p_title, ''))) < 5 or length(trim(coalesce(p_description, ''))) < 10
     or length(trim(coalesce(p_source_reference, ''))) < 3 or length(trim(coalesce(p_evidence_required, ''))) < 5 then
    perform app.fail('validation', 'Title, conditions, source reference and required evidence are all required.');
  end if;
  if p_due_date is null or p_due_date < current_date then perform app.fail('validation', 'Due date cannot be in the past.'); end if;

  insert into compliance_obligations (institution_id, region_code, application_id, obligation_type, title, description,
    source_reference, evidence_required, responsible_contact, due_at, recurrence, created_by)
  values (v_inst.id, v_inst.region_code, p_application_id, p_type, trim(p_title), trim(p_description), trim(p_source_reference),
          trim(p_evidence_required), nullif(trim(coalesce(p_responsible_contact, '')), ''), app.end_of_day(p_due_date),
          nullif(p_recurrence, ''), v_uid)
  returning * into v_obl;
  perform app.audit('obligation_created', 'obligation', v_obl.id, p_application_id, v_inst.id, v_inst.region_code, null, null,
    jsonb_build_object('title', v_obl.title, 'due_at', v_obl.due_at, 'type', p_type));
  perform app.notify_institution(v_inst.id, 'compliance', 'New compliance requirement', v_obl.title || ' — due ' ||
    to_char(p_due_date, 'DD Mon YYYY') || '.', '/app/compliance', 'obligation', v_obl.id, 'obligation:' || v_obl.id);
  return v_obl;
end $$;

create or replace function public.submit_compliance_evidence(
  p_obligation_id uuid, p_document_version_id uuid, p_comment text, p_renewal_expiry_date date, p_expected_version integer
) returns public.compliance_submissions
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_obl compliance_obligations; v_sub compliance_submissions; v_attempt integer;
        v_validity document_validities;
begin
  select * into v_obl from compliance_obligations where id = p_obligation_id for update;
  if v_obl.id is null or not app.is_representative_of(v_obl.institution_id) then
    perform app.fail('forbidden', 'Only an authorised representative of the institution can submit evidence.');
  end if;
  if v_obl.row_version <> p_expected_version then perform app.fail('stale', 'This obligation changed. Refresh first.'); end if;
  if v_obl.status not in ('awaiting_submission', 'correction_required') then
    perform app.fail('invalid_state', 'Evidence is not being requested for this obligation right now.');
  end if;
  if p_document_version_id is null or not exists (
      select 1 from document_versions v join documents d on d.id = v.document_id
      where v.id = p_document_version_id and d.institution_id = v_obl.institution_id) then
    perform app.fail('validation', 'Attach an evidence document uploaded by this institution.');
  end if;
  if v_obl.validity_id is not null then
    select * into v_validity from document_validities where id = v_obl.validity_id;
    if p_renewal_expiry_date is null or p_renewal_expiry_date <= v_validity.expiry_date then
      perform app.fail('validation', 'Enter the expiry date stated on the renewed document; it must be after ' ||
        to_char(v_validity.expiry_date, 'DD Mon YYYY') || '.');
    end if;
  end if;

  select coalesce(max(attempt), 0) + 1 into v_attempt from compliance_submissions where obligation_id = v_obl.id;
  insert into compliance_submissions (obligation_id, attempt, comment, document_version_id, renewal_expiry_date, submitted_by)
  values (v_obl.id, v_attempt, coalesce(trim(p_comment), ''), p_document_version_id, p_renewal_expiry_date, v_uid)
  returning * into v_sub;
  update compliance_obligations set status = 'submitted', row_version = row_version + 1, updated_at = now() where id = v_obl.id;
  if v_obl.validity_id is not null then
    update document_validities set renewal_state = 'renewal_submitted' where id = v_obl.validity_id;
  end if;
  insert into tasks (task_type, title, obligation_id, application_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
  values ('compliance_verification', 'Verify evidence — ' || v_obl.title, v_obl.id, v_obl.application_id, v_obl.region_code,
          v_obl.verifying_officer_id, 'compliance', now() + interval '10 days', 'complverify:' || v_obl.id || ':' || v_attempt)
  on conflict (dedupe_key) do nothing;
  perform app.audit('compliance_evidence_submitted', 'obligation', v_obl.id, v_obl.application_id, v_obl.institution_id,
    v_obl.region_code, null, jsonb_build_object('status', v_obl.status), jsonb_build_object('status', 'submitted', 'attempt', v_attempt));
  perform app.notify(r, 'compliance', 'Evidence submitted', v_obl.title || ' — awaiting verification.', '/app/compliance',
    'obligation', v_obl.id, 'complsub:' || v_obl.id || ':' || v_attempt)
  from app.capability_recipients(v_obl.region_code, 'compliance') r;
  return v_sub;
end $$;

create or replace function public.verify_compliance(p_obligation_id uuid, p_outcome text, p_reason text, p_expected_version integer)
returns public.compliance_obligations
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_obl compliance_obligations; v_sub compliance_submissions;
  v_old document_validities; v_new_validity uuid; v_next uuid;
begin
  select * into v_obl from compliance_obligations where id = p_obligation_id for update;
  if v_obl.id is null or not app.has_role('officer') or not app.has_capability_in('compliance', v_obl.region_code) then
    perform app.fail('forbidden', 'Only officers holding the compliance responsibility for this region can verify evidence.');
  end if;
  if v_obl.row_version <> p_expected_version then perform app.fail('stale', 'This obligation changed. Refresh first.'); end if;
  if v_obl.status not in ('submitted', 'under_verification') then perform app.fail('invalid_state', 'There is no submitted evidence to verify.'); end if;
  if p_outcome not in ('verified', 'correction_required', 'more_information') then perform app.fail('validation', 'Choose a verification outcome.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'Record the basis of this outcome (at least 10 characters).'); end if;

  select * into v_sub from compliance_submissions where obligation_id = v_obl.id order by attempt desc limit 1;
  insert into compliance_verifications (obligation_id, submission_id, outcome, reason, verified_by)
  values (v_obl.id, v_sub.id, p_outcome, trim(p_reason), v_uid);
  update compliance_obligations set
    status = case when p_outcome = 'verified' then 'verified'::app.obligation_status else 'correction_required' end,
    verifying_officer_id = v_uid, row_version = row_version + 1, updated_at = now()
  where id = v_obl.id;
  update tasks set status = 'done', completed_at = now(), completed_by = v_uid where obligation_id = v_obl.id and status = 'open';

  if p_outcome = 'verified' and v_obl.validity_id is not null then
    select * into v_old from document_validities where id = v_obl.validity_id for update;
    insert into document_validities (institution_id, document_id, document_version_id, doc_type, title, issue_date, expiry_date,
                                     source_reference, recorded_by)
    select v_old.institution_id, v.document_id, v.id, v_old.doc_type, v_old.title, current_date, v_sub.renewal_expiry_date,
           'Renewal verified under obligation ' || v_obl.id, v_uid
    from document_versions v where v.id = v_sub.document_version_id
    returning id into v_new_validity;
    update document_validities set renewal_state = 'renewed', superseded_by = v_new_validity where id = v_old.id;
  elsif p_outcome <> 'verified' and v_obl.validity_id is not null then
    update document_validities set renewal_state = 'renewal_requested' where id = v_obl.validity_id;
  end if;

  if p_outcome = 'verified' and v_obl.recurrence is not null then
    insert into compliance_obligations (institution_id, region_code, application_id, parent_obligation_id, obligation_type, title,
      description, source_reference, evidence_required, responsible_contact, due_at, recurrence, created_by)
    values (v_obl.institution_id, v_obl.region_code, v_obl.application_id, v_obl.id, v_obl.obligation_type, v_obl.title,
      v_obl.description, v_obl.source_reference, v_obl.evidence_required, v_obl.responsible_contact,
      app.add_interval(v_obl.due_at, v_obl.recurrence), v_obl.recurrence, v_uid)
    on conflict do nothing returning id into v_next;
  end if;

  perform app.audit('compliance_' || p_outcome, 'obligation', v_obl.id, v_obl.application_id, v_obl.institution_id,
    v_obl.region_code, trim(p_reason), jsonb_build_object('status', v_obl.status),
    jsonb_build_object('outcome', p_outcome, 'next_obligation', v_next, 'new_validity', v_new_validity));
  perform app.notify_institution(v_obl.institution_id, 'compliance',
    case when p_outcome = 'verified' then 'Evidence verified' else 'Evidence needs correction' end,
    v_obl.title || ': ' || replace(p_outcome, '_', ' ') || '. ' || trim(p_reason), '/app/compliance', 'obligation', v_obl.id,
    'complver:' || v_obl.id || ':' || v_sub.attempt);
  select * into v_obl from compliance_obligations where id = p_obligation_id;
  return v_obl;
end $$;

create or replace function public.close_obligation(p_obligation_id uuid, p_reason text) returns public.compliance_obligations
language plpgsql security definer set search_path = public, app as $$
declare v_obl compliance_obligations;
begin
  perform app.require_user();
  select * into v_obl from compliance_obligations where id = p_obligation_id for update;
  if v_obl.id is null or not app.has_role('admin') or not app.has_capability_in('compliance', v_obl.region_code) then
    perform app.fail('forbidden', 'Only administrators with compliance responsibility can close obligations.');
  end if;
  if v_obl.status = 'closed' then perform app.fail('invalid_state', 'Already closed.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A closing reason (at least 10 characters) is required.'); end if;
  update compliance_obligations set status = 'closed', closed_reason = trim(p_reason), row_version = row_version + 1, updated_at = now()
  where id = v_obl.id returning * into v_obl;
  update tasks set status = 'cancelled', completed_at = now() where obligation_id = v_obl.id and status = 'open';
  perform app.audit('obligation_closed', 'obligation', v_obl.id, v_obl.application_id, v_obl.institution_id, v_obl.region_code, trim(p_reason));
  return v_obl;
end $$;

create or replace function public.record_document_validity(
  p_institution_id uuid, p_document_version_id uuid, p_doc_type text, p_title text, p_issue_date date, p_expiry_date date,
  p_source_reference text
) returns public.document_validities
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_inst institutions; v_doc_id uuid; v_val document_validities;
begin
  select * into v_inst from institutions where id = p_institution_id;
  if v_inst.id is null or not (app.is_representative_of(p_institution_id) or app.has_capability_in('compliance', v_inst.region_code)) then
    perform app.fail('forbidden', 'You cannot record document validity for this institution.');
  end if;
  if p_document_version_id is not null then
    select d.id into v_doc_id from document_versions v join documents d on d.id = v.document_id
    where v.id = p_document_version_id and d.institution_id = p_institution_id;
    if v_doc_id is null then perform app.fail('validation', 'The document does not belong to this institution.'); end if;
  end if;
  if p_expiry_date is null or (p_issue_date is not null and p_issue_date >= p_expiry_date) then
    perform app.fail('validation', 'Expiry date is required and must be after the issue date.');
  end if;
  if length(trim(coalesce(p_title, ''))) < 3 then perform app.fail('validation', 'Title is required.'); end if;
  insert into document_validities (institution_id, document_id, document_version_id, doc_type, title, issue_date, expiry_date,
                                   source_reference, recorded_by)
  values (p_institution_id, v_doc_id, p_document_version_id, p_doc_type, trim(p_title), p_issue_date, p_expiry_date,
          coalesce(nullif(trim(coalesce(p_source_reference, '')), ''), 'Recorded by user'), v_uid)
  returning * into v_val;
  perform app.audit('document_validity_recorded', 'document_validity', v_val.id, null, p_institution_id, v_inst.region_code, null,
    null, jsonb_build_object('doc_type', p_doc_type, 'expiry_date', p_expiry_date));
  return v_val;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications API
-- ---------------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_n integer;
begin
  update notifications set read_at = now()
  where recipient_id = v_uid and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.set_notification_preference(p_kind text, p_in_app boolean, p_email boolean)
returns public.notification_preferences
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_p notification_preferences;
begin
  if p_kind not in ('stage_changed', 'assignment', 'submitted', 'deficiency', 'correction_received', 'evc', 'compliance',
                    'reminder', 'escalation', 'decision') then
    perform app.fail('validation', 'Unknown notification type.');
  end if;
  insert into notification_preferences (user_id, kind, in_app, email) values (v_uid, p_kind, p_in_app, p_email)
  on conflict (user_id, kind) do update set in_app = excluded.in_app, email = excluded.email
  returning * into v_p;
  return v_p;
end $$;

-- ---------------------------------------------------------------------------
-- Escalation handling
-- ---------------------------------------------------------------------------
create or replace function public.update_escalation_event(p_event_id uuid, p_action text, p_note text)
returns public.escalation_events
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_e escalation_events;
begin
  select * into v_e from escalation_events where id = p_event_id for update;
  if v_e.id is null or not app.is_staff() or not app.can_read_region(v_e.region_code) then
    perform app.fail('forbidden', 'You cannot act on this escalation.');
  end if;
  if p_action = 'acknowledge' and v_e.status = 'open' then
    update escalation_events set status = 'acknowledged', acknowledged_by = v_uid, acknowledged_at = now(),
      resolution_note = nullif(trim(coalesce(p_note, '')), '') where id = v_e.id returning * into v_e;
  elsif p_action = 'resolve' and v_e.status in ('open', 'acknowledged') then
    if length(trim(coalesce(p_note, ''))) < 10 then perform app.fail('reason_required', 'Describe how this was resolved (at least 10 characters).'); end if;
    update escalation_events set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution_note = trim(p_note)
    where id = v_e.id returning * into v_e;
  else
    perform app.fail('invalid_state', 'This action is not available for an escalation in status ' || v_e.status || '.');
  end if;
  perform app.audit('escalation_' || p_action, 'escalation', v_e.id, v_e.application_id, v_e.institution_id, v_e.region_code,
    nullif(trim(coalesce(p_note, '')), ''));
  return v_e;
end $$;

-- ---------------------------------------------------------------------------
-- Deadline scanner (idempotent). Runs from pg_cron in Supabase; administrators may trigger it manually.
-- ---------------------------------------------------------------------------
create or replace function app.rule_recipients(
  p_rule public.escalation_rules, p_institution_id uuid, p_region text, p_assigned uuid
) returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select app.institution_recipients(p_institution_id) where p_rule.recipient = 'institution'
  union select p_assigned where p_rule.recipient = 'assigned_officer' and p_assigned is not null
  union select app.capability_recipients(p_region, p_rule.recipient_capability) where p_rule.recipient = 'capability_officers'
  union select app.admin_recipients(p_region, false) where p_rule.recipient = 'regional_admin'
  union select app.admin_recipients(p_region, true) where p_rule.recipient = 'national_admin'
$$;

create or replace function app.run_deadline_scan(p_trigger text default 'scheduler', p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_run uuid;
  v_rule escalation_rules;
  v_item record;
  v_trigger_at timestamptz;
  v_repeat integer;
  v_key text;
  v_event uuid;
  v_recipient uuid;
  v_notified integer := 0;
  v_escalated integer := 0;
  v_evaluated integer := 0;
  v_renewals integer := 0;
  v_obl uuid;
begin
  insert into scheduled_job_runs (job_name, trigger_source, triggered_by)
  values ('deadline_scan', p_trigger, auth.uid()) returning id into v_run;

  begin
    for v_rule in select * from escalation_rules where is_active and effective_from <= p_now order by code loop
      for v_item in
        select * from (
          select 'application_stage'::text as et, a.id as entity_id, a.id as application_id, a.institution_id, a.region_code,
                 a.assigned_officer_id as assigned, a.stage_due_at as due_at,
                 a.reference || ' at stage ' || a.current_stage as label, '/app/applications/' || a.id as link
          from applications a
          where a.stage_due_at is not null
            and a.status not in ('draft', 'completed', 'closed', 'withdrawn', 'returned_for_correction', 'correction_submitted')
          union all
          select 'deficiency', d.id, d.application_id, a.institution_id, a.region_code, a.assigned_officer_id, d.due_at,
                 a.reference || ' deficiency: ' || d.title, '/app/deficiencies'
          from deficiencies d join applications a on a.id = d.application_id
          where d.status in ('open', 'still_deficient', 'needs_clarification')
          union all
          select 'evc_schedule', e.id, e.application_id, a.institution_id, a.region_code, e.coordinator_id,
                 case when e.status = 'scheduled' then e.scheduled_start else e.schedule_due_at end,
                 a.reference || case when e.status = 'scheduled' then ' EVC session' else ' EVC scheduling' end, '/app/evc'
          from evc_records e join applications a on a.id = e.application_id
          where e.status in ('awaiting_scheduling', 'proposed', 'scheduled')
            and (e.status <> 'scheduled' or e.scheduled_start is not null)
          union all
          select 'obligation', o.id, o.application_id, o.institution_id, o.region_code, o.verifying_officer_id, o.due_at,
                 'Obligation: ' || o.title, '/app/compliance'
          from compliance_obligations o where o.status in ('awaiting_submission', 'correction_required')
          union all
          select 'document_validity', v.id, null, v.institution_id, i.region_code, null, app.end_of_day(v.expiry_date),
                 'Document validity: ' || v.title, '/app/expiry'
          from document_validities v join institutions i on i.id = v.institution_id
          where v.superseded_by is null and v.renewal_state in ('current', 'renewal_requested')
        ) items
        where items.et = v_rule.entity_type and items.due_at is not null
      loop
        v_evaluated := v_evaluated + 1;
        v_trigger_at := v_item.due_at + make_interval(hours => v_rule.offset_hours);
        continue when p_now < v_trigger_at;
        v_repeat := 1;
        if v_rule.repeat_interval_hours is not null then
          v_repeat := least(v_rule.max_repeats,
                            1 + floor(extract(epoch from (p_now - v_trigger_at)) / (v_rule.repeat_interval_hours * 3600))::integer);
        end if;
        v_key := v_rule.code || ':' || v_item.entity_id || ':' || extract(epoch from v_item.due_at)::bigint || ':' || v_repeat;

        if v_rule.entity_type = 'document_validity' and v_rule.rule_kind = 'reminder' then
          v_obl := null;
          insert into compliance_obligations (institution_id, region_code, validity_id, obligation_type, title, description,
            source_reference, evidence_required, due_at)
          select v.institution_id, v_item.region_code, v.id, 'document_renewal', 'Renew: ' || v.title,
                 'The recorded validity of "' || v.title || '" ends on ' || to_char(v.expiry_date, 'DD Mon YYYY')
                 || '. Submit the renewed document for verification.',
                 'Alert rule ' || v_rule.code || ' v' || v_rule.version || ' (demo configuration)',
                 'Renewed ' || replace(v.doc_type, '_', ' ') || ' showing the new validity period', v_item.due_at
          from document_validities v where v.id = v_item.entity_id
          on conflict do nothing returning id into v_obl;
          if v_obl is not null then
            v_renewals := v_renewals + 1;
            update document_validities set renewal_state = 'renewal_requested' where id = v_item.entity_id and renewal_state = 'current';
          end if;
        end if;

        if v_rule.rule_kind = 'escalation' then
          v_event := null;
          insert into escalation_events (rule_id, entity_type, entity_id, application_id, institution_id, region_code,
                                         repeat_no, due_at, summary, idempotency_key)
          values (v_rule.id, v_rule.entity_type, v_item.entity_id, v_item.application_id, v_item.institution_id,
                  v_item.region_code, v_repeat, v_item.due_at, 'Overdue: ' || v_item.label, v_key)
          on conflict (idempotency_key) do nothing returning id into v_event;
          continue when v_event is null;
          v_escalated := v_escalated + 1;
          perform app.audit('escalation_triggered', 'escalation', v_event, v_item.application_id, v_item.institution_id,
            v_item.region_code, null, null,
            jsonb_build_object('rule', v_rule.code, 'rule_version', v_rule.version, 'entity_type', v_rule.entity_type,
                               'entity_id', v_item.entity_id, 'repeat', v_repeat));
          if v_item.application_id is not null then
            insert into application_events (application_id, event_type, summary, actor_kind, visibility, metadata)
            values (v_item.application_id, 'escalated', 'Escalated under rule ' || v_rule.code || ': ' || v_item.label, 'system',
                    'internal', jsonb_build_object('escalation_id', v_event, 'repeat', v_repeat));
          end if;
          insert into tasks (task_type, title, application_id, region_code, required_capability, due_at, dedupe_key)
          values ('escalation_followup', 'Follow up escalation — ' || v_item.label, v_item.application_id,
                  coalesce(v_item.region_code, 'WR'), 'escalation', p_now + interval '3 days', 'esc:' || v_key)
          on conflict (dedupe_key) do nothing;
        end if;

        for v_recipient in select * from app.rule_recipients(v_rule, v_item.institution_id, v_item.region_code, v_item.assigned) loop
          if app.notify(v_recipient, v_rule.rule_kind,
               case when v_rule.rule_kind = 'escalation' then 'Escalation: ' else 'Reminder: ' end || v_item.label,
               case when p_now >= v_item.due_at then 'Overdue since ' else 'Due ' end ||
               to_char(v_item.due_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST.',
               v_item.link, v_rule.entity_type, v_item.entity_id, v_key,
               v_rule.channel = 'in_app_and_email') then
            v_notified := v_notified + 1;
          end if;
        end loop;
      end loop;
    end loop;

    update scheduled_job_runs set status = 'succeeded', finished_at = clock_timestamp(),
      stats = jsonb_build_object('evaluated', v_evaluated, 'notifications', v_notified, 'escalations', v_escalated,
                                 'renewal_obligations', v_renewals)
    where id = v_run;
  exception when others then
    update scheduled_job_runs set status = 'failed', finished_at = clock_timestamp(), error = sqlerrm where id = v_run;
  end;
  return (select to_jsonb(r) from scheduled_job_runs r where r.id = v_run);
end $$;

create or replace function public.run_deadline_scan_now() returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_user();
  if not app.has_role('admin') or not app.has_capability('escalation') then
    perform app.fail('forbidden', 'Only administrators with escalation responsibility can run the deadline scan manually.');
  end if;
  perform app.audit('deadline_scan_triggered', 'scheduled_job', null);
  return app.run_deadline_scan('manual');
end $$;
