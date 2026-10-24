-- Session context, administration, configuration versioning, reporting views and analytics.

-- ---------------------------------------------------------------------------
-- Session context: the frontend renders workspaces from this, never from local state.
-- ---------------------------------------------------------------------------
create or replace function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_uid uuid := auth.uid(); v_profile profiles;
begin
  if v_uid is null then return null; end if;
  select * into v_profile from profiles where id = v_uid;
  if v_profile.id is null then return null; end if;
  return jsonb_build_object(
    'profile', jsonb_build_object('id', v_profile.id, 'email', v_profile.email, 'full_name', v_profile.full_name,
                                  'designation', v_profile.designation, 'phone', v_profile.phone,
                                  'is_active', v_profile.is_active, 'is_demo', v_profile.is_demo),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'role', r.role, 'region_code', r.region_code,
                                                           'capabilities', r.capabilities) order by r.role)
                       from user_role_assignments r where r.user_id = v_uid and r.is_active and v_profile.is_active), '[]'::jsonb),
    'institutions', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'code', i.code, 'kind', i.kind,
                                                                  'region_code', i.region_code, 'member_role', m.member_role,
                                                                  'via', 'membership') order by i.name)
                              from institution_memberships m join institutions i on i.id = m.institution_id
                              where m.user_id = v_uid and m.is_active and app.has_role('institution')), '[]'::jsonb),
    'granted_institutions', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'code', i.code))
                              from institutions i where i.id in (select app.readable_institution_ids())
                                and i.id not in (select app.member_institution_ids(false))), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from system_settings), '{}'::jsonb)
  );
end $$;

create or replace function public.update_my_profile(p_full_name text, p_designation text, p_phone text) returns public.profiles
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_p profiles;
begin
  if length(trim(coalesce(p_full_name, ''))) < 2 then perform app.fail('validation', 'Name is required.'); end if;
  if p_phone is not null and p_phone <> '' and p_phone !~ '^[0-9+ -]{7,20}$' then perform app.fail('validation', 'Phone number format is invalid.'); end if;
  update profiles set full_name = trim(p_full_name), designation = nullif(trim(coalesce(p_designation, '')), ''),
    phone = nullif(trim(coalesce(p_phone, '')), ''), updated_at = now()
  where id = v_uid returning * into v_p;
  perform app.audit('profile_updated', 'profile', v_uid);
  return v_p;
end $$;

create or replace function public.update_institution_contact(p_institution_id uuid, p_contact_email text, p_contact_phone text, p_address text)
returns public.institutions
language plpgsql security definer set search_path = public, app as $$
declare v_i institutions; v_before jsonb;
begin
  perform app.require_user();
  if not app.is_representative_of(p_institution_id) then perform app.fail('forbidden', 'Only institution representatives can edit contact details.'); end if;
  if p_contact_email is not null and p_contact_email <> '' and p_contact_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform app.fail('validation', 'Email address is invalid.');
  end if;
  select to_jsonb(i) - 'created_at' into v_before from institutions i where id = p_institution_id;
  update institutions set contact_email = nullif(trim(coalesce(p_contact_email, '')), ''),
    contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''), address = nullif(trim(coalesce(p_address, '')), ''), updated_at = now()
  where id = p_institution_id returning * into v_i;
  perform app.audit('institution_contact_updated', 'institution', v_i.id, null, v_i.id, v_i.region_code, null,
    jsonb_build_object('contact_email', v_before ->> 'contact_email', 'contact_phone', v_before ->> 'contact_phone'),
    jsonb_build_object('contact_email', v_i.contact_email, 'contact_phone', v_i.contact_phone));
  return v_i;
end $$;

-- ---------------------------------------------------------------------------
-- Role and access administration
-- ---------------------------------------------------------------------------
create or replace function public.assign_role(
  p_user_id uuid, p_role app.app_role, p_region_code text, p_capabilities text[], p_reason text,
  p_institution_id uuid default null
) returns public.user_role_assignments
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_a user_role_assignments; v_national boolean := app.is_national_admin();
begin
  if not app.has_role('admin') or not app.has_capability('user_admin') then
    perform app.fail('forbidden', 'Only administrators with user-administration responsibility can assign roles.');
  end if;
  if p_user_id = v_uid then perform app.fail('forbidden', 'You cannot change your own roles.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'Record why this access is being granted (at least 10 characters).'); end if;
  if not v_national then
    if p_role = 'admin' then perform app.fail('forbidden', 'Only a national administrator can grant administrator roles.'); end if;
    if p_region_code is null or not app.has_capability_in('user_admin', p_region_code) then
      perform app.fail('forbidden', 'You can only grant access within your own region.');
    end if;
  end if;
  if p_role = 'institution' then
    if p_institution_id is null then perform app.fail('validation', 'Choose the institution this user represents.'); end if;
    if not v_national and not exists (select 1 from institutions where id = p_institution_id and region_code = p_region_code) then
      perform app.fail('forbidden', 'That institution is outside your region.');
    end if;
    p_region_code := null; p_capabilities := '{}';
  end if;
  if p_role = 'officer' and 'user_admin' = any (coalesce(p_capabilities, '{}')) then
    perform app.fail('validation', 'User administration is an administrator capability.');
  end if;
  if not exists (select 1 from profiles where id = p_user_id and is_active) then perform app.fail('not_found', 'User not found or inactive.'); end if;

  insert into user_role_assignments (user_id, role, region_code, capabilities, granted_by)
  values (p_user_id, p_role, p_region_code, coalesce(p_capabilities, '{}'), v_uid)
  returning * into v_a;
  if p_role = 'institution' then
    insert into institution_memberships (user_id, institution_id, member_role) values (p_user_id, p_institution_id, 'representative')
    on conflict (user_id, institution_id) do update set is_active = true;
  end if;
  perform app.audit('role_granted', 'user', p_user_id, null, p_institution_id, p_region_code, trim(p_reason), null,
    jsonb_build_object('assignment_id', v_a.id, 'role', p_role, 'region', p_region_code, 'capabilities', v_a.capabilities));
  return v_a;
end $$;

create or replace function public.revoke_role(p_assignment_id uuid, p_reason text) returns public.user_role_assignments
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_a user_role_assignments;
begin
  select * into v_a from user_role_assignments where id = p_assignment_id for update;
  if v_a.id is null or not v_a.is_active then perform app.fail('not_found', 'Active assignment not found.'); end if;
  if not app.has_role('admin') or not app.has_capability('user_admin') then
    perform app.fail('forbidden', 'Only administrators with user-administration responsibility can revoke roles.');
  end if;
  if v_a.user_id = v_uid then perform app.fail('forbidden', 'You cannot change your own roles.'); end if;
  if not app.is_national_admin() and (v_a.role = 'admin' or v_a.region_code is null or not app.has_capability_in('user_admin', v_a.region_code)) then
    perform app.fail('forbidden', 'This assignment is outside your administrative scope.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'Record why this access is being revoked (at least 10 characters).'); end if;
  update user_role_assignments set is_active = false, revoked_by = v_uid, revoked_at = now(), revoke_reason = trim(p_reason)
  where id = v_a.id returning * into v_a;
  perform app.audit('role_revoked', 'user', v_a.user_id, null, null, v_a.region_code, trim(p_reason),
    jsonb_build_object('role', v_a.role, 'region', v_a.region_code, 'capabilities', v_a.capabilities), null,
    jsonb_build_object('assignment_id', v_a.id));
  return v_a;
end $$;

-- ---------------------------------------------------------------------------
-- Workflow configuration: publish a new version; existing cases keep the version they started with.
-- p_stages:      [{code,name,kind,sequence,sla_days,responsible_capability,description}]
-- p_transitions: [{code,name,from_stage,to_stage,allowed_role,required_capability,requires_reason,is_automatic,
--                  prerequisites[],records_decision,sort_order}]
-- ---------------------------------------------------------------------------
create or replace function public.publish_workflow_version(
  p_definition_id uuid, p_stages jsonb, p_transitions jsonb, p_source_reference text, p_change_summary text
) returns public.workflow_definition_versions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_old workflow_definition_versions; v_new workflow_definition_versions;
  v_codes text[]; v_s jsonb; v_t jsonb; v_p text;
  v_known_prereqs text[] := array['no_open_deficiencies', 'has_open_deficiency', 'evc_completed', 'evc_satisfactory',
                                  'required_documents', 'actor_is_assigned'];
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

create or replace function public.update_escalation_rule(
  p_code text, p_offset_hours integer, p_recipient text, p_recipient_capability text, p_channel text,
  p_max_repeats integer, p_repeat_interval_hours integer, p_active boolean, p_source_reference text, p_change_summary text
) returns public.escalation_rules
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_old escalation_rules; v_new escalation_rules;
begin
  if not app.is_national_admin() or not app.has_capability('escalation') then
    perform app.fail('forbidden', 'Only national administrators with escalation responsibility can change alert rules.');
  end if;
  select * into v_old from escalation_rules where code = p_code and is_active for update;
  if v_old.id is null then
    select * into v_old from escalation_rules where code = p_code order by version desc limit 1;
  end if;
  if v_old.id is null then perform app.fail('not_found', 'Rule not found.'); end if;
  if length(trim(coalesce(p_change_summary, ''))) < 10 then perform app.fail('validation', 'Describe the change (at least 10 characters).'); end if;
  if p_recipient = 'capability_officers' and coalesce(p_recipient_capability, '') = '' then
    perform app.fail('validation', 'Choose which officer responsibility receives this alert.');
  end if;
  update escalation_rules set is_active = false where id = v_old.id;
  insert into escalation_rules (code, version, is_active, rule_kind, entity_type, offset_hours, recipient, recipient_capability,
    channel, max_repeats, repeat_interval_hours, source_reference, change_summary, created_by)
  values (v_old.code, (select max(version) + 1 from escalation_rules where code = p_code), coalesce(p_active, true),
          v_old.rule_kind, v_old.entity_type, p_offset_hours, p_recipient, nullif(p_recipient_capability, ''), p_channel,
          p_max_repeats, p_repeat_interval_hours, coalesce(nullif(trim(p_source_reference), ''), v_old.source_reference),
          trim(p_change_summary), v_uid)
  returning * into v_new;
  if not coalesce(p_active, true) then update escalation_rules set is_active = false where id = v_new.id; end if;
  perform app.audit('alert_rule_changed', 'escalation_rule', v_new.id, null, null, null, trim(p_change_summary),
    to_jsonb(v_old) - 'id', to_jsonb(v_new) - 'id');
  return v_new;
end $$;

create or replace function public.record_report_export(p_report_code text, p_filters jsonb, p_row_count integer)
returns public.report_exports
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_r report_exports;
begin
  if not app.has_capability('reports') then perform app.fail('forbidden', 'You do not hold the reporting responsibility.'); end if;
  insert into report_exports (report_code, filters, row_count, generated_by) values (p_report_code, coalesce(p_filters, '{}'), p_row_count, v_uid)
  returning * into v_r;
  perform app.audit('report_exported', 'report', v_r.id, null, null, null, null, null,
    jsonb_build_object('report', p_report_code, 'rows', p_row_count, 'filters', p_filters));
  return v_r;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting views. security_invoker means the caller's RLS applies to every row and count.
-- ---------------------------------------------------------------------------
create view public.v_applications with (security_invoker = true) as
select a.id, a.reference, a.title, a.academic_year, a.status, a.current_stage, a.region_code, a.institution_id,
       i.name as institution_name, i.code as institution_code, a.application_type_code, t.name as application_type_name,
       s.name as stage_name, s.kind as stage_kind, a.stage_entered_at, a.stage_due_at, a.next_action, a.next_actor,
       a.assigned_officer_id, pd.full_name as assigned_officer_name, a.submitted_at, a.closed_at, a.created_at, a.updated_at,
       a.row_version, a.is_demo, a.workflow_version_id, v.version as route_version, wd.name as route_name,
       extract(day from now() - coalesce(a.submitted_at, a.created_at))::int as age_days,
       extract(day from now() - a.stage_entered_at)::int as stage_age_days,
       (a.stage_due_at is not null and a.stage_due_at < now()
        and a.status not in ('draft', 'completed', 'closed', 'withdrawn', 'returned_for_correction', 'correction_submitted')) as is_overdue,
       (select count(*) from deficiencies d where d.application_id = a.id and d.status not in ('resolved', 'withdrawn'))::int as open_deficiencies,
       (select min(d.due_at) from deficiencies d where d.application_id = a.id and d.status in ('open', 'still_deficient', 'needs_clarification')) as correction_due_at
from applications a
join institutions i on i.id = a.institution_id
join application_types t on t.code = a.application_type_code
join workflow_definition_versions v on v.id = a.workflow_version_id
join workflow_definitions wd on wd.id = v.definition_id
left join workflow_stages s on s.version_id = a.workflow_version_id and s.code = a.current_stage
left join profile_directory pd on pd.id = a.assigned_officer_id;

create view public.v_obligations with (security_invoker = true) as
select o.*, i.name as institution_name, a.reference as application_reference,
       case
         when o.status in ('awaiting_submission', 'correction_required') and o.due_at < now() then 'overdue'
         when o.status = 'awaiting_submission' and o.due_at < now() + make_interval(days =>
              coalesce((select (value #>> '{}')::int from system_settings where key = 'compliance.due_soon_days'), 30)) then 'due_soon'
         when o.status = 'awaiting_submission' and o.due_at >= now() + interval '90 days' then 'upcoming'
         else o.status::text
       end as effective_status,
       extract(day from o.due_at - now())::int as days_to_due,
       (select count(*) from compliance_submissions s where s.obligation_id = o.id)::int as submission_count
from compliance_obligations o
join institutions i on i.id = o.institution_id
left join applications a on a.id = o.application_id;

create view public.v_document_validity with (security_invoker = true) as
select v.*, i.name as institution_name, i.region_code,
       (v.expiry_date - current_date) as days_to_expiry,
       case when v.superseded_by is not null then 'superseded'
            when v.expiry_date < current_date then 'expired'
            when v.expiry_date < current_date + coalesce((select (value #>> '{}')::int from system_settings where key = 'validity.expiring_soon_days'), 90) then 'expiring_soon'
            else 'valid' end as validity_state,
       (select o.id from compliance_obligations o where o.validity_id = v.id limit 1) as renewal_obligation_id
from document_validities v join institutions i on i.id = v.institution_id;

create view public.v_evc_queue with (security_invoker = true) as
select e.*, a.reference, a.title as application_title, a.institution_id, i.name as institution_name, a.region_code,
       a.status as application_status, pd.full_name as coordinator_name,
       extract(day from now() - e.ready_at)::int as age_days,
       (e.status = 'awaiting_scheduling' and e.schedule_due_at < now())
         or (e.status = 'scheduled' and e.scheduled_end < now()) as is_overdue
from evc_records e
join applications a on a.id = e.application_id
join institutions i on i.id = a.institution_id
left join profile_directory pd on pd.id = e.coordinator_id;

create view public.v_tasks with (security_invoker = true) as
select t.*, a.reference as application_reference, pd.full_name as assignee_name,
       (t.status = 'open' and t.due_at < now()) as is_overdue
from tasks t
left join applications a on a.id = t.application_id
left join profile_directory pd on pd.id = t.assignee_id;

create view public.v_escalations with (security_invoker = true) as
select e.*, r.code as rule_code, r.version as rule_version, r.rule_kind, r.recipient as rule_recipient,
       a.reference as application_reference, i.name as institution_name
from escalation_events e
join escalation_rules r on r.id = e.rule_id
left join applications a on a.id = e.application_id
left join institutions i on i.id = e.institution_id;

create view public.v_audit_logs with (security_invoker = true) as
select l.*, pd.full_name as actor_name, a.reference as application_reference
from audit_logs l
left join profile_directory pd on pd.id = l.actor_id
left join applications a on a.id = l.application_id;

grant select on public.v_applications, public.v_obligations, public.v_document_validity, public.v_evc_queue,
                public.v_tasks, public.v_escalations, public.v_audit_logs to authenticated;

-- Aggregates computed over the caller's RLS-visible rows only (security invoker).
create or replace function public.analytics_summary(p_region text default null) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  with apps as (select * from v_applications where p_region is null or region_code = p_region),
       open_apps as (select * from apps where status not in ('draft', 'completed', 'closed', 'withdrawn'))
  select jsonb_build_object(
    'generated_at', now(),
    'region', p_region,
    'totals', jsonb_build_object(
      'all', (select count(*) from apps),
      'draft', (select count(*) from apps where status = 'draft'),
      'in_process', (select count(*) from open_apps),
      'awaiting_institution', (select count(*) from apps where status = 'returned_for_correction'),
      'correction_submitted', (select count(*) from apps where status = 'correction_submitted'),
      'under_scrutiny', (select count(*) from apps where status = 'under_scrutiny'),
      'completed', (select count(*) from apps where status in ('completed', 'closed')),
      'overdue', (select count(*) from apps where is_overdue)),
    'by_status', coalesce((select jsonb_agg(x) from (select status, count(*) as count from apps group by status order by count(*) desc) x), '[]'),
    'by_stage', coalesce((select jsonb_agg(x) from (
        select stage_name as stage, stage_kind as kind, count(*) as count, round(avg(stage_age_days), 1) as avg_stage_age_days,
               count(*) filter (where is_overdue) as overdue
        from open_apps group by stage_name, stage_kind order by count(*) desc) x), '[]'),
    'by_region', coalesce((select jsonb_agg(x) from (
        select region_code as region, count(*) as count, count(*) filter (where is_overdue) as overdue
        from open_apps group by region_code order by region_code) x), '[]'),
    'ageing', coalesce((select jsonb_agg(x) from (
        select bucket, count(*) as count from (
          select case when age_days < 15 then '0–14 days' when age_days < 30 then '15–29 days'
                      when age_days < 60 then '30–59 days' else '60+ days' end as bucket,
                 case when age_days < 15 then 1 when age_days < 30 then 2 when age_days < 60 then 3 else 4 end as ord
          from open_apps) b group by bucket, ord order by ord) x), '[]'),
    'workload', coalesce((select jsonb_agg(x) from (
        select coalesce(assigned_officer_name, 'Unassigned') as officer, count(*) as open_cases,
               count(*) filter (where is_overdue) as overdue
        from open_apps group by assigned_officer_name order by count(*) desc limit 12) x), '[]'),
    'evc', coalesce((select jsonb_object_agg(status, n) from (
        select status::text, count(*) as n from v_evc_queue where p_region is null or region_code = p_region group by status) x), '{}'),
    'evc_overdue', (select count(*) from v_evc_queue where is_overdue and (p_region is null or region_code = p_region)),
    'compliance', coalesce((select jsonb_object_agg(effective_status, n) from (
        select effective_status, count(*) as n from v_obligations where p_region is null or region_code = p_region group by effective_status) x), '{}'),
    'validity', coalesce((select jsonb_object_agg(validity_state, n) from (
        select validity_state, count(*) as n from v_document_validity
        where (p_region is null or region_code = p_region) and validity_state <> 'superseded' group by validity_state) x), '{}'),
    'escalations_open', (select count(*) from escalation_events where status <> 'resolved' and (p_region is null or region_code = p_region)),
    'tasks_overdue', (select count(*) from v_tasks where is_overdue and (p_region is null or region_code = p_region))
  )
$$;

-- ---------------------------------------------------------------------------
-- Scheduling: run the deadline scan every 30 minutes where pg_cron is available.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('aicasa-deadline-scan', '*/30 * * * *', $cron$select app.run_deadline_scan('scheduler')$cron$);
  end if;
exception when others then
  raise notice 'pg_cron not scheduled: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges. Internal helpers are not callable from the browser.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
grant usage on schema app to service_role;
grant select on all tables in schema public to service_role;

revoke execute on function
  app.notify(uuid, text, text, text, text, text, uuid, text, boolean),
  app.notify_institution(uuid, text, text, text, text, text, uuid, text),
  app.enter_stage(uuid, text, text, text),
  app.try_auto_advance(uuid, integer),
  app.audit(text, text, uuid, uuid, uuid, text, text, jsonb, jsonb, jsonb),
  app.run_deadline_scan(text, timestamptz),
  app.pick_officer(text, text, uuid),
  app.prerequisite_unmet(public.applications, text[]),
  app.transition_permission_error(public.applications, public.workflow_transitions),
  app.rule_recipients(public.escalation_rules, uuid, text, uuid),
  app.institution_recipients(uuid),
  app.capability_recipients(text, text),
  app.admin_recipients(text, boolean),
  app.evc_conflicts(uuid, timestamptz, timestamptz, uuid[]),
  app.require_case_officer(public.applications),
  app.require_evc_officer(public.evc_records, public.applications),
  app.handle_new_auth_user()
from public, anon, authenticated;
