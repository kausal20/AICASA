import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAudit, type AuditFilters } from '@/services/admin';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Pagination, Td, Th } from '@/components/ui/Page';
import { AuditStream } from '@/features/dashboards/AuditStream';
import { auditDetail, uniqueAudit } from '@/lib/auditDetail';
import { Input, Select } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { codeLabel, fmtDateTime, humanize } from '@/lib/format';
import { auditActionLabel, auditResponsibilities } from '@/lib/responsibilities';

const ACTIONS = ['application_created', 'application_submitted', 'stage_entered', 'transition', 'transition_rejected', 'decision_recorded',
  'deficiency_raised', 'returned_for_correction', 'correction_submitted', 'correction_reviewed', 'document_uploaded', 'document_replaced',
  'evc_scheduled', 'evc_rescheduled', 'evc_cancelled', 'evc_completed', 'obligation_created', 'compliance_evidence_submitted',
  'compliance_verified', 'compliance_correction_required', 'escalation_triggered', 'role_granted', 'role_revoked',
  'workflow_version_published', 'alert_rule_changed', 'report_exported', 'assignment_changed'];

export function AuditPage() {
  const [f, setF] = useState<AuditFilters>({});
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['audit', f, page], queryFn: () => listAudit(f, page) });
  const set = (k: keyof AuditFilters) => (e: { target: { value: string } }) => { setPage(0); setF({ ...f, [k]: e.target.value || undefined }); };
  return (
    <div>
      <PageHeader title="Audit log" description="Append-only record of significant actions, including rejected attempts. No user, including administrators, can edit or delete entries." />
      <div className="mb-6"><AuditStream /></div>
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <Select aria-label="Action" value={f.action ?? ''} onChange={set('action')} className="w-auto min-w-[200px]"><option value="">All actions</option>{ACTIONS.map((a) => <option key={a} value={a}>{auditActionLabel(a)}</option>)}</Select>
          <Select aria-label="Entity" value={f.entityType ?? ''} onChange={set('entityType')} className="w-auto"><option value="">All records</option>{['application', 'deficiency', 'document', 'evc', 'obligation', 'escalation', 'user', 'workflow_definition', 'escalation_rule', 'report'].map((e) => <option key={e} value={e}>{humanize(e)}</option>)}</Select>
          <Input aria-label="Application reference" placeholder="Application reference" value={f.search ?? ''} onChange={set('search')} className="w-auto" />
          <label className="text-xs text-ink-soft">From<Input type="date" value={f.from ?? ''} onChange={set('from')} className="mt-1 w-auto" /></label>
          <label className="text-xs text-ink-soft">To<Input type="date" value={f.to ?? ''} onChange={set('to')} className="mt-1 w-auto" /></label>
          {Object.values(f).some(Boolean) && <Button variant="ghost" size="sm" onClick={() => { setF({}); setPage(0); }}>Clear</Button>}
        </div>
        {q.isLoading ? <LoadingRows rows={8} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.rows.length ? <EmptyState title="No audit entries match" body="Widen the date range or clear filters." /> : (
          <>
            <DataTable>
              <thead><tr><Th>When (IST)</Th><Th>Actor</Th><Th>Action</Th><Th>Record</Th><Th>Reason / details</Th></tr></thead>
              <tbody>
                {uniqueAudit(q.data.rows).map((r) => (
                  <tr key={r.id} className="align-top">
                    <Td className="whitespace-nowrap text-[13px] tabular">{fmtDateTime(r.created_at)}</Td>
                    <Td className="text-[13px]">{r.actor_kind === 'system' ? <><Badge tone="neutral">System</Badge>{(r.metadata?.rule_code ?? r.metadata?.rule) ? <p className="mt-0.5 text-xs text-ink-soft">Rule: {codeLabel(String(r.metadata.rule_code ?? r.metadata.rule))}</p> : null}</> : r.actor_name ?? 'User'}</Td>
                    <Td><Badge tone={r.action.includes('rejected') ? 'danger' : r.action.includes('escalation') ? 'warning' : 'neutral'}>{auditActionLabel(r.action)}</Badge></Td>
                    <Td className="text-[13px]">{humanize(r.entity_type)}{r.application_reference && <p><Link className="text-xs text-accent hover:underline" to={`/app/applications/${r.application_id}`}>{r.application_reference}</Link></p>}{r.region_code && <p className="text-xs text-ink-soft">{r.region_code}</p>}</Td>
                    <Td className="max-w-[380px] text-[13px]">
                      {auditDetail(r) && <p className="font-medium">{auditDetail(r)}</p>}
                      {r.reason && <p>{r.reason}</p>}
                      {auditResponsibilities(r).length > 0 && <p className="text-xs text-ink-soft">Responsibilities: {auditResponsibilities(r).join(', ')}</p>}
                      {(r.before_state != null || r.after_state != null || Object.keys(r.metadata ?? {}).length > 0) && (
                        <button className="text-xs font-medium text-accent hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{open === r.id ? 'Hide' : 'Show'} state change</button>
                      )}
                      {open === r.id && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-2 text-[11px] leading-snug">{JSON.stringify({ before: r.before_state, after: r.after_state, metadata: r.metadata }, null, 2)}</pre>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
