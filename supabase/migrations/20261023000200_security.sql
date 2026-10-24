-- Authorisation helpers, immutability guards and row-level security.
-- Helpers are SECURITY DEFINER so policies can consult role tables without recursive RLS,
-- and they only ever answer questions about the *calling* user (auth.uid()).

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.uid() returns uuid
language sql stable as $$ select auth.uid() $$;

create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active)
$$;

create or replace function app.has_role(p_role app.app_role) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from user_role_assignments
    where user_id = auth.uid() and role = p_role and is_active)
$$;

create or replace function app.is_staff() returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.has_role('officer') or app.has_role('admin')
$$;

-- Officer/admin may read a region if any active staff assignment is national (null) or that region.
create or replace function app.can_read_region(p_region text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from user_role_assignments
    where user_id = auth.uid() and is_active and role in ('officer', 'admin')
      and (region_code is null or region_code = p_region))
$$;

-- Capability within a region (null capability = any staff assignment in region).
create or replace function app.has_capability_in(p_capability text, p_region text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from user_role_assignments
    where user_id = auth.uid() and is_active and role in ('officer', 'admin')
      and (p_capability is null or p_capability = any (capabilities))
      and (region_code is null or region_code = p_region))
$$;

create or replace function app.has_capability(p_capability text) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from user_role_assignments
    where user_id = auth.uid() and is_active and role in ('officer', 'admin')
      and p_capability = any (capabilities))
$$;

create or replace function app.is_national_admin() returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from user_role_assignments
    where user_id = auth.uid() and is_active and role = 'admin' and region_code is null)
$$;

create or replace function app.member_institution_ids(p_representative_only boolean default false)
returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select m.institution_id from institution_memberships m
  join user_role_assignments r on r.user_id = m.user_id and r.role = 'institution' and r.is_active
  where m.user_id = auth.uid() and m.is_active and app.is_active_user()
    and (not p_representative_only or m.member_role = 'representative')
$$;

create or replace function app.is_representative_of(p_institution_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select p_institution_id in (select app.member_institution_ids(true))
$$;

-- Institutions readable by an institution user: own memberships, plus explicit active grants
-- when the university-access feature flag is enabled.
create or replace function app.readable_institution_ids() returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select app.member_institution_ids(false)
  union
  select g.target_institution_id
  from institution_access_grants g
  where g.is_active
    and g.grantee_institution_id in (select app.member_institution_ids(false))
    and coalesce((select (value ->> 'enabled')::boolean from system_settings where key = 'feature.university_access'), false)
$$;

create or replace function app.can_read_institution(p_institution_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select p_institution_id in (select app.readable_institution_ids())
      or exists (select 1 from institutions i where i.id = p_institution_id and app.can_read_region(i.region_code))
$$;

create or replace function app.can_read_application(p_application_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from applications a
    where a.id = p_application_id
      and (a.institution_id in (select app.readable_institution_ids())
           or app.can_read_region(a.region_code)
           or a.assigned_officer_id = auth.uid()))
$$;

-- Structured, user-facing failures. detail carries a stable machine code.
create or replace function app.fail(p_code text, p_message text) returns void
language plpgsql as $$
begin
  raise exception '%', p_message using errcode = 'P0001', detail = p_code;
end $$;

create or replace function app.require_user() returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare v uuid := auth.uid();
begin
  if v is null then perform app.fail('not_authenticated', 'Sign in is required.'); end if;
  if not exists (select 1 from profiles where id = v and is_active) then
    perform app.fail('inactive_account', 'This account is inactive. Contact an administrator.');
  end if;
  return v;
end $$;

create or replace function app.audit(
  p_action text, p_entity_type text, p_entity_id uuid,
  p_application_id uuid default null, p_institution_id uuid default null, p_region text default null,
  p_reason text default null, p_before jsonb default null, p_after jsonb default null, p_meta jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = public, app as $$
  insert into audit_logs (actor_id, actor_kind, action, entity_type, entity_id, application_id, institution_id,
                          region_code, reason, before_state, after_state, metadata)
  values (auth.uid(), case when auth.uid() is null then 'system' else 'user' end, p_action, p_entity_type, p_entity_id,
          p_application_id, p_institution_id, p_region, p_reason, p_before, p_after, coalesce(p_meta, '{}'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- New auth users get a profile with no authority. Roles are granted separately.
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into profiles (id, email, full_name, is_demo)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''),
          coalesce((new.raw_user_meta_data ->> 'is_demo')::boolean, false))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Append-only history tables
-- ---------------------------------------------------------------------------
create or replace function app.block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001', detail = 'append_only';
end $$;

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function app.block_mutation();
create trigger application_events_append_only before update or delete on public.application_events
  for each row execute function app.block_mutation();
create trigger evc_history_append_only before update or delete on public.evc_history
  for each row execute function app.block_mutation();
create trigger deficiency_reviews_append_only before update or delete on public.deficiency_reviews
  for each row execute function app.block_mutation();
create trigger deficiency_submissions_append_only before update or delete on public.deficiency_submissions
  for each row execute function app.block_mutation();
create trigger compliance_verifications_append_only before update or delete on public.compliance_verifications
  for each row execute function app.block_mutation();
create trigger compliance_submissions_append_only before update or delete on public.compliance_submissions
  for each row execute function app.block_mutation();
create trigger decisions_append_only before update or delete on public.application_decisions
  for each row execute function app.block_mutation();

create or replace function app.block_version_rewrite() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.storage_path <> old.storage_path or new.sha256 is distinct from old.sha256
     or new.size_bytes <> old.size_bytes or new.document_id <> old.document_id or new.version <> old.version then
    raise exception 'Document versions are immutable' using errcode = 'P0001', detail = 'append_only';
  end if;
  return new;
end $$;
create trigger document_versions_immutable before update or delete on public.document_versions
  for each row execute function app.block_version_rewrite();

-- ---------------------------------------------------------------------------
-- Privileges: browser roles read through RLS; they never write tables directly.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to authenticated;
grant usage on schema app to authenticated;
grant select on all tables in schema public to authenticated;
grant execute on all functions in schema app to authenticated;
-- internal helpers that must never be called directly by the browser are revoked in later migrations

alter table public.regions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_role_assignments enable row level security;
alter table public.institutions enable row level security;
alter table public.institution_memberships enable row level security;
alter table public.institution_access_grants enable row level security;
alter table public.workflow_definitions enable row level security;
alter table public.workflow_definition_versions enable row level security;
alter table public.workflow_stages enable row level security;
alter table public.workflow_transitions enable row level security;
alter table public.application_types enable row level security;
alter table public.document_requirements enable row level security;
alter table public.applications enable row level security;
alter table public.application_stage_history enable row level security;
alter table public.application_events enable row level security;
alter table public.application_assignments enable row level security;
alter table public.application_observations enable row level security;
alter table public.application_decisions enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_check_runs enable row level security;
alter table public.document_check_findings enable row level security;
alter table public.deficiencies enable row level security;
alter table public.deficiency_submissions enable row level security;
alter table public.deficiency_reviews enable row level security;
alter table public.evc_records enable row level security;
alter table public.evc_participants enable row level security;
alter table public.evc_history enable row level security;
alter table public.document_validities enable row level security;
alter table public.compliance_obligations enable row level security;
alter table public.compliance_submissions enable row level security;
alter table public.compliance_verifications enable row level security;
alter table public.tasks enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_delivery_attempts enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.escalation_rules enable row level security;
alter table public.escalation_events enable row level security;
alter table public.scheduled_job_runs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.system_settings enable row level security;
alter table public.integration_settings enable row level security;
alter table public.report_exports enable row level security;

-- Reference/configuration data: readable by any signed-in active user.
create policy read_regions on public.regions for select to authenticated using (app.is_active_user());
create policy read_wf_defs on public.workflow_definitions for select to authenticated using (app.is_active_user());
create policy read_wf_versions on public.workflow_definition_versions for select to authenticated using (app.is_active_user());
create policy read_wf_stages on public.workflow_stages for select to authenticated using (app.is_active_user());
create policy read_wf_transitions on public.workflow_transitions for select to authenticated using (app.is_active_user());
create policy read_app_types on public.application_types for select to authenticated using (app.is_active_user());
create policy read_doc_requirements on public.document_requirements for select to authenticated using (app.is_active_user());
create policy read_escalation_rules on public.escalation_rules for select to authenticated using (app.is_staff());
create policy read_system_settings on public.system_settings for select to authenticated using (app.is_active_user());
create policy read_integrations on public.integration_settings for select to authenticated using (app.is_staff());

-- Identity
create policy read_profiles on public.profiles for select to authenticated
  using (id = auth.uid() or app.is_staff());
create policy read_role_assignments on public.user_role_assignments for select to authenticated
  using (user_id = auth.uid()
         or (app.has_capability('user_admin') and (app.is_national_admin() or app.can_read_region(region_code))));
create policy read_institutions on public.institutions for select to authenticated
  using (app.can_read_institution(id));
create policy read_memberships on public.institution_memberships for select to authenticated
  using (user_id = auth.uid() or app.is_staff());
create policy read_grants on public.institution_access_grants for select to authenticated
  using (grantee_institution_id in (select app.member_institution_ids(false))
         or target_institution_id in (select app.member_institution_ids(false))
         or app.is_staff());

-- Applications and children
create policy read_applications on public.applications for select to authenticated
  using (institution_id in (select app.readable_institution_ids())
         or app.can_read_region(region_code)
         or assigned_officer_id = auth.uid());
create policy read_stage_history on public.application_stage_history for select to authenticated
  using (app.can_read_application(application_id));
create policy read_events on public.application_events for select to authenticated
  using (app.can_read_application(application_id) and (visibility = 'shared' or app.is_staff()));
create policy read_assignments on public.application_assignments for select to authenticated
  using (app.is_staff() and app.can_read_application(application_id));
create policy read_observations on public.application_observations for select to authenticated
  using (app.can_read_application(application_id) and (visibility = 'shared' or app.is_staff()));
create policy read_decisions on public.application_decisions for select to authenticated
  using (app.can_read_application(application_id));

create policy read_documents on public.documents for select to authenticated
  using (app.can_read_institution(institution_id));
create policy read_document_versions on public.document_versions for select to authenticated
  using (exists (select 1 from documents d where d.id = document_id and app.can_read_institution(d.institution_id)));
create policy read_check_runs on public.document_check_runs for select to authenticated
  using (app.can_read_institution(institution_id));
create policy read_check_findings on public.document_check_findings for select to authenticated
  using (exists (select 1 from document_check_runs r where r.id = run_id and app.can_read_institution(r.institution_id)));

create policy read_deficiencies on public.deficiencies for select to authenticated
  using (app.can_read_application(application_id));
create policy read_deficiency_submissions on public.deficiency_submissions for select to authenticated
  using (exists (select 1 from deficiencies d where d.id = deficiency_id and app.can_read_application(d.application_id)));
create policy read_deficiency_reviews on public.deficiency_reviews for select to authenticated
  using (exists (select 1 from deficiencies d where d.id = deficiency_id and app.can_read_application(d.application_id)));

create or replace function app.is_evc_participant(p_evc_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from evc_participants where evc_id = p_evc_id and user_id = auth.uid())
$$;

create policy read_evc on public.evc_records for select to authenticated
  using (app.can_read_application(application_id) or app.is_evc_participant(id));
create or replace function app.can_read_evc(p_evc_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from evc_records e where e.id = p_evc_id
                 and (app.can_read_application(e.application_id) or app.is_evc_participant(e.id)))
$$;

create policy read_evc_participants on public.evc_participants for select to authenticated
  using (app.can_read_evc(evc_id));
create policy read_evc_history on public.evc_history for select to authenticated
  using (app.can_read_evc(evc_id));

-- Compliance
create policy read_validities on public.document_validities for select to authenticated
  using (app.can_read_institution(institution_id));
create policy read_obligations on public.compliance_obligations for select to authenticated
  using (institution_id in (select app.readable_institution_ids()) or app.can_read_region(region_code));
create policy read_compliance_submissions on public.compliance_submissions for select to authenticated
  using (exists (select 1 from compliance_obligations o where o.id = obligation_id
                 and (o.institution_id in (select app.readable_institution_ids()) or app.can_read_region(o.region_code))));
create policy read_compliance_verifications on public.compliance_verifications for select to authenticated
  using (exists (select 1 from compliance_obligations o where o.id = obligation_id
                 and (o.institution_id in (select app.readable_institution_ids()) or app.can_read_region(o.region_code))));

-- Work, alerts and audit
create policy read_tasks on public.tasks for select to authenticated
  using (assignee_id = auth.uid() or app.can_read_region(region_code));
create policy read_own_notifications on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy read_delivery_attempts on public.notification_delivery_attempts for select to authenticated
  using (exists (select 1 from notifications n where n.id = notification_id and n.recipient_id = auth.uid())
         or app.has_capability('escalation'));
create policy read_own_preferences on public.notification_preferences for select to authenticated
  using (user_id = auth.uid());
create policy read_escalations on public.escalation_events for select to authenticated
  using (app.can_read_region(region_code));
create policy read_job_runs on public.scheduled_job_runs for select to authenticated
  using (app.has_role('admin'));
create policy read_audit on public.audit_logs for select to authenticated
  using ((app.has_capability('audit') and (app.is_national_admin() or app.can_read_region(region_code)))
         or (application_id is not null and app.is_staff() and app.can_read_application(application_id)));
create policy read_report_exports on public.report_exports for select to authenticated
  using (generated_by = auth.uid() or app.is_national_admin());

-- Names only, for timelines and assignment pickers. Emails and phones stay in profiles.
create view public.profile_directory as
  select p.id, p.full_name, p.designation,
         (select array_agg(distinct r.role::text) from user_role_assignments r where r.user_id = p.id and r.is_active) as roles
  from profiles p where p.is_active;
revoke all on public.profile_directory from anon;
grant select on public.profile_directory to authenticated;
