-- Audit log: one entry per event; panels that match their timeline; readable detail on every row.
--  * the deadline scan writes ONE escalation_triggered entry per case per run, listing its notices inside it
--  * existing escalation_triggered entries recorded in the same minute for the same case are merged into one (notices listed inside)
--  * v_audit_logs gains "detail" (which document a check was for, which stage was entered) so distinct events never look identical
--  * demo EVC panels: every scheduled session shows the experts the timeline says were added

create or replace function app.run_deadline_scan(p_trigger text default 'scheduler', p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  v_run uuid; v_rule escalation_rules; v_item record; v_due_notices integer; v_notice integer; v_at timestamptz; v_key text; v_event uuid;
  v_primary uuid; v_batch jsonb := '{}'::jsonb; v_key2 text; v_recipient uuid; v_notified integer := 0; v_escalated integer := 0; v_evaluated integer := 0; v_renewals integer := 0; v_obl uuid;
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
            -- one audit entry per case per scan: the notices recorded for it in this run are listed inside it
            v_key2 := coalesce(v_item.application_id::text, v_item.entity_id::text);
            v_batch := jsonb_set(v_batch, array[v_key2], coalesce(v_batch -> v_key2, jsonb_build_object(
                'entity', coalesce(v_primary, v_event), 'application_id', v_item.application_id, 'institution_id', v_item.institution_id,
                'region', v_item.region_code, 'notices', '[]'::jsonb)), true);
            v_batch := jsonb_set(v_batch, array[v_key2, 'notices'], (v_batch -> v_key2 -> 'notices') || jsonb_build_object(
                'rule', v_rule.code, 'rule_version', v_rule.version, 'entity_type', v_rule.entity_type, 'notice', v_notice, 'notice_due_at', v_at));
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

    for v_key2 in select jsonb_object_keys(v_batch) loop
      perform app.audit('escalation_triggered', 'escalation', (v_batch -> v_key2 ->> 'entity')::uuid,
        nullif(v_batch -> v_key2 ->> 'application_id', '')::uuid, nullif(v_batch -> v_key2 ->> 'institution_id', '')::uuid, v_batch -> v_key2 ->> 'region', null, null,
        jsonb_build_object('notices', v_batch -> v_key2 -> 'notices'));
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

-- Merge duplicate-looking escalation entries (same case, same minute) into one. Audit rows are otherwise append-only.
alter table public.audit_logs disable trigger user;
with grp as (
  select min(id) as keep, array_agg(id order by id) as ids, max(entity_id::text)::uuid as entity,
         jsonb_agg(jsonb_build_object('rule', after_state ->> 'rule', 'rule_version', after_state -> 'rule_version', 'entity_type', after_state ->> 'entity_type',
                                      'notice', coalesce(after_state ->> 'notice', after_state ->> 'repeat')::int, 'notice_due_at', after_state -> 'notice_due_at') order by id) as notices
  from audit_logs
  where action = 'escalation_triggered' and after_state ? 'rule'
  group by coalesce(application_id::text, after_state ->> 'entity_id'), actor_kind, date_trunc('minute', created_at)
), merged as (
  update audit_logs l set after_state = jsonb_build_object('notices', g.notices), metadata = l.metadata || jsonb_build_object('merged_entries', cardinality(g.ids))
  from grp g where l.id = g.keep returning g.ids, g.keep
)
delete from audit_logs l using merged m where l.id = any (m.ids) and l.id <> m.keep;
-- Single-notice entries recorded earlier keep the same shape as merged ones.
update audit_logs set after_state = jsonb_build_object('notices', jsonb_build_array(jsonb_build_object('rule', after_state ->> 'rule', 'rule_version', after_state -> 'rule_version',
  'entity_type', after_state ->> 'entity_type', 'notice', coalesce(after_state ->> 'notice', after_state ->> 'repeat')::int, 'notice_due_at', after_state -> 'notice_due_at')))
where action = 'escalation_triggered' and after_state ? 'rule';
alter table public.audit_logs enable trigger user;

create or replace view public.v_audit_logs with (security_invoker = true) as
select l.*, pd.full_name as actor_name, a.reference as application_reference,
       case l.action
         when 'document_check_completed' then (select d.title || ' · version ' || v.version || ' · check ' || (select count(*) from document_check_runs r2 where r2.document_version_id = r.document_version_id and (r2.started_at, r2.id) <= (r.started_at, r.id)) from document_check_runs r
           join document_versions v on v.id = r.document_version_id join documents d on d.id = v.document_id where r.id = l.entity_id)
         when 'document_uploaded' then (l.after_state ->> 'file_name') || ' · version ' || (l.after_state ->> 'version')
         when 'document_replaced' then (l.after_state ->> 'file_name') || ' · version ' || (l.after_state ->> 'version')
         when 'deficiency_auto_raised' then l.after_state ->> 'title'
         when 'deficiency_raised' then l.after_state ->> 'title'
         when 'evc_expert_assigned' then l.after_state ->> 'expert'
         when 'stage_entered' then 'Entered ' || coalesce((select s.name from applications ap join workflow_stages s on s.version_id = ap.workflow_version_id
           and s.code = l.after_state ->> 'stage' where ap.id = l.application_id), l.after_state ->> 'stage')
       end as detail
from audit_logs l
left join profile_directory pd on pd.id = l.actor_id
left join applications a on a.id = l.application_id;
grant select on public.v_audit_logs to authenticated;

-- Demonstration panels. The session of each scheduled EVC shows the experts its timeline records (or, for a session with no panel yet,
-- the best-ranked eligible experts after the conflict-of-interest exclusions, exactly as Recommend panel ranks them).
create or replace function app.demo_panels() returns void
language plpgsql security definer set search_path = public, app as $$
declare
  rec record; v_expert uuid; v_chair uuid; v_email text; v_evc evc_records;
begin
  for rec in select * from (values
      ('Restoration of intake — Mechanical Engineering', array['DEMO-EXP-007']),
      ('New institution — Sahyadri School of Architecture', array['DEMO-EXP-007', 'DEMO-EXP-005'])
    ) as t(title, codes) loop
    select e.* into v_evc from evc_records e join applications a on a.id = e.application_id
      where a.title = rec.title and a.is_demo and e.status in ('scheduled', 'proposed', 'awaiting_scheduling') order by e.cycle desc limit 1;
    if v_evc.id is null then continue; end if;
    v_chair := null;
    foreach v_email in array rec.codes loop
      select id into v_expert from experts where code = v_email and is_active;
      if v_expert is null or exists (select 1 from evc_panel_experts where evc_id = v_evc.id and expert_id = v_expert) then
        v_chair := coalesce(v_chair, v_expert); continue;
      end if;
      -- the timeline may already record the assignment (deployed demo): restore the panel row without a second event
      if exists (select 1 from audit_logs where action = 'evc_expert_assigned' and entity_id = v_evc.id and (after_state ->> 'expert_id')::uuid = v_expert) then
        insert into evc_panel_experts (evc_id, expert_id, assigned_by, assigned_at)
        select v_evc.id, v_expert, (select id from profiles where email = 'officer.wr.evc@aicasa-demo.test'),
               (select min(created_at) from audit_logs where action = 'evc_expert_assigned' and entity_id = v_evc.id and (after_state ->> 'expert_id')::uuid = v_expert)
        on conflict do nothing;
      else
        perform app.demo_as('officer.wr.evc@aicasa-demo.test');
        select * into v_evc from evc_records where id = v_evc.id;
        perform public.assign_evc_expert(v_evc.id, v_expert, v_evc.row_version);
      end if;
      v_chair := coalesce(v_chair, v_expert);
    end loop;
    if v_chair is not null and not exists (select 1 from evc_panel_experts where evc_id = v_evc.id and is_chair) then
      update evc_panel_experts set is_chair = true where evc_id = v_evc.id and expert_id = v_chair;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;
revoke execute on function app.demo_panels() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'demo_as')
     and exists (select 1 from experts where code = 'DEMO-EXP-007') then
    perform app.demo_panels();
  end if;
end $$;
