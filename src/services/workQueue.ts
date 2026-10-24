import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { orderWork, workWindow, type WorkBucket, type WorkItem } from '@/lib/workQueue';
import type { ApplicationRow, ObligationRow, Role, TaskRow, EscalationRow } from '@/types/domain';

export async function getWorkQueue(input: { role: Role; userId: string; institutionId?: string; region?: string; bucket: WorkBucket }) {
  const { role, userId, institutionId, region, bucket } = input;
  const time = workWindow();
  const limit = 8;
  let apps = supabase.from('v_applications').select('*', { count: 'exact' });
  if (role === 'institution') {
    if (!institutionId) return { items: [], total: 0 };
    apps = apps.eq('institution_id', institutionId);
  }
  if (role === 'officer') apps = apps.eq('assigned_officer_id', userId);
  if (region) apps = apps.eq('region_code', region);
  if (bucket === 'completed') apps = apps.in('status', ['completed', 'closed']).gte('closed_at', time.recent).order('closed_at', { ascending: false });
  else if (bucket === 'waiting') {
    apps = role === 'institution'
      ? apps.not('status', 'in', '(draft,returned_for_correction,completed,closed,withdrawn)')
      : apps.eq('status', 'returned_for_correction');
    apps = apps.order('updated_at', { ascending: false });
  } else {
    if (role === 'institution') {
      apps = apps.in('status', ['draft', 'returned_for_correction']);
      apps = bucket === 'now' ? apps
        : apps.gte('correction_due_at', time.now).lt('correction_due_at', time.weekEnd);
      apps = apps.order('correction_due_at', { ascending: true, nullsFirst: false });
    } else {
      apps = apps.not('status', 'in', '(draft,returned_for_correction,completed,closed,withdrawn)');
      apps = bucket === 'now' ? apps.or(`is_overdue.eq.true,status.eq.correction_submitted,status.eq.awaiting_decision`)
        : apps.gte('stage_due_at', time.now).lt('stage_due_at', time.weekEnd).not('status', 'in', '(correction_submitted,awaiting_decision)');
      apps = apps.order('stage_due_at', { ascending: true, nullsFirst: false });
    }
  }
  const sources: Promise<{ items: WorkItem[]; total: number }>[] = [Promise.resolve(apps.limit(limit)).then((res) => ({
    total: res.count ?? 0,
    items: (unwrap(res) as ApplicationRow[]).map((r) => ({ id: `app-${r.id}`, title: `${r.reference} · ${r.title}`, detail: r.next_action ?? r.institution_name,
      to: `/app/applications/${r.id}`, date: bucket === 'completed' ? r.closed_at : r.status === 'returned_for_correction' ? r.correction_due_at : r.status === 'draft' ? null : r.stage_due_at,
      kind: bucket === 'waiting' ? `Waiting · ${role === 'institution' ? r.assigned_officer_name ?? 'review team' : 'institution'}` : 'Application', completed: bucket === 'completed' })),
  }))];
  if (role === 'institution' && bucket !== 'completed') {
    let obligations = supabase.from('v_obligations').select('*', { count: 'exact' }).eq('institution_id', institutionId!);
    if (bucket === 'waiting') obligations = obligations.in('status', ['submitted', 'under_verification']);
    else {
      obligations = obligations.in('status', ['awaiting_submission', 'correction_required']);
      obligations = bucket === 'now' ? obligations.or(`due_at.lt.${time.now},status.eq.correction_required`)
        : obligations.eq('status', 'awaiting_submission').gte('due_at', time.now).lt('due_at', time.weekEnd);
    }
    sources.push(Promise.resolve(obligations.order('due_at').limit(limit)).then((res) => ({ total: res.count ?? 0,
      items: (unwrap(res) as ObligationRow[]).map((r) => ({ id: `obl-${r.id}`, title: r.title, detail: bucket === 'waiting' ? 'Evidence submitted; waiting for verification.' : r.evidence_required, date: r.due_at,
        kind: 'Compliance obligation', to: `/app/compliance?status=${r.effective_status}` })),
    })));
  }
  if (role !== 'institution') {
    let tasks = supabase.from('v_tasks').select('*', { count: 'exact' });
    if (region) tasks = tasks.eq('region_code', region);
    if (role === 'officer') tasks = tasks.eq('assignee_id', userId);
    if (bucket === 'completed') tasks = tasks.eq('status', 'done').gte('completed_at', time.recent).order('completed_at', { ascending: false });
    else if (bucket === 'waiting') tasks = tasks.eq('status', 'open').is('assignee_id', null).order('due_at');
    else { tasks = tasks.eq('status', 'open'); tasks = bucket === 'now' ? tasks.or(`due_at.lt.${time.now},due_at.is.null`) : tasks.gte('due_at', time.now).lt('due_at', time.weekEnd); tasks = tasks.order('due_at'); }
    sources.push(Promise.resolve(tasks.limit(limit)).then((res) => ({ total: res.count ?? 0,
      items: (unwrap(res) as TaskRow[]).map((r) => ({ id: `task-${r.id}`, title: r.title, detail: r.assignee_name ? `Assigned to ${r.assignee_name}` : 'Needs an assignment', kind: 'Task',
        date: bucket === 'completed' ? r.completed_at : r.due_at, completed: bucket === 'completed', to: r.application_id ? `/app/applications/${r.application_id}` : r.obligation_id ? '/app/compliance' : r.evc_id ? '/app/evc' : '/app/escalations' })),
    })));
  }
  if (role === 'admin' && bucket === 'now') {
    let escalations = supabase.from('v_escalations').select('*', { count: 'exact' }).eq('status', 'open');
    if (region) escalations = escalations.eq('region_code', region);
    sources.push(Promise.resolve(escalations.order('due_at').limit(limit)).then((res) => ({ total: res.count ?? 0,
      items: (unwrap(res) as EscalationRow[]).map((r) => ({ id: `esc-${r.id}`, title: r.summary, detail: r.institution_name ?? 'Regional follow-up', kind: 'Escalation', date: r.due_at, to: '/app/escalations?status=open' })),
    })));
  }
  const results = await Promise.all(sources);
  return { items: orderWork(results.flatMap((r) => r.items), bucket), total: results.reduce((n, r) => n + r.total, 0) };
}
