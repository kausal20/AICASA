-- Workflow engine: routing, transitions, prerequisites, stage entry, notifications.
-- The browser calls only the public.* functions. app.* internals are revoked from it at the end.

-- ---------------------------------------------------------------------------
-- Notifications (internal)
-- ---------------------------------------------------------------------------
create or replace function app.email_configured() returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select status = 'configured' from integration_settings where code = 'email'), false)
$$;

create or replace function app.notify(
  p_recipient uuid, p_kind text, p_title text, p_body text, p_link text,
  p_entity_type text, p_entity_id uuid, p_key text, p_email boolean default false
) returns boolean
language plpgsql security definer set search_path = public, app as $$
declare
  v_id uuid;
  v_pref notification_preferences;
begin
  if p_recipient is null then return false; end if;
  select * into v_pref from notification_preferences where user_id = p_recipient and kind = p_kind;
  if v_pref.user_id is not null and not v_pref.in_app and not v_pref.email then
    return false;
  end if;
  insert into notifications (recipient_id, kind, title, body, link, entity_type, entity_id, idempotency_key)
  values (p_recipient, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id, p_key || ':' || p_recipient::text)
  on conflict (idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then return false; end if;
  if p_email or coalesce(v_pref.email, false) then
    insert into notification_delivery_attempts (notification_id, channel, status, error)
    values (v_id, 'email',
            case when app.email_configured() then 'pending' else 'skipped_unconfigured' end,
            case when app.email_configured() then null else 'No email provider configured; in-app only.' end);
  end if;
  return true;
end $$;

create or replace function app.institution_recipients(p_institution_id uuid) returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select m.user_id from institution_memberships m
  join profiles p on p.id = m.user_id and p.is_active
  join user_role_assignments r on r.user_id = m.user_id and r.role = 'institution' and r.is_active
  where m.institution_id = p_institution_id and m.is_active
$$;

create or replace function app.capability_recipients(p_region text, p_capability text) returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select distinct r.user_id from user_role_assignments r
  join profiles p on p.id = r.user_id and p.is_active
  where r.is_active and r.role = 'officer' and p_capability = any (r.capabilities)
    and (r.region_code is null or r.region_code = p_region)
$$;

create or replace function app.admin_recipients(p_region text, p_national_only boolean default false) returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select distinct r.user_id from user_role_assignments r
  join profiles p on p.id = r.user_id and p.is_active
  where r.is_active and r.role = 'admin'
    and ((p_national_only and r.region_code is null)
         or (not p_national_only and (r.region_code is null or r.region_code = p_region)))
$$;

create or replace function app.notify_institution(
  p_institution_id uuid, p_kind text, p_title text, p_body text, p_link text,
  p_entity_type text, p_entity_id uuid, p_key text
) returns integer
language plpgsql security definer set search_path = public, app as $$
declare v_user uuid; v_n integer := 0;
begin
  for v_user in select app.institution_recipients(p_institution_id) loop
    if app.notify(v_user, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id, p_key) then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Routing helpers
-- ---------------------------------------------------------------------------
create or replace function app.status_for_stage(p_kind app.stage_kind) returns app.application_status
language sql immutable as $$
  select case p_kind
    when 'intake' then 'submitted'::app.application_status
    when 'scrutiny' then 'under_scrutiny'
    when 'evc' then 'evc_required'
    when 'committee' then 'committee_review'
    when 'decision' then 'awaiting_decision'
    when 'terminal' then 'completed'
  end
$$;

create or replace function app.next_action_for_stage(p_kind app.stage_kind, p_name text) returns text
language sql immutable as $$
  select case p_kind
    when 'intake' then 'Automatic intake checks'
    when 'scrutiny' then 'Scrutiny review by assigned officer'
    when 'evc' then 'Schedule and conduct the expert visit (EVC)'
    when 'committee' then p_name || ' review'
    when 'decision' then 'Decision to be recorded by competent authority'
    when 'terminal' then null
  end
$$;

-- Least-loaded active officer with the capability in the region; keeps the current officer when eligible.
create or replace function app.pick_officer(p_region text, p_capability text, p_current uuid) returns uuid
language sql stable security definer set search_path = public, app as $$
  with eligible as (
    select distinct r.user_id from user_role_assignments r
    join profiles p on p.id = r.user_id and p.is_active
    where r.is_active and r.role = 'officer' and p_capability = any (r.capabilities)
      and (r.region_code = p_region or r.region_code is null)
  )
  select coalesce(
    (select user_id from eligible where user_id = p_current),
    (select e.user_id from eligible e
       left join applications a on a.assigned_officer_id = e.user_id
            and a.status not in ('draft', 'completed', 'closed', 'withdrawn')
     group by e.user_id order by count(a.id), e.user_id limit 1))
$$;

-- Returns the first unmet prerequisite as a human-readable sentence, or null when all are met.
-- Unknown prerequisite codes fail closed.
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

-- Can the caller perform this configured transition? Returns null if yes, otherwise the reason.
create or replace function app.transition_permission_error(p_app public.applications, p_t public.workflow_transitions)
returns text
language plpgsql stable security definer set search_path = public, app as $$
begin
  if p_t.allowed_role is null then
    return 'This step happens automatically when its prerequisites are met.';
  end if;
  if p_t.allowed_role = 'institution' then
    if not app.is_representative_of(p_app.institution_id) then
      return 'Only an authorised representative of the institution can take this action.';
    end if;
  else
    if not app.has_role(p_t.allowed_role) then
      return 'Your role does not permit this action.';
    end if;
    if not app.has_capability_in(p_t.required_capability, p_app.region_code) then
      return 'You do not hold the "' || coalesce(p_t.required_capability, 'staff') || '" responsibility for region ' || p_app.region_code || '.';
    end if;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Stage entry. Called only from trusted functions within the same transaction.
-- ---------------------------------------------------------------------------
create or replace function app.enter_stage(p_application_id uuid, p_stage_code text, p_via text, p_actor_kind text default 'user')
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  v_app applications;
  v_prev_stage text;
  v_prev_status app.application_status;
  v_stage workflow_stages;
  v_officer uuid;
  v_due timestamptz;
  v_cycle integer;
  v_evc_id uuid;
  v_task_type text;
begin
  select * into v_app from applications where id = p_application_id for update;
  select * into v_stage from workflow_stages where version_id = v_app.workflow_version_id and code = p_stage_code;
  if v_stage.id is null then
    perform app.fail('config_error', 'Stage ' || p_stage_code || ' is not defined in this route version.');
  end if;

  v_prev_stage := v_app.current_stage;
  v_prev_status := v_app.status;
  v_due := case when v_stage.sla_days is null then null else now() + make_interval(days => v_stage.sla_days) end;

  update application_stage_history set exited_at = now(), exit_transition = p_via
  where application_id = v_app.id and exited_at is null;

  insert into application_stage_history (application_id, stage_code, stage_name, entered_at, due_at, entered_by)
  values (v_app.id, v_stage.code, v_stage.name, now(), v_due, auth.uid());

  if v_stage.responsible_capability is not null then
    v_officer := app.pick_officer(v_app.region_code, v_stage.responsible_capability, v_app.assigned_officer_id);
  end if;

  -- cancel open stage work from the previous stage
  update tasks set status = 'cancelled', completed_at = now()
  where application_id = v_app.id and status = 'open'
    and task_type in ('scrutiny', 'committee_review', 'decision', 'evc_schedule', 'evc_complete');

  update application_assignments set ended_at = now()
  where application_id = v_app.id and ended_at is null
    and (v_officer is null or officer_id <> v_officer or stage_code <> v_stage.code);

  update applications set
    current_stage = v_stage.code,
    status = app.status_for_stage(v_stage.kind),
    stage_entered_at = now(),
    stage_due_at = v_due,
    next_action = app.next_action_for_stage(v_stage.kind, v_stage.name),
    next_actor = case when v_stage.kind = 'terminal' then null
                      when v_stage.kind = 'intake' then 'system'
                      else coalesce(v_stage.responsible_capability, 'officer') end,
    assigned_officer_id = case when v_stage.kind = 'terminal' then assigned_officer_id else coalesce(v_officer, assigned_officer_id) end,
    closed_at = case when v_stage.kind = 'terminal' then now() else null end,
    row_version = row_version + 1,
    updated_at = now()
  where id = v_app.id;

  if v_officer is not null then
    insert into application_assignments (application_id, officer_id, stage_code, assigned_by, reason)
    select v_app.id, v_officer, v_stage.code, auth.uid(), 'Automatic assignment by routing rules'
    where not exists (select 1 from application_assignments where application_id = v_app.id and ended_at is null
                      and officer_id = v_officer and stage_code = v_stage.code);
  end if;

  insert into application_events (application_id, event_type, summary, from_stage, to_stage, from_status, to_status,
                                  actor_id, actor_kind, metadata)
  values (v_app.id, 'stage_entered', 'Entered stage: ' || v_stage.name, v_prev_stage, v_stage.code, v_prev_status,
          app.status_for_stage(v_stage.kind), auth.uid(), p_actor_kind,
          jsonb_build_object('via', p_via, 'due_at', v_due, 'assigned_officer_id', v_officer));

  v_task_type := case v_stage.kind when 'scrutiny' then 'scrutiny' when 'committee' then 'committee_review'
                                   when 'decision' then 'decision' when 'evc' then 'evc_schedule' end;

  if v_stage.kind = 'evc' then
    select coalesce(max(cycle), 0) + 1 into v_cycle from evc_records where application_id = v_app.id and stage_code = v_stage.code;
    insert into evc_records (application_id, stage_code, cycle, status, schedule_due_at, coordinator_id)
    values (v_app.id, v_stage.code, v_cycle, 'awaiting_scheduling', v_due, v_officer)
    returning id into v_evc_id;
    insert into evc_history (evc_id, action, to_status, actor_id, reason)
    values (v_evc_id, 'queued', 'awaiting_scheduling', auth.uid(), 'Prerequisites complete; entered EVC queue');
  end if;

  if v_task_type is not null then
    insert into tasks (task_type, title, application_id, evc_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
    values (v_task_type, v_stage.name || ' — ' || v_app.reference, v_app.id, v_evc_id, v_app.region_code, v_officer,
            v_stage.responsible_capability, v_due,
            'stage:' || v_app.id || ':' || v_stage.code || ':' || extract(epoch from now())::bigint)
    on conflict (dedupe_key) do nothing;
  end if;

  perform app.notify_institution(v_app.institution_id, 'stage_changed', v_app.reference || ': ' || v_stage.name,
    case when v_stage.kind = 'terminal' then 'Processing of this application is complete.'
         else 'Your application has moved to ' || v_stage.name || '.' end,
    '/app/applications/' || v_app.id, 'application', v_app.id,
    'stage:' || v_app.id || ':' || v_stage.code || ':' || extract(epoch from now())::bigint);

  if v_officer is not null and v_officer is distinct from v_app.assigned_officer_id then
    perform app.notify(v_officer, 'assignment', 'Assigned: ' || v_app.reference,
      'You have been assigned ' || v_app.reference || ' for ' || v_stage.name || '.',
      '/app/applications/' || v_app.id, 'application', v_app.id,
      'assign:' || v_app.id || ':' || v_stage.code || ':' || extract(epoch from now())::bigint);
  end if;

  perform app.audit('stage_entered', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code, null,
    jsonb_build_object('stage', v_prev_stage, 'status', v_prev_status),
    jsonb_build_object('stage', v_stage.code, 'status', app.status_for_stage(v_stage.kind), 'assigned_officer_id', v_officer),
    jsonb_build_object('via', p_via));
end $$;

-- Follow automatic transitions whose prerequisites are satisfied. Bounded to avoid loops.
create or replace function app.try_auto_advance(p_application_id uuid, p_depth integer default 0) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  v_app applications;
  v_t workflow_transitions;
begin
  if p_depth > 6 then return; end if;
  select * into v_app from applications where id = p_application_id for update;
  if v_app.status in ('draft', 'returned_for_correction', 'correction_submitted', 'completed', 'closed', 'withdrawn') then
    return;
  end if;
  for v_t in
    select * from workflow_transitions
    where version_id = v_app.workflow_version_id and from_stage = v_app.current_stage and is_automatic
    order by sort_order, code
  loop
    if app.prerequisite_unmet(v_app, v_t.prerequisites) is null then
      insert into application_events (application_id, event_type, summary, from_stage, to_stage, actor_kind, metadata)
      values (v_app.id, 'auto_transition', 'Automatic routing: ' || v_t.name, v_app.current_stage, v_t.to_stage, 'system',
              jsonb_build_object('transition', v_t.code, 'prerequisites', v_t.prerequisites));
      perform app.enter_stage(v_app.id, v_t.to_stage, v_t.code, 'system');
      perform app.try_auto_advance(v_app.id, p_depth + 1);
      return;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Public API: applications
-- ---------------------------------------------------------------------------
create or replace function public.create_application_draft(
  p_institution_id uuid, p_type_code text, p_title text, p_academic_year text, p_form_data jsonb default '{}'::jsonb
) returns public.applications
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user();
  v_inst institutions;
  v_type application_types;
  v_version workflow_definition_versions;
  v_first workflow_stages;
  v_app applications;
begin
  if not app.is_representative_of(p_institution_id) then
    perform app.fail('forbidden', 'You are not an authorised representative of this institution.');
  end if;
  select * into v_inst from institutions where id = p_institution_id;
  select * into v_type from application_types where code = p_type_code and enabled;
  if v_type.code is null then perform app.fail('invalid_type', 'This application type is not enabled.'); end if;
  if length(trim(coalesce(p_title, ''))) < 5 then perform app.fail('validation', 'Title must be at least 5 characters.'); end if;
  if coalesce(p_academic_year, '') !~ '^[0-9]{4}-[0-9]{2}$' then
    perform app.fail('validation', 'Academic year must look like 2027-28.');
  end if;

  select * into v_version from workflow_definition_versions
  where definition_id = v_type.workflow_definition_id and status = 'active';
  if v_version.id is null then perform app.fail('config_error', 'No active route is configured for this application type.'); end if;
  select * into v_first from workflow_stages where version_id = v_version.id order by sequence limit 1;

  insert into applications (reference, institution_id, region_code, application_type_code, workflow_version_id,
                            checklist_version, title, academic_year, form_data, current_stage, status,
                            next_action, next_actor, created_by, is_demo)
  values ('DEMO-' || v_inst.region_code || '-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('application_reference_seq')::text, 5, '0'),
          v_inst.id, v_inst.region_code, v_type.code, v_version.id, v_type.checklist_version, trim(p_title), p_academic_year,
          coalesce(p_form_data, '{}'::jsonb), v_first.code, 'draft',
          'Complete details, upload required documents and submit', 'institution', v_uid, v_inst.is_demo)
  returning * into v_app;

  insert into application_events (application_id, event_type, summary, to_stage, to_status, actor_id)
  values (v_app.id, 'created', 'Draft created', v_first.code, 'draft', v_uid);
  perform app.audit('application_created', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, null, jsonb_build_object('reference', v_app.reference, 'type', v_type.code, 'route_version', v_version.version));
  return v_app;
end $$;

create or replace function public.update_application_draft(
  p_application_id uuid, p_expected_version integer, p_title text, p_academic_year text, p_form_data jsonb
) returns public.applications
language plpgsql security definer set search_path = public, app as $$
declare v_app applications;
begin
  perform app.require_user();
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null or not app.is_representative_of(v_app.institution_id) then
    perform app.fail('not_found', 'Application not found or you do not have access.');
  end if;
  if v_app.status <> 'draft' then perform app.fail('invalid_state', 'Only drafts can be edited.'); end if;
  if v_app.row_version <> p_expected_version then
    perform app.fail('stale', 'This draft was changed elsewhere. Refresh to see the latest version.');
  end if;
  if length(trim(coalesce(p_title, ''))) < 5 then perform app.fail('validation', 'Title must be at least 5 characters.'); end if;
  if coalesce(p_academic_year, '') !~ '^[0-9]{4}-[0-9]{2}$' then
    perform app.fail('validation', 'Academic year must look like 2027-28.');
  end if;
  update applications set title = trim(p_title), academic_year = p_academic_year, form_data = coalesce(p_form_data, '{}'::jsonb),
    row_version = row_version + 1, updated_at = now()
  where id = v_app.id returning * into v_app;
  perform app.audit('draft_updated', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code);
  return v_app;
end $$;

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

  select * into v_app from applications where id = p_application_id;
  return v_app;
end $$;

-- Transitions return a result object instead of raising so that rejections are recorded in the audit log.
create or replace function public.perform_transition(
  p_application_id uuid, p_transition_code text, p_expected_version integer,
  p_reason text default null, p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user();
  v_app applications;
  v_t workflow_transitions;
  v_err text;
  v_code text;
  v_decision text;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null or not app.can_read_application(v_app.id) then
    return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'Application not found or you do not have access.');
  end if;

  select * into v_t from workflow_transitions
  where version_id = v_app.workflow_version_id and code = p_transition_code and from_stage = v_app.current_stage;

  if v_app.row_version <> p_expected_version then
    v_code := 'stale'; v_err := 'This case changed since you opened it. Refresh to see the latest state.';
  elsif v_t.id is null then
    v_code := 'invalid_transition';
    v_err := 'Transition "' || p_transition_code || '" is not permitted from stage "' || v_app.current_stage || '" under this route version.';
  elsif v_app.status in ('returned_for_correction', 'correction_submitted') then
    v_code := 'awaiting_correction'; v_err := 'The case is in a correction loop. Review the deficiencies before routing it.';
  elsif v_app.status in ('draft', 'completed', 'closed', 'withdrawn') then
    v_code := 'invalid_state'; v_err := 'No transitions are available in status ' || v_app.status || '.';
  else
    v_err := app.transition_permission_error(v_app, v_t);
    if v_err is not null then v_code := 'forbidden'; end if;
    if v_err is null and v_t.requires_reason and length(trim(coalesce(p_reason, ''))) < 10 then
      v_code := 'reason_required'; v_err := 'A reason of at least 10 characters is required for this action.';
    end if;
    if v_err is null then
      v_err := app.prerequisite_unmet(v_app, v_t.prerequisites);
      if v_err is not null then v_code := 'prerequisite'; end if;
    end if;
    if v_err is null and v_t.records_decision then
      v_decision := p_payload ->> 'decision';
      if v_decision is null or v_decision not in ('approved', 'approved_with_conditions', 'not_approved', 'deferred') then
        v_code := 'validation'; v_err := 'Select the decision recorded by the competent authority.';
      end if;
    end if;
  end if;

  if v_err is not null then
    perform app.audit('transition_rejected', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
      v_err, null, null, jsonb_build_object('transition', p_transition_code, 'code', v_code, 'stage', v_app.current_stage));
    return jsonb_build_object('ok', false, 'code', v_code, 'message', v_err);
  end if;

  if v_t.records_decision then
    insert into application_decisions (application_id, decision, reason, recorded_by, stage_code)
    values (v_app.id, v_decision, trim(p_reason), v_uid, v_app.current_stage);
  end if;

  insert into application_events (application_id, event_type, summary, from_stage, to_stage, from_status, actor_id, reason, metadata)
  values (v_app.id, case when v_t.records_decision then 'decision_recorded' else 'transition' end,
          v_t.name || case when v_decision is not null then ' — ' || replace(v_decision, '_', ' ') else '' end,
          v_app.current_stage, v_t.to_stage, v_app.status, v_uid, nullif(trim(coalesce(p_reason, '')), ''),
          jsonb_build_object('transition', v_t.code, 'decision', v_decision));
  perform app.audit(case when v_t.records_decision then 'decision_recorded' else 'transition' end,
    'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code, nullif(trim(coalesce(p_reason, '')), ''),
    jsonb_build_object('stage', v_app.current_stage, 'status', v_app.status),
    jsonb_build_object('stage', v_t.to_stage, 'decision', v_decision), jsonb_build_object('transition', v_t.code));

  update tasks set status = 'done', completed_at = now(), completed_by = v_uid
  where application_id = v_app.id and status = 'open' and task_type in ('scrutiny', 'committee_review', 'decision');

  perform app.enter_stage(v_app.id, v_t.to_stage, v_t.code);
  perform app.try_auto_advance(v_app.id);

  if v_decision is not null then
    perform app.notify_institution(v_app.institution_id, 'decision', 'Decision recorded: ' || v_app.reference,
      'A decision has been recorded by the competent authority: ' || replace(v_decision, '_', ' ') || '.',
      '/app/applications/' || v_app.id, 'application', v_app.id, 'decision:' || v_app.id);
  end if;

  select * into v_app from applications where id = p_application_id;
  return jsonb_build_object('ok', true, 'application', to_jsonb(v_app));
end $$;

-- What can the caller do next on this case, and why not?
create or replace function public.available_transitions(p_application_id uuid)
returns table (code text, name text, to_stage text, requires_reason boolean, records_decision boolean,
               permitted boolean, blocked_reason text)
language plpgsql stable security definer set search_path = public, app as $$
declare v_app applications; v_t workflow_transitions; v_err text;
begin
  select * into v_app from applications a where a.id = p_application_id;
  if v_app.id is null or not app.can_read_application(v_app.id) then return; end if;
  for v_t in select * from workflow_transitions t
             where t.version_id = v_app.workflow_version_id and t.from_stage = v_app.current_stage and not t.is_automatic
             order by t.sort_order, t.code loop
    v_err := app.transition_permission_error(v_app, v_t);
    -- Hide transitions belonging to other roles entirely (e.g. institutions never see officer actions).
    if v_err is not null and v_t.allowed_role = 'institution' and not app.has_role('institution') then continue; end if;
    if v_err is not null and v_t.allowed_role <> 'institution' and not app.is_staff() then continue; end if;
    if v_err is null and v_app.status in ('returned_for_correction', 'correction_submitted') then
      v_err := 'The case is in a correction loop. Review the deficiencies first.';
    end if;
    if v_err is null then v_err := app.prerequisite_unmet(v_app, v_t.prerequisites); end if;
    code := v_t.code; name := v_t.name; to_stage := v_t.to_stage; requires_reason := v_t.requires_reason;
    records_decision := v_t.records_decision; permitted := v_err is null; blocked_reason := v_err;
    return next;
  end loop;
end $$;

create or replace function public.add_observation(p_application_id uuid, p_category text, p_body text, p_visibility text default 'internal')
returns public.application_observations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_app applications; v_obs application_observations;
begin
  select * into v_app from applications where id = p_application_id;
  if v_app.id is null or not app.has_capability_in(null, v_app.region_code) or not app.has_role('officer') then
    perform app.fail('forbidden', 'Only officers responsible for this region can record observations.');
  end if;
  if v_app.status in ('draft', 'completed', 'closed', 'withdrawn') then
    perform app.fail('invalid_state', 'Observations can only be recorded on cases under processing.');
  end if;
  insert into application_observations (application_id, stage_code, author_id, category, body, visibility)
  values (v_app.id, v_app.current_stage, v_uid, coalesce(p_category, 'general'), trim(p_body), coalesce(p_visibility, 'internal'))
  returning * into v_obs;
  insert into application_events (application_id, event_type, summary, actor_id, visibility, metadata)
  values (v_app.id, 'observation', 'Observation recorded (' || v_obs.category || ')', v_uid, v_obs.visibility,
          jsonb_build_object('observation_id', v_obs.id));
  perform app.audit('observation_recorded', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, null, jsonb_build_object('category', v_obs.category, 'visibility', v_obs.visibility));
  return v_obs;
end $$;

create or replace function public.reassign_application(p_application_id uuid, p_officer_id uuid, p_reason text)
returns public.applications
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_app applications; v_stage workflow_stages;
begin
  select * into v_app from applications where id = p_application_id for update;
  if v_app.id is null or not app.has_capability_in('assignment', v_app.region_code) then
    perform app.fail('forbidden', 'You do not hold the assignment responsibility for this region.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  select * into v_stage from workflow_stages where version_id = v_app.workflow_version_id and code = v_app.current_stage;
  if not exists (select 1 from user_role_assignments r join profiles p on p.id = r.user_id and p.is_active
                 where r.user_id = p_officer_id and r.is_active and r.role = 'officer'
                   and (v_stage.responsible_capability is null or v_stage.responsible_capability = any (r.capabilities))
                   and (r.region_code is null or r.region_code = v_app.region_code)) then
    perform app.fail('validation', 'The selected officer does not hold the responsibility required for this stage and region.');
  end if;
  update application_assignments set ended_at = now() where application_id = v_app.id and ended_at is null;
  insert into application_assignments (application_id, officer_id, stage_code, assigned_by, reason)
  values (v_app.id, p_officer_id, v_app.current_stage, v_uid, trim(p_reason));
  update tasks set assignee_id = p_officer_id where application_id = v_app.id and status = 'open';
  update applications set assigned_officer_id = p_officer_id, row_version = row_version + 1, updated_at = now()
  where id = v_app.id returning * into v_app;
  insert into application_events (application_id, event_type, summary, actor_id, reason, visibility)
  values (v_app.id, 'reassigned', 'Case reassigned', v_uid, trim(p_reason), 'internal');
  perform app.audit('assignment_changed', 'application', v_app.id, v_app.id, v_app.institution_id, v_app.region_code,
    trim(p_reason), null, jsonb_build_object('officer_id', p_officer_id));
  perform app.notify(p_officer_id, 'assignment', 'Assigned: ' || v_app.reference, 'A case has been reassigned to you.',
    '/app/applications/' || v_app.id, 'application', v_app.id, 'reassign:' || v_app.id || ':' || extract(epoch from now())::bigint);
  return v_app;
end $$;
