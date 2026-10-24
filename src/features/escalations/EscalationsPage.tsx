import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listEscalations, updateEscalation } from '@/services/operations';
import { runScanNow } from '@/services/admin';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge, Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Tabs, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { TextAreaField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, humanize } from '@/lib/format';
import type { EscalationRow } from '@/types/domain';

export function EscalationsPage() {
  const { workspace, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = ['open', 'acknowledged', 'resolved', 'all'].includes(sp.get('status') ?? '') ? sp.get('status')! : 'open';
  const setTab = (t: string) => setSp({ status: t }, { replace: true });
  const [act, setAct] = useState<{ row: EscalationRow; action: 'acknowledge' | 'resolve' } | null>(null);
  const q = useQuery({ queryKey: ['escalations', tab], queryFn: () => listEscalations(tab === 'all' ? undefined : tab) });
  const scan = useAction(runScanNow, {
    invalidate: [['escalations'], ['notifications'], ['obligations'], ['jobs']],
    success: (r) => r.status === 'succeeded' ? `Scan finished: ${r.stats.escalations ?? 0} new escalations, ${r.stats.notifications ?? 0} notifications.` : `Scan failed: ${r.error}`,
  });
  return (
    <div>
      <PageHeader title="Escalations" description="Raised automatically by the deadline scanner under the active, versioned alert rules. Re-running the scan never duplicates an escalation."
        actions={workspace === 'admin' && can('escalation') && <Button variant="secondary" icon={<Play className="h-4 w-4" />} loading={scan.isPending} onClick={() => scan.mutate(undefined)}>Run deadline scan now</Button>} />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]}>
        <Card>
          {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState title="No escalations here" /> : (
            <DataTable>
              <thead><tr><Th>Escalation</Th><Th>Rule</Th><Th>Triggered</Th><Th>Status</Th><Th /></tr></thead>
              <tbody>
                {q.data.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-muted/60">
                    <Td><p className="font-medium">{e.summary}</p>
                      <p className="text-xs text-ink-soft">{e.institution_name ?? ''}{e.application_reference && <> · <Link className="text-accent hover:underline" to={`/app/applications/${e.application_id}`}>{e.application_reference}</Link></>} · {e.region_code}</p>
                      {e.resolution_note && <p className="mt-1 text-xs text-ink-soft">Note: {e.resolution_note}</p>}</Td>
                    <Td><Badge tone="neutral">{e.rule_code} v{e.rule_version}</Badge><p className="mt-1 text-xs text-ink-soft">{humanize(e.entity_type)} · notice {e.repeat_no} · to {humanize(e.rule_recipient)}</p></Td>
                    <Td className="text-[13px] tabular">{fmtDateTime(e.triggered_at)}<p className="text-xs text-ink-soft">Due was {fmtDateTime(e.due_at)}</p></Td>
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
    </div>
  );
}

function EscalationDialog({ row, action, onClose }: { row: EscalationRow; action: 'acknowledge' | 'resolve'; onClose: () => void }) {
  const [note, setNote] = useState('');
  const a = useAction(() => updateEscalation(row.id, action, note), { success: action === 'resolve' ? 'Escalation resolved.' : 'Escalation acknowledged.', invalidate: [['escalations']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={action === 'resolve' ? 'Resolve escalation' : 'Acknowledge escalation'} description={row.summary}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={a.isPending} disabled={action === 'resolve' && note.trim().length < 10} onClick={() => a.mutate(undefined)}>{action === 'resolve' ? 'Resolve' : 'Acknowledge'}</Button></>}>
      <TextAreaField label={action === 'resolve' ? 'How was this resolved?' : 'Note'} required={action === 'resolve'} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="mt-3 text-xs text-ink-soft">Resolving records the follow-up; it does not change the underlying case. Act on the case itself separately.</p>
    </Dialog>
  );
}
