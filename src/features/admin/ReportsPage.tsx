import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { unwrap, errorMessage } from '@/lib/errors';
import { recordExport, listRegions } from '@/services/admin';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { Select, Input } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { downloadText, toCsv } from '@/lib/csv';
import { fmtDateTime, humanize } from '@/lib/format';

interface ReportDef { code: string; name: string; description: string; view: string; dateCol: string; regionCol: string; columns: { key: string; label: string }[] }

const REPORTS: ReportDef[] = [
  { code: 'pendency', name: 'Application pendency and ageing', description: 'Open and closed applications with stage, age and target dates.', view: 'v_applications', dateCol: 'created_at', regionCol: 'region_code',
    columns: [{ key: 'reference', label: 'Reference' }, { key: 'institution_name', label: 'Institution' }, { key: 'region_code', label: 'Region' }, { key: 'application_type_name', label: 'Type' },
      { key: 'stage_name', label: 'Stage' }, { key: 'status', label: 'Status' }, { key: 'assigned_officer_name', label: 'Regional Officer' }, { key: 'age_days', label: 'Age (days)' },
      { key: 'stage_age_days', label: 'Days in stage' }, { key: 'stage_due_at', label: 'Stage target' }, { key: 'is_overdue', label: 'Past target' }] },
  { code: 'evc', name: 'EVC queue and outcomes', description: 'Awaiting, scheduled, completed and delayed EVCs.', view: 'v_evc_queue', dateCol: 'ready_at', regionCol: 'region_code',
    columns: [{ key: 'reference', label: 'Reference' }, { key: 'institution_name', label: 'Institution' }, { key: 'region_code', label: 'Region' }, { key: 'cycle', label: 'Cycle' }, { key: 'status', label: 'Status' },
      { key: 'scheduled_start', label: 'Scheduled start' }, { key: 'outcome', label: 'Outcome' }, { key: 'age_days', label: 'Days in queue' }, { key: 'is_overdue', label: 'Overdue' }] },
  { code: 'compliance', name: 'Undertakings and compliance', description: 'Obligations with effective status and due dates.', view: 'v_obligations', dateCol: 'created_at', regionCol: 'region_code',
    columns: [{ key: 'title', label: 'Obligation' }, { key: 'institution_name', label: 'Institution' }, { key: 'region_code', label: 'Region' }, { key: 'obligation_type', label: 'Type' },
      { key: 'effective_status', label: 'Status' }, { key: 'due_at', label: 'Due' }, { key: 'source_reference', label: 'Source' }, { key: 'submission_count', label: 'Submissions' }] },
  { code: 'validity', name: 'Document validity and renewals', description: 'Documents approaching expiry, expired and awaiting renewal verification.', view: 'v_document_validity', dateCol: 'created_at', regionCol: 'region_code',
    columns: [{ key: 'title', label: 'Document' }, { key: 'institution_name', label: 'Institution' }, { key: 'region_code', label: 'Region' }, { key: 'doc_type', label: 'Type' },
      { key: 'expiry_date', label: 'Expiry' }, { key: 'validity_state', label: 'State' }, { key: 'renewal_state', label: 'Renewal' }] },
  { code: 'escalations', name: 'Overdue and escalation outcomes', description: 'Escalations raised by the scanner and how they were handled.', view: 'v_escalations', dateCol: 'triggered_at', regionCol: 'region_code',
    columns: [{ key: 'summary', label: 'Escalation' }, { key: 'rule_code', label: 'Rule' }, { key: 'rule_version', label: 'Rule version' }, { key: 'region_code', label: 'Region' },
      { key: 'triggered_at', label: 'Triggered' }, { key: 'status', label: 'Status' }, { key: 'resolved_at', label: 'Resolved' }, { key: 'resolution_note', label: 'Resolution' }] },
];

const MAX_ROWS = 5000;

export function ReportsPage() {
  const { isNational, regions } = useAuth();
  const [code, setCode] = useState(REPORTS[0].code);
  const [region, setRegion] = useState(isNational ? '' : regions[0] ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const allRegions = useQuery({ queryKey: ['regions'], queryFn: listRegions });
  const def = REPORTS.find((r) => r.code === code)!;
  const filters = { region: region || 'all permitted', from: from || null, to: to || null };
  const q = useQuery({
    queryKey: ['report', code, region, from, to],
    queryFn: async () => {
      let s = supabase.from(def.view).select(def.columns.map((c) => c.key).join(','), { count: 'exact' }).limit(MAX_ROWS);
      if (region) s = s.eq(def.regionCol, region);
      if (from) s = s.gte(def.dateCol, `${from}T00:00:00+05:30`);
      if (to) s = s.lte(def.dateCol, `${to}T23:59:59+05:30`);
      const res = await s;
      return { rows: unwrap(res) as unknown as Record<string, unknown>[], total: res.count ?? 0, at: new Date().toISOString() };
    },
  });
  const exportCsv = async () => {
    if (!q.data) return;
    try {
      const meta = [`AICASA report: ${def.name}`, `Scope: ${filters.region}`, `Date range: ${from || 'any'} to ${to || 'any'} (${def.dateCol})`,
        `Generated: ${fmtDateTime(q.data.at)}`, 'Synthetic demonstration data — not AICTE records', `Rows: ${q.data.rows.length}${q.data.total > q.data.rows.length ? ` of ${q.data.total} (truncated)` : ''}`];
      downloadText(`aicasa-${code}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(def.columns, q.data.rows, meta));
      await recordExport(code, filters, q.data.rows.length);
      toast.success('Export downloaded and recorded in the audit log.');
    } catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div>
      <PageHeader title="Reports and export" description="Every report runs against the database with your permissions applied, so it contains only records you are authorised to see." />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit">
          <ul className="p-2">
            {REPORTS.map((r) => (
              <li key={r.code}><button onClick={() => setCode(r.code)} className={`w-full rounded-lg px-3 py-2.5 text-left ${code === r.code ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}>
                <p className="text-[13.5px] font-medium">{r.name}</p><p className="text-xs text-ink-soft">{r.description}</p></button></li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title={def.name} description={q.data ? `${q.data.total} row${q.data.total === 1 ? '' : 's'} · scope ${filters.region} · data as of ${fmtDateTime(q.data.at)}` : 'Loading…'}
            action={<Button icon={<Download className="h-4 w-4" />} disabled={!q.data?.rows.length} onClick={exportCsv}>Export CSV</Button>} />
          <CardBody className="flex flex-wrap items-end gap-3 border-b border-line">
            <label className="text-xs text-ink-soft">Region<Select value={region} onChange={(e) => setRegion(e.target.value)} className="mt-1 w-auto">
              {isNational && <option value="">All regions</option>}
              {(allRegions.data ?? []).filter((r) => isNational || regions.includes(r.code)).map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}
            </Select></label>
            <label className="text-xs text-ink-soft">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-auto" /></label>
            <label className="text-xs text-ink-soft">To<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-auto" /></label>
          </CardBody>
          {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.rows.length ? <EmptyState title="No rows for this scope and date range" body="Widen the date range or choose another region." /> : (
            <DataTable>
              <thead><tr>{def.columns.map((c) => <Th key={c.key}>{c.label}</Th>)}</tr></thead>
              <tbody>{q.data.rows.slice(0, 50).map((r, i) => <tr key={i}>{def.columns.map((c) => <Td key={c.key} className="text-[13px]">{fmt(r[c.key])}</Td>)}</tr>)}</tbody>
            </DataTable>
          )}
          {q.data && q.data.rows.length > 50 && <p className="px-5 py-3 text-xs text-ink-soft">Showing the first 50 rows; the export contains all {q.data.rows.length}.</p>}
        </Card>
      </div>
    </div>
  );
}

function fmt(v: unknown) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
  if (typeof v === 'string' && /^[a-z_]+$/.test(v)) return humanize(v);
  return String(v);
}
