import { ActionQueue } from './ActionQueue';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, CheckCircle2, ClipboardCheck, FilePen, FilePlus2, FileStack, ShieldAlert, TimerReset, Workflow } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import { listApplications } from '@/services/applications';
import { listNotifications, listObligations, listValidities } from '@/services/operations';
import { ButtonLink } from '@/components/ui/Button';
import { DueBadge, StatusBadge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { Kpi, PageTitle, Panel } from '@/components/ui/Workspace';
import { ApplicationsTable } from '@/features/applications/ApplicationsListPage';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { ApplicationStatus, CheckRun } from '@/types/domain';

const IN_PROCESS: ApplicationStatus[] = ['submitted', 'under_scrutiny', 'correction_submitted', 'evc_required', 'evc_scheduled', 'evc_completed', 'committee_review', 'awaiting_decision'];

export function InstitutionDashboard() {
  const { institution, context } = useAuth();
  const id = institution?.id;
  const statuses = useQuery({ queryKey: ['applications', 'statuses', id], enabled: !!id,
    queryFn: async () => unwrap(await supabase.from('v_applications').select('status').eq('institution_id', id!)) as { status: ApplicationStatus }[] });
  const recent = useQuery({ queryKey: ['applications', 'recent', id], queryFn: () => listApplications({ institutionId: id }, 0), enabled: !!id });
  const obl = useQuery({ queryKey: ['obligations', id], queryFn: () => listObligations({ institutionId: id }), enabled: !!id });
  const val = useQuery({ queryKey: ['validities', id], queryFn: () => listValidities({ institutionId: id }), enabled: !!id });
  const notes = useQuery({ queryKey: ['notifications', 'recent5'], queryFn: () => listNotifications(5) });
  const checks = useQuery({ queryKey: ['checkruns', 'inst', id], enabled: !!id,
    queryFn: async () => unwrap(await supabase.from('document_check_runs').select('*, document_versions(file_name, documents(title, application_id))').eq('institution_id', id!).order('started_at', { ascending: false }).limit(5)) as (CheckRun & { document_versions: { file_name: string; documents: { title: string } } })[] });

  if (!institution) return <Notice tone="warning">Your account is not linked to an institution.</Notice>;
  const s = statuses.data ?? [];
  const c = (pred: (x: { status: ApplicationStatus }) => boolean) => s.filter(pred).length;
  const obligations = obl.data ?? [];
  const overdueObl = obligations.filter((o) => o.effective_status === 'overdue');
  const nextObl = obligations.filter((o) => ['overdue', 'due_soon', 'correction_required', 'awaiting_submission'].includes(o.effective_status)).slice(0, 6);
  const renewals = (val.data ?? []).filter((v) => v.validity_state === 'expired' || v.validity_state === 'expiring_soon');
  const loading = statuses.isLoading;

  return (
    <div>
      <PageTitle title={institution.name} description={`${institution.code} · Region ${institution.region_code ?? ''} · signed in as ${context?.profile.full_name}`}
        actions={<ButtonLink to="/app/applications/new" icon={<FilePlus2 className="h-4 w-4" />}>New application</ButtonLink>} />

      <ActionQueue />

      {statuses.error ? <Panel className="mb-6"><ErrorState error={statuses.error} onRetry={() => statuses.refetch()} /></Panel> : (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Applications" value={s.length} loading={loading} icon={FileStack} to="/app/applications" />
          <Kpi label="Drafts" value={c((x) => x.status === 'draft')} loading={loading} icon={FilePen} to="/app/applications?status=draft" />
          <Kpi label="Under processing" value={c((x) => IN_PROCESS.includes(x.status))} loading={loading} icon={Workflow} tone="accent" to="/app/applications?group=open" />
          <Kpi label="Awaiting your action" value={c((x) => x.status === 'returned_for_correction')} loading={loading} icon={ShieldAlert} tone={c((x) => x.status === 'returned_for_correction') ? 'warning' : 'neutral'} to="/app/applications?status=returned_for_correction" />
          <Kpi label="Completed" value={c((x) => x.status === 'completed' || x.status === 'closed')} loading={loading} icon={CheckCircle2} tone="primary" to="/app/applications?group=closed" />
          <Kpi label="Overdue obligations" value={overdueObl.length} loading={obl.isLoading} icon={ClipboardCheck} tone={overdueObl.length ? 'danger' : 'neutral'} to="/app/compliance?status=overdue" />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-12">
        <Panel className="xl:col-span-12" title="Applications" description="Most recently updated. Select a row to open its workspace."
          action={<Link to="/app/applications" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">All applications <ArrowRight className="h-3.5 w-3.5" /></Link>}>
          {recent.isLoading ? <LoadingRows /> : recent.error ? <ErrorState error={recent.error} onRetry={() => recent.refetch()} /> : !recent.data?.rows.length ? <EmptyState title="No applications yet" action={<ButtonLink to="/app/applications/new">Start an application</ButtonLink>} /> :
            <ApplicationsTable rows={recent.data.rows.slice(0, 6)} showInstitution={false} />}
        </Panel>
        <div className="grid gap-6 md:grid-cols-2 xl:col-span-12">
          <Panel title="Compliance calendar" description="By due date" action={<Link to="/app/compliance" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
            {obl.isLoading ? <LoadingRows rows={3} /> : !nextObl.length ? <EmptyState title="Nothing due" /> : (
              <ul className="divide-y divide-line">{nextObl.map((o) => (
                <li key={o.id}><Link to={`/app/compliance?status=${o.effective_status}`} className="flex items-start justify-between gap-3 px-5 py-3 hover:bg-surface-muted/60">
                  <div className="min-w-0"><p className="text-[13px] font-medium">{o.title}</p><StatusBadge status={o.effective_status} className="mt-1" /></div><DueBadge due={o.due_at} /></Link></li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="Document renewals" action={<Link to="/app/expiry" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
            {val.isLoading ? <LoadingRows rows={2} /> : !renewals.length ? <EmptyState icon={<TimerReset className="h-5 w-5" />} title="No renewals due" body="Documents expiring within 90 days appear here." /> : (
              <ul className="divide-y divide-line">{renewals.map((v) => (
                <li key={v.id}><Link to={`/app/expiry?state=${v.validity_state}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-muted/60">
                  <div><p className="text-[13px] font-medium">{v.title}</p><p className="text-xs text-ink-soft">Expiry {fmtDate(v.expiry_date)}</p></div><StatusBadge status={v.validity_state} /></Link></li>
              ))}</ul>
            )}
          </Panel>
        </div>
        <Panel className="xl:col-span-6" title="Recent pre-check results" action={<Link to="/app/precheck" className="text-[13px] font-medium text-accent hover:underline">Run a check</Link>}>
          {checks.isLoading ? <LoadingRows rows={3} /> : !checks.data?.length ? <EmptyState title="No pre-checks run yet" /> : (
            <ul className="divide-y divide-line">{checks.data.map((r) => {
              const issues = Object.entries(r.summary ?? {}).filter(([k]) => k !== 'passed').reduce((a, [, n]) => a + (n as number), 0);
              return (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0"><p className="truncate text-[13px] font-medium">{r.document_versions?.documents?.title}</p><p className="text-xs text-ink-soft">{fmtDateTime(r.completed_at ?? r.started_at)}</p></div>
                  {r.status === 'failed' ? <StatusBadge status="extraction_failed" label="Check failed" /> : issues ? <StatusBadge status="potential_issue" label={`${issues} to review`} /> : <StatusBadge status="passed" label="All passed" />}
                </li>
              );
            })}</ul>
          )}
        </Panel>
        <Panel className="xl:col-span-6" title="Latest notifications" action={<Link to="/app/notifications" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
          {!notes.data?.length ? <EmptyState icon={<Bell className="h-5 w-5" />} title="No notifications yet" /> : (
            <ul className="divide-y divide-line">{notes.data.map((n) => (
              <li key={n.id}><Link to={n.link ?? '/app/notifications'} className="block px-5 py-3 hover:bg-surface-muted/60"><p className="text-[13px] font-medium">{n.title}</p><p className="text-xs text-ink-soft">{n.body}</p><p className="mt-0.5 text-[11px] text-ink-faint">{fmtDateTime(n.created_at)}</p></Link></li>
            ))}</ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
