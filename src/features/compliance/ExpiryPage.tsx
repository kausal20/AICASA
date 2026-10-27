import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listValidities, recordValidity } from '@/services/operations';
import { listDocuments } from '@/services/documents';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Stat, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDate, humanize, relativeDay } from '@/lib/format';

export function ExpiryPage() {
  const { workspace, institution } = useAuth();
  const [record, setRecord] = useState(false);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const q = useQuery({ queryKey: ['validities', workspace === 'institution' ? institution?.id : 'scope'], queryFn: () => listValidities({ institutionId: workspace === 'institution' ? institution?.id : undefined }) });
  const all = q.data ?? [];
  const [sp, setSp] = useSearchParams();
  const stateFilter = sp.get('state') ?? '';
  const rows = all.filter((r) => (showSuperseded || r.validity_state !== 'superseded') && (!stateFilter || r.validity_state === stateFilter));
  const n = (s: string) => all.filter((r) => r.validity_state === s).length;
  return (
    <div>
      <PageHeader title="Document validity" description="Lease deeds and other prescribed documents with recorded expiry dates. Renewal reminders follow the configured lead time; an expired date is flagged for follow-up and is not by itself a legal finding."
        actions={workspace === 'institution' && <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setRecord(true)}>Record validity</Button>} />
      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat label="Expired" value={q.isLoading ? '…' : n('expired')} tone={n('expired') ? 'danger' : 'neutral'} />
        <Stat label="Expiring within 90 days" value={q.isLoading ? '…' : n('expiring_soon')} tone={n('expiring_soon') ? 'warning' : 'neutral'} />
        <Stat label="Valid" value={q.isLoading ? '…' : n('valid')} />
      </div>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Filter by validity">
            {[['', 'All'], ['expired', 'Expired'], ['expiring_soon', 'Expiring soon'], ['valid', 'Valid']].map(([v, l]) => (
              <button key={v || 'all'} aria-pressed={stateFilter === v} onClick={() => { const p = new URLSearchParams(sp); if (v) p.set('state', v); else p.delete('state'); setSp(p, { replace: true }); }}
                className={`rounded-full px-3 py-1 text-[13px] font-medium ${stateFilter === v ? 'bg-primary text-white' : 'bg-surface-muted text-ink-soft hover:text-ink'}`}>{l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-[#1e3a8a]" checked={showSuperseded} onChange={(e) => setShowSuperseded(e.target.checked)} />Show superseded records (renewal history)</label>
        </div>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? (
          <EmptyState title="No validity records" body="Record a document's issue and expiry dates to receive renewal reminders." />
        ) : (
          <DataTable>
            <thead><tr><Th>Document</Th>{workspace !== 'institution' && <Th>Institution</Th>}<Th>Validity</Th><Th>Expiry</Th><Th>Renewal</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.validity_state === 'superseded' ? 'opacity-70' : ''}>
                  <Td><p className="font-medium">{r.title}</p><p className="text-xs text-ink-soft">{humanize(r.doc_type)} · {r.source_reference}</p></Td>
                  {workspace !== 'institution' && <Td className="text-[13px]">{r.institution_name}<p className="text-xs text-ink-soft">{r.region_code}</p></Td>}
                  <Td><StatusBadge status={r.validity_state} /></Td>
                  <Td className="tabular text-[13px]">{fmtDate(r.expiry_date)}<p className="text-xs text-ink-soft">{r.validity_state === 'superseded' ? '' : relativeDay(r.expiry_date)}</p></Td>
                  <Td className="text-[13px]">{humanize(r.renewal_state)}{r.renewal_obligation_id && <p><Link to="/app/compliance" className="text-xs text-accent hover:underline">Renewal obligation</Link></p>}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
      {record && institution && <RecordDialog institutionId={institution.id} onClose={() => setRecord(false)} />}
    </div>
  );
}

function RecordDialog({ institutionId, onClose }: { institutionId: string; onClose: () => void }) {
  const docs = useQuery({ queryKey: ['documents', 'inst', institutionId], queryFn: () => listDocuments({ institutionId }) });
  const [f, setF] = useState({ version: '', title: '', issue: '', expiry: '', source: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const doc = (docs.data ?? []).find((d) => d.document_versions?.some((v) => v.id === f.version));
  const act = useAction(() => recordValidity({ institutionId, versionId: f.version || null, docType: doc?.doc_type ?? 'other', title: f.title || doc?.title || '', issueDate: f.issue || null, expiryDate: f.expiry, source: f.source }),
    { success: 'Validity recorded. Reminders follow the configured lead time.', invalidate: [['validities']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Record document validity"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!f.expiry || !(f.title || doc)} onClick={() => act.mutate(undefined)}>Save</Button></>}>
      <div className="space-y-4">
        <SelectField label="Uploaded document" value={f.version} onChange={set('version')}>
          <option value="">None (record dates only)</option>
          {(docs.data ?? []).map((d) => { const v = d.document_versions?.find((x) => x.version === d.current_version); return v ? <option key={v.id} value={v.id}>{d.title} (v{v.version})</option> : null; })}
        </SelectField>
        <TextField label="Title" required={!doc} value={f.title} onChange={set('title')} placeholder={doc?.title} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Issue date" type="date" value={f.issue} onChange={set('issue')} />
          <TextField label="Expiry date" type="date" required value={f.expiry} onChange={set('expiry')} />
        </div>
        <TextField label="Source / reference" value={f.source} onChange={set('source')} />
        <Notice tone="info">These dates are what you declare from the document; an officer may verify them.</Notice>
      </div>
    </Dialog>
  );
}
