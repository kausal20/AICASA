import { SavedViews } from './SavedViews';
import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence } from 'motion/react';
import { Copy, ExternalLink, FilePlus2, FileText, History, Search, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import { getApplicationTypes, getDirectory, listApplications, PAGE_SIZE, type ApplicationFilters, type SortField } from '@/services/applications';
import { listRegions } from '@/services/admin';
import { ButtonLink, Button } from '@/components/ui/Button';
import { DueBadge, StatusBadge, statusLabel } from '@/components/ui/Badge';
import { Input, Select } from '@/components/ui/Field';
import { Pagination } from '@/components/ui/Page';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { FilterChip, PageTitle, Panel, RowMenu, Segmented, SortHeader, type SortDir } from '@/components/ui/Workspace';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';
import type { ApplicationRow } from '@/types/domain';

const STATUSES = ['draft', 'under_scrutiny', 'returned_for_correction', 'correction_submitted', 'evc_required', 'evc_scheduled',
  'evc_completed', 'committee_review', 'awaiting_decision', 'completed'];
const STAGES = ['intake', 'scrutiny', 'evc', 'committee', 'decision', 'terminal'];
type Quick = 'all' | 'open' | 'action' | 'overdue' | 'closed';

export function ApplicationsListPage({ mode = 'all' }: { mode?: 'all' | 'mine' }) {
  const { workspace, institution, session } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Math.floor(Number(params.get('page')) || 0));
  const setPage = (next: number) => { const p = new URLSearchParams(params); if (next > 0) p.set('page', String(next)); else p.delete('page'); setParams(p); };
  const [search, setSearch] = useState(params.get('q') ?? '');
  const num = (k: string) => (params.get(k) !== null && params.get(k) !== '' ? Number(params.get(k)) : undefined);
  const filters: ApplicationFilters = {
    search: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    stage: params.get('stage') ?? undefined,
    type: params.get('type') ?? undefined,
    region: params.get('region') ?? undefined,
    overdueOnly: params.get('overdue') === '1',
    evcThisWeek: params.get('evcWeek') === '1',
    group: (params.get('group') as ApplicationFilters['group']) ?? undefined,
    ageMin: num('ageMin'), ageMax: num('ageMax'),
    unassigned: params.get('unassigned') === '1',
    sort: (params.get('sort') as SortField) ?? (mode === 'mine' ? 'due' : 'updated'),
    dir: (params.get('dir') as SortDir) ?? undefined,
    institutionId: workspace === 'institution' ? institution?.id : undefined,
    assignedTo: mode === 'mine' ? session?.user.id : params.get('assigned') ?? undefined,
  };
  useEffect(() => { setSearch(params.get('q') ?? ''); }, [params]);

  const q = useQuery({ queryKey: ['applications', filters, page], queryFn: () => listApplications(filters, page), placeholderData: keepPreviousData });
  const types = useQuery({ queryKey: ['types'], queryFn: getApplicationTypes, staleTime: 600_000 });
  const regions = useQuery({ queryKey: ['regions'], queryFn: listRegions, staleTime: 600_000, enabled: workspace !== 'institution' });
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000, enabled: !!params.get('assigned') });

  const update = (changes: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    p.delete('page');
    for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); }
    setParams(p, { replace: true });
  };
  const quick: Quick = params.get('overdue') === '1' && !params.get('group') ? 'overdue' : (params.get('group') as Quick) ?? 'all';
  const setQuick = (v: Quick) => update({ group: v === 'all' || v === 'overdue' ? null : v, overdue: v === 'overdue' ? '1' : null, status: null });
  const onSort = (field: string, d: SortDir) => update({ sort: field, dir: d });

  const chips: { key: string; label: string; clear: Record<string, null> }[] = [];
  if (filters.evcThisWeek) chips.push({ key: 'evcWeek', label: 'EVC scheduled this week (IST)', clear: { evcWeek: null } });
  if (filters.search) chips.push({ key: 'q', label: `“${filters.search}”`, clear: { q: null } });
  if (filters.status) chips.push({ key: 'status', label: statusLabel(filters.status), clear: { status: null } });
  if (filters.stage) chips.push({ key: 'stage', label: `Stage: ${filters.stage === 'terminal' ? 'closed' : filters.stage}`, clear: { stage: null } });
  if (filters.type) chips.push({ key: 'type', label: types.data?.find((t) => t.code === filters.type)?.name ?? filters.type, clear: { type: null } });
  if (filters.region) chips.push({ key: 'region', label: `Region ${filters.region}`, clear: { region: null } });
  if (filters.overdueOnly && quick !== 'overdue') chips.push({ key: 'overdue', label: 'Past stage target', clear: { overdue: null } });
  if (filters.ageMin !== undefined || filters.ageMax !== undefined) chips.push({ key: 'age', label: `Age ${filters.ageMin ?? 0}${filters.ageMax !== undefined ? `–${filters.ageMax}` : '+'} days`, clear: { ageMin: null, ageMax: null } });
  if (params.get('assigned') && mode !== 'mine') chips.push({ key: 'assigned', label: `Assigned: ${dir.data?.find((p) => p.id === params.get('assigned'))?.full_name ?? 'officer'}`, clear: { assigned: null } });
  if (filters.unassigned) chips.push({ key: 'unassigned', label: 'Unassigned', clear: { unassigned: null } });

  const title = mode === 'mine' ? 'My application queue' : 'Applications';
  const total = q.data?.total ?? 0;
  return (
    <div>
      <PageTitle title={title}
        description={mode === 'mine' ? 'Applications currently assigned to you, earliest stage target first.'
          : workspace === 'institution' ? `Every application of ${institution?.name ?? 'your institution'}, with where it is and what happens next.`
            : 'Every application your role and region permit you to see. Select a reference to open its workspace.'}
        meta={<span className="text-[13px] text-ink-soft"><span className="font-semibold text-ink tabular">{q.isLoading ? '…' : total}</span> matching application{total === 1 ? '' : 's'}</span>}
        actions={workspace === 'institution' && <ButtonLink to="/app/applications/new" icon={<FilePlus2 className="h-4 w-4" />}>New application</ButtonLink>} />

      <Panel bodyClassName="">
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented label="Quick filter" value={quick} onChange={setQuick} options={[
              { value: 'all', label: 'All' },
              { value: 'open', label: 'In process' },
              { value: 'action', label: workspace === 'institution' ? 'Needs your action' : 'With institution' },
              { value: 'overdue', label: 'Past target' },
              { value: 'closed', label: 'Completed' },
            ]} />
            <form className="flex min-w-0 flex-1 flex-wrap gap-2 sm:max-w-lg" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() || null }); }}>
              <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reference, title or institution" aria-label="Search applications" className="pl-9 pr-11" />{search && <button type="button" aria-label="Clear application search" onClick={() => { setSearch(''); update({ q: null }); }} className="absolute right-0 top-0 h-10 w-10 text-ink-soft">×</button>}</div><Button type="submit" variant="secondary" size="sm">Search</Button>
            </form>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-ink-faint" aria-hidden />
            <Select aria-label="Status" value={params.get('status') ?? ''} onChange={(e) => update({ status: e.target.value || null, group: null })} className="h-9 w-auto min-w-[160px] text-[13px]">
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </Select>
            <Select aria-label="Stage" value={params.get('stage') ?? ''} onChange={(e) => update({ stage: e.target.value || null })} className="h-9 w-auto min-w-[130px] text-[13px]">
              <option value="">Any stage</option>
              {STAGES.map((s) => <option key={s} value={s}>{s === 'terminal' ? 'Closed' : s === 'evc' ? 'EVC' : humanize(s)}</option>)}
            </Select>
            <Select aria-label="Application type" value={params.get('type') ?? ''} onChange={(e) => update({ type: e.target.value || null })} className="h-9 w-auto min-w-[160px] text-[13px]">
              <option value="">Any type</option>
              {(types.data ?? []).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </Select>
            {workspace !== 'institution' && (
              <Select aria-label="Region" value={params.get('region') ?? ''} onChange={(e) => update({ region: e.target.value || null })} className="h-9 w-auto text-[13px]">
                <option value="">Any permitted region</option>
                {(regions.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}
              </Select>
            )}
          </div>
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <AnimatePresence initial={false}>
                {chips.map((c) => <FilterChip key={c.key} label={c.label} onRemove={() => update(c.clear)} />)}
              </AnimatePresence>
              <Button variant="link" size="sm" className="ml-1 text-xs" onClick={() => setParams({}, { replace: true })}>Clear all</Button>
            </div>
          )}
        </div>

        <SavedViews key={`${session?.user.id}-${workspace}-${mode}`} mode={mode} />
        {q.isLoading ? <LoadingRows rows={8} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.rows.length ? (
          <EmptyState title={chips.length || quick !== 'all' ? 'No applications match these filters' : 'No applications yet'}
            body={chips.length || quick !== 'all' ? 'Remove a filter chip above or switch the quick filter to All.' : workspace === 'institution' ? 'Start a new application to see it here.' : 'Applications appear here once institutions in your scope submit them.'}
            action={(chips.length > 0 || quick !== 'all') && <Button variant="secondary" size="sm" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>} />
        ) : (
          <div className={cn('transition-opacity', q.isFetching && 'opacity-60')} aria-busy={q.isFetching}>
            <div>
              <ApplicationsTable rows={q.data.rows} showInstitution={workspace !== 'institution'} sort={filters.sort!} dir={filters.dir} onSort={onSort} />
            </div>
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={setPage} />
          </div>
        )}
      </Panel>
    </div>
  );
}

function rowTone(r: ApplicationRow) {
  if (r.is_overdue) return 'before:bg-danger';
  if (r.status === 'returned_for_correction') return 'before:bg-warning';
  if (r.status === 'correction_submitted') return 'before:bg-accent';
  return 'before:bg-transparent';
}

function DueCell({ r }: { r: ApplicationRow }) {
  if (r.status === 'returned_for_correction') return <div><p className="mb-0.5 text-[11px] text-ink-faint">Correction due</p><DueBadge due={r.correction_due_at} /></div>;
  if (['completed', 'closed', 'draft'].includes(r.status)) return <span className="text-[13px] text-ink-faint">{r.status === 'draft' ? 'Not submitted' : 'Closed'}</span>;
  return <div><p className="mb-0.5 text-[11px] text-ink-faint">Stage target</p><DueBadge due={r.stage_due_at} /></div>;
}

/** Shared application table. Sorting is optional so dashboards can reuse it. */
export function ApplicationsTable({ rows, showInstitution, sort, dir, onSort }: {
  rows: ApplicationRow[]; showInstitution: boolean; sort?: SortField; dir?: SortDir; onSort?: (f: string, d: SortDir) => void;
}) {
  const { session, workspace } = useAuth();
  const preferenceKey = `aicasa.columns.${session?.user.id}.${workspace}.${showInstitution ? 'staff' : 'institution'}`;
  const [extra, setExtra] = useState<string[]>(() => { try { const v: unknown = JSON.parse(localStorage.getItem(preferenceKey) ?? '[]'); return Array.isArray(v) ? v.filter((x) => ['next', 'age'].includes(x)) : []; } catch { return []; } });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleColumn = (column: string) => { const next = extra.includes(column) ? extra.filter((v) => v !== column) : [...extra, column]; setExtra(next); try { localStorage.setItem(preferenceKey, JSON.stringify(next)); } catch { /* Session preference still works. */ } };
  const toggleRow = (id: string) => setExpanded((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const sortable = !!onSort && !!sort;
  const effDir: SortDir = dir ?? (sort === 'updated' || sort === 'age' ? 'desc' : 'asc');
  const H = ({ label, field, className }: { label: string; field?: SortField; className?: string }) =>
    sortable && field ? <SortHeader label={label} field={field} sort={sort!} dir={effDir} onSort={onSort!} className={className} />
      : <th scope="col" className={cn('border-b border-line bg-surface-muted/70 px-4 py-2.5 text-xs font-semibold text-ink-soft', className)}>{label}</th>;
  return (
    <div>
      <details className="hidden border-b border-line px-4 py-2 md:block"><summary className="cursor-pointer py-2 text-sm font-medium text-accent">Choose columns</summary><div className="flex flex-wrap gap-6 py-3">{[{ value: 'next', label: 'Next action and owner' }, { value: 'age', label: 'Application age' }].map((c) => <label key={c.value} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={extra.includes(c.value)} onChange={() => toggleColumn(c.value)} className="h-4 w-4 accent-primary" />{c.label}</label>)}</div><p className="pb-2 text-xs text-ink-soft">Reference, institution, status, deadline and actions stay visible. More information is available in Details.</p></details>
      <ul className="divide-y divide-line md:hidden">{rows.map((r) => <MobileRow key={r.id} r={r} />)}</ul>
      <div className="hidden overflow-x-auto md:block"><table className="application-table w-full border-collapse text-left text-sm">
        <thead><tr>
          <H label="Application" field="reference" />
          {showInstitution && <H label="Institution" field="institution" />}
          <H label="Stage and status" field="stage" />
          {extra.includes('next') && <H label="Next action" />}
          <H label="Deadline" field="due" />
          {extra.includes('age') && <H label="Age" field="age" className="text-right" />}
          <th scope="col" className="w-10 border-b border-line bg-surface-muted/70"><span className="sr-only">Actions</span></th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.id}><tr className="border-b border-line transition-colors hover:bg-primary-soft/30">
              <td className="px-4 py-3 align-top">
                <Link to={`/app/applications/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-accent hover:underline">{r.reference}</Link>
                <p className="mt-0.5 max-w-[300px] truncate text-[13px] text-ink" title={r.title}>{r.title}</p>
                <p className="text-xs text-ink-faint">{r.application_type_name}</p>
              </td>
              {showInstitution && <td className="px-4 py-3 align-top"><p className="max-w-[220px] truncate text-[13px] text-ink">{r.institution_name}</p><p className="text-xs text-ink-faint">Region {r.region_code}</p></td>}
              <td className="px-4 py-3 align-top">
                <p className="mb-1 text-xs text-ink-soft">{r.stage_name}</p>
                <StatusBadge status={r.status} />
                {r.open_deficiencies > 0 && <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning"><ShieldAlert className="h-3 w-3" aria-hidden />{r.open_deficiencies} open deficienc{r.open_deficiencies === 1 ? 'y' : 'ies'}</p>}
              </td>
              {extra.includes('next') && <td className="max-w-[260px] px-4 py-3 align-top">
                <p className="text-[13px] text-ink">{r.next_action ?? '—'}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{r.status === 'returned_for_correction' || r.status === 'draft' ? 'With the institution' : r.assigned_officer_name ? `With ${r.assigned_officer_name}` : ['completed', 'closed'].includes(r.status) ? '' : 'Unassigned'}</p>
              </td>}
              <td className="px-4 py-3 align-top"><DueCell r={r} /></td>
              {extra.includes('age') && <td className="px-4 py-3 text-right align-top text-[13px] tabular text-ink-soft">{r.submitted_at ? `${r.age_days}d` : '—'}<p className="text-[11px] text-ink-faint">{r.submitted_at ? `${r.stage_age_days}d in stage` : ''}</p></td>}
              <td className="px-2 py-3 align-top"><div className="flex items-center"><Button variant="ghost" size="sm" aria-expanded={expanded.has(r.id)} aria-controls={`details-${r.id}`} aria-label={`Details for ${r.reference}`} onClick={() => toggleRow(r.id)}>Details</Button><CaseMenu r={r} /></div></td>
            </tr>{expanded.has(r.id) && <tr id={`details-${r.id}`} className="border-b border-line bg-page/70"><td colSpan={4 + Number(showInstitution) + extra.length} className="px-5 py-4"><RecordDetails r={r} /></td></tr>}</Fragment>
          ))}
        </tbody>
      </table></div>
    </div>
  );
}

export function CaseMenu({ r }: { r: ApplicationRow }) {
  const nav = useNavigate();
  return (
    <RowMenu label={`Actions for ${r.reference}`} actions={[
      { label: 'Open application', icon: ExternalLink, onSelect: () => nav(`/app/applications/${r.id}`) },
      { label: 'Documents and versions', icon: FileText, onSelect: () => nav(`/app/applications/${r.id}?tab=documents`) },
      { label: 'Deficiencies', icon: ShieldAlert, onSelect: () => nav(`/app/applications/${r.id}?tab=deficiencies`), hint: r.open_deficiencies ? `${r.open_deficiencies} open` : undefined },
      { label: 'Activity timeline', icon: History, onSelect: () => nav(`/app/applications/${r.id}?tab=timeline`) },
      { label: 'Copy reference', icon: Copy, onSelect: () => { navigator.clipboard?.writeText(r.reference).then(() => toast.success(`Copied ${r.reference}`), () => toast.error('Copy was blocked by the browser.')); } },
    ]} />
  );
}

function MobileRow({ r }: { r: ApplicationRow }) {
  return (
    <li className={cn('work-item relative px-4 py-3.5 before:absolute before:inset-y-3 before:left-0 before:w-[3px] before:rounded-r-full', rowTone(r))}>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/app/applications/${r.id}`} className="min-w-0 flex-1">
          <span className="font-semibold text-accent">{r.reference}</span>
          <p className="mt-0.5 text-[13px] text-ink">{r.title}</p>
          <p className="text-xs text-ink-soft">{r.institution_name} · {r.stage_name}</p>
        </Link>
        <CaseMenu r={r} />
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-2"><StatusBadge status={r.status} /><DueCell r={r} /></div>
      <p className="mt-3 text-sm text-ink-soft">{r.next_action ?? 'Open the application for details.'}</p>
      <details className="mt-2"><summary className="min-h-11 cursor-pointer py-3 text-sm font-medium text-accent">Application details</summary><RecordDetails r={r} /></details>
    </li>
  );
}

function RecordDetails({ r }: { r: ApplicationRow }) {
  return <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">{[
    ['Application', r.title], ['Institution', r.institution_name], ['Next action', r.next_action ?? 'No pending action'],
    ['Responsible', ['draft', 'returned_for_correction'].includes(r.status) ? 'Institution' : r.assigned_officer_name ?? 'Not assigned'],
    ['Academic year', r.academic_year], ['Application type', r.application_type_name], ['Stage', r.stage_name],
    ['Time in process', r.submitted_at ? `${r.age_days} days; ${r.stage_age_days} days in this stage` : 'Not submitted'],
    ['Open deficiencies', String(r.open_deficiencies)],
  ].map(([label, value]) => <div key={label}><dt className="mb-1 text-xs text-ink-soft">{label}</dt><dd className="leading-relaxed text-ink">{value}</dd></div>)}</dl>;
}
