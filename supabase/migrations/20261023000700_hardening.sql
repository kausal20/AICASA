-- Hardening from Supabase security advisors.

-- 1. The name directory becomes a security-invoker view over a narrow definer function, so the view itself
--    never bypasses RLS and only id / name / designation / roles of active users are exposed to signed-in users.
create or replace function app.profile_directory_rows()
returns table (id uuid, full_name text, designation text, roles text[])
language sql stable security definer set search_path = public, app as $$
  select p.id, p.full_name, p.designation,
         (select array_agg(distinct r.role::text) from user_role_assignments r where r.user_id = p.id and r.is_active)
  from profiles p
  where p.is_active and app.is_active_user()
$$;
revoke execute on function app.profile_directory_rows() from public, anon;
grant execute on function app.profile_directory_rows() to authenticated, service_role;

create or replace view public.profile_directory with (security_invoker = true) as
  select * from app.profile_directory_rows();
revoke all on public.profile_directory from anon;
grant select on public.profile_directory to authenticated, service_role;

-- 2. Pin search_path on the remaining helper and trigger functions.
alter function app.uid() set search_path = public, app;
alter function app.fail(text, text) set search_path = public, app;
alter function app.block_mutation() set search_path = public, app;
alter function app.block_version_rewrite() set search_path = public, app;
alter function app.status_for_stage(app.stage_kind) set search_path = public, app;
alter function app.next_action_for_stage(app.stage_kind, text) set search_path = public, app;
alter function app.add_interval(timestamptz, text) set search_path = public, app;
alter function app.storage_institution(text) set search_path = public, app;
