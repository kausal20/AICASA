import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarX2, ClipboardCheck, AlertTriangle, CalendarRange, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  cancelEvc, completeEvc, declareEvcConflict, evcAssignmentCheck, listEvc, listEvcAvailability, listEvcConflicts, listEvcOfficers,
  recordEvcAvailability, scheduleEvc, withdrawEvcAvailability, withdrawEvcConflict,
} from '@/services/operations';
import { listInstitutions } from '@/services/admin';
import { EvcCheckView } from './EvcChecks';
import { getDirectory } from '@/services/applications';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DueBadge, StatusBadge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Stat, Tabs, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, localDateTimeToIso, humanize } from '@/lib/format';
import type { EvcRow } from '@/types/domain';

const GROUPS: Record<string, string[]> = {
  queue: ['awaiting_scheduling'], proposed: ['proposed'], scheduled: ['scheduled'], done: ['completed', 'cancelled'],
};

export function EvcPage() {
  const { workspace, can } = useAuth();
  const canAct = workspace === 'officer' && can('evc');
  const [sp, setSp] = useSearchParams();
  const tab = ['queue', 'proposed', 'scheduled', 'done', 'availability'].includes(sp.get('tab') ?? '') ? sp.get('tab')! : 'queue';
  const setTab = (t: string) => { const p = new URLSearchParams(sp); p.set('tab', t); p.delete('overdue'); setSp(p, { replace: true }); };
  const overdueOnly = sp.get('overdue') === '1';
  const q = useQuery({ queryKey: ['evc', 'all'], queryFn: () => listEvc() });
  const [dialog, setDialog] = useState<{ kind: 'schedule' | 'complete' | 'cancel'; row: EvcRow } | null>(null);
  const rows = q.data ?? [];
  const count = (k: string) => rows.filter((r) => GROUPS[k].includes(r.status)).length;
  const list = overdueOnly ? rows.filter((r) => r.is_overdue) : rows.filter((r) => (GROUPS[tab] ?? []).includes(r.status));

  return (
    <div>
      <PageHeader title={workspace === 'admin' ? 'EVC overview' : 'EVC scheduling'}
        description="Applications enter this queue only when their configured route reaches an expert-visit stage and its prerequisites are met. Scheduling here is internal; no external calendar is connected." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Awaiting scheduling" value={count('queue')} tone={count('queue') ? 'warning' : 'neutral'} />
        <Stat label="Proposed" value={count('proposed')} />
        <Stat label="Scheduled" value={count('scheduled')} />
        <Stat label="Overdue" value={rows.filter((r) => r.is_overdue).length} tone={rows.some((r) => r.is_overdue) ? 'danger' : 'neutral'} hint="Past scheduling target or outcome not recorded" />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[
        { value: 'queue', label: `Queue (${count('queue')})` }, { value: 'proposed', label: `Proposed (${count('proposed')})` },
        { value: 'scheduled', label: `Scheduled (${count('scheduled')})` }, { value: 'done', label: `History (${count('done')})` },
        { value: 'availability', label: 'Availability & conflicts' },
      ]}>
        {tab === 'availability' ? <AvailabilityTab /> : <Card>
          {overdueOnly && <p className="flex items-center justify-between border-b border-line bg-danger-soft px-5 py-2.5 text-[13px] font-medium text-danger">Showing overdue EVCs only (all groups).
            <button className="underline" onClick={() => setTab(tab)}>Show all</button></p>}
          {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !list.length ? <EmptyState title="No EVCs in this group" /> : (
            <DataTable>
              <thead><tr><Th>Case</Th><Th>Status</Th><Th>{tab === 'queue' ? 'Schedule by' : 'Session (IST)'}</Th><Th>Coordinator</Th><Th className="text-right">In queue</Th><Th /></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-muted/60">
                    <Td><Link to={`/app/applications/${r.application_id}`} className="font-medium text-accent hover:underline">{r.reference}</Link>
                      <p className="max-w-[260px] truncate text-xs text-ink-soft">{r.institution_name} · cycle {r.cycle}</p></Td>
                    <Td><StatusBadge status={r.status} />{r.is_overdue && <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="h-3 w-3" />Overdue</p>}
                      {r.outcome && <p className="mt-1 text-xs text-ink-soft">{humanize(r.outcome)}</p>}</Td>
                    <Td>{r.status === 'awaiting_scheduling' ? <DueBadge due={r.schedule_due_at} /> : r.scheduled_start ? <span className="text-[13px] tabular">{fmtDateTime(r.scheduled_start)}</span> : '—'}
                      {r.reschedule_count > 0 && <p className="text-xs text-ink-soft">Rescheduled {r.reschedule_count}×</p>}</Td>
                    <Td className="text-[13px]">{r.coordinator_name ?? '—'}</Td>
                    <Td className="text-right tabular text-[13px] text-ink-soft">{r.age_days}d</Td>
                    <Td className="text-right">
                      {canAct && (
                        <div className="flex justify-end gap-1.5">
                          {['awaiting_scheduling', 'proposed', 'scheduled'].includes(r.status) && <Button size="sm" variant="secondary" icon={<CalendarClock className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'schedule', row: r })}>{r.status === 'awaiting_scheduling' ? 'Schedule' : r.status === 'proposed' ? 'Confirm / change' : 'Reschedule'}</Button>}
                          {r.status === 'scheduled' && <Button size="sm" icon={<ClipboardCheck className="h-3.5 w-3.5" />} disabled={!!r.scheduled_start && new Date(r.scheduled_start) > new Date()} title={r.scheduled_start && new Date(r.scheduled_start) > new Date() ? 'Available once the session has started' : undefined} onClick={() => setDialog({ kind: 'complete', row: r })}>Record outcome</Button>}
                          {['proposed', 'scheduled'].includes(r.status) && <Button size="sm" variant="ghost" icon={<CalendarX2 className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'cancel', row: r })}>Cancel</Button>}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>}
      </Tabs>
      {!canAct && workspace === 'officer' && <p className="mt-3 text-xs text-ink-soft">You can view EVCs in your region; scheduling requires the EVC responsibility.</p>}
      {dialog?.kind === 'schedule' && <ScheduleDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'complete' && <CompleteDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelDialog row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600_000);
  return d.toISOString().slice(0, 16);
}

function ScheduleDialog({ row, onClose }: { row: EvcRow; onClose: () => void }) {
  const { session } = useAuth();
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory });
  const officers = useQuery({ queryKey: ['evc-officers'], queryFn: listEvcOfficers });
  const eligible = (officers.data ?? []).filter((o) => o.region_code === null || o.region_code === row.region_code).map((o) => o.user_id).filter((id) => id !== session?.user.id);
  const [start, setStart] = useState(toLocalInput(row.scheduled_start));
  const [end, setEnd] = useState(toLocalInput(row.scheduled_end));
  const [people, setPeople] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(true);
  const [notes, setNotes] = useState(row.notes ?? '');
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const resched = row.status === 'scheduled';
  const slotOk = !!start && !!end;
  const check = useQuery({
    queryKey: ['evc-check', row.id, start, end, [...people].sort().join(',')],
    queryFn: () => evcAssignmentCheck(row.id, localDateTimeToIso(start), localDateTimeToIso(end), people),
    enabled: slotOk,
  });
  const hardBlock = !!check.data?.blocked && !check.data?.needs_override;
  const needsOverride = !!check.data?.needs_override;
  const act = useAction(() => scheduleEvc({ evcId: row.id, start: localDateTimeToIso(start), end: localDateTimeToIso(end), participants: people, confirm, notes,
    version: row.row_version, reason: reason || undefined, override: needsOverride ? override : undefined }), {
    invalidate: [['evc'], ['application'], ['applications'], ['tasks'], ['evc-check']],
    onSuccess: (r) => {
      toast.success(r.override ? 'Saved with a recorded override. The reason is in the EVC history and audit log.'
        : confirm ? 'EVC scheduled. Institution and panel notified in-app.' : 'EVC proposed.');
      onClose();
    },
  });
  const canSave = slotOk && !hardBlock && (!resched || reason.trim().length >= 10) && (!needsOverride || override.trim().length >= 10) && !check.isFetching;
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title={resched ? 'Reschedule EVC' : 'Schedule EVC'} description={`${row.reference} · ${row.institution_name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={act.isPending} disabled={!canSave} onClick={() => act.mutate(undefined)}>{needsOverride ? 'Save with override' : confirm ? 'Confirm schedule' : 'Save proposal'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Start (IST)" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        <TextField label="End (IST)" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Panel members <span className="text-xs font-normal text-ink-faint">optional · you are the coordinator</span></legend>
          {!eligible.length ? <p className="text-xs text-ink-soft">No other EVC officers in this region.</p> : (
            <div className="flex flex-wrap gap-2">
              {eligible.map((id) => {
                const p = dir.data?.find((x) => x.id === id);
                const on = people.includes(id);
                return <label key={id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] ${on ? 'border-primary bg-primary-soft' : 'border-line'}`}>
                  <input type="checkbox" className="accent-[#1e3a8a]" checked={on} onChange={() => setPeople(on ? people.filter((x) => x !== id) : [...people, id])} />{p?.full_name ?? 'Officer'}</label>;
              })}
            </div>
          )}
        </fieldset>
        <section className="sm:col-span-2 rounded-lg border border-line bg-surface-muted/40 p-3" aria-live="polite">
          <p className="mb-2 text-[13px] font-medium">Assignment checks</p>
          {!slotOk ? <p className="text-xs text-ink-soft">Choose a start and end to check readiness, availability and conflicts.</p>
            : check.isLoading ? <LoadingRows rows={2} /> : check.error ? <ErrorState error={check.error} onRetry={() => check.refetch()} />
              : check.data && <EvcCheckView check={check.data} />}
        </section>
        {hardBlock && <div className="sm:col-span-2"><Notice tone="danger" title="This assignment cannot proceed">Remove the blocked member or change the slot. Declared conflicts and missing authorisation cannot be overridden.</Notice></div>}
        {needsOverride && (
          <div className="sm:col-span-2"><TextAreaField label="Override reason" required rows={2} value={override} onChange={(e) => setOverride(e.target.value)}
            hint="Required to proceed despite an overlap or recorded unavailability. Stored in the EVC history and the audit log with your name." /></div>
        )}
        <div className="sm:col-span-2"><TextAreaField label="Notes for the institution and panel" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        {resched && <div className="sm:col-span-2"><TextAreaField label="Reason for rescheduling" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-[#1e3a8a]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          Confirm now (uncheck to record only a proposed slot)
        </label>
      </div>
    </Dialog>
  );
}

function AvailabilityTab() {
  const { session, can, workspace } = useAuth();
  const me = session?.user.id ?? '';
  const mayEdit = workspace === 'officer' ? can('evc') || can('assignment') : can('assignment');
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory });
  const officers = useQuery({ queryKey: ['evc-officers'], queryFn: listEvcOfficers });
  const avail = useQuery({ queryKey: ['evc-availability'], queryFn: listEvcAvailability });
  const conflicts = useQuery({ queryKey: ['evc-conflicts'], queryFn: listEvcConflicts });
  const insts = useQuery({ queryKey: ['institutions'], queryFn: listInstitutions, enabled: mayEdit });
  const name = (id: string) => dir.data?.find((p) => p.id === id)?.full_name ?? 'Officer';
  const choosable = can('assignment') ? [...new Set((officers.data ?? []).map((o) => o.user_id))] : [me];
  const [a, setA] = useState({ userId: me, kind: 'unavailable' as 'available' | 'unavailable', start: '', end: '', note: '' });
  const [c, setC] = useState({ userId: me, institutionId: '', nature: '' });
  const addAvail = useAction(() => recordEvcAvailability({ userId: a.userId, kind: a.kind, start: localDateTimeToIso(a.start), end: localDateTimeToIso(a.end), note: a.note }), {
    success: 'Availability recorded.', invalidate: [['evc-availability'], ['evc-check']], onSuccess: () => setA({ ...a, start: '', end: '', note: '' }) });
  const withdrawAvail = useAction((id: string) => withdrawEvcAvailability(id, 'Withdrawn from the EVC availability list'), { success: 'Withdrawn.', invalidate: [['evc-availability'], ['evc-check']] });
  const declare = useAction(() => declareEvcConflict(c.userId, c.institutionId, c.nature), {
    success: 'Conflict of interest recorded.', invalidate: [['evc-conflicts'], ['evc-check']], onSuccess: () => setC({ ...c, institutionId: '', nature: '' }) });
  const [withdrawing, setWithdrawing] = useState<{ id: string; reason: string } | null>(null);
  const withdrawConflict = useAction(() => withdrawEvcConflict(withdrawing!.id, withdrawing!.reason), {
    success: 'Declaration withdrawn.', invalidate: [['evc-conflicts'], ['evc-check']], onSuccess: () => setWithdrawing(null) });

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <div className="border-b border-line px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><CalendarRange className="h-4 w-4 text-primary" aria-hidden />Recorded availability</h2>
          <p className="mt-0.5 text-[13px] text-ink-soft">Used by the scheduling checks. Nothing here is read from an external calendar.</p>
        </div>
        {avail.isLoading ? <LoadingRows rows={3} /> : avail.error ? <ErrorState error={avail.error} onRetry={() => avail.refetch()} /> : !avail.data?.length ? (
          <EmptyState title="No availability recorded" body="Without recorded windows the checks can only note that availability is unknown." />
        ) : (
          <ul className="divide-y divide-line">{avail.data.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
              <span><span className="font-medium">{name(w.user_id)}</span> · {w.kind === 'available' ? 'Available' : 'Unavailable'} {fmtDateTime(w.starts_at)} – {fmtDateTime(w.ends_at)}{w.note ? ` · ${w.note}` : ''}</span>
              {(w.user_id === me || can('assignment')) && <Button size="sm" variant="ghost" loading={withdrawAvail.isPending} onClick={() => withdrawAvail.mutate(w.id)}>Withdraw</Button>}
            </li>
          ))}</ul>
        )}
        {mayEdit && (
          <form className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); addAvail.mutate(undefined); }}>
            <SelectField label="Officer" value={a.userId} onChange={(e) => setA({ ...a, userId: e.target.value })}>
              {choosable.map((id) => <option key={id} value={id}>{name(id)}{id === me ? ' (you)' : ''}</option>)}
            </SelectField>
            <SelectField label="Kind" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as typeof a.kind })}>
              <option value="unavailable">Unavailable</option><option value="available">Available</option>
            </SelectField>
            <TextField label="From (IST)" type="datetime-local" required value={a.start} onChange={(e) => setA({ ...a, start: e.target.value })} />
            <TextField label="To (IST)" type="datetime-local" required value={a.end} onChange={(e) => setA({ ...a, end: e.target.value })} />
            <div className="sm:col-span-2"><TextField label="Note" value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} /></div>
            <div className="sm:col-span-2 flex justify-end"><Button type="submit" size="sm" loading={addAvail.isPending} disabled={!a.start || !a.end}>Record window</Button></div>
          </form>
        )}
      </Card>

      <Card>
        <div className="border-b border-line px-5 py-3.5">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><ShieldAlert className="h-4 w-4 text-primary" aria-hidden />Declared conflicts of interest</h2>
          <p className="mt-0.5 text-[13px] text-ink-soft">Only declared conflicts are known. No affiliation register is connected, so undeclared relationships cannot be detected.</p>
        </div>
        {conflicts.isLoading ? <LoadingRows rows={3} /> : conflicts.error ? <ErrorState error={conflicts.error} onRetry={() => conflicts.refetch()} /> : !conflicts.data?.length ? (
          <EmptyState title="No conflicts declared" />
        ) : (
          <ul className="divide-y divide-line">{conflicts.data.map((d) => (
            <li key={d.id} className="px-5 py-2.5 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{name(d.user_id)}</span> · {d.institutions?.name ?? 'Institution'}</span>
                {can('assignment') && d.user_id !== me && <Button size="sm" variant="ghost" onClick={() => setWithdrawing({ id: d.id, reason: '' })}>Withdraw</Button>}
              </div>
              <p className="text-xs text-ink-soft">{d.nature} · declared {fmtDateTime(d.declared_at)}</p>
            </li>
          ))}</ul>
        )}
        {mayEdit && (
          <form className="grid gap-3 border-t border-line px-5 py-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); declare.mutate(undefined); }}>
            <SelectField label="Officer" value={c.userId} onChange={(e) => setC({ ...c, userId: e.target.value })}>
              {choosable.map((id) => <option key={id} value={id}>{name(id)}{id === me ? ' (you)' : ''}</option>)}
            </SelectField>
            <SelectField label="Institution" required value={c.institutionId} onChange={(e) => setC({ ...c, institutionId: e.target.value })}>
              <option value="">Select</option>
              {(insts.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </SelectField>
            <div className="sm:col-span-2"><TextField label="Nature of the conflict" required value={c.nature} onChange={(e) => setC({ ...c, nature: e.target.value })} hint="At least 10 characters, e.g. former employment or family relationship." /></div>
            <div className="sm:col-span-2 flex justify-end"><Button type="submit" size="sm" loading={declare.isPending} disabled={!c.institutionId || c.nature.trim().length < 10}>Record declaration</Button></div>
          </form>
        )}
      </Card>
      {withdrawing && (
        <Dialog open onOpenChange={(o) => !o && setWithdrawing(null)} title="Withdraw declared conflict" description="An officer cannot withdraw their own declaration."
          footer={<><Button variant="secondary" onClick={() => setWithdrawing(null)}>Cancel</Button><Button loading={withdrawConflict.isPending} disabled={withdrawing.reason.trim().length < 10} onClick={() => withdrawConflict.mutate(undefined)}>Withdraw</Button></>}>
          <TextAreaField label="Reason" required rows={3} value={withdrawing.reason} onChange={(e) => setWithdrawing({ ...withdrawing, reason: e.target.value })} />
        </Dialog>
      )}
    </div>
  );
}

function CompleteDialog({ row, onClose }: { row: EvcRow; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'satisfactory' | 'deficiencies_noted'>('satisfactory');
  const [summary, setSummary] = useState('');
  const act = useAction(() => completeEvc(row.id, outcome, summary, row.row_version), {
    success: 'EVC outcome recorded.', invalidate: [['evc'], ['application'], ['applications'], ['tasks']], onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Record EVC outcome" description={`${row.reference} · held ${fmtDateTime(row.scheduled_start)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={summary.trim().length < 20} onClick={() => act.mutate(undefined)}>Record outcome</Button></>}>
      <div className="space-y-4">
        <SelectField label="Authorised outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="satisfactory">Satisfactory</option>
          <option value="deficiencies_noted">Deficiencies noted</option>
        </SelectField>
        <TextAreaField label="Completion summary" required rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} hint="At least 20 characters. If the visit did not take place, cancel and reschedule instead." />
        <Notice tone="info">A satisfactory outcome lets the route advance automatically when its other prerequisites are met. With deficiencies noted, record them on the case before routing it.</Notice>
      </div>
    </Dialog>
  );
}

function CancelDialog({ row, onClose }: { row: EvcRow; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(() => cancelEvc(row.id, reason, row.row_version), { success: 'EVC cancelled and re-queued for scheduling.', invalidate: [['evc'], ['application'], ['applications']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Cancel EVC" description="The case stays at the EVC stage and a new scheduling cycle opens."
      footer={<><Button variant="secondary" onClick={onClose}>Keep</Button><Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Cancel EVC</Button></>}>
      <TextAreaField label="Cancellation reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}
