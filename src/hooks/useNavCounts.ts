import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/features/auth/AuthProvider';
import type { BadgeKey } from '@/components/layout/nav';

async function count(q: PromiseLike<{ count: number | null; error: unknown }>) {
  const r = await q;
  if (r.error) throw r.error;
  return r.count ?? 0;
}

/** Live counts for sidebar badges. Every query runs under the user's RLS, so counts match what they can open. */
export function useNavCounts(): Partial<Record<BadgeKey, number>> {
  const { workspace, session, institution } = useAuth();
  const me = session?.user.id;
  const q = useQuery({
    queryKey: ['navcounts', workspace, institution?.id],
    enabled: !!workspace,
    refetchInterval: 60_000,
    queryFn: async () => {
      const head = { count: 'exact' as const, head: true };
      const out: Partial<Record<BadgeKey, number>> = {};
      out.unread = await count(supabase.from('notifications').select('id', head).is('read_at', null));
      if (workspace === 'institution' && institution) {
        out.returned = await count(supabase.from('deficiencies').select('id, applications!inner(institution_id)', head)
          .eq('applications.institution_id', institution.id).not('status', 'in', '(resolved,withdrawn)'));
        out.oblOverdue = await count(supabase.from('v_obligations').select('id', head).eq('institution_id', institution.id).eq('effective_status', 'overdue'));
      }
      if (workspace === 'officer') {
        out.corrections = await count(supabase.from('deficiencies').select('id', head).eq('status', 'correction_submitted'));
        out.tasksOverdue = await count(supabase.from('v_tasks').select('id', head).eq('assignee_id', me!).eq('is_overdue', true));
        out.evcQueue = await count(supabase.from('v_evc_queue').select('id', head).eq('status', 'awaiting_scheduling'));
      }
      if (workspace === 'officer' || workspace === 'admin') {
        out.escalations = await count(supabase.from('escalation_events').select('id', head).eq('status', 'open'));
      }
      if (workspace === 'admin') {
        out.oblOverdue = await count(supabase.from('v_obligations').select('id', head).eq('effective_status', 'overdue'));
      }
      return out;
    },
  });
  return q.data ?? {};
}
