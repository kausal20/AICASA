import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, ArrowRight, CalendarCheck, CheckCircle2, Copy, Eye, FilePen, FileText, Gavel, Info, MapPin, MessageSquarePlus, RotateCcw,
  Route as RouteIcon, Send, ShieldAlert, Siren, Sparkles, UserCog, UserRound, Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  addObservation, getApplication, getApplicationRow, getAvailableTransitions, getDecisions, getDirectory, getEvents,
  getObservations, getRequirements, getRoute, getStageHistory, performTransition, reassignApplication,
} from '@/services/applications';
import { listDocuments } from '@/services/documents';
import { listDeficiencies, listEvc, raiseDeficiency, returnForCorrection, getEvcHistory, getEvcParticipants } from '@/services/operations';
import { listEvcPanelExperts } from '@/services/experts';
import { RecommendPanelDialog } from '@/features/evc/RecommendPanel';
import { EvcReports, ReportStamp } from '@/features/evc/EvcReports';
import { listAuditForApplication } from '@/services/admin';
import { WorkflowTracker } from './WorkflowTracker';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Badge, DueBadge, StatusBadge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, LoadingRows, Notice, PermissionState, Skeleton } from '@/components/ui/States';
import { KeyValue, Tabs, TabPanel } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { Disclosure, Panel } from '@/components/ui/Workspace';
import { DocumentsSection } from '@/features/documents/DocumentsSection';
import { DeficiencyCard } from '@/features/deficiencies/DeficiencyCard';
import { DeficiencyMatrix } from '@/features/compliance/DeficiencyMatrix';
import { ReviewTasksPanel } from './ReviewTasksPanel';
import { useAction } from '@/hooks/useAction';
import { cn } from '@/lib/cn';
import { decisionLabel, fmtDate, fmtDateTime, humanize, endOfDayIso } from '@/lib/format';
import type { Application, ApplicationRow, AvailableTransition, AppEvent, Deficiency, EvcRow } from '@/types/domain';

const TABS = ['overview', 'timeline', 'documents', 'deficiencies', 'evc', 'details', 'audit'] as const;
type Tab = (typeof TABS)[number];

export function ApplicationDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { workspace, can, institution } = useAuth();
  const staff = workspace === 'officer' || workspace === 'admin';
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const setTab = (t: string) => { const p = new URLSearchParams(params); if (t === 'overview') p.delete('tab'); else p.set('tab', t); setParams(p, { replace: true }); };

  const row = useQuery({ queryKey: ['application', id, 'row'], queryFn: () => getApplicationRow(id) });
  const raw = useQuery({ queryKey: ['application', id, 'raw'], queryFn: () => getApplication(id) });
  const versionId = row.data?.workflow_version_id;
  const route = useQuery({ queryKey: ['route', versionId], queryFn: () => getRoute(versionId!), enabled: !!versionId, staleTime: 600_000 });
  const history = useQuery({ queryKey: ['application', id, 'history'], queryFn: () => getStageHistory(id) });
  const events = useQuery({ queryKey: ['application', id, 'events'], queryFn: () => getEvents(id) });
  const defs = useQuery({ queryKey: ['deficiencies', 'app', id], queryFn: () => listDeficiencies({ applicationId: id }) });
  const docs = useQuery({ queryKey: ['documents', 'app', id], queryFn: () => listDocuments({ applicationId: id }) });
  const reqs = useQuery({ queryKey: ['requirements', raw.data?.application_type_code, raw.data?.checklist_version],
    queryFn: () => getRequirements(raw.data!.application_type_code, raw.data!.checklist_version), enabled: !!raw.data });
  const evc = useQuery({ queryKey: ['evc', 'app', id], queryFn: () => listEvc({ applicationId: id }) });
  const decisions = useQuery({ queryKey: ['application', id, 'decisions'], queryFn: () => getDecisions(id) });
  const transitions = useQuery({ queryKey: ['application', id, 'transitions'], queryFn: () => getAvailableTransitions(id), enabled: workspace === 'officer' });
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });

  if (row.isLoading) return <div className="space-y-4"><Skeleton className="h-48 rounded-card" /><Skeleton className="h-96 rounded-card" /></div>;
  if (row.error) return <Panel><ErrorState error={row.error} onRetry={() => row.refetch()} /></Panel>;
  if (!row.data || !raw.data) return <Panel><PermissionState body="This application does not exist or is outside your authorised scope." /></Panel>;
  const a = row.data;
  const app = raw.data;
  const name = (uid: string | null) => (uid ? dir.data?.find((p) => p.id === uid)?.full_name ?? 'Authorised user' : 'System');
  const isRep = workspace === 'institution' && institution?.id === a.institution_id && institution?.member_role === 'representative';
  const openDefs = (defs.data ?? []).filter((d) => !['resolved', 'withdrawn'].includes(d.status));
  const awaitingReview = openDefs.filter((d) => d.status === 'correction_submitted');
  const latestEvc = (evc.data ?? []).filter((e) => e.status !== 'cancelled').at(-1);
  // institutions see the matrix while they can still act on it (draft or returned); staff always
  const showMatrix = staff || ['draft', 'returned_for_correction'].includes(a.status);

  return (
    <div>
      {/* Case header */}
      <section className="mb-6 overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4 px-6 pb-4 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => navigator.clipboard?.writeText(a.reference).then(() => toast.success(`Copied ${a.reference}`), () => toast.error('Copy was blocked by the browser.'))}
                className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-semibold text-accent hover:underline" aria-label={`Copy reference ${a.reference}`}>
                {a.reference}<Copy className="h-3 w-3" aria-hidden />
              </button>
              <StatusBadge status={a.status} />
              {a.is_overdue && <StatusBadge status="overdue" label="Past stage target" />}
              {a.is_demo && <Badge tone="warning">Synthetic record</Badge>}
            </div>
            <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.01em] text-ink">{a.title}</h1>
            <p className="mt-1 text-[13.5px] text-ink-soft">{a.institution_name} · {a.application_type_name} · Academic year {a.academic_year}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" icon={<RouteIcon className="h-3 w-3" />}>{a.route_name} · v{a.route_version}</Badge>
          </div>
        </div>
        <div className="border-t border-line bg-surface-muted/40 px-6 py-5">
          {route.data && history.data ? (
            <WorkflowTracker stages={route.data.stages} transitions={route.data.transitions} history={history.data}
              current={a.current_stage} status={a.status} stageDueAt={a.stage_due_at} formData={app.form_data} />
          ) : <Skeleton className="h-16" />}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 min-w-0 xl:order-1">
          <Tabs value={tab} onValueChange={setTab} tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'timeline', label: <>Timeline{events.data ? <span className="ml-1.5 text-ink-faint tabular">{events.data.length}</span> : null}</> },
            { value: 'documents', label: <>Documents{docs.data ? <span className="ml-1.5 text-ink-faint tabular">{docs.data.length}</span> : null}</> },
            { value: 'deficiencies', label: <>Query &amp; Clarification{openDefs.length ? <span className="ml-1.5 rounded-full bg-warning-soft px-1.5 text-[11px] font-semibold text-[#7a5100]">{openDefs.length} open</span> : null}</> },
            { value: 'evc', label: 'EVC' },
            { value: 'details', label: 'Details' },
            ...(staff ? [{ value: 'audit', label: 'Audit' }] : []),
          ]}>
            <TabPanel value="overview">
              {staff && <ReviewTasksPanel applicationId={a.id} />}
              {showMatrix && <DeficiencyMatrix applicationId={a.id} audience={staff ? 'staff' : 'institution'} />}
              <OverviewTab a={a} events={events.data} openDefs={openDefs} docs={docs.data?.length ?? 0} missingDocs={(reqs.data ?? []).filter((r) => r.is_required && !(docs.data ?? []).some((d) => d.doc_type === r.doc_type && d.current_version > 0)).map((r) => r.name)}
                latestEvc={latestEvc} decisions={decisions.data} name={name} onTab={setTab} />
            </TabPanel>
            <TabPanel value="timeline"><Panel><TimelineList events={events.data} loading={events.isLoading} name={name} /></Panel></TabPanel>
            <TabPanel value="documents">
              {showMatrix && <DeficiencyMatrix applicationId={a.id} audience={staff ? 'staff' : 'institution'} />}
              <Panel title="Documents and versions" description="Every upload is a new version; earlier versions stay on file and remain openable.">
                <div className="px-5">
                  {docs.isLoading ? <LoadingRows /> : (
                    <DocumentsSection docs={docs.data ?? []} requirements={reqs.data} institutionId={a.institution_id} applicationId={a.id}
                      canUpload={isRep && ['draft', 'returned_for_correction'].includes(a.status)} canRunCheck={isRep} />
                  )}
                </div>
                {!isRep && workspace === 'institution' && <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">Read-only: only a representative of this institution can upload.</p>}
                {isRep && !['draft', 'returned_for_correction'].includes(a.status) && <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">Uploads are closed while the case is with AICTE. They reopen if the case is returned for correction.</p>}
              </Panel>
            </TabPanel>
            <TabPanel value="deficiencies">
              <div className="space-y-4">
                {defs.isLoading ? <Panel><LoadingRows /></Panel> : defs.error ? <Panel><ErrorState error={defs.error} onRetry={() => defs.refetch()} /></Panel> : !defs.data?.length ? (
                  <Panel><EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="No queries raised" body="Queries raised during review appear here with every clarification and review outcome." /></Panel>
                ) : defs.data.map((d) => <DeficiencyCard key={d.id} d={{ ...d, applications: { reference: a.reference, title: a.title, institution_id: a.institution_id, status: a.status } }}
                  mode={staff ? 'staff' : 'institution'} institutionId={a.institution_id} canReview={workspace === 'officer'} />)}
              </div>
            </TabPanel>
            <TabPanel value="evc"><EvcTab rows={evc.data} loading={evc.isLoading} name={name} /></TabPanel>
            <TabPanel value="details"><DetailsTab a={a} app={app} decisions={decisions.data} name={name} /></TabPanel>
            {staff && <TabPanel value="audit"><AuditTab id={a.id} name={name} /></TabPanel>}
          </Tabs>
        </div>

        <aside className="order-1 space-y-4 xl:sticky xl:top-[84px] xl:order-2 xl:self-start">
          <NextActionCard a={a} isRep={isRep} transitions={transitions.data} awaitingReview={awaitingReview.length} openDefs={openDefs.length} onTab={setTab} />
          {workspace === 'officer' && <OfficerActions a={a} transitions={transitions.data} loading={transitions.isLoading} openDeficiencies={openDefs.filter((d) => d.status !== 'correction_submitted').length} canAssign={can('assignment')} />}
          {workspace === 'admin' && <AdminActions a={a} canAssign={can('assignment')} />}
          <CaseFacts a={a} />
          {staff && <ObservationsCard id={a.id} name={name} canAdd={workspace === 'officer' && !['draft', 'completed', 'closed'].includes(a.status)} />}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------
function Person({ label, name, sub }: { label: string; name: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-ink"><UserRound className="h-4 w-4" aria-hidden /></span>
      <div className="min-w-0"><p className="text-[11px] text-ink-faint">{label}</p><p className="truncate text-[13.5px] font-medium text-ink">{name}</p>{sub && <p className="text-xs text-ink-soft">{sub}</p>}</div>
    </div>
  );
}

function NextActionCard({ a, isRep, transitions, awaitingReview, openDefs, onTab }: {
  a: ApplicationRow; isRep: boolean; transitions?: AvailableTransition[]; awaitingReview: number; openDefs: number; onTab: (t: string) => void;
}) {
  const { workspace } = useAuth();
  const closed = ['completed', 'closed'].includes(a.status);
  const withInstitution = a.status === 'returned_for_correction' || a.status === 'draft';
  const due = a.status === 'returned_for_correction' ? a.correction_due_at : a.stage_due_at;
  const permitted = (transitions ?? []).filter((t) => t.permitted);
  let cta: ReactNode = null;
  let yours = false;
  if (workspace === 'institution' && isRep && a.status === 'draft') { yours = true; cta = <ButtonLink className="w-full" to={`/app/applications/new?draft=${a.id}`} icon={<FilePen className="h-4 w-4" />}>Continue draft</ButtonLink>; }
  else if (workspace === 'institution' && isRep && a.status === 'returned_for_correction') { yours = true; cta = <Button className="w-full" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => onTab('deficiencies')}>Respond to {openDefs} deficienc{openDefs === 1 ? 'y' : 'ies'}</Button>; }
  else if (workspace === 'officer' && awaitingReview > 0) { yours = true; cta = <Button className="w-full" icon={<Eye className="h-4 w-4" />} onClick={() => onTab('deficiencies')}>Review {awaitingReview} correction{awaitingReview > 1 ? 's' : ''}</Button>; }
  else if (workspace === 'officer' && permitted.length > 0) { yours = true; }

  return (
    <motion.section layout className={cn('overflow-hidden rounded-card border bg-surface shadow-card', yours ? 'border-primary/40 ring-1 ring-primary/15' : 'border-line')}>
      <div className={cn('px-5 py-4', yours ? 'bg-primary-soft/50' : 'bg-surface-muted/50')}>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft">
          {yours ? <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden /> : <Workflow className="h-3.5 w-3.5" aria-hidden />}
          {closed ? 'Outcome' : yours ? 'Your next action' : 'Next required action'}
        </p>
        <p className="mt-1.5 text-[16px] font-semibold leading-snug text-ink">{closed ? 'Processing complete — decision recorded' : a.next_action ?? 'No action configured'}</p>
      </div>
      <div className="space-y-4 px-5 py-4">
        {!closed && (
          <Person label="With" name={withInstitution ? a.institution_name : a.assigned_officer_name ?? 'Not yet assigned'}
            sub={withInstitution ? 'Institution' : a.assigned_officer_name ? humanize(a.next_actor) : 'Routing will assign an officer'} />
        )}
        {!closed && (
          <div>
            <p className="text-[11px] text-ink-faint">{a.status === 'returned_for_correction' ? 'Correction due' : 'Stage target date'} <span className="text-ink-faint">(internal target, IST)</span></p>
            <div className="mt-1">{due ? <DueBadge due={due} /> : <span className="text-[13px] text-ink-soft">No target configured for this stage</span>}</div>
          </div>
        )}
        {cta}
        {workspace === 'officer' && !cta && permitted.length > 0 && <p className="text-xs text-ink-soft">Choose one of your permitted actions below.</p>}
        {!yours && !closed && workspace !== 'admin' && <p className="text-xs text-ink-soft">Nothing for you to do on this case right now.</p>}
        {workspace === 'admin' && !closed && <p className="text-xs text-ink-soft">Administrators oversee applications; scrutiny and decisions stay with officers.</p>}
      </div>
    </motion.section>
  );
}

function CaseFacts({ a }: { a: ApplicationRow }) {
  return (
    <Panel title="Case facts">
      <dl className="divide-y divide-line text-[13px]">
        {[
          ['Submitted', a.submitted_at ? `${fmtDate(a.submitted_at)} · ${a.age_days} days ago` : 'Not submitted'],
          ['In current stage', a.submitted_at ? `${a.stage_age_days} days (${a.stage_name})` : '—'],
          ['Assigned officer', a.assigned_officer_name ?? '—'],
          ['Region', a.region_code],
          ['Institution code', a.institution_code],
          ['Route', `${a.route_name} · version ${a.route_version}`],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-5 py-2.5"><dt className="text-ink-soft">{k}</dt><dd className="text-right font-medium text-ink">{v}</dd></div>
        ))}
      </dl>
    </Panel>
  );
}

function OfficerActions({ a, transitions, loading, openDeficiencies, canAssign }: {
  a: ApplicationRow; transitions?: AvailableTransition[]; loading: boolean; openDeficiencies: number; canAssign: boolean;
}) {
  const [active, setActive] = useState<AvailableTransition | null>(null);
  const [def, setDef] = useState(false);
  const [ret, setRet] = useState(false);
  const [reassign, setReassign] = useState(false);
  const review = ['scrutiny', 'evc', 'committee', 'decision'].includes(a.stage_kind ?? '');
  const closed = ['completed', 'closed', 'draft'].includes(a.status);
  const permitted = (transitions ?? []).filter((t) => t.permitted);
  const blocked = (transitions ?? []).filter((t) => !t.permitted);
  return (
    <Panel title="Your actions" description="Re-checked on the server against your role, region and the route.">
      <div className="space-y-4 px-5 py-4">
        {closed ? <p className="text-[13px] text-ink-soft">No actions in status “{humanize(a.status)}”.</p> : (
          <>
            {loading ? <Skeleton className="h-10" /> : permitted.length > 0 ? (
              <ul className="space-y-2">
                {permitted.map((t) => (
                  <li key={t.code}>
                    <Button className="w-full justify-between" onClick={() => setActive(t)} icon={t.records_decision ? <Gavel className="h-4 w-4" /> : undefined}>
                      <span className="truncate">{t.name}</span><ArrowRight className="h-4 w-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-soft">No routing action is available to you at this point.</p>}
            {review && (
              <div className="grid gap-2">
                <Button variant="secondary" className="w-full justify-start" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => setDef(true)}>Raise query</Button>
                {openDeficiencies > 0 && a.status !== 'returned_for_correction' && (
                  <Button variant="secondary" className="w-full justify-start" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setRet(true)}>Return to institution ({openDeficiencies})</Button>
                )}
              </div>
            )}
            {blocked.length > 0 && (
              <Disclosure summary={`Not available right now (${blocked.length})`}>
                <ul className="space-y-2.5">
                  {blocked.map((t) => (
                    <li key={t.code} className="rounded-lg bg-surface-muted px-3 py-2">
                      <p className="text-[13px] font-medium text-ink-soft">{t.name}</p>
                      <p className="mt-0.5 flex gap-1.5 text-xs text-ink-soft"><Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{t.blocked_reason}</p>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </>
        )}
        {canAssign && !closed && <Button variant="ghost" className="w-full" icon={<UserCog className="h-4 w-4" />} onClick={() => setReassign(true)}>Reassign case</Button>}
      </div>
      {active && <TransitionDialog a={a} t={active} onClose={() => setActive(null)} />}
      {def && <RaiseDeficiencyDialog a={a} onClose={() => setDef(false)} />}
      {ret && <ReturnDialog a={a} count={openDeficiencies} onClose={() => setRet(false)} />}
      {reassign && <ReassignDialog a={a} onClose={() => setReassign(false)} />}
    </Panel>
  );
}

function AdminActions({ a, canAssign }: { a: ApplicationRow; canAssign: boolean }) {
  const [reassign, setReassign] = useState(false);
  if (!canAssign || ['completed', 'closed', 'draft'].includes(a.status)) return null;
  return (
    <Panel title="Administration">
      <div className="px-5 py-4"><Button variant="secondary" className="w-full" icon={<UserCog className="h-4 w-4" />} onClick={() => setReassign(true)}>Reassign case</Button></div>
      {reassign && <ReassignDialog a={a} onClose={() => setReassign(false)} />}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
/** Labels for declared figures whose key is not self-explanatory; other keys fall back to a humanised key. */
const FIELD_LABELS: Record<string, string> = {
  student_count: 'Students (total)', faculty_count: 'Faculty (total)', computer_count: 'Computers', library_book_count: 'Library books / volumes',
  lab_count: 'Laboratories', faculty_professors: 'Faculty: Professors', faculty_associate_professors: 'Faculty: Associate Professors',
  faculty_assistant_professors: 'Faculty: Assistant Professors', programme_level: 'Programme level', approved_intake: 'Approved intake',
  land_area_acres: 'Land area (acres)', built_up_area_sqm: 'Built-up instructional area (sqm)',
};

function OverviewTab({ a, events, openDefs, docs, missingDocs, latestEvc, decisions, name, onTab }: {
  a: ApplicationRow; events?: AppEvent[]; openDefs: Deficiency[]; docs: number; missingDocs: string[]; latestEvc?: EvcRow;
  decisions?: { id: string; decision: string; reason: string; recorded_by: string; created_at: string }[]; name: (id: string | null) => string; onTab: (t: string) => void;
}) {
  return (
    <div className="space-y-4">
      {decisions && decisions.length > 0 && (
        <Notice tone="success" icon={<Gavel className="h-4 w-4" />} title={`Decision recorded: ${decisionLabel(decisions[0].decision, a.application_type_code)}`}>
          {decisions[0].reason} — {name(decisions[0].recorded_by)}, {fmtDateTime(decisions[0].created_at)}. Recorded by a competent officer; AICASA never decides.
        </Notice>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <SummaryTile icon={ShieldAlert} tone={openDefs.length ? 'warning' : 'ok'} title="Queries" value={openDefs.length ? `${openDefs.length} open` : 'None open'}
          body={openDefs.length ? openDefs.map((d) => d.title).join('; ') : 'No outstanding corrections.'} onClick={() => onTab('deficiencies')} />
        <SummaryTile icon={FileText} tone={missingDocs.length ? 'warning' : 'ok'} title="Documents" value={`${docs} on file`}
          body={missingDocs.length ? `Missing: ${missingDocs.join(', ')}` : 'All required documents uploaded.'} onClick={() => onTab('documents')} />
        <SummaryTile icon={CalendarCheck} tone={latestEvc?.is_overdue ? 'warning' : 'neutral'} title="Expert visit" value={latestEvc ? humanize(latestEvc.status) : 'Not on route yet'}
          body={latestEvc ? (latestEvc.scheduled_start ? `Session ${fmtDateTime(latestEvc.scheduled_start)}` : `Schedule by ${fmtDate(latestEvc.schedule_due_at)}`) : 'Created only if the route reaches an EVC stage.'} onClick={() => onTab('evc')} />
      </div>
      <Panel title="Recent activity" action={<Button variant="link" size="sm" onClick={() => onTab('timeline')}>Full timeline</Button>}>
        <TimelineList events={events?.slice(0, 6)} loading={!events} name={name} compact />
      </Panel>
      {a.status === 'draft' && <Notice tone="info">This application is a draft. Nothing has been submitted to AICTE yet.</Notice>}
    </div>
  );
}

function SummaryTile({ icon: Icon, title, value, body, tone, onClick }: { icon: typeof ShieldAlert; title: string; value: string; body: string; tone: 'ok' | 'warning' | 'neutral'; onClick: () => void }) {
  return (
    <motion.button whileHover={{ y: -2 }} transition={{ duration: 0.15 }} onClick={onClick}
      className="group rounded-card border border-line bg-surface p-4 text-left shadow-card transition-[box-shadow,border-color] hover:border-line-strong hover:shadow-lift">
      <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', tone === 'warning' ? 'bg-warning-soft text-warning' : tone === 'ok' ? 'bg-success-soft text-success' : 'bg-surface-muted text-ink-soft')}><Icon className="h-4 w-4" aria-hidden /></span>
      <p className="mt-3 text-xs font-medium text-ink-soft">{title}</p>
      <p className="mt-0.5 text-[15px] font-semibold text-ink">{value}</p>
      <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{body}</p>
    </motion.button>
  );
}

const EVENT_ICON: Record<string, { icon: typeof Send; tone: string }> = {
  created: { icon: FilePen, tone: 'bg-surface-muted text-ink-soft' },
  submitted: { icon: Send, tone: 'bg-accent-soft text-accent' },
  stage_entered: { icon: Workflow, tone: 'bg-primary-soft text-primary' },
  auto_transition: { icon: Workflow, tone: 'bg-surface-muted text-ink-soft' },
  transition: { icon: ArrowRight, tone: 'bg-primary-soft text-primary' },
  decision_recorded: { icon: Gavel, tone: 'bg-success-soft text-success' },
  deficiency_raised: { icon: ShieldAlert, tone: 'bg-warning-soft text-warning' },
  returned: { icon: RotateCcw, tone: 'bg-warning-soft text-warning' },
  correction_submitted: { icon: Send, tone: 'bg-accent-soft text-accent' },
  correction_reviewed: { icon: Eye, tone: 'bg-accent-soft text-accent' },
  corrections_resolved: { icon: CheckCircle2, tone: 'bg-success-soft text-success' },
  document_uploaded: { icon: FileText, tone: 'bg-surface-muted text-ink-soft' },
  document_replaced: { icon: FileText, tone: 'bg-surface-muted text-ink-soft' },
  escalated: { icon: Siren, tone: 'bg-danger-soft text-danger' },
  evc_report_uploaded: { icon: MapPin, tone: 'bg-success-soft text-success' },
  observation: { icon: MessageSquarePlus, tone: 'bg-surface-muted text-ink-soft' },
};

function TimelineList({ events, loading, name, compact }: { events?: AppEvent[]; loading: boolean; name: (id: string | null) => string; compact?: boolean }) {
  if (loading) return <LoadingRows />;
  if (!events?.length) return <EmptyState title="No activity yet" />;
  const groups = new Map<string, AppEvent[]>();
  for (const e of events) { const k = fmtDate(e.created_at); groups.set(k, [...(groups.get(k) ?? []), e]); }
  return (
    <div className={cn('px-5', compact ? 'py-3' : 'py-4')}>
      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="mb-4 last:mb-0">
          {!compact && <h3 className="sticky top-0 mb-2 bg-surface py-1 text-xs font-semibold text-ink-faint">{day}</h3>}
          <ol>
            {list.map((e, i) => {
              const ic = EVENT_ICON[e.event_type] ?? (e.event_type.startsWith('evc') ? { icon: CalendarCheck, tone: 'bg-accent-soft text-accent' } : { icon: Info, tone: 'bg-surface-muted text-ink-soft' });
              const Icon = ic.icon;
              return (
                <motion.li key={e.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.02 }}
                  className="relative flex gap-3 pb-4 last:pb-1">
                  {i < list.length - 1 && <span aria-hidden className="absolute left-[13px] top-8 h-[calc(100%-28px)] w-px bg-line" />}
                  <span className={cn('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full', ic.tone)}><Icon className="h-3.5 w-3.5" aria-hidden /></span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-[13.5px] font-medium text-ink">{e.summary}{e.visibility === 'internal' && <Badge tone="neutral" className="ml-2">Internal</Badge>}</p>
                    <p className="text-xs text-ink-soft">{compact ? fmtDateTime(e.created_at) : fmtDateTime(e.created_at).split(', ').pop()} · {e.actor_kind === 'system' ? 'Automatic (configured rule)' : name(e.actor_id)}
                      {e.from_stage && e.to_stage && e.from_stage !== e.to_stage && <> · {humanize(e.from_stage)} → {humanize(e.to_stage)}</>}</p>
                    {e.event_type === 'evc_report_uploaded' && typeof e.metadata?.latitude === 'number' && typeof e.metadata?.longitude === 'number' && (
                      <p className="mt-1"><ReportStamp at={e.created_at} lat={e.metadata.latitude} lng={e.metadata.longitude} source={String(e.metadata.geo_source ?? '')} /></p>
                    )}
                    {e.reason && <p className="mt-1.5 rounded-lg bg-surface-muted px-3 py-2 text-[13px] text-ink-soft">{e.reason}</p>}
                  </div>
                </motion.li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function EvcTab({ rows, loading, name }: { rows?: EvcRow[]; loading: boolean; name: (id: string | null) => string }) {
  if (loading) return <Panel><LoadingRows /></Panel>;
  if (!rows?.length) return <Panel><EmptyState icon={<CalendarCheck className="h-5 w-5" />} title="No EVC on record" body="An expert visit is created only when the configured route reaches an EVC stage." /></Panel>;
  return <div className="space-y-4">{rows.map((e) => <EvcRecordCard key={e.id} e={e} name={name} />)}</div>;
}

function EvcRecordCard({ e, name }: { e: EvcRow; name: (id: string | null) => string }) {
  const { session, workspace, can } = useAuth();
  const hist = useQuery({ queryKey: ['evc', e.id, 'history'], queryFn: () => getEvcHistory(e.id) });
  const people = useQuery({ queryKey: ['evc', e.id, 'participants'], queryFn: () => getEvcParticipants(e.id) });
  const experts = useQuery({ queryKey: ['evc-panel', e.id], queryFn: () => listEvcPanelExperts(e.id), enabled: workspace !== 'institution' });
  const [recommend, setRecommend] = useState(false);
  const staff = workspace === 'officer' || workspace === 'admin';
  const open = ['awaiting_scheduling', 'proposed', 'scheduled'].includes(e.status);
  const canAssign = workspace === 'officer' && can('evc') && open;
  const isMember = !!people.data?.some((p) => p.user_id === session?.user.id);
  const started = !!e.scheduled_start && new Date(e.scheduled_start) <= new Date();
  return (
    <Panel title={`EVC cycle ${e.cycle}`} description={e.coordinator_name ? `Coordinator: ${e.coordinator_name}` : 'Coordinator not yet assigned'}
      action={<div className="flex items-center gap-2">{staff && open && <Button size="sm" variant="secondary" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => setRecommend(true)}>Recommend panel</Button>}<StatusBadge status={e.status} /></div>}>
      {recommend && <RecommendPanelDialog evcId={e.id} version={e.row_version} canAssign={canAssign} onClose={() => setRecommend(false)} />}
      <div className="px-5 py-4">
        <KeyValue items={[
          { label: 'Queued', value: fmtDateTime(e.ready_at) },
          { label: e.status === 'awaiting_scheduling' ? 'Schedule by' : 'Session', value: e.status === 'awaiting_scheduling' ? <DueBadge due={e.schedule_due_at} /> : e.scheduled_start ? `${fmtDateTime(e.scheduled_start)} – ${fmtDateTime(e.scheduled_end)}` : '—' },
          { label: 'Outcome', value: e.outcome === 'satisfactory' ? 'EVC Recommended' : e.outcome ? humanize(e.outcome) : '—' },
          { label: 'Reschedules', value: e.reschedule_count },
        ]} />
        {e.completion_summary && <p className="mt-3 rounded-lg bg-surface-muted px-3 py-2 text-[13px]">{e.completion_summary}</p>}
        {staff && (
          <div className="mt-4 border-t border-line pt-4" aria-label="Expert panel">
            <h3 className="text-[13px] font-semibold">Experts on the panel</h3>
            {!experts.data?.length ? <p className="mt-1 text-[13px] text-ink-soft">No expert added yet. Use Recommend panel to see eligible experts; anyone with a conflict of interest is excluded automatically.</p> : (
              <ul className="mt-2 flex flex-wrap gap-2">{experts.data.map((x) => (
                <li key={x.expert_id} className="rounded-lg border border-line px-3 py-1.5 text-[13px]"><span className="font-medium">{x.experts?.full_name ?? 'Expert'}</span>
                  <span className="ml-2 text-xs text-ink-soft">{x.experts?.specializations.join(', ')} · {x.experts?.region_code}</span></li>
              ))}</ul>
            )}
          </div>
        )}
        {staff && ['scheduled', 'completed'].includes(e.status) && <EvcReports evcId={e.id} canUpload={isMember} hasStarted={started} status={e.status} />}
        {hist.data && (
          <ol className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-ink-soft">
            {hist.data.map((h) => <li key={h.id}><span className="font-medium text-ink">{humanize(h.action)}</span> · {fmtDateTime(h.created_at)} · {name(h.actor_id)}{h.reason ? ` · ${h.reason}` : ''}</li>)}
          </ol>
        )}
        <p className="mt-3 text-xs text-ink-soft">Scheduling is done by EVC officers in <Link to="/app/evc" className="text-accent hover:underline">EVC scheduling</Link>.</p>
      </div>
    </Panel>
  );
}

function DetailsTab({ a, app, decisions, name }: { a: ApplicationRow; app: Application; decisions?: { id: string; decision: string; reason: string; recorded_by: string; created_at: string }[]; name: (id: string | null) => string }) {
  return (
    <div className="space-y-4">
      <Panel title="Application details"><div className="px-5 py-4">
        <KeyValue items={[
          { label: 'Reference', value: a.reference }, { label: 'Institution', value: `${a.institution_name} (${a.institution_code})` },
          { label: 'Region', value: a.region_code }, { label: 'Type', value: a.application_type_name },
          { label: 'Route version', value: `${a.route_name} v${a.route_version} (fixed when the case was created)` },
          { label: 'Created', value: fmtDateTime(a.created_at) },
          ...Object.entries(app.form_data ?? {}).map(([k, v]) => ({ label: FIELD_LABELS[k] ?? humanize(k), value: typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '—') })),
        ]} />
      </div></Panel>
      {!!decisions?.length && (
        <Panel title="Recorded decisions" description="Recorded by a competent officer. AICASA never makes approval decisions.">
          <ul className="space-y-3 px-5 py-4">{decisions.map((d) => (
            <li key={d.id} className="text-[13px]"><StatusBadge status={d.decision === 'not_approved' ? 'still_deficient' : 'completed'} label={decisionLabel(d.decision, a.application_type_code)} />
              <span className="ml-2 text-ink-soft">{name(d.recorded_by)} · {fmtDateTime(d.created_at)}</span><p className="mt-1">{d.reason}</p></li>
          ))}</ul>
        </Panel>
      )}
    </div>
  );
}

function AuditTab({ id, name }: { id: string; name: (id: string | null) => string }) {
  const q = useQuery({ queryKey: ['application', id, 'audit'], queryFn: () => listAuditForApplication(id) });
  if (q.isLoading) return <Panel><LoadingRows /></Panel>;
  if (q.error) return <Panel><ErrorState error={q.error} onRetry={() => q.refetch()} /></Panel>;
  return (
    <Panel title="Audit trail" description="Append-only. Includes rejected attempts.">
      <ul className="divide-y divide-line">
        {(q.data ?? []).map((r) => (
          <li key={r.id} className="px-5 py-3 text-[13px]">
            <p><Badge tone={r.action.includes('rejected') ? 'danger' : 'neutral'}>{humanize(r.action)}</Badge>
              <span className="ml-2 text-ink-soft">{fmtDateTime(r.created_at)} · {r.actor_kind === 'system' ? 'System' : r.actor_name ?? name(r.actor_id)}</span></p>
            {r.reason && <p className="mt-1 text-ink-soft">{r.reason}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Dialogs (all call server operations; on failure the message is shown and nothing changes locally)
// ---------------------------------------------------------------------------
function TransitionDialog({ a, t, onClose }: { a: ApplicationRow; t: AvailableTransition; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = useAction(async () => {
    const r = await performTransition(a.id, t.code, a.row_version, reason || undefined, t.records_decision ? { decision } : {});
    if (!r.ok) throw new Error(r.message);
    return r;
  }, { success: () => `Done. ${t.name} recorded.`, invalidate: [['application'], ['applications'], ['tasks'], ['evc'], ['navcounts']], onSuccess: onClose });
  const invalid = (t.requires_reason && reason.trim().length < 10) || (t.records_decision && !decision);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t.name} description={`${a.reference} → ${humanize(t.to_stage)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={act.isPending} disabled={invalid} onClick={() => { setError(null); act.mutate(undefined, { onError: (e) => setError((e as Error).message) }); }}>Confirm</Button></>}>
      <div className="space-y-4">
        {t.records_decision && (
          <>
            <Notice tone="info" icon={<Gavel className="h-4 w-4" />}>You are recording the decision of the competent authority. It is stored with your name and time and cannot be edited.</Notice>
            <SelectField label="Decision" required value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">Select…</option>
              <option value="approved">{decisionLabel("approved", a.application_type_code)}</option>
              <option value="approved_with_conditions">{decisionLabel("approved_with_conditions", a.application_type_code)}</option>
              <option value="not_approved">{decisionLabel("not_approved")}</option>
              <option value="deferred">Deferred</option>
            </SelectField>
          </>
        )}
        <TextAreaField label="Reason / remarks" required={t.requires_reason} rows={4} value={reason} onChange={(e) => setReason(e.target.value)}
          hint={t.requires_reason ? 'Required by the route configuration (at least 10 characters).' : 'Optional; recorded in the timeline.'} />
        <AnimatePresence>{error && <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}><Notice tone="danger" icon={<AlertTriangle className="h-4 w-4" />}>{error} The case was not changed.</Notice></motion.div>}</AnimatePresence>
      </div>
    </Dialog>
  );
}

function RaiseDeficiencyDialog({ a, onClose }: { a: ApplicationRow; onClose: () => void }) {
  const reqs = useQuery({ queryKey: ['requirements-for', a.application_type_code], queryFn: async () => {
    const raw = await getApplication(a.id); return raw ? getRequirements(raw.application_type_code, raw.checklist_version) : [];
  } });
  const { context } = useAuth();
  const period = context?.settings?.['deficiency.correction_period'] as { days?: number; source_reference?: string } | undefined;
  const win = context?.settings?.['deficiency.query_window'] as { hours?: number; source_reference?: string } | undefined;
  const windowHours = typeof win?.hours === 'number' && win.hours > 0 ? win.hours : null;
  const defaultDays = typeof period?.days === 'number' && period.days >= 1 ? period.days : null;
  const [f, setF] = useState({ title: '', reason: '', source: '', correction: '', docType: '', due: '' });
  const [useDefault, setUseDefault] = useState(defaultDays !== null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction(() => raiseDeficiency({ applicationId: a.id, title: f.title, reason: f.reason, source: f.source, correction: f.correction, docType: f.docType || undefined,
    dueAt: windowHours || useDefault ? null : endOfDayIso(f.due) }),
    { success: 'Query raised. Return the case to the institution to send it.', invalidate: [['deficiencies'], ['application'], ['matrix']], onSuccess: onClose });
  const valid = f.title.trim().length >= 5 && f.reason.trim().length >= 10 && f.source.trim().length >= 3 && f.correction.trim().length >= 10 && (windowHours !== null || useDefault || f.due);
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Raise query" description={a.reference}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!valid} onClick={() => act.mutate(undefined)}>Raise query</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><TextField label="Title" required value={f.title} onChange={set('title')} /></div>
        <div className="sm:col-span-2"><TextAreaField label="Reason" required value={f.reason} onChange={set('reason')} hint="What is missing or incorrect, stated plainly." /></div>
        <TextField label="Requirement / source" required value={f.source} onChange={set('source')} hint="Checklist item or rule reference." />
        <SelectField label="Related document" value={f.docType} onChange={set('docType')}>
          <option value="">None / information only</option>
          {(reqs.data ?? []).map((r) => <option key={r.doc_type} value={r.doc_type}>{r.name}</option>)}
        </SelectField>
        <div className="sm:col-span-2"><TextAreaField label="Query: clarification or correction requested" required value={f.correction} onChange={set('correction')} /></div>
        {windowHours !== null ? (
          <div className="sm:col-span-2"><Notice tone="info" title={`${windowHours}-hour response window`}>The institution has {windowHours} hours from the moment the query is raised to send its clarification. A live countdown shows on both sides; when it ends, uploads are disabled and the escalation rule fires. {win?.source_reference}</Notice></div>
        ) : (
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Correction deadline <span className="text-danger">*</span></legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={cn('flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]', defaultDays === null && 'opacity-60')}>
              <input type="radio" name="due-mode" className="mt-0.5 accent-[#1e3a8a]" disabled={defaultDays === null} checked={useDefault} onChange={() => setUseDefault(true)} />
              <span>{defaultDays === null ? 'No default correction period is configured' : <>Configured default: {defaultDays} days<span className="block text-xs text-ink-soft">{period?.source_reference ?? 'Set by an administrator'}</span></>}</span>
            </label>
            <label className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]">
              <input type="radio" name="due-mode" className="mt-0.5 accent-[#1e3a8a]" checked={!useDefault} onChange={() => setUseDefault(false)} />
              <span className="min-w-0 flex-1">Choose a date
                {!useDefault && <TextField label="Due date" type="date" required value={f.due} onChange={set('due')} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} hint="End of day, IST." />}
              </span>
            </label>
          </div>
        </fieldset>
        )}
      </div>
    </Dialog>
  );
}

function ReturnDialog({ a, count, onClose }: { a: ApplicationRow; count: number; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(() => returnForCorrection(a.id, a.row_version, reason), { success: 'Returned to the institution. They have been notified.', invalidate: [['application'], ['applications'], ['deficiencies'], ['navcounts']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Return to institution" description={`${count} open deficienc${count === 1 ? 'y' : 'ies'} will be sent for correction.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Return for correction</Button></>}>
      <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}

function ReassignDialog({ a, onClose }: { a: ApplicationRow; onClose: () => void }) {
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory });
  const [officer, setOfficer] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => reassignApplication(a.id, officer, reason), { success: 'Case reassigned.', invalidate: [['application'], ['applications']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Reassign case" description="Only officers holding this stage's responsibility in the region are accepted by the server."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!officer || reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Reassign</Button></>}>
      <div className="space-y-4">
        <SelectField label="Officer" required value={officer} onChange={(e) => setOfficer(e.target.value)}>
          <option value="">Select…</option>
          {(dir.data ?? []).filter((p) => p.roles?.includes('officer') && p.id !== a.assigned_officer_id).map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.designation ? ` — ${p.designation}` : ''}</option>)}
        </SelectField>
        <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function ObservationsCard({ id, name, canAdd }: { id: string; name: (id: string | null) => string; canAdd: boolean }) {
  const q = useQuery({ queryKey: ['application', id, 'observations'], queryFn: () => getObservations(id) });
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [cat, setCat] = useState('general');
  const [vis, setVis] = useState<'internal' | 'shared'>('internal');
  const act = useAction(() => addObservation(id, cat, body, vis), { success: 'Observation recorded.', invalidate: [['application', id]], onSuccess: () => { setOpen(false); setBody(''); } });
  return (
    <Panel title="Observations" action={canAdd && <Button size="sm" variant="secondary" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Add</Button>}>
      <div className="px-5 py-4">
        {q.isLoading ? <LoadingRows rows={2} /> : !q.data?.length ? <p className="text-[13px] text-ink-soft">No observations yet.</p> : (
          <ul className="space-y-3">
            {q.data.map((o) => (
              <li key={o.id} className="text-[13px]">
                <p className="flex flex-wrap items-center gap-1.5"><Badge tone="neutral">{humanize(o.category)}</Badge>{o.visibility === 'shared' ? <Badge tone="accent" icon={<Eye className="h-3 w-3" />}>Shared</Badge> : <Badge tone="neutral">Internal</Badge>}</p>
                <p className="mt-1">{o.body}</p>
                <p className="mt-0.5 text-xs text-ink-soft">{name(o.author_id)} · {fmtDateTime(o.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && (
        <Dialog open onOpenChange={setOpen} title="Record observation"
          footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={act.isPending} disabled={body.trim().length < 3} onClick={() => act.mutate(undefined)}>Save</Button></>}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Category" required value={cat} onChange={(e) => setCat(e.target.value)}>
                {['general', 'document', 'infrastructure', 'faculty', 'finance', 'legal'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </SelectField>
              <SelectField label="Visibility" required value={vis} onChange={(e) => setVis(e.target.value as 'internal' | 'shared')}>
                <option value="internal">Internal (AICTE staff only)</option>
                <option value="shared">Shared with institution</option>
              </SelectField>
            </div>
            <TextAreaField label="Observation" required rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </Dialog>
      )}
    </Panel>
  );
}
