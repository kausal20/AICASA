-- Query & Clarification window.
--  * An officer-raised query opens a response window (default 48 hours, from system_settings 'deficiency.query_window').
--  * After the window closes the institution can no longer upload for that query or submit a clarification; the deadline scanner raises
--    the DEFICIENCY_WINDOW_EXPIRED escalation. An officer can reopen the window once (a fresh window), recorded in the audit log.
--  * The document pre-check stores the extracted text so two versions can be compared line by line.
-- The window length is configuration (the project's 48-hour requirement), not a statutory period.

alter table public.deficiencies add column if not exists window_opens_at timestamptz;
alter table public.deficiencies add column if not exists window_closes_at timestamptz;
alter table public.deficiencies add column if not exists window_reopen_count integer not null default 0;
alter table public.document_check_runs add column if not exists extracted_text text;

alter table public.escalation_rules drop constraint if exists escalation_rules_entity_type_check;
alter table public.escalation_rules add constraint escalation_rules_entity_type_check
  check (entity_type in ('application_stage', 'deficiency', 'deficiency_window', 'evc_schedule', 'obligation', 'document_validity'));

insert into public.escalation_rules (code, version, rule_kind, entity_type, offset_hours, recipient, recipient_capability, channel,
                                     max_repeats, repeat_interval_hours, source_reference, change_summary)
values ('DEFICIENCY_WINDOW_EXPIRED', 1, 'escalation', 'deficiency_window', 0, 'assigned_officer', null, 'in_app', 2, 24,
        'Project requirement: 48-hour query window (configured, not a statutory period)', 'Fires when the response window of a query closes without a clarification')
on conflict do nothing;

insert into public.system_settings (key, value, description) values
  ('deficiency.query_window', '{"hours": 48, "max_reopens": 1, "source_reference": "Project requirement: 48-hour query window (configured, not a statutory period)"}',
   'Response window opened when an officer raises a query. After it closes the institution cannot respond until an officer reopens it (limited number of times).')
on conflict (key) do nothing;

drop function if exists public.complete_document_check(uuid, text, text, text, text, jsonb, text[], jsonb, jsonb, text);
create or replace function public.complete_document_check(
  p_run_id uuid, p_engine text, p_status text, p_extraction_status text, p_extraction_method text,
  p_steps jsonb, p_limitations text[], p_summary jsonb, p_findings jsonb, p_error text default null,
  p_extracted_text text default null
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
    summary = coalesce(p_summary, '{}'::jsonb), error = p_error, completed_at = now(),
    extracted_text = left(nullif(p_extracted_text, ''), 100000)
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

revoke execute on function public.complete_document_check(uuid, text, text, text, text, jsonb, text[], jsonb, jsonb, text, text) from public, anon;
grant execute on function public.complete_document_check(uuid, text, text, text, text, jsonb, text[], jsonb, jsonb, text, text) to authenticated, service_role;
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
    if exists (select 1 from deficiencies q where q.application_id = p_application_id and q.doc_type = p_doc_type
               and q.status in ('open', 'still_deficient', 'needs_clarification')
               and q.window_closes_at is not null and q.window_closes_at <= now()) then
      perform app.fail('window_expired', 'The response window for the query on this document has closed. Ask the officer to reopen it.');
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

create or replace function public.raise_deficiency(
  p_application_id uuid, p_title text, p_reason text, p_requirement_source text,
  p_requested_correction text, p_doc_type text, p_due_at timestamptz
) returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_app applications; v_def deficiencies; v_kind app.stage_kind;
  v_due timestamptz := p_due_at; v_days numeric; v_due_source text := 'officer';
  v_hours numeric; v_open timestamptz;
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
  if nullif(p_doc_type, '') is not null and not exists (
      select 1 from document_requirements r where r.application_type_code = v_app.application_type_code
        and r.checklist_version = v_app.checklist_version and r.doc_type = p_doc_type) then
    perform app.fail('validation', 'The related document type is not on this application''s checklist.');
  end if;
  v_hours := app.try_numeric((select value #>> '{hours}' from system_settings where key = 'deficiency.query_window'));
  if v_hours is not null and v_hours > 0 then
    -- the response window is authoritative: it opens now and the correction deadline is its close time
    v_open := now(); v_due := v_open + make_interval(secs => (v_hours * 3600)::double precision); v_due_source := 'query_window';
  end if;
  if v_due is null then
    v_days := app.try_numeric((select value #>> '{days}' from system_settings where key = 'deficiency.correction_period'));
    if v_days is null or v_days < 1 then
      perform app.fail('validation', 'Set a correction due date: no default correction period is configured.');
    end if;
    v_due := app.end_of_day(((now() at time zone coalesce((select value #>> '{}' from system_settings where key = 'display_timezone'), 'Asia/Kolkata'))::date) + v_days::integer);
    v_due_source := 'configured_default';
  end if;
  if v_due <= now() then perform app.fail('validation', 'The correction due date must be in the future.'); end if;

  insert into deficiencies (application_id, stage_code, title, reason, requirement_source, requested_correction, doc_type,
                            due_at, raised_by, window_opens_at, window_closes_at)
  values (v_app.id, v_app.current_stage, trim(p_title), trim(p_reason), trim(p_requirement_source), trim(p_requested_correction),
          nullif(p_doc_type, ''), v_due, v_uid, v_open, case when v_open is not null then v_due end)
  returning * into v_def;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'deficiency_raised', 'Deficiency recorded: ' || v_def.title, v_uid, v_def.reason,
          jsonb_build_object('deficiency_id', v_def.id, 'due_at', v_def.due_at, 'due_source', v_due_source,
                             'window_opens_at', v_def.window_opens_at, 'window_closes_at', v_def.window_closes_at,
                             'affected_document_version_id', v_def.affected_document_version_id));
  perform app.audit('deficiency_raised', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code, v_def.reason,
    null, jsonb_build_object('title', v_def.title, 'due_at', v_def.due_at, 'due_source', v_due_source,
                             'window_opens_at', v_def.window_opens_at, 'window_closes_at', v_def.window_closes_at,
                             'affected_document_version_id', v_def.affected_document_version_id));
  return v_def;
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
    select greatest(case when v_def.affected_version_basis = 'captured_at_raise'
                         then coalesce((select version from document_versions where id = v_def.affected_document_version_id), 0) else 0 end,
                    coalesce(max(v.version), 0))
      into v_floor
    from deficiency_submissions s join document_versions v on v.id = s.document_version_id where s.deficiency_id = v_def.id;
    if v_ver.version <= v_floor then
      perform app.fail('validation', 'Attach a new version: version ' || v_ver.version || ' was already on file for this memo. Earlier versions stay preserved.');
    end if;
    if v_def.affected_version_basis is distinct from 'captured_at_raise'
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
    window_closes_at = case when p_outcome <> 'resolved' and window_opens_at is not null then now() + (window_closes_at - window_opens_at) else window_closes_at end,
    due_at = case when p_outcome <> 'resolved' and window_opens_at is not null then now() + (window_closes_at - window_opens_at) else due_at end,
    window_opens_at = case when p_outcome <> 'resolved' and window_opens_at is not null then now() else window_opens_at end,
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

create or replace function public.change_deficiency_deadline(p_deficiency_id uuid, p_new_due timestamptz, p_reason text, p_expected_version integer)
returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_old timestamptz;
begin
  select * into v_def from deficiencies where id = p_deficiency_id for update;
  if v_def.id is null then perform app.fail('not_found', 'Deficiency not found.'); end if;
  select * into v_app from applications where id = v_def.application_id for update;
  perform app.require_case_officer(v_app);
  if v_def.row_version <> p_expected_version then perform app.fail('stale', 'This deficiency changed since you opened it. Refresh first.'); end if;
  if v_def.status not in ('open', 'still_deficient', 'needs_clarification') then
    perform app.fail('invalid_state', 'The deadline can be changed only while the institution still has to respond.');
  end if;
  if p_new_due is null or p_new_due <= now() then perform app.fail('validation', 'The new deadline must be in the future.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  v_old := v_def.due_at;
  update deficiencies set due_at = p_new_due, window_closes_at = case when window_closes_at is not null then p_new_due end, row_version = row_version + 1 where id = v_def.id returning * into v_def;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'deficiency_deadline_changed', 'Correction deadline changed for: ' || v_def.title, v_uid, trim(p_reason),
          jsonb_build_object('deficiency_id', v_def.id, 'from', v_old, 'to', p_new_due));
  perform app.audit('deficiency_deadline_changed', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code, trim(p_reason),
    jsonb_build_object('due_at', v_old), jsonb_build_object('due_at', p_new_due));
  perform app.notify_institution(v_app.institution_id, 'deficiency', 'Deadline changed: ' || v_app.reference,
    '"' || v_def.title || '" is now due ' || to_char(p_new_due at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST.',
    '/app/applications/' || v_app.id, 'deficiency', v_def.id, 'deadline:' || v_def.id || ':' || v_def.row_version);
  return v_def;
end $$;


create or replace function public.reopen_deficiency_window(p_deficiency_id uuid, p_reason text, p_expected_version integer)
returns public.deficiencies
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_cfg jsonb; v_max integer; v_hours numeric; v_len interval; v_old timestamptz;
begin
  select * into v_def from deficiencies where id = p_deficiency_id for update;
  if v_def.id is null then perform app.fail('not_found', 'Query not found.'); end if;
  select * into v_app from applications where id = v_def.application_id for update;
  perform app.require_case_officer(v_app);
  if v_def.row_version <> p_expected_version then perform app.fail('stale', 'This query changed since you opened it. Refresh first.'); end if;
  if v_def.window_closes_at is null then perform app.fail('invalid_state', 'This query has no response window.'); end if;
  if v_def.status not in ('open', 'still_deficient', 'needs_clarification') then
    perform app.fail('invalid_state', 'The window can be reopened only while the institution still has to respond.');
  end if;
  if v_def.window_closes_at > now() then perform app.fail('invalid_state', 'The response window is still open.'); end if;
  v_cfg := (select value from system_settings where key = 'deficiency.query_window');
  v_max := coalesce(app.try_numeric(v_cfg ->> 'max_reopens'), 1)::integer;
  if v_def.window_reopen_count >= v_max then
    perform app.fail('invalid_state', 'The window has already been reopened ' || v_def.window_reopen_count || ' time(s); the limit is ' || v_max || '. Raise a new query instead.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  v_hours := app.try_numeric(v_cfg ->> 'hours');
  v_len := case when v_hours is not null and v_hours > 0 then make_interval(secs => (v_hours * 3600)::double precision) else v_def.window_closes_at - v_def.window_opens_at end;
  v_old := v_def.window_closes_at;
  update deficiencies set window_opens_at = now(), window_closes_at = now() + v_len, due_at = now() + v_len,
    window_reopen_count = window_reopen_count + 1, row_version = row_version + 1 where id = v_def.id returning * into v_def;
  insert into application_events (application_id, event_type, summary, actor_id, reason, metadata)
  values (v_app.id, 'deficiency_window_reopened', 'Response window reopened for: ' || v_def.title, v_uid, trim(p_reason),
          jsonb_build_object('deficiency_id', v_def.id, 'previous_close', v_old, 'window_closes_at', v_def.window_closes_at, 'reopen_count', v_def.window_reopen_count));
  perform app.audit('deficiency_window_reopened', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code, trim(p_reason),
    jsonb_build_object('window_closes_at', v_old), jsonb_build_object('window_closes_at', v_def.window_closes_at, 'reopen_count', v_def.window_reopen_count));
  perform app.notify_institution(v_app.institution_id, 'deficiency', 'Response window reopened: ' || v_app.reference,
    '"' || v_def.title || '" can be answered until ' || to_char(v_def.window_closes_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') || ' IST.',
    '/app/applications/' || v_app.id, 'deficiency', v_def.id, 'reopen:' || v_def.id || ':' || v_def.window_reopen_count);
  return v_def;
end $$;
revoke execute on function public.reopen_deficiency_window(uuid, text, integer) from public, anon;
grant execute on function public.reopen_deficiency_window(uuid, text, integer) to authenticated, service_role;

create or replace function public.compare_document_versions(p_old_version_id uuid, p_new_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  o document_versions; n document_versions; d documents; ro document_check_runs; rn document_check_runs;
  v_reason text; v_fields jsonb := '[]'::jsonb; v_meta jsonb := '[]'::jsonb; v_text_reason text;
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

  v_text_reason := case
    when v_reason is not null then v_reason
    when ro.extracted_text is null then 'The extracted text of version ' || o.version || ' was not stored, so no line-level comparison is possible.'
    when rn.extracted_text is null then 'The extracted text of version ' || n.version || ' was not stored, so no line-level comparison is possible.'
  end;

  return jsonb_build_object(
    'document', jsonb_build_object('id', d.id, 'title', d.title, 'doc_type', d.doc_type),
    'old', jsonb_build_object('id', o.id, 'version', o.version, 'file_name', o.file_name, 'mime_type', o.mime_type, 'size_bytes', o.size_bytes,
                              'sha256', o.sha256, 'uploaded_at', o.uploaded_at, 'replaced_reason', o.replaced_reason),
    'new', jsonb_build_object('id', n.id, 'version', n.version, 'file_name', n.file_name, 'mime_type', n.mime_type, 'size_bytes', n.size_bytes,
                              'sha256', n.sha256, 'uploaded_at', n.uploaded_at, 'replaced_reason', n.replaced_reason),
    'identical_file', o.sha256 is not null and o.sha256 = n.sha256,
    'metadata_changes', v_meta,
    'content', jsonb_build_object('available', v_reason is null, 'reason', v_reason, 'fields', v_fields,
                                  'text_available', v_text_reason is null, 'text_reason', v_text_reason,
                                  'old_text', case when v_text_reason is null then ro.extracted_text end,
                                  'new_text', case when v_text_reason is null then rn.extracted_text end));
end $$;

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
          select 'deficiency_window', d.id, d.application_id, a.institution_id, a.region_code, a.assigned_officer_id, d.window_closes_at,
                 a.reference || ' query window: ' || d.title, '/app/applications/' || d.application_id || '?tab=deficiencies'
          from deficiencies d join applications a on a.id = d.application_id
          where d.window_closes_at is not null and d.status in ('open', 'still_deficient', 'needs_clarification')
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


revoke execute on function app.run_deadline_scan(text, timestamptz) from public, anon, authenticated;
