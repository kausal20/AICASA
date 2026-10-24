-- Analytics drill-down: expose the identifiers dashboards need to link a chart segment to the filtered list.
-- Still security invoker, so every count stays inside the caller's RLS scope.
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
    'escalations_open', (select count(*) from escalation_events where status <> 'resolved' and (p_region is null or region_code = p_region)),
    'tasks_overdue', (select count(*) from v_tasks where is_overdue and (p_region is null or region_code = p_region))
  ) $$;
grant execute on function public.analytics_summary(text) to authenticated, service_role;
