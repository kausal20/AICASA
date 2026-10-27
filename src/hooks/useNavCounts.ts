import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { useAuth } from '@/features/auth/AuthProvider';
import { stageResponsibility } from '@/lib/queries';
import type { BadgeKey } from '@/components/layout/nav';
import type { Capability } from '@/types/domain';

async function count(q: PromiseLike<{ count: number | null; error: unknown }>) {
  const r = await q;
  if (r.error) throw r.error;
  return r.count ?? 0;
}

/**
 * Live counts for sidebar badges. Each badge is computed from the same source as the page it opens:
 *   returned    — queries waiting for the institution's answer (v_applications.queries_awaiting_institution, as on the dashboard)
 *   corrections — answers this officer may re-review (same capability rule as the Clarification reviews page)
 *   tasksOverdue / escalations / oblOverdue — the overdue flag and open escalations of the same views the pages list,
 *   limited to the administrator's own regions when the account is regional.
 */
export function useNavCounts(): Partial<Record<BadgeKey, number>> {
  const { workspace, session, institution, isNational, regions, canIn } = useAuth();
  const me = session?.user.id;
  const regionKey = isNational ? 'national' : regions.join(',');
  const q = useQuery({
    queryKey: ['navcounts', workspace, institution?.id, regionKey],
    enabled: !!workspace,
    refetchInterval: 60_000,
    queryFn: async () => {
      const head = { count: 'exact' as const, head: true };
      const out: Partial<Record<BadgeKey, number>> = {};
      const scoped = <T extends { in: (c: string, v: string[]) => T }>(qb: T) => (workspace === 'admin' && !isNational ? qb.in('region_code', regions) : qb);
      out.unread = await count(supabase.from('notifications').select('id', head).is('read_at', null));
      if (workspace === 'institution' && institution) {
        const rows = unwrap(await supabase.from('v_applications').select('queries_awaiting_institution').eq('institution_id', institution.id)) as { queries_awaiting_institution: number }[];
        out.returned = rows.reduce((n, r) => n + r.queries_awaiting_institution, 0);
        out.oblOverdue = await count(supabase.from('v_obligations').select('id', head).eq('institution_id', institution.id).eq('effective_status', 'overdue'));
      }
      if (workspace === 'officer') {
        const subs = unwrap(await supabase.from('deficiencies').select('id, applications!inner(current_stage, region_code)').eq('status', 'correction_submitted')) as
          unknown as { applications: { current_stage: string; region_code: string } }[];
        out.corrections = subs.filter((d) => canIn(stageResponsibility(d.applications.current_stage) as Capability, d.applications.region_code)).length;
        out.tasksOverdue = await count(supabase.from('v_tasks').select('id', head).eq('assignee_id', me!).eq('is_overdue', true));
        out.evcQueue = await count(supabase.from('v_evc_queue').select('id', head).eq('status', 'awaiting_scheduling'));
      }
      if (workspace === 'officer' || workspace === 'admin') {
        out.escalations = await count(scoped(supabase.from('v_escalations').select('id', head).eq('status', 'open')));
      }
      if (workspace === 'admin') {
        out.oblOverdue = await count(scoped(supabase.from('v_obligations').select('id', head).eq('effective_status', 'overdue')));
      }
      return out;
    },
  });
  return q.data ?? {};
}
