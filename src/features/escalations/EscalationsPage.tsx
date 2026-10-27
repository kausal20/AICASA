import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Play } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { acknowledgeEscalations, listEscalations, updateEscalation } from '@/services/operations';
import { runScanNow } from '@/services/admin';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Tabs, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { TextAreaField } from '@/components/ui/Field';
import { Disclosure } from '@/components/ui/Workspace';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { codeLabel, fmtDate, fmtDateTime, humanize, plainText, plural } from '@/lib/format';
import type { EscalationRow } from '@/types/domain';

/** The rule's cadence in words, from the same fields the scanner uses. */
export function cadenceText(e: Pick<EscalationRow, 'rule_offset_hours' | 'rule_repeat_interval_hours' | 'rule_max_repeats' | 'entity_type'>): string {
  const base = e.entity_type === 'deficiency_window' ? 'the moment the window closes' : 'the end of the due date (11:59 PM IST)';
  const first = e.rule_offset_hours === 0 ? `at ${base}` : `${plural(Math.abs(e.rule_offset_hours), 'hour')} ${e.rule_offset_hours > 0 ? 'after' : 'before'} ${base}`;
  return e.rule_repeat_interval_hours
    ? `First notice ${first}, then every ${plural(e.rule_repeat_interval_hours, 'hour')}, up to ${plural(e.rule_max_repeats, 'notice')}.`
    : `One notice ${first}.`;
}

export function EscalationsPage() {
  const { workspace, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = ['open', 'acknowledged', 'resolved', 'all'].includes(sp.get('status') ?? '') ? sp.get('status')! : 'open';
  const setTab = (t: string) => { setSelected([]); setSp({ status: t }, { replace: true }); };
  const [act, setAct] = useState<{ row: EscalationRow; action: 'acknowledge' | 'resolve' } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState(false);
  const q = useQuery({ queryKey: ['escalations', tab], queryFn: () => listEscalations(tab === 'all' ? undefined : tab) });
  const scan = useAction(runScanNow, {
    invalidate: [['escalations'], ['notifications'], ['obligations'], ['jobs'], ['navcounts']],
    success: (r) => r.status === 'succeeded' ? `Scan finished: ${plural(r.stats.escalations ?? 0, 'new notice')}, ${plural(r.stats.notifications ?? 0, 'notification')}.` : `Scan failed: ${r.error}`,
  });
  const openRows = (q.data ?? []).filter((e) => e.status === 'open');
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <div>
      <PageHeader title="Escalations"
        description="Raised automatically by the deadline scanner under the active, versioned alert rules. Each case and rule has one escalation; repeat notices are listed inside it, and re-running the scan never records the same notice twice."
        actions={workspace === 'admin' && can('escalation') && <Button variant="secondary" icon={<Play className="h-4 w-4" />} loading={scan.isPending} onClick={() => scan.mutate(undefined)}>Run deadline scan now</Button>} />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]}>
        <Card>
          {openRows.length > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-[13px]">
              <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[#1e3a8a]" checked={selected.length === openRows.length}
                onChange={(e) => setSelected(e.target.checked ? openRows.map((r) => r.id) : [])} />Select all open ({openRows.length})</label>
              <Button size="sm" variant="secondary" icon={<CheckCheck className="h-3.5 w-3.5" />} disabled={!selected.length} onClick={() => setBulk(true)}>Acknowledge selected ({selected.length})</Button>
            </div>
          )}
          {q.isLoading || q.isFetching && !q.data ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState title="No escalations here" /> : (
            <DataTable>
              <thead><tr><Th><span className="sr-only">Select</span></Th><Th>Escalation</Th><Th>Rule and notices</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-surface-muted/60">
                    <Td>{e.status === 'open' && <input type="checkbox" aria-label={`Select ${e.summary}`} className="mt-1 h-4 w-4 accent-[#1e3a8a]" checked={selected.includes(e.id)} onChange={() => toggle(e.id)} />}</Td>
                    <Td><p className="font-medium">{plainText(e.summary)}</p>
                      <p className="text-xs text-ink-soft">{e.institution_name ?? ''}{e.application_reference && <> · <Link className="text-accent hover:underline" to={`/app/applications/${e.application_id}`}>{e.application_reference}</Link></>} · Region {e.region_code}</p>
                      <p className="mt-0.5 text-xs text-ink-soft">Was due {e.entity_type === 'deficiency_window' ? fmtDateTime(e.due_at) : fmtDate(e.due_at)}</p>
                      {e.resolution_note && <p className="mt-1 text-xs text-ink-soft">Note: {e.resolution_note}</p>}</Td>
                    <Td className="min-w-[260px]"><Badge tone="neutral">{codeLabel(e.rule_code)}</Badge>
                      <p className="mt-1 text-xs font-medium text-ink">{plural(e.notice_count, 'notice')} of {e.rule_repeat_interval_hours ? e.rule_max_repeats : 1} · to {humanize(e.rule_recipient)}</p>
                      <p className="text-xs text-ink-soft">{cadenceText(e)}</p>
                      <div className="mt-1"><Disclosure summary={<span className="text-xs">Notice timeline</span>}>
                        <ol className="space-y-0.5 text-xs text-ink-soft">{e.notices.map((n) => (
                          <li key={n.notice}>Notice {n.notice} · due by the rule {fmtDateTime(n.scheduled_at ?? n.triggered_at)}
                            {n.scheduled_at && Date.parse(n.triggered_at) - Date.parse(n.scheduled_at) > 3_600_000 && <> · recorded by the scan {fmtDateTime(n.triggered_at)}</>}</li>
                        ))}</ol>
                        <p className="mt-1 text-[11px] text-ink-faint">Rule {e.rule_code} version {e.rule_version}</p>
                      </Disclosure></div>
                    </Td>
                    <Td><StatusBadge status={e.status === 'open' ? 'overdue' : e.status} label={e.status === 'open' ? 'Open' : undefined} /></Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1.5">
                        {e.status === 'open' && <Button size="sm" variant="secondary" onClick={() => setAct({ row: e, action: 'acknowledge' })}>Acknowledge</Button>}
                        {e.status !== 'resolved' && <Button size="sm" onClick={() => setAct({ row: e, action: 'resolve' })}>Resolve</Button>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </Tabs>
      {act && <EscalationDialog row={act.row} action={act.action} onClose={() => setAct(null)} />}
      {bulk && <BulkAcknowledgeDialog ids={selected} onClose={() => { setBulk(false); setSelected([]); }} />}
    </div>
  );
}

function EscalationDialog({ row, action, onClose }: { row: EscalationRow; action: 'acknowledge' | 'resolve'; onClose: () => void }) {
  const [note, setNote] = useState('');
  const a = useAction(() => updateEscalation(row.id, action, note), { success: action === 'resolve' ? 'Escalation resolved.' : 'Escalation acknowledged.', invalidate: [['escalations'], ['navcounts'], ['analytics']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={action === 'resolve' ? 'Resolve escalation' : 'Acknowledge escalation'} description={plainText(row.summary)}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={a.isPending} disabled={action === 'resolve' && note.trim().length < 10} onClick={() => a.mutate(undefined)}>{action === 'resolve' ? 'Resolve' : 'Acknowledge'}</Button></>}>
      <TextAreaField label={action === 'resolve' ? 'How was this resolved?' : 'Note'} required={action === 'resolve'} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="mt-3 text-xs text-ink-soft">This applies to all {plural(row.notice_count, 'notice')} of this escalation. Resolving records the follow-up; it does not change the underlying case.</p>
    </Dialog>
  );
}

function BulkAcknowledgeDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [note, setNote] = useState('');
  const a = useAction(() => acknowledgeEscalations(ids, note), { success: (n) => `${plural(n, 'escalation')} acknowledged.`, invalidate: [['escalations'], ['navcounts'], ['analytics']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Acknowledge ${plural(ids.length, 'escalation')}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={a.isPending} onClick={() => a.mutate(undefined)}>Acknowledge</Button></>}>
      <TextAreaField label="Note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} hint="Optional; recorded on each escalation." />
    </Dialog>
  );
}
