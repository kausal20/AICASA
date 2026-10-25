import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarRange, Pencil, Search, ShieldAlert, UserPlus } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listInstitutions, listRegions } from '@/services/admin';
import { listEvcConflicts } from '@/services/operations';
import { listExpertAvailability, listExperts, recordExpertAvailability, upsertExpert, withdrawExpertAvailability } from '@/services/experts';
import { Card } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { Input, SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, localDateTimeToIso } from '@/lib/format';
import type { Expert } from '@/types/domain';

const SPECIALIZATIONS = ['CSE', 'ECE', 'EEE', 'Civil', 'Mechanical', 'Pharmacy', 'Management', 'Architecture'];

/** Registry of experts the EVC coordinator can call on. An "Expert" is not a sign-in role: they hold no access unless an account is linked. */
export function ExpertsPage() {
  const { workspace, can } = useAuth();
  const mayEdit = workspace === 'officer' ? can('evc') || can('assignment') : can('assignment') || can('user_admin');
  const q = useQuery({ queryKey: ['experts'], queryFn: listExperts });
  const avail = useQuery({ queryKey: ['expert-availability'], queryFn: listExpertAvailability });
  const conflicts = useQuery({ queryKey: ['evc-conflicts'], queryFn: listEvcConflicts });
  const regions = useQuery({ queryKey: ['regions'], queryFn: listRegions });
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('');
  const [form, setForm] = useState<Expert | 'new' | null>(null);
  const [windows, setWindows] = useState<Expert | null>(null);
  const rows = useMemo(() => (q.data ?? []).filter((e) =>
    (!region || e.region_code === region)
    && (!search || `${e.full_name} ${e.specializations.join(' ')} ${e.home_district}`.toLowerCase().includes(search.toLowerCase()))), [q.data, region, search]);

  return (
    <div>
      <PageHeader title="Experts" description="People who can be recommended for an expert visit panel, with their specializations, home district, employer and availability. Recommendations exclude anyone from the institute's district, affiliated with it, or with a declared conflict."
        actions={<>
          <ButtonLink to="/app/evc" variant="secondary" icon={<ArrowLeft className="h-4 w-4" />}>EVC</ButtonLink>
          {mayEdit && <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setForm('new')}>Add expert</Button>}
        </>} />
      <Notice tone="info">Experts are a registry for panel selection. They have no access to the system and an administrator grants a sign-in separately in <Link to="/app/admin/users" className="font-medium underline">Users and access</Link>.</Notice>
      <Card className="mt-5">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative min-w-[220px] max-w-sm flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input className="pl-9" placeholder="Search name, specialization or district" aria-label="Search experts" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select aria-label="Region" className="h-10 rounded-lg border border-line bg-surface px-3 text-sm" value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">All regions</option>
            {(regions.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
        </div>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title="No experts found" /> : (
          <DataTable>
            <thead><tr><Th>Expert</Th><Th>Specializations</Th><Th>Home district</Th><Th>Home institution</Th><Th>Availability</Th><Th /></tr></thead>
            <tbody>
              {rows.map((e) => {
                const w = (avail.data ?? []).filter((x) => x.expert_id === e.id);
                const c = (conflicts.data ?? []).filter((x) => x.expert_id === e.id);
                return (
                  <tr key={e.id}>
                    <Td>
                      <p className="font-medium">{e.full_name}</p>
                      <div className="mt-1 flex flex-wrap gap-1"><Badge tone="accent">Expert</Badge><Badge tone="neutral">{e.region_code}</Badge>
                        {!e.is_active && <Badge tone="danger">Inactive</Badge>}{e.is_demo && <Badge tone="warning">Demo</Badge>}
                        {c.length > 0 && <Badge tone="danger" icon={<ShieldAlert className="h-3 w-3" aria-hidden />}>{c.length} declared conflict{c.length > 1 ? 's' : ''}</Badge>}</div>
                    </Td>
                    <Td><div className="flex flex-wrap gap-1">{e.specializations.map((s) => <Badge key={s} tone="primary">{s}</Badge>)}</div></Td>
                    <Td className="text-[13px]">{e.home_district}, {e.home_state}</Td>
                    <Td className="text-[13px]">{e.institutions?.name ?? e.home_institution_name ?? '—'}</Td>
                    <Td className="text-[13px]">
                      {w.length === 0 ? <span className="text-ink-soft">Not recorded</span> : (
                        <ul className="space-y-0.5">{w.slice(0, 2).map((x) => <li key={x.id}><span className={x.kind === 'available' ? 'text-success' : 'text-danger'}>{x.kind === 'available' ? 'Available' : 'Unavailable'}</span> <span className="text-xs text-ink-soft">{fmtDateTime(x.starts_at)} – {fmtDateTime(x.ends_at)}</span></li>)}
                          {w.length > 2 && <li className="text-xs text-ink-soft">+{w.length - 2} more</li>}</ul>
                      )}
                    </Td>
                    <Td className="text-right">
                      {mayEdit && <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="secondary" icon={<CalendarRange className="h-3.5 w-3.5" />} onClick={() => setWindows(e)}>Availability</Button>
                        <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setForm(e)}>Edit</Button>
                      </div>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>
      {form && <ExpertForm expert={form === 'new' ? null : form} onClose={() => setForm(null)} />}
      {windows && <AvailabilityDialog expert={windows} onClose={() => setWindows(null)} />}
    </div>
  );
}

function ExpertForm({ expert, onClose }: { expert: Expert | null; onClose: () => void }) {
  const regions = useQuery({ queryKey: ['regions'], queryFn: listRegions });
  const insts = useQuery({ queryKey: ['institutions'], queryFn: listInstitutions });
  const [name, setName] = useState(expert?.full_name ?? '');
  const [specs, setSpecs] = useState<string[]>(expert?.specializations ?? []);
  const [other, setOther] = useState('');
  const [district, setDistrict] = useState(expert?.home_district ?? '');
  const [state, setState] = useState(expert?.home_state ?? '');
  const [instId, setInstId] = useState(expert?.home_institution_id ?? '');
  const [instName, setInstName] = useState(expert?.home_institution_name ?? '');
  const [region, setRegion] = useState(expert?.region_code ?? '');
  const [active, setActive] = useState(expert?.is_active ?? true);
  const all = [...new Set([...SPECIALIZATIONS, ...specs])];
  const act = useAction(() => upsertExpert({
    id: expert?.id, fullName: name, specializations: [...specs, ...other.split(',').map((x) => x.trim()).filter(Boolean)], homeDistrict: district, homeState: state,
    homeInstitutionId: instId || null, homeInstitutionName: instId ? null : instName || null, region, isActive: active, profileId: expert?.profile_id ?? null,
  }), { success: expert ? 'Expert updated.' : 'Expert added.', invalidate: [['experts']], onSuccess: onClose });
  const ready = name.trim().length >= 3 && (specs.length > 0 || other.trim().length > 0) && district.trim().length >= 2 && state.trim().length >= 2 && !!region;
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title={expert ? 'Edit expert' : 'Add expert'} description="Home district and employer drive the automatic conflict-of-interest exclusions."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!ready} onClick={() => act.mutate(undefined)}>{expert ? 'Save' : 'Add expert'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><TextField label="Full name" required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Specializations <span className="text-danger">*</span></legend>
          <div className="flex flex-wrap gap-2">
            {all.map((s) => (
              <label key={s} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] ${specs.includes(s) ? 'border-primary bg-primary-soft' : 'border-line'}`}>
                <input type="checkbox" className="accent-[#1e3a8a]" checked={specs.includes(s)} onChange={() => setSpecs(specs.includes(s) ? specs.filter((x) => x !== s) : [...specs, s])} />{s}
              </label>
            ))}
          </div>
          <div className="mt-2 max-w-sm"><TextField label="Other (comma separated)" value={other} onChange={(e) => setOther(e.target.value)} /></div>
        </fieldset>
        <TextField label="Home district" required value={district} onChange={(e) => setDistrict(e.target.value)} />
        <TextField label="Home state" required value={state} onChange={(e) => setState(e.target.value)} />
        <SelectField label="Region" required value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">Select…</option>
          {(regions.data ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
        </SelectField>
        <SelectField label="Home institution (in this system)" value={instId} onChange={(e) => setInstId(e.target.value)}>
          <option value="">Not in the registry</option>
          {(insts.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </SelectField>
        {!instId && <div className="sm:col-span-2"><TextField label="Employer (if not in the registry)" value={instName} onChange={(e) => setInstName(e.target.value)} hint="If this equals an institute's name, the expert is treated as affiliated with it." /></div>}
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="h-4 w-4 accent-[#1e3a8a]" checked={active} onChange={(e) => setActive(e.target.checked)} />Active (can be recommended)</label>
      </div>
    </Dialog>
  );
}

function AvailabilityDialog({ expert, onClose }: { expert: Expert; onClose: () => void }) {
  const avail = useQuery({ queryKey: ['expert-availability'], queryFn: listExpertAvailability });
  const mine = (avail.data ?? []).filter((w) => w.expert_id === expert.id);
  const [a, setA] = useState({ kind: 'available' as 'available' | 'unavailable', start: '', end: '', note: '' });
  const add = useAction(() => recordExpertAvailability({ expertId: expert.id, kind: a.kind, start: localDateTimeToIso(a.start), end: localDateTimeToIso(a.end), note: a.note }),
    { success: 'Availability recorded.', invalidate: [['expert-availability']], onSuccess: () => setA({ ...a, start: '', end: '', note: '' }) });
  const withdraw = useAction((id: string) => withdrawExpertAvailability(id, 'Withdrawn from the expert availability list'), { success: 'Withdrawn.', invalidate: [['expert-availability']] });
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Availability windows" description={expert.full_name}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        {!mine.length ? <p className="text-[13px] text-ink-soft">No future windows recorded. Without one, recommendations can only say that availability is unknown.</p> : (
          <ul className="divide-y divide-line rounded-lg border border-line">{mine.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]">
              <span><span className={w.kind === 'available' ? 'font-medium text-success' : 'font-medium text-danger'}>{w.kind === 'available' ? 'Available' : 'Unavailable'}</span> {fmtDateTime(w.starts_at)} – {fmtDateTime(w.ends_at)}{w.note ? ` · ${w.note}` : ''}</span>
              <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate(w.id)}>Withdraw</Button>
            </li>))}</ul>
        )}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}>
          <SelectField label="Kind" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as typeof a.kind })}>
            <option value="available">Available</option><option value="unavailable">Unavailable</option>
          </SelectField>
          <div />
          <TextField label="From (IST)" type="datetime-local" required value={a.start} onChange={(e) => setA({ ...a, start: e.target.value })} />
          <TextField label="To (IST)" type="datetime-local" required value={a.end} onChange={(e) => setA({ ...a, end: e.target.value })} />
          <div className="sm:col-span-2"><TextAreaField label="Note" rows={2} value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} /></div>
          <div className="flex justify-end sm:col-span-2"><Button type="submit" size="sm" loading={add.isPending} disabled={!a.start || !a.end}>Record window</Button></div>
        </form>
      </div>
    </Dialog>
  );
}
