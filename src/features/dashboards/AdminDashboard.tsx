import { ActionQueue } from './ActionQueue';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from 'motion/react';
import {
  AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, FileStack, Hourglass, RefreshCw, Siren, TimerReset, Undo2, Workflow,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '@/features/auth/AuthProvider';
import { getAnalytics, listEscalations } from '@/services/operations';
import { listRegions } from '@/services/admin';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { Kpi, PageTitle, Panel } from '@/components/ui/Workspace';
import { codeLabel, fmtDateTime, plainText, plural } from '@/lib/format';

export const CHART = { primary: '#1e3a8a', primarySoft: '#93A8DB', warn: '#C98A12', danger: '#B42318', accent: '#236B9A', muted: '#94A3B8', grid: '#E2E7F0' };
export const axis = { fontSize: 12, fill: '#475569' };

/** Tooltip with the same type scale as the rest of the app. */
export function ChartTooltip({ active, payload, label, hint }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; hint?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-semibold text-ink">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-ink-soft"><span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />{p.name}: <span className="font-semibold text-ink tabular">{p.value}</span></p>
      ))}
      {hint && <p className="mt-1.5 text-ink-faint">{hint}</p>}
    </div>
  );
}

const withRegion = (path: string, region: string) => (region ? `${path}${path.includes('?') ? '&' : '?'}region=${region}` : path);

export function AdminDashboard() {
  const { isNational, regions, can } = useAuth();
  const nav = useNavigate();
  const [region, setRegion] = useState<string>(isNational ? '' : regions[0] ?? '');
  const reduce = useReducedMotion();
  const allRegions = useQuery({ queryKey: ['regions'], queryFn: listRegions, staleTime: 600_000 });
  const q = useQuery({ queryKey: ['analytics', region], queryFn: () => getAnalytics(region || null) });
  const esc = useQuery({ queryKey: ['escalations', 'open'], queryFn: () => listEscalations('open') });
  const d = q.data;
  const scopeLabel = region ? `Region ${region}` : isNational ? 'All regions (national scope)' : 'Your regions';
  const r = (p: string) => withRegion(p, region);
  // one row per case: its most recent open escalation
  const escalationsInScope = (esc.data ?? []).filter((e) => !region || e.region_code === region)
    .filter((e, i, all) => all.findIndex((x) => (x.application_id ?? x.entity_id) === (e.application_id ?? e.entity_id)) === i);

  return (
    <div>
      <PageTitle title="Administrator workspace"
        description="Apex Bureau monitoring · Track pending applications, deadlines and follow-up across your administrative scope."
        meta={d && <span className="text-xs text-ink-soft">{scopeLabel} · updated {fmtDateTime(d.generated_at)} · synthetic demo data</span>}
        actions={<>
          <Select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)} className="w-auto min-w-[180px]">
            {isNational && <option value="">All regions</option>}
            {(allRegions.data ?? []).filter((x) => isNational || regions.includes(x.code)).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </Select>
          <Button variant="secondary" icon={<RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} />} onClick={() => { q.refetch(); esc.refetch(); }} disabled={q.isFetching}>Refresh</Button>
        </>} />
      <ActionQueue region={region} />

      {q.error ? <Panel><ErrorState error={q.error} onRetry={() => q.refetch()} /></Panel> : (
        <>
          <section aria-labelledby="attention" className="mb-8">
            <h2 id="attention" className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-soft"><AlertTriangle className="h-4 w-4 text-danger" aria-hidden />Needs attention</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Kpi label="Applications past stage target" value={d?.totals.overdue ?? 0} loading={!d} icon={Hourglass} tone={d?.totals.overdue ? 'danger' : 'neutral'} to={r('/app/applications?overdue=1&sort=due')} hint="Open the overdue queue" />
              <Kpi label="Open escalations" value={d?.escalations_open ?? 0} loading={!d} icon={Siren} tone={d?.escalations_open ? 'danger' : 'neutral'} to="/app/escalations?status=open" hint="Raised by the deadline scanner" />
              <Kpi label="EVCs overdue" value={d?.evc_overdue ?? 0} loading={!d} icon={CalendarClock} tone={d?.evc_overdue ? 'warning' : 'neutral'} to="/app/evc?overdue=1" hint="Scheduling or outcome late" />
              <Kpi label="Overdue obligations" value={d?.compliance.overdue ?? 0} loading={!d} icon={ClipboardCheck} tone={d?.compliance.overdue ? 'danger' : 'neutral'} to="/app/compliance?status=overdue" hint="Evidence not submitted in time" />
              <Kpi label="Expired documents" value={d?.validity.expired ?? 0} loading={!d} icon={TimerReset} tone={d?.validity.expired ? 'warning' : 'neutral'} to="/app/expiry?state=expired" hint={`${d?.validity.expiring_soon ?? 0} more expiring within 90 days`} />
            </div>
          </section>

          <section aria-labelledby="pipeline" className="mb-8">
            <h2 id="pipeline" className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-soft"><Workflow className="h-4 w-4 text-primary" aria-hidden />Pipeline</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Kpi label="All applications" value={d?.totals.all ?? 0} loading={!d} icon={FileStack} to={r('/app/applications')} hint={`${d?.totals.draft ?? 0} still in draft`} />
              <Kpi label="In process" value={d?.totals.in_process ?? 0} loading={!d} icon={Workflow} tone="accent" to={r('/app/applications?group=open')} hint={`${d?.totals.under_scrutiny ?? 0} under scrutiny`} />
              <Kpi label="With institutions" value={d?.totals.awaiting_institution ?? 0} loading={!d} icon={Undo2} tone={d?.totals.awaiting_institution ? 'warning' : 'neutral'} to={r('/app/applications?status=returned_for_correction')} hint={`Drafts excluded · ${plural(d?.totals.correction_submitted ?? 0, 'correction')} awaiting review`} />
              <Kpi label="Completed" value={d?.totals.completed ?? 0} loading={!d} icon={CheckCircle2} tone="primary" to={r('/app/applications?group=closed')} hint="Decision recorded by an officer" />
            </div>
          </section>

          {!d ? <div className="grid gap-6 xl:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 rounded-card" />)}</div> : (
            <div className="grid gap-6 xl:grid-cols-12">
              <Panel className="xl:col-span-7" title="Pendency by stage" description="Open applications per stage. Red is past the stage's internal target. Select a bar to open those applications.">
                <div className="px-3 pb-3 pt-4">
                  {!d.by_stage.length ? <EmptyState title="No open applications in this scope" /> : (
                    <div className="h-64" role="img" aria-label={`Open applications by stage: ${d.by_stage.map((s) => `${s.stage} ${s.count}, ${s.overdue} past target`).join('; ')}`}>
                      <ResponsiveContainer>
                        <BarChart data={d.by_stage.map((s) => ({ ...s, label: s.stage.replace('Expert Visit Committee (EVC)', 'EVC'), on_track: s.count - s.overdue }))} margin={{ left: -18, right: 8, top: 4 }} barCategoryGap="28%">
                          <CartesianGrid vertical={false} stroke={CHART.grid} />
                          <XAxis dataKey="label" tick={axis} interval={0} tickLine={false} axisLine={false} />
                          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                          <Tooltip cursor={{ fill: '#EEF1F6' }} content={<ChartTooltip hint="Select to open these applications" />} />
                          <Bar dataKey="on_track" name="Within target" stackId="a" fill={CHART.primary} isAnimationActive={!reduce} cursor="pointer"
                            onClick={(x: { kind?: string }) => x.kind && nav(r(`/app/applications?stage=${x.kind}&group=open`))} />
                          <Bar dataKey="overdue" name="Past target" stackId="a" fill={CHART.danger} radius={[5, 5, 0, 0]} isAnimationActive={!reduce} cursor="pointer"
                            onClick={(x: { kind?: string }) => x.kind && nav(r(`/app/applications?stage=${x.kind}&overdue=1`))} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
                {d.by_stage.length > 0 && (
                  <dl className="grid gap-px border-t border-line bg-line" style={{ gridTemplateColumns: `repeat(${Math.min(d.by_stage.length, 4)}, minmax(0, 1fr))` }}>
                    {d.by_stage.map((s) => (
                      <Link key={s.stage} to={r(`/app/applications?stage=${s.kind}&group=open`)} className="bg-surface px-4 py-3 hover:bg-surface-muted">
                        <dt className="truncate text-xs text-ink-soft">{s.stage.replace('Expert Visit Committee (EVC)', 'EVC')}</dt>
                        <dd className="mt-0.5 text-[13px] text-ink"><span className="font-semibold tabular">{s.avg_stage_age_days ?? 0}d</span> <span className="text-ink-soft">avg in stage</span></dd>
                      </Link>
                    ))}
                  </dl>
                )}
              </Panel>

              <Panel className="xl:col-span-7" title="Officer workload" description="Open applications currently assigned. Select a reference to open that officer's applications.">
                {!d.workload.length ? <EmptyState title="No assigned applications" /> : (
                  <ul className="divide-y divide-line">
                    {d.workload.map((w) => {
                      const max = Math.max(...d.workload.map((x) => x.open_cases), 1);
                      return (
                        <li key={w.officer_id ?? 'none'}>
                          <Link to={r(w.officer_id ? `/app/applications?group=open&assigned=${w.officer_id}` : '/app/applications?group=open&unassigned=1')}
                            className="grid grid-cols-[minmax(0,180px)_1fr_auto] items-center gap-4 px-5 py-3 hover:bg-surface-muted/70">
                            <span className="truncate text-[13px] font-medium text-ink">{w.officer}</span>
                            <span className="relative h-2.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                              <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${(w.open_cases / max) * 100}%` }} />
                              <span className="absolute inset-y-0 left-0 rounded-full bg-danger" style={{ width: `${(w.overdue / max) * 100}%` }} />
                            </span>
                            <span className="text-right text-[13px] tabular"><span className="font-semibold text-ink">{w.open_cases}</span> <span className="text-ink-soft">open</span>
                              {w.overdue > 0 && <span className="ml-2 font-medium text-danger">{w.overdue} late</span>}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>

              <Panel className="xl:col-span-5" title="Latest escalations" description="One row per case." action={<Link to="/app/escalations?status=open" className="text-[13px] font-medium text-accent hover:underline">Escalations</Link>}>
                {esc.isLoading ? <div className="space-y-2 p-5"><Skeleton className="h-4" /><Skeleton className="h-4" /></div> : !escalationsInScope.length ? <EmptyState title="No open escalations" /> : (
                  <ul className="divide-y divide-line">
                    {escalationsInScope.slice(0, 5).map((e) => (
                      <li key={e.id}>
                        <Link to={e.application_id ? `/app/applications/${e.application_id}` : '/app/escalations'} className="block px-5 py-3 hover:bg-surface-muted/70">
                          <p className="text-[13px] font-medium text-ink">{plainText(e.summary)}</p>
                          <p className="mt-0.5 text-xs text-ink-soft">{codeLabel(e.rule_code)} · {plural(e.notice_count, 'notice')} · latest {fmtDateTime(e.latest_notice_at)}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

            </div>
          )}
        </>
      )}
      <Panel className="mt-6" title="More in your scope" description="Each opens its full page; nothing is hidden, only moved off the dashboard.">
        <ul className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['Ageing of open applications', r('/app/applications?group=open&sort=age')],
            ['Expert visits (EVC)', '/app/evc'],
            ['Compliance obligations', '/app/compliance'],
            ['Document validity', '/app/expiry'],
            ['Applications by region', '/app/applications?group=open'],
            ...(can('audit') ? [['Audit log and event stream', '/app/admin/audit']] : []),
          ].map(([label, to]) => (
            <li key={label} className="bg-surface"><Link to={to} className="flex items-center justify-between gap-2 px-5 py-3 text-[13px] font-medium text-accent hover:bg-surface-muted/70">{label}<span className="text-xs text-ink-soft">View all</span></Link></li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
