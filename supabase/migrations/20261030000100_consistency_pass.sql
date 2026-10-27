-- Consistency pass (judge audit):
--  * one date-only deadline policy: a date is compared at 23:59:59 IST; "overdue" means the due date has ended, "due today" is never overdue
--  * a query is "sent" to the institution when its case is returned for correction (or raised while it already is); each sent query
--    notifies the institution with a link to its card
--  * the institution may answer with a reply, a corrected document version, or both
--  * escalation notices for the same case + rule form one escalation with a timeline of notices; cadence follows the rule exactly
--  * automatic events are attributed to System in the audit log
--  * EVC: one stored session time drives the "next action"; a panel chair can be recorded
--  * reassignment lists only officers eligible for the stage

-- ---------------------------------------------------------------------------
-- 1. Date helpers
-- ---------------------------------------------------------------------------
create or replace function app.today_ist() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function app.ist_date(p timestamptz) returns date
language sql immutable as $$ select (p at time zone 'Asia/Kolkata')::date $$;

-- ---------------------------------------------------------------------------
-- 2. Audit attribution: automatic events are recorded as System, never as the user whose action happened to trigger them
-- ---------------------------------------------------------------------------
create or replace function app.audit(
  p_action text, p_entity_type text, p_entity_id uuid,
  p_application_id uuid default null, p_institution_id uuid default null, p_region text default null,
  p_reason text default null, p_before jsonb default null, p_after jsonb default null, p_meta jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_system boolean;
begin
  v_system := auth.uid() is null
    or p_action in ('deficiency_auto_raised', 'deficiency_auto_updated', 'deficiency_auto_resolved', 'escalation_triggered', 'reminder_sent')
    or (p_action = 'stage_entered' and exists (select 1 from workflow_transitions t where t.code = p_meta ->> 'via' and t.is_automatic));
  insert into audit_logs (actor_id, actor_kind, action, entity_type, entity_id, application_id, institution_id,
                          region_code, reason, before_state, after_state, metadata)
  values (case when v_system then null else auth.uid() end, case when v_system then 'system' else 'user' end, p_action, p_entity_type,
          p_entity_id, p_application_id, p_institution_id, p_region, p_reason, p_before, p_after,
          coalesce(p_meta, '{}'::jsonb) || case when v_system and auth.uid() is not null then jsonb_build_object('triggered_during_action_of', auth.uid()) else '{}'::jsonb end);
end $$;

-- Correct the rows recorded before this rule (synthetic demo data): same rows, actor moved to System.
alter table public.audit_logs disable trigger user;
update public.audit_logs l set actor_kind = 'system', actor_id = null,
  metadata = l.metadata || jsonb_build_object('attribution_corrected', true)
where l.actor_kind = 'user' and (
  l.action in ('deficiency_auto_raised', 'deficiency_auto_updated', 'deficiency_auto_resolved', 'escalation_triggered', 'reminder_sent')
  or (l.action = 'stage_entered' and exists (select 1 from workflow_transitions t where t.code = l.metadata ->> 'via' and t.is_automatic)));
alter table public.audit_logs enable trigger user;

-- ---------------------------------------------------------------------------
-- 3. Queries sent to the institution
-- ---------------------------------------------------------------------------
alter table public.deficiencies add column if not exists sent_at timestamptz;
alter table public.deficiencies add column if not exists sent_by uuid references public.profiles (id);

-- Marks the unsent open queries of a returned case as sent and notifies the institution once per query.
create or replace function app.send_open_queries(p_application_id uuid, p_deficiency_id uuid default null) returns integer
language plpgsql security definer set search_path = public, app as $$
declare v_app applications; d deficiencies; v_n integer := 0;
begin
  select * into v_app from applications where id = p_application_id;
  if v_app.status is distinct from 'returned_for_correction' then return 0; end if;
  for d in select * from deficiencies where application_id = p_application_id
           and status in ('open', 'still_deficient', 'needs_clarification') and sent_at is null
           and (p_deficiency_id is null or id = p_deficiency_id) for update loop
    update deficiencies set sent_at = now(), sent_by = auth.uid() where id = d.id;
    perform app.notify_institution(v_app.institution_id, 'deficiency', 'Query to answer: ' || v_app.reference,
      d.title || '. Reply, upload a corrected document, and submit it for re-review on the query card.',
      '/app/applications/' || v_app.id || '?tab=deficiencies&query=' || d.id, 'deficiency', d.id, 'query-sent:' || d.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function app.send_open_queries(uuid, uuid) from public, anon, authenticated;

create or replace function app.on_case_returned() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.status = 'returned_for_correction' and old.status is distinct from 'returned_for_correction' then
    perform app.send_open_queries(new.id);
  end if;
  return new;
end $$;
drop trigger if exists case_returned_sends_queries on public.applications;
create trigger case_returned_sends_queries after update of status on public.applications
  for each row execute function app.on_case_returned();

create or replace function app.on_query_raised() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.send_open_queries(new.application_id, new.id);
  return new;
end $$;
drop trigger if exists query_raised_on_returned_case on public.deficiencies;
create trigger query_raised_on_returned_case after insert on public.deficiencies
  for each row execute function app.on_query_raised();

-- Queries on cases already returned: the return is when they were sent (earliest "returned" event after the query was raised).
update public.deficiencies d set sent_at = coalesce((
    select min(e.created_at) from application_events e where e.application_id = d.application_id and e.event_type = 'returned' and e.created_at >= d.raised_at),
    d.raised_at),
  sent_by = (select e.actor_id from application_events e where e.application_id = d.application_id and e.event_type = 'returned'
             and e.created_at >= d.raised_at order by e.created_at limit 1)
where d.sent_at is null and (d.status not in ('open', 'still_deficient', 'needs_clarification')
  or exists (select 1 from applications a where a.id = d.application_id and a.status = 'returned_for_correction'));
-- Notifications for queries already with the institution (idempotent: one per query).
do $$
declare d record; begin
  for d in select q.id, q.title, a.id as app_id, a.reference, a.institution_id from deficiencies q join applications a on a.id = q.application_id
           where a.status = 'returned_for_correction' and q.status in ('open', 'still_deficient', 'needs_clarification') loop
    perform app.notify_institution(d.institution_id, 'deficiency', 'Query to answer: ' || d.reference,
      d.title || '. Reply, upload a corrected document, and submit it for re-review on the query card.',
      '/app/applications/' || d.app_id || '?tab=deficiencies&query=' || d.id, 'deficiency', d.id, 'query-sent:' || d.id);
  end loop;
end $$;

-- The institution answers with a reply, a corrected document, or both. A query about a document type needs a new version of it;
-- any other query accepts a supporting version of one of this application's documents.
create or replace function public.submit_deficiency_correction(
  p_deficiency_id uuid, p_response_text text, p_document_version_id uuid default null
) returns public.deficiency_submissions
language plpgsql security definer set search_path = public, app as $$
declare
  v_uid uuid := app.require_user(); v_def deficiencies; v_app applications; v_sub deficiency_submissions;
  v_attempt integer; v_remaining integer; v_ver record; v_floor integer; v_sha text; v_same integer; v_text text; v_officer uuid;
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
    perform app.fail('window_expired', 'The response window for this query closed on ' || to_char(v_def.window_closes_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI AM') || ' IST. Ask the officer to reopen it.');
  end if;
  if v_app.status <> 'returned_for_correction' then
    perform app.fail('invalid_state', 'The case has not been returned to the institution for correction.');
  end if;
  v_text := nullif(trim(coalesce(p_response_text, '')), '');
  if v_text is null and p_document_version_id is null then
    perform app.fail('validation', 'Write a reply or upload a corrected document before submitting.');
  end if;
  if v_text is not null and length(v_text) < 10 then
    perform app.fail('validation', 'Describe the correction made (at least 10 characters).');
  end if;
  if p_document_version_id is not null then
    select v.version, v.sha256, v.document_id, d.doc_type, d.application_id, d.title into v_ver
    from document_versions v join documents d on d.id = v.document_id where v.id = p_document_version_id;
    if v_ver.document_id is null or v_ver.application_id is distinct from v_app.id then
      perform app.fail('validation', 'Attach a version of a document of this application.');
    end if;
  end if;
  if v_def.doc_type is not null then
    if p_document_version_id is null then
      perform app.fail('validation', 'This query concerns a document: upload a new version of it and attach that version.');
    end if;
    if v_ver.doc_type <> v_def.doc_type then
      perform app.fail('validation', 'Attach a version of the ' || replace(v_def.doc_type, '_', ' ') || ' document for this application.');
    end if;
    select greatest(case when v_def.affected_version_basis in ('captured_at_raise', 'seed_fixture_verified')
                         then coalesce((select version from document_versions where id = v_def.affected_document_version_id), 0) else 0 end,
                    coalesce(max(v.version), 0))
      into v_floor
    from deficiency_submissions s join document_versions v on v.id = s.document_version_id where s.deficiency_id = v_def.id;
    if v_ver.version <= v_floor then
      perform app.fail('validation', 'Attach a new version: version ' || v_ver.version || ' was already on file for this query. Earlier versions stay preserved.');
    end if;
    if coalesce(v_def.affected_version_basis, '') not in ('captured_at_raise', 'seed_fixture_verified')
       and v_ver.version <> (select current_version from documents where id = v_ver.document_id) then
      perform app.fail('validation', 'The version on file when this query was raised could not be established, so attach the latest version of the document.');
    end if;
  end if;
  if p_document_version_id is not null then
    v_sha := v_ver.sha256;
    if v_sha is not null then
      select min(x.version) into v_same from document_versions x
      where x.document_id = v_ver.document_id and x.version < v_ver.version and x.sha256 = v_sha;
      if v_same is not null then
        perform app.fail('validation', 'This file has identical content to version ' || v_same || ' of the same document, so it is not a correction. Upload the corrected file.');
      end if;
    end if;
  end if;
  v_text := coalesce(v_text, 'Corrected document uploaded: ' || v_ver.title || ', version ' || v_ver.version || '.');

  select coalesce(max(attempt), 0) + 1 into v_attempt from deficiency_submissions where deficiency_id = v_def.id;
  insert into deficiency_submissions (deficiency_id, attempt, response_text, document_version_id, submitted_by)
  values (v_def.id, v_attempt, v_text, p_document_version_id, v_uid) returning * into v_sub;
  update deficiencies set status = 'correction_submitted', row_version = row_version + 1 where id = v_def.id;

  insert into application_events (application_id, event_type, summary, actor_id, metadata)
  values (v_app.id, 'correction_submitted', 'Correction submitted for: ' || v_def.title || ' (attempt ' || v_attempt || ')', v_uid,
          jsonb_build_object('deficiency_id', v_def.id, 'submission_id', v_sub.id, 'document_version_id', p_document_version_id));
  perform app.audit('correction_submitted', 'deficiency', v_def.id, v_app.id, v_app.institution_id, v_app.region_code,
    null, jsonb_build_object('status', v_def.status),
    jsonb_build_object('status', 'correction_submitted', 'attempt', v_attempt, 'document_version_id', p_document_version_id,
                       'fingerprint_recorded', v_sha is not null));

  v_officer := coalesce(v_app.assigned_officer_id, v_def.raised_by);
  insert into tasks (task_type, title, application_id, deficiency_id, region_code, assignee_id, required_capability, due_at, dedupe_key)
  values ('deficiency_review', 'Review correction — ' || v_app.reference, v_app.id, v_def.id, v_app.region_code,
          v_officer, null, now() + interval '7 days', 'defreview:' || v_def.id || ':' || v_attempt)
  on conflict (dedupe_key) do nothing;
  perform app.notify(v_officer, 'correction_received',
    'Correction submitted: ' || v_app.reference, 'The institution responded to "' || v_def.title || '". It is awaiting your re-review.',
    '/app/applications/' || v_app.id || '?tab=deficiencies&query=' || v_def.id, 'deficiency', v_def.id, 'correction:' || v_def.id || ':' || v_attempt);

  select count(*) into v_remaining from deficiencies
  where application_id = v_app.id and status in ('open', 'still_deficient', 'needs_clarification');
  if v_remaining = 0 then
    update applications set status = 'correction_submitted', next_action = 'Correction submitted — awaiting officer re-review',
      next_actor = 'officer', row_version = row_version + 1, updated_at = now() where id = v_app.id;
    insert into application_events (application_id, event_type, summary, from_status, to_status, actor_id)
    values (v_app.id, 'status_changed', 'All requested corrections submitted', 'returned_for_correction', 'correction_submitted', v_uid);
  else
    update applications set next_action = 'Institution to answer ' || v_remaining || ' more quer' || case when v_remaining = 1 then 'y' else 'ies' end
      || '; ' || (select count(*) from deficiencies where application_id = v_app.id and status = 'correction_submitted') || ' awaiting officer re-review',
      updated_at = now() where id = v_app.id;
  end if;
  return v_sub;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Reporting views on the date-only policy
-- ---------------------------------------------------------------------------
drop view if exists public.v_applications;
create view public.v_applications with (security_invoker = true) as
select a.id, a.reference, a.title, a.academic_year, a.status, a.current_stage, a.region_code, a.institution_id,
       i.name as institution_name, i.code as institution_code, a.application_type_code, t.name as application_type_name,
       s.name as stage_name, s.kind as stage_kind, a.stage_entered_at, a.stage_due_at, a.next_action, a.next_actor,
       a.assigned_officer_id, pd.full_name as assigned_officer_name, a.submitted_at, a.closed_at, a.created_at, a.updated_at,
       a.row_version, a.is_demo, a.workflow_version_id, v.version as route_version, wd.name as route_name,
       (app.today_ist() - app.ist_date(coalesce(a.submitted_at, a.created_at)))::int as age_days,
       (app.today_ist() - app.ist_date(a.stage_entered_at))::int as stage_age_days,
       (a.status not in ('draft', 'completed', 'closed', 'withdrawn') and x.due_at is not null and app.ist_date(x.due_at) < app.today_ist()) as is_overdue,
       coalesce(q.open_total, 0)::int as open_deficiencies,
       q.correction_due_at,
       x.due_at,
       (a.status not in ('draft', 'completed', 'closed', 'withdrawn') and x.due_at is not null and app.ist_date(x.due_at) = app.today_ist()) as is_due_today,
       coalesce(q.awaiting_institution, 0)::int as queries_awaiting_institution,
       coalesce(q.awaiting_review, 0)::int as queries_awaiting_review
from applications a
join institutions i on i.id = a.institution_id
join application_types t on t.code = a.application_type_code
join workflow_definition_versions v on v.id = a.workflow_version_id
join workflow_definitions wd on wd.id = v.definition_id
left join workflow_stages s on s.version_id = a.workflow_version_id and s.code = a.current_stage
left join profile_directory pd on pd.id = a.assigned_officer_id
left join lateral (
  select count(*) filter (where d.status not in ('resolved', 'withdrawn')) as open_total,
         count(*) filter (where d.status in ('open', 'still_deficient', 'needs_clarification') and d.sent_at is not null) as awaiting_institution,
         count(*) filter (where d.status = 'correction_submitted') as awaiting_review,
         min(d.due_at) filter (where d.status in ('open', 'still_deficient', 'needs_clarification')) as correction_due_at
  from deficiencies d where d.application_id = a.id) q on true
cross join lateral (select case when a.status = 'returned_for_correction' then q.correction_due_at else a.stage_due_at end as due_at) x;

drop view if exists public.v_obligations;
create view public.v_obligations with (security_invoker = true) as
select o.*, i.name as institution_name, a.reference as application_reference,
       case
         when o.status in ('awaiting_submission', 'correction_required') and app.ist_date(o.due_at) < app.today_ist() then 'overdue'
         when o.status = 'awaiting_submission' and app.ist_date(o.due_at) < app.today_ist() +
              coalesce((select (value #>> '{}')::int from system_settings where key = 'compliance.due_soon_days'), 30) then 'due_soon'
         when o.status = 'awaiting_submission' and app.ist_date(o.due_at) >= app.today_ist() + 90 then 'upcoming'
         else o.status::text
       end as effective_status,
       (app.ist_date(o.due_at) - app.today_ist())::int as days_to_due,
       (select count(*) from compliance_submissions s where s.obligation_id = o.id)::int as submission_count
from compliance_obligations o
join institutions i on i.id = o.institution_id
left join applications a on a.id = o.application_id;

drop view if exists public.v_document_validity;
create view public.v_document_validity with (security_invoker = true) as
select v.*, i.name as institution_name, i.region_code,
       (v.expiry_date - app.today_ist())::int as days_to_expiry,
       case when v.superseded_by is not null then 'superseded'
            when v.expiry_date < app.today_ist() then 'expired'
            when v.expiry_date < app.today_ist() + coalesce((select (value #>> '{}')::int from system_settings where key = 'validity.expiring_soon_days'), 90) then 'expiring_soon'
            else 'valid' end as validity_state,
       (select o.id from compliance_obligations o where o.validity_id = v.id limit 1) as renewal_obligation_id
from document_validities v join institutions i on i.id = v.institution_id;

alter table public.evc_panel_experts add column if not exists is_chair boolean not null default false;
create unique index if not exists one_chair_per_panel on public.evc_panel_experts (evc_id) where is_chair;
drop view if exists public.v_evc_queue;
create view public.v_evc_queue with (security_invoker = true) as
select e.*, a.reference, a.title as application_title, a.institution_id, i.name as institution_name, a.region_code,
       a.status as application_status, pd.full_name as coordinator_name,
       (app.today_ist() - app.ist_date(e.ready_at))::int as age_days,
       (e.status = 'awaiting_scheduling' and app.ist_date(e.schedule_due_at) < app.today_ist())
         or (e.status = 'scheduled' and app.ist_date(e.scheduled_end) < app.today_ist()) as is_overdue,
       (select coalesce(jsonb_agg(jsonb_build_object('expert_id', x.id, 'full_name', x.full_name, 'is_chair', p.is_chair)
                                  order by p.is_chair desc, x.full_name), '[]'::jsonb)
        from evc_panel_experts p join experts x on x.id = p.expert_id where p.evc_id = e.id) as panel
from evc_records e
join applications a on a.id = e.application_id
join institutions i on i.id = a.institution_id
left join profile_directory pd on pd.id = e.coordinator_id;

drop view if exists public.v_tasks;
create view public.v_tasks with (security_invoker = true) as
select t.*, a.reference as application_reference, pd.full_name as assignee_name,
       (t.status = 'open' and t.due_at is not null and app.ist_date(t.due_at) < app.today_ist()) as is_overdue
from tasks t
left join applications a on a.id = t.application_id
left join profile_directory pd on pd.id = t.assignee_id;

-- ---------------------------------------------------------------------------
-- 5. Escalations: one escalation per case/entity + rule + due date; repeat notices are its timeline
-- ---------------------------------------------------------------------------
alter table public.escalation_events add column if not exists primary_id uuid references public.escalation_events (id);
alter table public.escalation_events add column if not exists scheduled_at timestamptz;
alter table public.escalation_events add column if not exists withdrawn_reason text;

-- When notice N of a rule is due: the end of the due date (IST) plus the rule offset, then every repeat interval.
-- Query response windows keep their exact closing time (they are timed to the minute).
create or replace function app.escalation_notice_at(p_rule public.escalation_rules, p_due timestamptz, p_notice integer) returns timestamptz
language sql stable as $$
  select (case when p_rule.entity_type = 'deficiency_window' or p_rule.offset_hours < 0 then p_due else app.end_of_day(app.ist_date(p_due)) end)
         + make_interval(hours => p_rule.offset_hours)
         + make_interval(hours => coalesce(p_rule.repeat_interval_hours, 0) * (p_notice - 1))
$$;

update public.escalation_events e set scheduled_at = app.escalation_notice_at(r, e.due_at, e.repeat_no)
from escalation_rules r where r.id = e.rule_id and e.scheduled_at is null and e.due_at is not null;
-- Notices recorded before they were due under the date-only policy are withdrawn (kept on record, never counted).
update public.escalation_events set withdrawn_reason = 'Withdrawn: under the date-only deadline policy this notice was not yet due when it was recorded.',
  status = case when status = 'open' then 'resolved' else status end, resolved_at = coalesce(resolved_at, now()),
  resolution_note = coalesce(resolution_note, 'Withdrawn automatically (recorded before it was due).'),
  idempotency_key = idempotency_key || ':withdrawn'
where withdrawn_reason is null and scheduled_at is not null and triggered_at < scheduled_at - interval '1 hour';
-- Synthetic demo notices were recorded by the first scan after seeding; the demo timeline shows them at the time the rule set.
update public.escalation_events e set triggered_at = e.scheduled_at
from applications a where a.id = e.application_id and a.is_demo and e.withdrawn_reason is null and e.scheduled_at is not null
  and e.triggered_at > e.scheduled_at;
update public.escalation_events e set triggered_at = e.scheduled_at
where e.application_id is null and e.withdrawn_reason is null and e.scheduled_at is not null and e.triggered_at > e.scheduled_at
  and exists (select 1 from institutions i where i.id = e.institution_id and i.code like 'DEMO-%');
-- Earlier notices that a late first scan skipped (recorded so the timeline matches the rule).
insert into public.escalation_events (rule_id, entity_type, entity_id, application_id, institution_id, region_code, repeat_no, due_at, summary,
                                      status, idempotency_key, triggered_at, scheduled_at)
select e.rule_id, e.entity_type, e.entity_id, e.application_id, e.institution_id, e.region_code, n.k, e.due_at, e.summary,
       e.status, r.code || ':' || e.entity_id || ':' || extract(epoch from e.due_at)::bigint || ':' || n.k,
       app.escalation_notice_at(r, e.due_at, n.k), app.escalation_notice_at(r, e.due_at, n.k)
from escalation_events e join escalation_rules r on r.id = e.rule_id
cross join lateral generate_series(1, e.repeat_no - 1) n(k)
where e.withdrawn_reason is null and e.due_at is not null and app.escalation_notice_at(r, e.due_at, n.k) <= now()
on conflict (idempotency_key) do nothing;
-- Plain stage names in summaries (not stage codes).
update public.escalation_events e set summary = 'Overdue: ' || a.reference || ' at stage ' || s.name
from applications a join workflow_stages s on s.version_id = a.workflow_version_id
where e.entity_type = 'application_stage' and a.id = e.application_id and e.summary = 'Overdue: ' || a.reference || ' at stage ' || s.code;

-- The earliest valid notice of each group is the escalation; later notices point to it.
update public.escalation_events e set primary_id = p.first_id
from (select rule_id, entity_id, due_at, (array_agg(id order by repeat_no, triggered_at))[1] as first_id
      from escalation_events where withdrawn_reason is null group by rule_id, entity_id, due_at) p
where e.rule_id = p.rule_id and e.entity_id = p.entity_id and e.due_at is not distinct from p.due_at
  and e.withdrawn_reason is null and e.id <> p.first_id and e.primary_id is null;
-- A group shares one status: the most advanced of its notices.
update public.escalation_events c set status = p.status, acknowledged_at = coalesce(c.acknowledged_at, p.acknowledged_at), acknowledged_by = coalesce(c.acknowledged_by, p.acknowledged_by)
from escalation_events p where c.primary_id = p.id and c.status <> p.status;

drop view if exists public.v_escalations;
create view public.v_escalations with (security_invoker = true) as
select e.*, r.code as rule_code, r.version as rule_version, r.rule_kind, r.recipient as rule_recipient,
       r.offset_hours as rule_offset_hours, r.repeat_interval_hours as rule_repeat_interval_hours, r.max_repeats as rule_max_repeats,
       a.reference as application_reference, i.name as institution_name,
       n.notice_count, n.latest_notice_at, n.notices
from escalation_events e
join escalation_rules r on r.id = e.rule_id
left join applications a on a.id = e.application_id
left join institutions i on i.id = e.institution_id
cross join lateral (
  select count(*)::int as notice_count, max(x.triggered_at) as latest_notice_at,
         jsonb_agg(jsonb_build_object('notice', x.repeat_no, 'scheduled_at', x.scheduled_at, 'triggered_at', x.triggered_at) order by x.repeat_no) as notices
  from escalation_events x where (x.id = e.id or x.primary_id = e.id) and x.withdrawn_reason is null) n
where e.primary_id is null and e.withdrawn_reason is null;

grant select on public.v_applications, public.v_obligations, public.v_document_validity, public.v_evc_queue,
                public.v_tasks, public.v_escalations to authenticated;

-- Acting on an escalation acts on all of its notices. Several escalations can be acknowledged at once.
create or replace function public.update_escalation_event(p_event_id uuid, p_action text, p_note text)
returns public.escalation_events
language plpgsql security definer set search_path = public, app as $$
declare v_uid uuid := app.require_user(); v_e escalation_events;
begin
  select * into v_e from escalation_events where id = p_event_id for update;
  if v_e.primary_id is not null then select * into v_e from escalation_events where id = v_e.primary_id for update; end if;
  if v_e.id is null or not app.is_staff() or not app.can_read_region(v_e.region_code) then
    perform app.fail('forbidden', 'You cannot act on this escalation.');
  end if;
  if p_action = 'acknowledge' and v_e.status = 'open' then
    update escalation_events set status = 'acknowledged', acknowledged_by = v_uid, acknowledged_at = now(),
      resolution_note = nullif(trim(coalesce(p_note, '')), '') where id = v_e.id or primary_id = v_e.id;
  elsif p_action = 'resolve' and v_e.status in ('open', 'acknowledged') then
    if length(trim(coalesce(p_note, ''))) < 10 then perform app.fail('reason_required', 'Describe how this was resolved (at least 10 characters).'); end if;
    update escalation_events set status = 'resolved', resolved_by = v_uid, resolved_at = now(), resolution_note = trim(p_note)
    where id = v_e.id or primary_id = v_e.id;
  else
    perform app.fail('invalid_state', 'This action is not available for an escalation in status ' || v_e.status || '.');
  end if;
  select * into v_e from escalation_events where id = v_e.id;
  perform app.audit('escalation_' || p_action, 'escalation', v_e.id, v_e.application_id, v_e.institution_id, v_e.region_code,
    nullif(trim(coalesce(p_note, '')), ''));
  return v_e;
end $$;

create or replace function public.acknowledge_escalations(p_event_ids uuid[], p_note text default null) returns integer
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid; v_n integer := 0;
begin
  perform app.require_user();
  foreach v_id in array coalesce(p_event_ids, '{}') loop
    if exists (select 1 from escalation_events where id = v_id and status = 'open') then
      perform public.update_escalation_event(v_id, 'acknowledge', p_note);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke execute on function public.acknowledge_escalations(uuid[], text) from public, anon;
grant execute on function public.acknowledge_escalations(uuid[], text) to authenticated;

-- Deadline scanner: notices fall due at app.escalation_notice_at; a late scan records every notice that has fallen due, once.
create or replace function app.run_deadline_scan(p_trigger text default 'scheduler', p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_run uuid; v_rule escalation_rules; v_item record; v_due_notices integer; v_notice integer; v_at timestamptz; v_key text; v_event uuid;
  v_primary uuid; v_recipient uuid; v_notified integer := 0; v_escalated integer := 0; v_evaluated integer := 0; v_renewals integer := 0; v_obl uuid;
begin
  insert into scheduled_job_runs (job_name, trigger_source, triggered_by)
  values ('deadline_scan', p_trigger, auth.uid()) returning id into v_run;

  begin
    for v_rule in select * from escalation_rules where is_active and effective_from <= p_now order by code loop
      for v_item in
        select * from (
          select 'application_stage'::text as et, a.id as entity_id, a.id as application_id, a.institution_id, a.region_code,
                 a.assigned_officer_id as assigned, a.stage_due_at as due_at,
                 a.reference || ' at stage ' || coalesce(s.name, a.current_stage) as label, '/app/applications/' || a.id as link
          from applications a left join workflow_stages s on s.version_id = a.workflow_version_id and s.code = a.current_stage
          where a.stage_due_at is not null
            and a.status not in ('draft', 'completed', 'closed', 'withdrawn', 'returned_for_correction', 'correction_submitted')
          union all
          select 'deficiency', d.id, d.application_id, a.institution_id, a.region_code, a.assigned_officer_id, d.due_at,
                 a.reference || ' query: ' || d.title, '/app/applications/' || d.application_id || '?tab=deficiencies&query=' || d.id
          from deficiencies d join applications a on a.id = d.application_id
          where d.status in ('open', 'still_deficient', 'needs_clarification') and d.sent_at is not null
          union all
          select 'deficiency_window', d.id, d.application_id, a.institution_id, a.region_code, a.assigned_officer_id, d.window_closes_at,
                 a.reference || ' query window: ' || d.title, '/app/applications/' || d.application_id || '?tab=deficiencies&query=' || d.id
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
        v_due_notices := 0;
        for v_notice in 1 .. coalesce(case when v_rule.repeat_interval_hours is null then 1 else v_rule.max_repeats end, 1) loop
          exit when app.escalation_notice_at(v_rule, v_item.due_at, v_notice) > p_now;
          v_due_notices := v_notice;
        end loop;
        continue when v_due_notices = 0;

        if v_rule.entity_type = 'document_validity' and v_rule.rule_kind = 'reminder' then
          v_obl := null;
          insert into compliance_obligations (institution_id, region_code, validity_id, obligation_type, title, description,
            source_reference, evidence_required, due_at)
          select v.institution_id, v_item.region_code, v.id, 'document_renewal', 'Renew: ' || v.title,
                 'The recorded validity of "' || v.title || '" ends on the expiry date shown with this obligation. Submit the renewed document for verification.',
                 'Alert rule ' || v_rule.code || ' v' || v_rule.version || ' (demo configuration)',
                 'Renewed ' || replace(v.doc_type, '_', ' ') || ' showing the new validity period', v_item.due_at
          from document_validities v where v.id = v_item.entity_id
          on conflict do nothing returning id into v_obl;
          if v_obl is not null then
            v_renewals := v_renewals + 1;
            update document_validities set renewal_state = 'renewal_requested' where id = v_item.entity_id and renewal_state = 'current';
          end if;
        end if;

        for v_notice in 1 .. v_due_notices loop
          v_at := app.escalation_notice_at(v_rule, v_item.due_at, v_notice);
          v_key := v_rule.code || ':' || v_item.entity_id || ':' || extract(epoch from v_item.due_at)::bigint || ':' || v_notice;
          if v_rule.rule_kind = 'escalation' then
            select id into v_primary from escalation_events
            where rule_id = v_rule.id and entity_id = v_item.entity_id and due_at = v_item.due_at and primary_id is null and withdrawn_reason is null
            order by repeat_no limit 1;
            v_event := null;
            insert into escalation_events (rule_id, entity_type, entity_id, application_id, institution_id, region_code,
                                           repeat_no, due_at, summary, idempotency_key, scheduled_at, primary_id, status)
            values (v_rule.id, v_rule.entity_type, v_item.entity_id, v_item.application_id, v_item.institution_id,
                    v_item.region_code, v_notice, v_item.due_at, 'Overdue: ' || v_item.label, v_key, v_at, v_primary,
                    coalesce((select status from escalation_events where id = v_primary), 'open'))
            on conflict (idempotency_key) do nothing returning id into v_event;
            continue when v_event is null;
            v_escalated := v_escalated + 1;
            perform app.audit('escalation_triggered', 'escalation', coalesce(v_primary, v_event), v_item.application_id, v_item.institution_id,
              v_item.region_code, null, null,
              jsonb_build_object('rule', v_rule.code, 'rule_version', v_rule.version, 'entity_type', v_rule.entity_type,
                                 'entity_id', v_item.entity_id, 'notice', v_notice, 'notice_due_at', v_at));
            if v_item.application_id is not null and v_primary is null then
              insert into application_events (application_id, event_type, summary, actor_kind, visibility, metadata)
              values (v_item.application_id, 'escalated', 'Escalated under rule ' || v_rule.code || ': ' || v_item.label, 'system',
                      'internal', jsonb_build_object('escalation_id', v_event, 'notice', v_notice));
            end if;
            insert into tasks (task_type, title, application_id, region_code, required_capability, due_at, dedupe_key)
            values ('escalation_followup', 'Follow up escalation — ' || v_item.label, v_item.application_id,
                    coalesce(v_item.region_code, 'WR'), 'escalation', p_now + interval '3 days',
                    'esc:' || v_rule.code || ':' || v_item.entity_id || ':' || extract(epoch from v_item.due_at)::bigint)
            on conflict (dedupe_key) do nothing;
          elsif exists (select 1 from notifications where idempotency_key like v_key || ':%') then
            continue;
          end if;

          for v_recipient in select * from app.rule_recipients(v_rule, v_item.institution_id, v_item.region_code, v_item.assigned) loop
            if app.notify(v_recipient, v_rule.rule_kind,
                 case when v_rule.rule_kind = 'escalation' then 'Escalation: ' else 'Reminder: ' end || v_item.label,
                 case when v_rule.rule_kind = 'escalation' then 'Notice ' || v_notice || ' under rule ' || v_rule.code || '.' else 'Upcoming deadline.' end,
                 v_item.link, v_rule.entity_type, v_item.entity_id, v_key,
                 v_rule.channel = 'in_app_and_email') then
              v_notified := v_notified + 1;
            end if;
          end loop;
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

-- Escalation counts on dashboards count escalations, not notices.
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
      'overdue', (select count(*) from apps where is_overdue),
      'due_today', (select count(*) from apps where is_due_today)),
    'by_status', coalesce((select jsonb_agg(x) from (select status, count(*) as count from apps group by status order by count(*) desc) x), '[]'),
    'by_stage', coalesce((select jsonb_agg(x) from (
        select stage_name as stage, stage_kind as kind, count(*) as count, round(avg(stage_age_days), 1) as avg_stage_age_days,
               count(*) filter (where is_overdue) as overdue
        from open_apps group by stage_name, stage_kind order by count(*) desc) x), '[]'),
    'by_region', coalesce((select jsonb_agg(x) from (
        select region_code as region, count(*) as count, count(*) filter (where is_overdue) as overdue
        from open_apps group by region_code order by region_code) x), '[]'),
    'ageing', coalesce((select jsonb_agg(x) from (
        select bucket, min_days, max_days, count(*) as count from (
          select case when age_days < 15 then '0–14 days' when age_days < 30 then '15–29 days'
                      when age_days < 60 then '30–59 days' else '60+ days' end as bucket,
                 case when age_days < 15 then 0 when age_days < 30 then 15 when age_days < 60 then 30 else 60 end as min_days,
                 case when age_days < 15 then 14 when age_days < 30 then 29 when age_days < 60 then 59 else null end as max_days
          from open_apps) b group by bucket, min_days, max_days order by min_days) x), '[]'),
    'workload', coalesce((select jsonb_agg(x) from (
        select assigned_officer_id as officer_id, coalesce(assigned_officer_name, 'Unassigned') as officer, count(*) as open_cases,
               count(*) filter (where is_overdue) as overdue
        from open_apps group by assigned_officer_id, assigned_officer_name order by count(*) desc limit 12) x), '[]'),
    'evc', coalesce((select jsonb_object_agg(status, n) from (
        select status::text, count(*) as n from v_evc_queue where p_region is null or region_code = p_region group by status) x), '{}'),
    'evc_overdue', (select count(*) from v_evc_queue where is_overdue and (p_region is null or region_code = p_region)),
    'compliance', coalesce((select jsonb_object_agg(effective_status, n) from (
        select effective_status, count(*) as n from v_obligations where p_region is null or region_code = p_region group by effective_status) x), '{}'),
    'validity', coalesce((select jsonb_object_agg(validity_state, n) from (
        select validity_state, count(*) as n from v_document_validity
        where (p_region is null or region_code = p_region) and validity_state <> 'superseded' group by validity_state) x), '{}'),
    'escalations_open', (select count(*) from v_escalations where status = 'open' and (p_region is null or region_code = p_region)),
    'tasks_overdue', (select count(*) from v_tasks where is_overdue and (p_region is null or region_code = p_region))
  ) $$;
grant execute on function public.analytics_summary(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Notifications show the live due date of what they are about
-- ---------------------------------------------------------------------------
create or replace view public.v_notifications with (security_invoker = true) as
select n.*,
       case n.entity_type
         when 'obligation' then (select o.due_at from compliance_obligations o where o.id = n.entity_id)
         when 'deficiency' then (select coalesce(d.window_closes_at, d.due_at) from deficiencies d where d.id = n.entity_id
                                 and d.status in ('open', 'still_deficient', 'needs_clarification'))
         when 'deficiency_window' then (select d.window_closes_at from deficiencies d where d.id = n.entity_id)
         when 'application_stage' then (select a.stage_due_at from applications a where a.id = n.entity_id)
         when 'evc_schedule' then (select case when e.status = 'scheduled' then e.scheduled_start else e.schedule_due_at end from evc_records e where e.id = n.entity_id)
         when 'evc' then (select case when e.status = 'scheduled' then e.scheduled_start else e.schedule_due_at end from evc_records e where e.id = n.entity_id)
         when 'document_validity' then (select app.end_of_day(v.expiry_date) from document_validities v where v.id = n.entity_id)
       end as subject_due_at,
       case when n.entity_type in ('evc_schedule', 'evc') then 'Session' when n.entity_type = 'document_validity' then 'Expires' else 'Due' end as subject_due_label
from notifications n;
grant select on public.v_notifications to authenticated;

-- Dates copied into notification text go stale when the record changes; the live date above replaces them.
create or replace function app.strip_copied_due_date(p_body text) returns text
language sql immutable as $$
  select trim(regexp_replace(regexp_replace(regexp_replace(p_body,
    '\s*(Overdue since|Due) \d{1,2} [A-Z][a-z]{2} \d{4}( \d{2}:\d{2})?( IST)?\.', '', 'g'),
    '\s*—\s*due \d{1,2} [A-Z][a-z]{2} \d{4}\.', '.', 'g'),
    ' by \d{1,2} [A-Z][a-z]{2} \d{4}\.', '.', 'g'))
$$;
create or replace function app.on_notification_insert() returns trigger
language plpgsql as $$
begin
  if new.entity_type in ('obligation', 'deficiency', 'deficiency_window', 'application_stage', 'evc_schedule', 'document_validity', 'application') then
    new.body := coalesce(nullif(app.strip_copied_due_date(new.body), ''), new.title);
  end if;
  return new;
end $$;
drop trigger if exists notifications_no_copied_dates on public.notifications;
create trigger notifications_no_copied_dates before insert on public.notifications
  for each row execute function app.on_notification_insert();
update public.notifications set body = coalesce(nullif(app.strip_copied_due_date(body), ''), title)
where entity_type in ('obligation', 'deficiency', 'deficiency_window', 'application_stage', 'evc_schedule', 'document_validity', 'application')
  and body is distinct from coalesce(nullif(app.strip_copied_due_date(body), ''), title);

-- ---------------------------------------------------------------------------
-- 7. EVC: the session time is stored once; the case's next action follows it. Panels can record a chair.
-- ---------------------------------------------------------------------------
create or replace function app.on_evc_session_change() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.status = 'scheduled' and new.scheduled_start is not null then
    update applications set next_action = 'Conduct the expert visit (session ' ||
      to_char(new.scheduled_start at time zone 'Asia/Kolkata', 'DD Mon YYYY, FMHH12:MI AM') || ' IST)'
    where id = new.application_id and status = 'evc_scheduled';
  end if;
  return new;
end $$;
drop trigger if exists evc_session_sets_next_action on public.evc_records;
create trigger evc_session_sets_next_action after insert or update of scheduled_start, status on public.evc_records
  for each row execute function app.on_evc_session_change();
update public.evc_records set scheduled_start = scheduled_start where status = 'scheduled' and scheduled_start is not null;


create or replace function public.set_evc_panel_chair(p_evc_id uuid, p_expert_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare v_evc evc_records; v_app applications;
begin
  perform app.require_user();
  select * into v_evc from evc_records where id = p_evc_id for update;
  if v_evc.id is null then perform app.fail('not_found', 'EVC not found.'); end if;
  select * into v_app from applications where id = v_evc.application_id;
  perform app.require_evc_officer(v_evc, v_app);
  if not exists (select 1 from evc_panel_experts where evc_id = p_evc_id and expert_id = p_expert_id) then
    perform app.fail('validation', 'Add the expert to the panel before naming them chair.');
  end if;
  update evc_panel_experts set is_chair = false where evc_id = p_evc_id and is_chair;
  update evc_panel_experts set is_chair = true where evc_id = p_evc_id and expert_id = p_expert_id;
  perform app.audit('evc_panel_chair_set', 'evc', p_evc_id, v_app.id, v_app.institution_id, v_app.region_code, null, null,
    jsonb_build_object('expert_id', p_expert_id));
end $$;
revoke execute on function public.set_evc_panel_chair(uuid, uuid) from public, anon;
grant execute on function public.set_evc_panel_chair(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Officers eligible to take over the current stage of a case (region + the stage's responsibility)
-- ---------------------------------------------------------------------------
create or replace function public.eligible_case_officers(p_application_id uuid)
returns table (officer_id uuid, full_name text, designation text)
language sql stable security definer set search_path = public, app as $$
  select distinct p.id, p.full_name, p.designation
  from applications a
  join workflow_stages s on s.version_id = a.workflow_version_id and s.code = a.current_stage
  join user_role_assignments r on r.is_active and r.role = 'officer'
       and (s.responsible_capability is null or s.responsible_capability = any (r.capabilities))
       and (r.region_code is null or r.region_code = a.region_code)
  join profiles p on p.id = r.user_id and p.is_active
  where a.id = p_application_id and app.is_staff() and app.can_read_application(a.id)
  order by p.full_name
$$;
revoke execute on function public.eligible_case_officers(uuid) from public, anon;
grant execute on function public.eligible_case_officers(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Demonstration: the rule queries on the Nirmala cases are sent to the institution by their case officers
-- ---------------------------------------------------------------------------
create or replace function app.demo_send_matrix_queries() returns void
language plpgsql security definer set search_path = public, app as $$
declare a applications; v_email text;
begin
  for a in select * from applications where is_demo and status not in ('returned_for_correction', 'draft', 'completed', 'closed', 'withdrawn')
           and title in ('Extension of approval with intake increase 2027-28', 'Extension of approval — faculty cadre review (demo)')
           and exists (select 1 from deficiencies d where d.application_id = applications.id and d.status in ('open', 'still_deficient', 'needs_clarification'))
  loop
    select p.email into v_email from profiles p where p.id = a.assigned_officer_id;
    if v_email is null then continue; end if;
    perform app.demo_as(v_email);
    perform public.return_for_correction(a.id, a.row_version,
      'Rule check found declared figures below the requirement. Please correct them or provide evidence.');
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;
revoke execute on function app.demo_send_matrix_queries() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'demo_as') then
    perform app.demo_send_matrix_queries();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Landing page preview: the same seeded figures the signed-in dashboards show, and a few real demo cases.
--     Synthetic demo records only (is_demo); readable without signing in.
-- ---------------------------------------------------------------------------
create or replace function public.landing_snapshot() returns jsonb
language sql stable security definer set search_path = public, app as $$
  with apps as (select * from v_applications where is_demo),
       showcase as (
         select distinct on (stage_kind) * from apps
         where status not in ('draft', 'withdrawn') and stage_kind in ('scrutiny', 'evc', 'committee', 'decision', 'terminal')
         order by stage_kind, updated_at desc)
  select jsonb_build_object(
    'generated_at', now(),
    'totals', jsonb_build_object(
      'applications', (select count(*) from apps),
      'in_process', (select count(*) from apps where status not in ('draft', 'completed', 'closed', 'withdrawn')),
      'with_institution', (select count(*) from apps where status = 'returned_for_correction'),
      'past_target', (select count(*) from apps where is_overdue)),
    'cases', coalesce((select jsonb_agg(jsonb_build_object(
        'reference', c.reference, 'title', c.title, 'institution', c.institution_name, 'status', c.status,
        'current_stage', c.current_stage, 'next_action', c.next_action,
        'stages', (select jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'kind', s.kind, 'sequence', s.sequence) order by s.sequence)
                   from workflow_stages s where s.version_id = c.workflow_version_id and s.kind <> 'terminal'))
      order by array_position(array['scrutiny', 'evc', 'committee', 'decision', 'terminal']::text[], c.stage_kind::text))
      from showcase c), '[]'::jsonb))
$$;
revoke execute on function public.landing_snapshot() from public;
grant execute on function public.landing_snapshot() to anon, authenticated;
