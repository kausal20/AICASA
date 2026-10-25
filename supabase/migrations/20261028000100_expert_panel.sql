-- Expert panel routing.
--  * An Expert registry (specializations, home district, home institution, region, availability windows).
--  * Panel recommendation inputs, with three hard exclusions enforced on the server when an expert is assigned:
--    same district as the institute, home institution is the institute, declared conflict against the institute.
--  * Geo-tagged, server-time-stamped inspection report uploads against an EVC session. A session cannot be completed
--    until at least one report has been uploaded.
-- Experts are a registry of people the EVC coordinator may call on; an expert only has a sign-in account when linked to a profile.

alter table public.institutions add column if not exists district text;
alter table public.institutions add column if not exists programmes text[] not null default '{}';

update public.institutions set district = 'Pune', programmes = '{CSE,Mechanical,Civil}' where code = 'DEMO-WR-001' and district is null;
update public.institutions set district = 'Nashik', programmes = '{CSE,Mechanical,Civil}' where code = 'DEMO-WR-002' and district is null;
update public.institutions set district = 'Aurangabad', programmes = '{CSE,ECE,Pharmacy}' where code = 'DEMO-WR-003' and district is null;
update public.institutions set district = 'Chennai', programmes = '{Management}' where code = 'DEMO-SR-001' and district is null;

-- ---------------------------------------------------------------------------
-- Experts
-- ---------------------------------------------------------------------------
create table public.experts (
  id uuid primary key default gen_random_uuid(),
  code text unique,                                  -- demo identifier, not an official register number
  full_name text not null check (length(trim(full_name)) >= 3),
  specializations text[] not null check (cardinality(specializations) >= 1),
  home_district text not null check (length(trim(home_district)) >= 2),
  home_state text not null check (length(trim(home_state)) >= 2),
  home_institution_id uuid references public.institutions (id),
  home_institution_name text,                        -- for an employer that is not in the institution registry
  region_code text not null references public.regions (code),
  profile_id uuid unique references public.profiles (id),
  is_active boolean not null default true,
  is_demo boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.experts (region_code) where is_active;

create table public.expert_availability (
  id uuid primary key default gen_random_uuid(),
  expert_id uuid not null references public.experts (id) on delete cascade,
  kind text not null check (kind in ('available', 'unavailable')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  recorded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_reason text,
  check (ends_at > starts_at)
);
create index on public.expert_availability (expert_id) where withdrawn_at is null;

create table public.evc_panel_experts (
  evc_id uuid not null references public.evc_records (id) on delete cascade,
  expert_id uuid not null references public.experts (id),
  assigned_by uuid not null references public.profiles (id),
  assigned_at timestamptz not null default now(),
  primary key (evc_id, expert_id)
);

-- Declared conflicts can now also be recorded against an expert (the existing officer declarations keep working).
alter table public.evc_conflict_declarations alter column user_id drop not null;
alter table public.evc_conflict_declarations add column if not exists expert_id uuid references public.experts (id);
alter table public.evc_conflict_declarations add constraint conflict_subject check (num_nonnulls(user_id, expert_id) = 1);
create unique index one_active_expert_conflict on public.evc_conflict_declarations (expert_id, institution_id)
  where withdrawn_at is null and expert_id is not null;

-- ---------------------------------------------------------------------------
-- Inspection reports (private bucket, one folder per EVC session)
-- ---------------------------------------------------------------------------
create table public.evc_reports (
  id uuid primary key default gen_random_uuid(),
  evc_id uuid not null references public.evc_records (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id),
  storage_bucket text not null default 'evc-reports',
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null check (mime_type = 'application/pdf'),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text,
  latitude numeric(9, 6) not null check (latitude between -90 and 90),
  longitude numeric(9, 6) not null check (longitude between -180 and 180),
  geo_source text not null check (geo_source in ('browser', 'manual')),
  geo_accuracy_m numeric check (geo_accuracy_m is null or geo_accuracy_m >= 0),
  note text,
  uploaded_at timestamptz not null default now()      -- server time; the browser clock is never trusted
);
create index on public.evc_reports (evc_id);
create trigger evc_reports_append_only before update or delete on public.evc_reports
  for each row execute function app.block_mutation();

alter table public.experts enable row level security;
alter table public.expert_availability enable row level security;
alter table public.evc_panel_experts enable row level security;
alter table public.evc_reports enable row level security;

create or replace function app.is_expert_on_panel(p_evc_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from evc_panel_experts pe join experts x on x.id = pe.expert_id
                 where pe.evc_id = p_evc_id and x.profile_id = auth.uid() and x.is_active)
$$;

-- A report can be added by a panel member (officer participant or an assigned expert with an account) to a confirmed session.
create or replace function app.can_upload_evc_report(p_evc_id uuid) returns boolean
language sql stable security definer set search_path = public, app as $$
  select app.is_active_user() and exists (
    select 1 from evc_records e where e.id = p_evc_id and e.status = 'scheduled'
      and (app.is_evc_participant(e.id) or app.is_expert_on_panel(e.id)))
$$;

create policy read_experts on public.experts for select to authenticated using (app.is_staff());
create policy read_expert_availability on public.expert_availability for select to authenticated using (app.is_staff());
create policy read_evc_panel_experts on public.evc_panel_experts for select to authenticated
  using ((app.is_staff() and app.can_read_evc(evc_id)) or app.is_evc_participant(evc_id) or app.is_expert_on_panel(evc_id));
create policy read_evc_reports on public.evc_reports for select to authenticated
  using ((app.is_staff() and app.can_read_evc(evc_id)) or app.is_evc_participant(evc_id) or app.is_expert_on_panel(evc_id));
revoke all on public.experts, public.expert_availability, public.evc_panel_experts, public.evc_reports from anon, authenticated;
grant select on public.experts, public.expert_availability, public.evc_panel_experts, public.evc_reports to authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evc-reports', 'evc-reports', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy evc_report_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'evc-reports'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
    and app.can_upload_evc_report(app.storage_institution(name))
  );
create policy evc_report_read on storage.objects for select to authenticated
  using (bucket_id = 'evc-reports' and (
    (app.is_staff() and app.can_read_evc(app.storage_institution(name)))
    or app.is_evc_participant(app.storage_institution(name)) or app.is_expert_on_panel(app.storage_institution(name))));

-- ---------------------------------------------------------------------------
-- Exclusion rules (single definition used when an expert is assigned; the recommender shows the same reasons)
-- ---------------------------------------------------------------------------
create or replace function app.expert_exclusions(p_expert_id uuid, p_institution_id uuid) returns text[]
language plpgsql stable security definer set search_path = public, app as $$
declare e experts; i institutions; r text[] := '{}'; v_home text;
begin
  select * into e from experts where id = p_expert_id;
  select * into i from institutions where id = p_institution_id;
  if e.id is null or i.id is null then return r; end if;
  v_home := coalesce((select name from institutions where id = e.home_institution_id), e.home_institution_name);
  if e.home_institution_id = i.id or (v_home is not null and lower(trim(v_home)) = lower(trim(i.name))) then
    r := r || 'affiliated'::text;
  end if;
  if exists (select 1 from evc_conflict_declarations d
             where d.withdrawn_at is null and d.institution_id = i.id
               and (d.expert_id = e.id or (e.profile_id is not null and d.user_id = e.profile_id))) then
    r := r || 'declared_conflict'::text;
  end if;
  if i.district is not null and lower(trim(e.home_district)) = lower(trim(i.district))
     and lower(trim(e.home_state)) = lower(trim(i.state)) then
    r := r || 'same_district'::text;
  end if;
  return r;
end $$;
revoke execute on function app.expert_exclusions(uuid, uuid) from public, anon, authenticated;

create or replace function app.expert_exclusion_text(p_codes text[]) returns text
language sql immutable as $$
  select string_agg('Excluded — ' || case c when 'same_district' then 'same district as institute'
                                              when 'declared_conflict' then 'declared conflict'
                                              when 'affiliated' then 'affiliated with this institute' else c end, '; ')
  from unnest(p_codes) c
$$;

-- ---------------------------------------------------------------------------
-- Expert registry maintenance
-- ---------------------------------------------------------------------------
create or replace function app.require_expert_admin(p_region text) returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not app.is_staff() or not (app.has_capability('assignment') or app.has_capability('user_admin') or app.has_capability('evc')) then
    perform app.fail('forbidden', 'Managing experts needs the EVC, assignment or user-admin responsibility.');
  end if;
  if not (app.is_national_admin() or app.can_read_region(p_region)) then
    perform app.fail('forbidden', 'This expert is outside your region scope.');
  end if;
end $$;
revoke execute on function app.require_expert_admin(text) from public, anon, authenticated;

create or replace function public.upsert_expert(
  p_id uuid, p_full_name text, p_specializations text[], p_home_district text, p_home_state text,
  p_home_institution_id uuid, p_home_institution_name text, p_region_code text, p_profile_id uuid,
  p_is_active boolean default true
) returns public.experts
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row experts; v_specs text[]; v_before jsonb;
begin
  perform app.require_expert_admin(p_region_code);
  if not exists (select 1 from regions where code = p_region_code) then perform app.fail('validation', 'Choose a region.'); end if;
  v_specs := array(select distinct trim(x) from unnest(coalesce(p_specializations, '{}')) x where length(trim(x)) > 0);
  if cardinality(v_specs) < 1 then perform app.fail('validation', 'Add at least one specialization (for example CSE or Civil).'); end if;
  if length(trim(coalesce(p_full_name, ''))) < 3 then perform app.fail('validation', 'Enter the expert''s name.'); end if;
  if length(trim(coalesce(p_home_district, ''))) < 2 or length(trim(coalesce(p_home_state, ''))) < 2 then
    perform app.fail('validation', 'Home district and state are needed so that same-district conflicts can be detected.');
  end if;
  if p_home_institution_id is not null and not exists (select 1 from institutions where id = p_home_institution_id) then
    perform app.fail('validation', 'Home institution not found.');
  end if;
  if p_id is null then
    insert into experts (full_name, specializations, home_district, home_state, home_institution_id, home_institution_name,
                         region_code, profile_id, is_active, created_by)
    values (trim(p_full_name), v_specs, trim(p_home_district), trim(p_home_state), p_home_institution_id,
            nullif(trim(coalesce(p_home_institution_name, '')), ''), p_region_code, p_profile_id, coalesce(p_is_active, true), v_uid)
    returning * into v_row;
    perform app.audit('expert_created', 'expert', v_row.id, null, null, v_row.region_code, null, null, to_jsonb(v_row));
  else
    select to_jsonb(x) into v_before from experts x where id = p_id for update;
    if v_before is null then perform app.fail('not_found', 'Expert not found.'); end if;
    update experts set full_name = trim(p_full_name), specializations = v_specs, home_district = trim(p_home_district),
      home_state = trim(p_home_state), home_institution_id = p_home_institution_id,
      home_institution_name = nullif(trim(coalesce(p_home_institution_name, '')), ''), region_code = p_region_code,
      profile_id = p_profile_id, is_active = coalesce(p_is_active, true), updated_at = now()
    where id = p_id returning * into v_row;
    perform app.audit('expert_updated', 'expert', v_row.id, null, null, v_row.region_code, null, v_before, to_jsonb(v_row));
  end if;
  return v_row;
end $$;

create or replace function public.record_expert_availability(p_expert_id uuid, p_kind text, p_start timestamptz, p_end timestamptz, p_note text)
returns public.expert_availability
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_exp experts; v_row expert_availability;
begin
  select * into v_exp from experts where id = p_expert_id;
  if v_exp.id is null then perform app.fail('not_found', 'Expert not found.'); end if;
  if v_exp.profile_id is distinct from v_uid then perform app.require_expert_admin(v_exp.region_code); end if;
  if p_kind not in ('available', 'unavailable') then perform app.fail('validation', 'Choose available or unavailable.'); end if;
  if p_start is null or p_end is null or p_end <= p_start or p_end - p_start > interval '92 days' then
    perform app.fail('validation', 'Give a start and an end; a window can cover at most 92 days.');
  end if;
  if p_end <= now() then perform app.fail('validation', 'The window must end in the future.'); end if;
  insert into expert_availability (expert_id, kind, starts_at, ends_at, note, recorded_by)
  values (p_expert_id, p_kind, p_start, p_end, nullif(trim(coalesce(p_note, '')), ''), v_uid) returning * into v_row;
  perform app.audit('expert_availability_recorded', 'expert_availability', v_row.id, null, null, v_exp.region_code, v_row.note, null,
    jsonb_build_object('expert_id', p_expert_id, 'kind', p_kind, 'start', p_start, 'end', p_end));
  return v_row;
end $$;

create or replace function public.withdraw_expert_availability(p_id uuid, p_reason text) returns public.expert_availability
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row expert_availability; v_exp experts;
begin
  select * into v_row from expert_availability where id = p_id for update;
  if v_row.id is null then perform app.fail('not_found', 'Availability entry not found.'); end if;
  select * into v_exp from experts where id = v_row.expert_id;
  if v_exp.profile_id is distinct from v_uid then perform app.require_expert_admin(v_exp.region_code); end if;
  if v_row.withdrawn_at is not null then perform app.fail('invalid_state', 'Already withdrawn.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then perform app.fail('reason_required', 'Give a short reason.'); end if;
  update expert_availability set withdrawn_at = now(), withdrawn_reason = trim(p_reason) where id = p_id returning * into v_row;
  perform app.audit('expert_availability_withdrawn', 'expert_availability', v_row.id, null, null, v_exp.region_code, trim(p_reason));
  return v_row;
end $$;

-- A declared conflict of an expert against an institute: by the expert (when they have an account) or by an officer on their behalf.
create or replace function public.declare_expert_conflict(p_expert_id uuid, p_institution_id uuid, p_nature text)
returns public.evc_conflict_declarations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_exp experts; v_inst institutions; v_row evc_conflict_declarations;
begin
  select * into v_exp from experts where id = p_expert_id;
  if v_exp.id is null then perform app.fail('not_found', 'Expert not found.'); end if;
  if v_exp.profile_id is distinct from v_uid then perform app.require_expert_admin(v_exp.region_code); end if;
  select * into v_inst from institutions where id = p_institution_id;
  if v_inst.id is null then perform app.fail('not_found', 'Institution not found.'); end if;
  if length(trim(coalesce(p_nature, ''))) < 10 then perform app.fail('validation', 'Describe the nature of the conflict (at least 10 characters).'); end if;
  if exists (select 1 from evc_conflict_declarations where expert_id = p_expert_id and institution_id = p_institution_id and withdrawn_at is null) then
    perform app.fail('invalid_state', 'A conflict with this institution is already on record for this expert.');
  end if;
  insert into evc_conflict_declarations (expert_id, institution_id, nature, declared_by)
  values (p_expert_id, p_institution_id, trim(p_nature), v_uid) returning * into v_row;
  perform app.audit('evc_conflict_declared', 'evc_conflict_declaration', v_row.id, null, p_institution_id, v_inst.region_code, trim(p_nature),
    null, jsonb_build_object('expert_id', p_expert_id));
  return v_row;
end $$;

-- Withdrawing: officer declarations keep their rule; an expert's declaration is withdrawn by another authorised person
-- in the expert's region, never by the expert themselves.
create or replace function public.withdraw_evc_conflict(p_id uuid, p_reason text) returns public.evc_conflict_declarations
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_row evc_conflict_declarations; v_exp experts;
begin
  select * into v_row from evc_conflict_declarations where id = p_id for update;
  if v_row.id is null then perform app.fail('not_found', 'Declaration not found.'); end if;
  if v_row.expert_id is not null then
    select * into v_exp from experts where id = v_row.expert_id;
    if v_exp.profile_id = v_uid then
      perform app.fail('forbidden', 'Only another officer or administrator with the assignment responsibility can withdraw a declared conflict.');
    end if;
    perform app.require_expert_admin(v_exp.region_code);
  elsif not app.can_manage_officer(v_row.user_id) or v_row.user_id = v_uid then
    perform app.fail('forbidden', 'Only another officer or administrator with the assignment responsibility can withdraw a declared conflict.');
  end if;
  if v_row.withdrawn_at is not null then perform app.fail('invalid_state', 'Already withdrawn.'); end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then perform app.fail('reason_required', 'A reason of at least 10 characters is required.'); end if;
  update evc_conflict_declarations set withdrawn_at = now(), withdrawn_by = v_uid, withdrawn_reason = trim(p_reason)
  where id = p_id returning * into v_row;
  perform app.audit('evc_conflict_withdrawn', 'evc_conflict_declaration', v_row.id, null, v_row.institution_id, null, trim(p_reason));
  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- Panel recommendation inputs and assignment
-- ---------------------------------------------------------------------------
-- Raw facts only. Ranking and the exclusion reasons are produced by the matcher (src/lib/expertMatch.ts); assign_evc_expert
-- re-checks the same three rules on the server so an excluded expert can never be added, whatever the browser sends.
create or replace function public.expert_match_inputs(p_evc_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare v_evc evc_records; v_app applications; v_inst institutions;
begin
  perform app.require_user();
  select * into v_evc from evc_records where id = p_evc_id;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  if not (app.is_staff() and app.can_read_application(v_app.id)) then perform app.fail('forbidden', 'Only AICTE staff can see panel recommendations.'); end if;
  select * into v_inst from institutions where id = v_app.institution_id;
  return jsonb_build_object(
    'evc', jsonb_build_object('id', v_evc.id, 'status', v_evc.status, 'scheduled_start', v_evc.scheduled_start, 'scheduled_end', v_evc.scheduled_end),
    'institution', jsonb_build_object('id', v_inst.id, 'name', v_inst.name, 'district', v_inst.district, 'state', v_inst.state,
                                      'region_code', v_inst.region_code, 'programmes', to_jsonb(v_inst.programmes)),
    'programme_text', coalesce(v_app.form_data ->> 'programme', v_app.form_data ->> 'proposed_programmes', ''),
    'experts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', x.id, 'full_name', x.full_name, 'specializations', to_jsonb(x.specializations),
        'home_district', x.home_district, 'home_state', x.home_state, 'home_institution_id', x.home_institution_id,
        'home_institution_name', coalesce(hi.name, x.home_institution_name), 'region_code', x.region_code, 'profile_id', x.profile_id,
        'declared_conflicts', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'nature', d.nature, 'declared_at', d.declared_at)), '[]'::jsonb)
                               from evc_conflict_declarations d
                               where d.withdrawn_at is null and d.institution_id = v_inst.id
                                 and (d.expert_id = x.id or (x.profile_id is not null and d.user_id = x.profile_id))),
        'availability', (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'note', a.note)
                                                  order by a.starts_at), '[]'::jsonb)
                         from expert_availability a where a.expert_id = x.id and a.withdrawn_at is null and a.ends_at > now()),
        'assigned', exists (select 1 from evc_panel_experts pe where pe.evc_id = v_evc.id and pe.expert_id = x.id)
      ) order by x.full_name), '[]'::jsonb)
      from experts x left join institutions hi on hi.id = x.home_institution_id where x.is_active)
  );
end $$;

create or replace function public.assign_evc_expert(p_evc_id uuid, p_expert_id uuid, p_expected_version integer)
returns public.evc_panel_experts
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_exp experts; v_row evc_panel_experts; v_ex text[];
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  perform app.require_evc_officer(v_evc, v_app);
  if v_evc.row_version <> p_expected_version then perform app.fail('stale', 'This EVC record changed. Refresh first.'); end if;
  if v_evc.status not in ('awaiting_scheduling', 'proposed', 'scheduled') then
    perform app.fail('invalid_state', 'Experts can be added only before the session is completed or cancelled.');
  end if;
  select * into v_exp from experts where id = p_expert_id;
  if v_exp.id is null or not v_exp.is_active then perform app.fail('not_found', 'Expert not found or not active.'); end if;
  v_ex := app.expert_exclusions(v_exp.id, v_app.institution_id);
  if cardinality(v_ex) > 0 then
    perform app.fail('conflict_of_interest', app.expert_exclusion_text(v_ex) || '. ' || v_exp.full_name || ' cannot be assigned to this institute''s panel.');
  end if;
  if exists (select 1 from evc_panel_experts where evc_id = p_evc_id and expert_id = p_expert_id) then
    perform app.fail('invalid_state', 'This expert is already on the panel.');
  end if;
  insert into evc_panel_experts (evc_id, expert_id, assigned_by) values (p_evc_id, p_expert_id, v_uid) returning * into v_row;
  insert into evc_history (evc_id, action, reason, actor_id) values (p_evc_id, 'expert_assigned', v_exp.full_name, v_uid);
  insert into application_events (application_id, event_type, summary, actor_id, visibility, metadata)
  values (v_app.id, 'evc_expert_assigned', 'Expert added to the EVC panel: ' || v_exp.full_name, v_uid, 'internal',
          jsonb_build_object('evc_id', p_evc_id, 'expert_id', p_expert_id));
  perform app.audit('evc_expert_assigned', 'evc', p_evc_id, v_app.id, v_app.institution_id, v_app.region_code, null, null,
    jsonb_build_object('expert_id', p_expert_id, 'expert', v_exp.full_name));
  return v_row;
end $$;

create or replace function public.remove_evc_expert(p_evc_id uuid, p_expert_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_exp experts;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  perform app.require_evc_officer(v_evc, v_app);
  if v_evc.status not in ('awaiting_scheduling', 'proposed', 'scheduled') then
    perform app.fail('invalid_state', 'The panel cannot change after the session is completed or cancelled.');
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then perform app.fail('reason_required', 'Give a short reason.'); end if;
  select * into v_exp from experts where id = p_expert_id;
  delete from evc_panel_experts where evc_id = p_evc_id and expert_id = p_expert_id;
  if not found then perform app.fail('not_found', 'This expert is not on the panel.'); end if;
  insert into evc_history (evc_id, action, reason, actor_id) values (p_evc_id, 'expert_removed', v_exp.full_name || ': ' || trim(p_reason), v_uid);
  perform app.audit('evc_expert_removed', 'evc', p_evc_id, v_app.id, v_app.institution_id, v_app.region_code, trim(p_reason), null,
    jsonb_build_object('expert_id', p_expert_id));
end $$;

-- ---------------------------------------------------------------------------
-- Inspection reports
-- ---------------------------------------------------------------------------
create or replace function public.register_evc_report(
  p_evc_id uuid, p_storage_path text, p_file_name text, p_sha256 text,
  p_latitude numeric, p_longitude numeric, p_geo_source text, p_accuracy_m numeric default null, p_note text default null
) returns public.evc_reports
language plpgsql security definer set search_path = public, app, storage as $$
declare
  v_uid uuid := app.require_user(); v_evc evc_records; v_app applications; v_obj record; v_row evc_reports;
begin
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC record not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  if not (app.is_evc_participant(v_evc.id) or app.is_expert_on_panel(v_evc.id)) then
    perform app.fail('forbidden', 'Only a member of this EVC panel can upload its inspection report.');
  end if;
  if v_evc.status <> 'scheduled' then perform app.fail('invalid_state', 'Reports can be uploaded only against a confirmed (scheduled) session.'); end if;
  if v_evc.scheduled_start > now() then perform app.fail('invalid_state', 'The session has not started yet; upload the report once the inspection has taken place.'); end if;
  if p_storage_path !~ ('^' || p_evc_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') then
    perform app.fail('validation', 'Storage key is not in the expected EVC folder format.');
  end if;
  if p_latitude is null or p_longitude is null or p_latitude = 'NaN' or p_longitude = 'NaN'
     or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    perform app.fail('geo_required', 'A geo-tag is required: latitude between -90 and 90 and longitude between -180 and 180.');
  end if;
  if p_geo_source not in ('browser', 'manual') then perform app.fail('validation', 'Say whether the location came from the browser or was entered manually.'); end if;
  if p_accuracy_m is not null and (p_accuracy_m = 'NaN' or p_accuracy_m < 0) then perform app.fail('validation', 'Location accuracy must be zero or more metres.'); end if;
  if length(trim(coalesce(p_file_name, ''))) < 1 then perform app.fail('validation', 'File name is required.'); end if;

  select o.name, (o.metadata ->> 'size')::bigint as size, o.metadata ->> 'mimetype' as mimetype into v_obj
  from storage.objects o where o.bucket_id = 'evc-reports' and o.name = p_storage_path;
  if v_obj.name is null then perform app.fail('upload_missing', 'The uploaded file was not found in private storage. Retry the upload.'); end if;
  if v_obj.mimetype is distinct from 'application/pdf' then perform app.fail('file_type', 'The inspection report must be a PDF.'); end if;
  if v_obj.size is null or v_obj.size <= 0 or v_obj.size > 10485760 then perform app.fail('file_size', 'File size must be between 1 byte and 10 MB.'); end if;

  insert into evc_reports (evc_id, uploaded_by, storage_path, file_name, mime_type, size_bytes, sha256, latitude, longitude, geo_source,
                           geo_accuracy_m, note)
  values (p_evc_id, v_uid, p_storage_path, left(trim(p_file_name), 200), 'application/pdf', v_obj.size, nullif(lower(coalesce(p_sha256, '')), ''),
          round(p_latitude, 6), round(p_longitude, 6), p_geo_source, p_accuracy_m, nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_row;
  insert into evc_history (evc_id, action, reason, actor_id)
  values (p_evc_id, 'report_uploaded', left(trim(p_file_name), 200) || ' (' || v_row.latitude || ', ' || v_row.longitude || ')', v_uid);
  insert into application_events (application_id, event_type, summary, actor_id, visibility, metadata)
  values (v_app.id, 'evc_report_uploaded',
          'EVC inspection report uploaded (' || v_row.file_name || ') — geo-tagged ' || v_row.latitude || ', ' || v_row.longitude,
          v_uid, 'internal',
          jsonb_build_object('evc_id', p_evc_id, 'report_id', v_row.id, 'latitude', v_row.latitude, 'longitude', v_row.longitude,
                             'geo_source', v_row.geo_source, 'uploaded_at', v_row.uploaded_at));
  perform app.audit('evc_report_uploaded', 'evc_report', v_row.id, v_app.id, v_app.institution_id, v_app.region_code, null, null,
    jsonb_build_object('evc_id', p_evc_id, 'file', v_row.file_name, 'latitude', v_row.latitude, 'longitude', v_row.longitude,
                       'geo_source', v_row.geo_source, 'sha256_recorded', v_row.sha256 is not null));
  return v_row;
end $$;

-- A session cannot be completed until at least one inspection report is on file.
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
  if not exists (select 1 from evc_reports where evc_id = v_evc.id) then
    perform app.fail('report_required', 'Upload the inspection report (a PDF with its geo-tag) before the session can be marked completed.');
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
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.upsert_expert(uuid, text, text[], text, text, uuid, text, text, uuid, boolean),
  public.record_expert_availability(uuid, text, timestamptz, timestamptz, text),
  public.withdraw_expert_availability(uuid, text),
  public.declare_expert_conflict(uuid, uuid, text),
  public.expert_match_inputs(uuid),
  public.assign_evc_expert(uuid, uuid, integer),
  public.remove_evc_expert(uuid, uuid, text),
  public.register_evc_report(uuid, text, text, text, numeric, numeric, text, numeric, text),
  public.complete_evc(uuid, text, text, integer)
from public, anon;
grant execute on function
  public.upsert_expert(uuid, text, text[], text, text, uuid, text, text, uuid, boolean),
  public.record_expert_availability(uuid, text, timestamptz, timestamptz, text),
  public.withdraw_expert_availability(uuid, text),
  public.declare_expert_conflict(uuid, uuid, text),
  public.expert_match_inputs(uuid),
  public.assign_evc_expert(uuid, uuid, integer),
  public.remove_evc_expert(uuid, uuid, text),
  public.register_evc_report(uuid, text, text, text, numeric, numeric, text, numeric, text),
  public.complete_evc(uuid, text, text, integer)
to authenticated, service_role;
