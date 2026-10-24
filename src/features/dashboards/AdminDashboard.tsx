import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useReducedMotion } from 'motion/react';
import {
  AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, ClipboardCheck, FileStack, Hourglass, RefreshCw, Siren, TimerReset, Undo2, Workflow,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '@/features/auth/AuthProvider';
import { getAnalytics, listEscalations } from '@/services/operations';
import { listRegions } from '@/services/admin';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/States';
import { Kpi, PageTitle, Panel } from '@/components/ui/Workspace';
import { fmtDateTime, humanize } from '@/lib/format';

export const CHART = { primary: '#176B5B', primarySoft: '#7FB7A9', warn: '#C98A12', danger: '#B42318', accent: '#236B9A', muted: '#9AA8A1', grid: '#E7ECE8' };
export const axis = { fontSize: 12, fill: '#5D6963' };

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
  const { isNational, regions } = useAuth();
  const nav = useNavigate();
  const [region, setRegion] = useState<string>(isNational ? '' : regions[0] ?? '');
  const reduce = useReducedMotion();
  const allRegions = useQuery({ queryKey: ['regions'], queryFn: listRegions, staleTime: 600_000 });
  const q = useQuery({ queryKey: ['analytics', region], queryFn: () => getAnalytics(region || null) });
  const esc = useQuery({ queryKey: ['escalations', 'open'], queryFn: () => listEscalations('open') });
  const d = q.data;
  const scopeLabel = region ? `Region ${region}` : isNational ? 'All regions (national scope)' : 'Your regions';
  const r = (p: string) => withRegion(p, region);
  const evcData = d ? (['awaiting_scheduling', 'proposed', 'scheduled', 'completed'] as const).map((k) => ({ key: k, name: humanize(k), count: d.evc[k] ?? 0 })) : [];
  const complianceKeys = ['overdue', 'due_soon', 'awaiting_submission', 'correction_required', 'submitted', 'upcoming', 'verified'];
  const escalationsInScope = (esc.data ?? []).filter((e) => !region || e.region_code === region);

  return (
    <div>
      <PageTitle title="Operational overview"
        description="Pendency, deadlines and follow-up across your administrative scope. Every figure is computed in the database from records your scope permits; select any tile or bar to open those records."
        meta={d && <span className="text-xs text-ink-soft">{scopeLabel} · updated {fmtDateTime(d.generated_at)} · synthetic demo data</span>}
        actions={<>
          <Select aria-label="Region scope" value={region} onChange={(e) => setRegion(e.target.value)} className="w-auto min-w-[180px]">
            {isNational && <option value="">All regions</option>}
            {(allRegions.data ?? []).filter((x) => isNational || regions.includes(x.code)).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
          </Select>
          <Button variant="secondary" icon={<RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} />} onClick={() => { q.refetch(); esc.refetch(); }} disabled={q.isFetching}>Refresh</Button>
        </>} />

      {q.error ? <Panel><ErrorState error={q.error} onRetry={() => q.refetch()} /></Panel> : (
        <>
          <section aria-labelledby="attention" className="mb-8">
            <h2 id="attention" className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink-soft"><AlertTriangle className="h-4 w-4 text-danger" aria-hidden />Needs attention</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              <Kpi label="Cases past stage target" value={d?.totals.overdue ?? 0} loading={!d} icon={Hourglass} tone={d?.totals.overdue ? 'danger' : 'neutral'} to={r('/app/applications?overdue=1&sort=due')} hint="Open the overdue queue" />
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
              <Kpi label="With institutions" value={d?.totals.awaiting_institution ?? 0} loading={!d} icon={Undo2} tone={d?.totals.awaiting_institution ? 'warning' : 'neutral'} to={r('/app/applications?status=returned_for_correction')} hint={`${d?.totals.correction_submitted ?? 0} corrections awaiting review`} />
              <Kpi label="Completed" value={d?.totals.completed ?? 0} loading={!d} icon={CheckCircle2} tone="primary" to={r('/app/applications?group=closed')} hint="Decision recorded by an officer" />
            </div>
          </section>

          {!d ? <div className="grid gap-6 xl:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 rounded-card" />)}</div> : (
            <div className="grid gap-6 xl:grid-cols-12">
              <Panel className="xl:col-span-7" title="Pendency by stage" description="Open cases per stage. Red is past the stage's internal target. Select a bar to open those cases.">
                <div className="px-3 pb-3 pt-4">
                  {!d.by_stage.length ? <EmptyState title="No open applications in this scope" /> : (
                    <div className="h-64" role="img" aria-label={`Open applications by stage: ${d.by_stage.map((s) => `${s.stage} ${s.count}, ${s.overdue} past target`).join('; ')}`}>
                      <ResponsiveContainer>
                        <BarChart data={d.by_stage.map((s) => ({ ...s, label: s.stage.replace('Expert Visit Committee (EVC)', 'EVC'), on_track: s.count - s.overdue }))} margin={{ left: -18, right: 8, top: 4 }} barCategoryGap="28%">
                          <CartesianGrid vertical={false} stroke={CHART.grid} />
                          <XAxis dataKey="label" tick={axis} interval={0} tickLine={false} axisLine={false} />
                          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                          <Tooltip cursor={{ fill: '#F0F3F0' }} content={<ChartTooltip hint="Select to open these cases" />} />
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

              <Panel className="xl:col-span-5" title="Ageing of open cases" description="Days since submission. Select a bar to open that age band.">
                <div className="px-3 pb-4 pt-4">
                  {!d.ageing.length ? <EmptyState title="No open applications" /> : (
                    <div className="h-64" role="img" aria-label={`Ageing: ${d.ageing.map((a) => `${a.bucket} ${a.count}`).join(', ')}`}>
                      <ResponsiveContainer>
                        <BarChart data={d.ageing} margin={{ left: -18, right: 8, top: 4 }} barCategoryGap="30%">
                          <CartesianGrid vertical={false} stroke={CHART.grid} />
                          <XAxis dataKey="bucket" tick={axis} tickLine={false} axisLine={false} />
                          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                          <Tooltip cursor={{ fill: '#F0F3F0' }} content={<ChartTooltip hint="Select to open these cases" />} />
                          <Bar dataKey="count" name="Open cases" radius={[5, 5, 0, 0]} isAnimationActive={!reduce} cursor="pointer"
                            onClick={(x: { min_days: number; max_days: number | null }) => nav(r(`/app/applications?group=open&ageMin=${x.min_days}${x.max_days !== null ? `&ageMax=${x.max_days}` : ''}&sort=age`))}>
                            {d.ageing.map((a) => <Cell key={a.bucket} fill={a.min_days >= 60 ? CHART.danger : a.min_days >= 30 ? CHART.warn : a.min_days >= 15 ? CHART.accent : CHART.primary} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </Panel>

              <Panel className="xl:col-span-7" title="Officer workload" description="Open cases currently assigned. Select a row to open that officer's cases.">
                {!d.workload.length ? <EmptyState title="No assigned cases" /> : (
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

              <Panel className="xl:col-span-5" title="Expert visits (EVC)" description={`${d.evc_overdue} overdue for scheduling or outcome`}
                action={<Link to="/app/evc" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">EVC overview<ArrowRight className="h-3.5 w-3.5" /></Link>}>
                <div className="px-3 pb-4 pt-4">
                  <div className="h-52" role="img" aria-label={`EVC: ${evcData.map((e) => `${e.name} ${e.count}`).join(', ')}`}>
                    <ResponsiveContainer>
                      <BarChart data={evcData} layout="vertical" margin={{ left: 40, right: 16 }} barCategoryGap="28%">
                        <CartesianGrid horizontal={false} stroke={CHART.grid} />
                        <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
                        <YAxis type="category" dataKey="name" tick={axis} width={120} tickLine={false} axisLine={false} />
                        <Tooltip cursor={{ fill: '#F0F3F0' }} content={<ChartTooltip hint="Select to open this group" />} />
                        <Bar dataKey="count" name="EVCs" radius={[0, 5, 5, 0]} isAnimationActive={!reduce} cursor="pointer"
                          onClick={(x: { key: string }) => nav(`/app/evc?tab=${x.key === 'awaiting_scheduling' ? 'queue' : x.key === 'completed' ? 'done' : x.key}`)}>
                          {evcData.map((e) => <Cell key={e.key} fill={e.key === 'awaiting_scheduling' ? CHART.warn : e.key === 'completed' ? CHART.primary : CHART.accent} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </Panel>

              <Panel className="xl:col-span-4" title="Compliance obligations" action={<Link to="/app/compliance" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
                <ul className="divide-y divide-line">
                  {complianceKeys.map((k) => (
                    <li key={k}>
                      <Link to={`/app/compliance?status=${k}`} className="flex items-center justify-between px-5 py-2.5 hover:bg-surface-muted/70">
                        <StatusBadge status={k} /><span className="text-[14px] font-semibold tabular text-ink">{d.compliance[k] ?? 0}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel className="xl:col-span-3" title="Document validity" action={<Link to="/app/expiry" className="text-[13px] font-medium text-accent hover:underline">All</Link>}>
                <ul className="divide-y divide-line">
                  {['expired', 'expiring_soon', 'valid'].map((k) => (
                    <li key={k}>
                      <Link to={`/app/expiry?state=${k}`} className="flex items-center justify-between px-5 py-2.5 hover:bg-surface-muted/70">
                        <StatusBadge status={k} /><span className="text-[14px] font-semibold tabular text-ink">{d.validity[k] ?? 0}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-line px-5 py-3">
                  <p className="text-xs text-ink-soft">Overdue officer tasks: <span className="font-semibold text-ink tabular">{d.tasks_overdue}</span></p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">Tasks are worked by officers in their own workspace.</p>
                </div>
              </Panel>

              <Panel className="xl:col-span-5" title="Latest open escalations" action={<Link to="/app/escalations?status=open" className="text-[13px] font-medium text-accent hover:underline">Escalations</Link>}>
                {esc.isLoading ? <div className="space-y-2 p-5"><Skeleton className="h-4" /><Skeleton className="h-4" /></div> : !escalationsInScope.length ? <EmptyState title="No open escalations" /> : (
                  <ul className="divide-y divide-line">
                    {escalationsInScope.slice(0, 5).map((e) => (
                      <li key={e.id}>
                        <Link to={e.application_id ? `/app/applications/${e.application_id}` : '/app/escalations'} className="block px-5 py-3 hover:bg-surface-muted/70">
                          <p className="text-[13px] font-medium text-ink">{e.summary}</p>
                          <p className="mt-0.5 text-xs text-ink-soft">{e.rule_code} · notice {e.repeat_no} · {fmtDateTime(e.triggered_at)}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {isNational && !region && d.by_region.length > 0 && (
                <Panel className="xl:col-span-12" title="Open cases by region" description="Select a region to open its cases.">
                  <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">
                    {d.by_region.map((x) => (
                      <Link key={x.region} to={`/app/applications?region=${x.region}&group=open`} className="rounded-xl border border-line px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-muted/60">
                        <p className="text-xs text-ink-soft">Region {x.region}</p>
                        <p className="mt-0.5 text-[22px] font-semibold tabular text-ink">{x.count}</p>
                        <p className={`text-xs ${x.overdue ? 'font-medium text-danger' : 'text-ink-soft'}`}>{x.overdue} past target</p>
                      </Link>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
