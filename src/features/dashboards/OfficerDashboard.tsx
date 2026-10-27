import { ActionQueue } from './ActionQueue';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, ClipboardCheck, Eye, Inbox, ListTodo, Siren, Hourglass } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listApplications } from '@/services/applications';
import { getAnalytics, listDeficiencies, listEscalations, listEvc, listObligations, listReviewTasks, listTasks } from '@/services/operations';
import { REVIEW_STATUS } from '@/features/applications/ReviewTasksPanel';
import { useCanReview } from '@/features/deficiencies/DeficienciesPage';
import { DueBadge, StatusBadge, Badge } from '@/components/ui/Badge';
import { EmptyState, LoadingRows } from '@/components/ui/States';
import { Kpi, PageTitle, Panel } from '@/components/ui/Workspace';
import { ApplicationsTable } from '@/features/applications/ApplicationsListPage';
import { humanize } from '@/lib/format';
import type { TaskRow } from '@/types/domain';

function taskLink(t: TaskRow) {
  if (t.task_type === 'compliance_verification') return '/app/compliance';
  if (t.task_type.startsWith('evc')) return '/app/evc';
  if (t.task_type === 'escalation_followup') return '/app/escalations';
  return t.application_id ? `/app/applications/${t.application_id}` : '/app/tasks';
}

export function OfficerDashboard() {
  const { session, context, can, activeAssignments } = useAuth();
  const me = session?.user.id;
  const queue = useQuery({ queryKey: ['applications', 'mine', me], queryFn: () => listApplications({ assignedTo: me, sort: 'due' }, 0), enabled: !!me });
  const tasks = useQuery({ queryKey: ['tasks', 'mine'], queryFn: () => listTasks({ mine: me }) });
  const defs = useQuery({ queryKey: ['deficiencies', 'all'], queryFn: () => listDeficiencies({ openOnly: true }) });
  const evc = useQuery({ queryKey: ['evc', 'all'], queryFn: () => listEvc(), enabled: can('evc') });
  const obl = useQuery({ queryKey: ['obligations', 'scope'], queryFn: () => listObligations(), enabled: can('compliance') });
  const esc = useQuery({ queryKey: ['escalations', 'open'], queryFn: () => listEscalations('open') });
  const stats = useQuery({ queryKey: ['analytics', 'scope'], queryFn: () => getAnalytics(null) });
  const reviewsQ = useQuery({ queryKey: ['review-tasks', 'mine', me], queryFn: () => listReviewTasks({ assignee: me, openOnly: true }), enabled: !!me });

  const open = (queue.data?.rows ?? []).filter((r) => !['completed', 'closed', 'draft'].includes(r.status));
  const overdueCases = open.filter((r) => r.is_overdue);
  const canReview = useCanReview();
  const reviews = (defs.data ?? []).filter((d) => d.status === 'correction_submitted' && canReview(d));
  const toSchedule = (evc.data ?? []).filter((e) => e.status === 'awaiting_scheduling');
  const toVerify = (obl.data ?? []).filter((o) => ['submitted', 'under_verification'].includes(o.status));
  const scope = activeAssignments.map((a) => a.region_code ?? 'National').join(', ');

  return (
    <div>
      <PageTitle title="Officer workspace"
        description={`Regional Office scrutiny · Good day, ${context?.profile.full_name?.replace(/\(.*\)/, '').trim().split(' ')[0] ?? ''} ·${scope} · ${[...new Set(activeAssignments.flatMap((a) => a.capabilities))].map(humanize).join(', ')}`} />

      <ActionQueue />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="My open applications" value={open.length} loading={queue.isLoading} icon={Inbox} to="/app/queue" />
        <Kpi label="My overdue applications" value={overdueCases.length} loading={queue.isLoading} icon={Hourglass} tone={overdueCases.length ? 'danger' : 'neutral'} to="/app/queue?overdue=1" />
        <Kpi label="Corrections to review" value={reviews.length} loading={defs.isLoading} icon={Eye} tone={reviews.length ? 'warning' : 'neutral'} to="/app/deficiencies" />
        {can('evc') && <Kpi label="EVCs to schedule" value={toSchedule.length} loading={evc.isLoading} icon={CalendarClock} tone={toSchedule.length ? 'warning' : 'neutral'} to="/app/evc?tab=queue" />}
        {can('compliance') && <Kpi label="Evidence to verify" value={toVerify.length} loading={obl.isLoading} icon={ClipboardCheck} tone={toVerify.length ? 'warning' : 'neutral'} to="/app/compliance?status=submitted" />}
        <Kpi label="Open escalations" value={esc.data?.length ?? 0} loading={esc.isLoading} icon={Siren} tone={esc.data?.length ? 'danger' : 'neutral'} to="/app/escalations?status=open" />
      </div>

      <div className="grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-12" title="My queue" description="Assigned to you, earliest stage target first. Select a reference to open the application."
          action={<Link to="/app/queue" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">Full queue <ArrowRight className="h-3.5 w-3.5" /></Link>}>
          {queue.isLoading ? <LoadingRows /> : !queue.data?.rows.length ? <EmptyState title="No applications assigned to you" body="Applications are assigned automatically when they enter a stage that needs your responsibility." /> :
            <ApplicationsTable rows={queue.data.rows.slice(0, 7)} showInstitution />}
        </Panel>
        <Panel className="xl:col-span-4" title="Tasks and deadlines" action={<Link to="/app/tasks" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
          {tasks.isLoading ? <LoadingRows rows={3} /> : !tasks.data?.length ? <EmptyState icon={<ListTodo className="h-5 w-5" />} title="No open tasks" /> : (
            <ul className="divide-y divide-line">{tasks.data.slice(0, 7).map((t) => (
              <li key={t.id}><Link to={taskLink(t)} className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-surface-muted/60">
                <div className="min-w-0"><p className="truncate text-[13px] font-medium">{t.title}</p><Badge tone="neutral" className="mt-1">{humanize(t.task_type)}</Badge></div><DueBadge due={t.due_at} /></Link></li>
            ))}</ul>
          )}
        </Panel>
        <Panel className="xl:col-span-4" title="Corrections awaiting your review">
          {defs.isLoading ? <LoadingRows rows={3} /> : !reviews.length ? <EmptyState title="Nothing to review" /> : (
            <ul className="divide-y divide-line">{reviews.slice(0, 5).map((d) => (
              <li key={d.id}><Link to={`/app/applications/${d.application_id}?tab=deficiencies&query=${d.id}`} className="block px-5 py-3 hover:bg-surface-muted/60"><p className="text-[13px] font-medium text-accent">{d.applications?.reference}</p><p className="text-xs text-ink-soft">{d.title}</p></Link></li>
            ))}</ul>
          )}
        </Panel>
        {(reviewsQ.data?.length ?? 0) > 0 && (
          <Panel className="xl:col-span-4" title="My concurrent reviews" description="Review tasks assigned to you on routes that run reviews in parallel.">
            <ul className="divide-y divide-line">{reviewsQ.data!.slice(0, 6).map((t) => (
              <li key={t.id}><Link to={`/app/applications/${t.application_id}`} className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-surface-muted/60">
                <div className="min-w-0"><p className="text-[13px] font-medium text-accent">{t.applications?.reference}</p><p className="truncate text-xs text-ink-soft">{t.name}</p></div>
                <div className="flex flex-col items-end gap-1"><Badge tone={REVIEW_STATUS[t.status].tone}>{REVIEW_STATUS[t.status].label}</Badge><DueBadge due={t.due_at} /></div></Link></li>
            ))}</ul>
          </Panel>
        )}
        <Panel className="xl:col-span-12" title="Pendency in your scope" description="Open applications by stage. Select a stage to open its applications.">
          {stats.isLoading ? <LoadingRows rows={3} /> : !stats.data?.by_stage.length ? <EmptyState title="No open applications in scope" /> : (
            <ul className="divide-y divide-line">{stats.data.by_stage.map((s) => (
              <li key={s.stage}><Link to={`/app/applications?stage=${s.kind}&group=open`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13px] hover:bg-surface-muted/60">
                <span className="font-medium">{s.stage}</span>
                <span className="flex items-center gap-4 tabular text-ink-soft"><span>{s.count} open</span><span>avg {s.avg_stage_age_days ?? 0}d in stage</span>{s.overdue > 0 && <StatusBadge status="overdue" label={`${s.overdue} past target`} />}</span></Link></li>
            ))}</ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
