import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarX2, ClipboardCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import { cancelEvc, completeEvc, listEvc, listEvcOfficers, scheduleEvc } from '@/services/operations';
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
  const tab = ['queue', 'proposed', 'scheduled', 'done'].includes(sp.get('tab') ?? '') ? sp.get('tab')! : 'queue';
  const setTab = (t: string) => { const p = new URLSearchParams(sp); p.set('tab', t); p.delete('overdue'); setSp(p, { replace: true }); };
  const overdueOnly = sp.get('overdue') === '1';
  const q = useQuery({ queryKey: ['evc', 'all'], queryFn: () => listEvc() });
  const [dialog, setDialog] = useState<{ kind: 'schedule' | 'complete' | 'cancel'; row: EvcRow } | null>(null);
  const rows = q.data ?? [];
  const count = (k: string) => rows.filter((r) => GROUPS[k].includes(r.status)).length;
  const list = overdueOnly ? rows.filter((r) => r.is_overdue) : rows.filter((r) => GROUPS[tab].includes(r.status));

  return (
    <div>
      <PageHeader title={workspace === 'admin' ? 'EVC overview' : 'EVC scheduling'}
        description="Cases enter this queue only when their configured route reaches an expert-visit stage and its prerequisites are met. Scheduling here is internal; no external calendar is connected." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Awaiting scheduling" value={count('queue')} tone={count('queue') ? 'warning' : 'neutral'} />
        <Stat label="Proposed" value={count('proposed')} />
        <Stat label="Scheduled" value={count('scheduled')} />
        <Stat label="Overdue" value={rows.filter((r) => r.is_overdue).length} tone={rows.some((r) => r.is_overdue) ? 'danger' : 'neutral'} hint="Past scheduling target or outcome not recorded" />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={[
        { value: 'queue', label: `Queue (${count('queue')})` }, { value: 'proposed', label: `Proposed (${count('proposed')})` },
        { value: 'scheduled', label: `Scheduled (${count('scheduled')})` }, { value: 'done', label: `History (${count('done')})` },
      ]}>
        <Card>
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
        </Card>
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
  const [conflicts, setConflicts] = useState<{ reference: string; start: string }[] | null>(null);
  const resched = row.status === 'scheduled';
  const act = useAction(() => scheduleEvc({ evcId: row.id, start: localDateTimeToIso(start), end: localDateTimeToIso(end), participants: people, confirm, notes, version: row.row_version, reason: reason || undefined }), {
    invalidate: [['evc'], ['application'], ['applications'], ['tasks']],
    onSuccess: (r) => {
      if (r.conflicts.length) { setConflicts(r.conflicts); toast.warning(`Saved, but ${r.conflicts.length} overlapping EVC${r.conflicts.length > 1 ? 's' : ''} share a panel member.`); }
      else { toast.success(confirm ? 'EVC scheduled. Institution and panel notified in-app.' : 'EVC proposed.'); onClose(); }
    },
  });
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title={resched ? 'Reschedule EVC' : 'Schedule EVC'} description={`${row.reference} · ${row.institution_name}`}
      footer={conflicts ? <Button onClick={onClose}>Done</Button> : <><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={act.isPending} disabled={!start || !end || (resched && reason.trim().length < 10)} onClick={() => act.mutate(undefined)}>{confirm ? 'Confirm schedule' : 'Save proposal'}</Button></>}>
      {conflicts ? (
        <Notice tone="warning" title="Schedule saved with conflicts">
          Overlapping sessions for the same panel: {conflicts.map((c) => `${c.reference} (${fmtDateTime(c.start)})`).join(', ')}. Reschedule one of them if the overlap is not intended.
        </Notice>
      ) : (
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
                    <input type="checkbox" className="accent-[#176B5B]" checked={on} onChange={() => setPeople(on ? people.filter((x) => x !== id) : [...people, id])} />{p?.full_name ?? 'Officer'}</label>;
                })}
              </div>
            )}
          </fieldset>
          <div className="sm:col-span-2"><TextAreaField label="Notes for the institution and panel" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {resched && <div className="sm:col-span-2"><TextAreaField label="Reason for rescheduling" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
          <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
            <input type="checkbox" className="h-4 w-4 accent-[#176B5B]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            Confirm now (uncheck to record only a proposed slot)
          </label>
        </div>
      )}
    </Dialog>
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
