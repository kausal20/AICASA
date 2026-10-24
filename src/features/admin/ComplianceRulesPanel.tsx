import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, Plus } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listComplianceRules, publishComplianceRule, retireComplianceRule } from '@/services/admin';
import { getApplicationTypes } from '@/services/applications';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime } from '@/lib/format';
import type { ComplianceRule } from '@/types/domain';

const KINDS: Record<string, string> = {
  min: 'Minimum value', max: 'Maximum value', ratio_max: 'Ratio at most (a ÷ b ≤ threshold)', consistency_gt: 'Consistency (a > b)',
};

export function ruleSummary(r: Pick<ComplianceRule, 'kind' | 'params'>): string {
  const p = r.params as Record<string, string | number | undefined>;
  switch (r.kind) {
    case 'min': return `${p.field} ≥ ${p.threshold}${p.unit ? ` ${p.unit}` : ''}`;
    case 'max': return `${p.field} ≤ ${p.threshold}${p.unit ? ` ${p.unit}` : ''}`;
    case 'ratio_max': return `${p.numerator} ÷ ${p.denominator} ≤ ${p.threshold}`;
    case 'consistency_gt': return `${p.field} > ${p.other}${p.when_flag ? ` when ${p.when_flag}` : ''}`;
    default: return `Unsupported kind "${r.kind}"`;
  }
}

/** Deficiency Matrix rule registry. Publishing creates a new version; earlier versions stay on record. */
export function ComplianceRulesPanel() {
  const { isNational, can } = useAuth();
  const q = useQuery({ queryKey: ['compliance-rules'], queryFn: listComplianceRules });
  const [publish, setPublish] = useState<ComplianceRule | 'new' | null>(null);
  const [retire, setRetire] = useState<ComplianceRule | null>(null);
  const canEdit = isNational && can('workflow_config');
  const active = (q.data ?? []).filter((r) => r.status === 'active');
  const retired = (q.data ?? []).filter((r) => r.status === 'retired');
  return (
    <Card className="mt-6">
      <CardHeader title="Deficiency Matrix rules"
        description="Numeric and consistency checks shown to institutions and officers. Each rule states where it applies and its source. Results are advisory and never reject a case."
        action={canEdit && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPublish('new')}>New rule</Button>} />
      {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !active.length ? (
        <EmptyState title="No rules configured" body="Without configured rules the matrix checks only form fields, documents, duplicates and pre-check results." />
      ) : (
        <DataTable>
          <thead><tr><Th>Rule</Th><Th>Check</Th><Th>Applies to</Th><Th>Source</Th><Th /></tr></thead>
          <tbody>
            {active.map((r) => (
              <tr key={r.id}>
                <Td><p className="font-medium">{r.label}</p><p className="text-xs text-ink-soft">{r.code} · v{r.version}</p></Td>
                <Td className="text-[13px]">{ruleSummary(r)}<p className="text-xs text-ink-soft">{KINDS[r.kind] ?? r.kind}</p></Td>
                <Td><div className="flex flex-wrap gap-1">{r.applies_to.map((x) => <Badge key={x} tone="neutral">{x}</Badge>)}</div></Td>
                <Td className="max-w-[320px] text-[13px]">{r.is_synthetic && <Badge tone="warning" className="mb-1">Synthetic rule</Badge>}<p className="text-xs text-ink-soft">{r.source_reference}</p></Td>
                <Td className="text-right">{canEdit && (
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => setPublish(r)}>New version</Button>
                    <Button size="sm" variant="ghost" icon={<Archive className="h-3.5 w-3.5" />} onClick={() => setRetire(r)}>Retire</Button>
                  </div>
                )}</Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {retired.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">{retired.length} earlier or retired version{retired.length === 1 ? '' : 's'} kept on record
          ({retired.slice(0, 4).map((r) => `${r.code} v${r.version}${r.retired_at ? `, ${fmtDateTime(r.retired_at)}` : ''}`).join('; ')}{retired.length > 4 ? '; …' : ''}).</p>
      )}
      {publish && <PublishRuleDialog base={publish === 'new' ? null : publish} onClose={() => setPublish(null)} />}
      {retire && <RetireRuleDialog r={retire} onClose={() => setRetire(null)} />}
    </Card>
  );
}

function PublishRuleDialog({ base, onClose }: { base: ComplianceRule | null; onClose: () => void }) {
  const types = useQuery({ queryKey: ['application-types'], queryFn: getApplicationTypes });
  const p = (base?.params ?? {}) as Record<string, string | number | undefined>;
  const [f, setF] = useState({
    code: base?.code ?? '', label: base?.label ?? '', kind: base?.kind && KINDS[base.kind] ? base.kind : 'min',
    field: String(p.field ?? p.numerator ?? ''), other: String(p.other ?? p.denominator ?? ''), threshold: p.threshold !== undefined ? String(p.threshold) : '',
    unit: String(p.unit ?? ''), target: String(p.target ?? ''), whenFlag: String(p.when_flag ?? ''), source: base?.source_reference ?? '',
    synthetic: base?.is_synthetic ?? true, explanation: base?.explanation ?? '', reason: '',
  });
  const [applies, setApplies] = useState<string[]>(base?.applies_to ?? []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const params: Record<string, unknown> = f.kind === 'ratio_max'
    ? { numerator: f.field, denominator: f.other, threshold: Number(f.threshold), ...(f.target ? { target: f.target } : {}) }
    : f.kind === 'consistency_gt' ? { field: f.field, other: f.other, ...(f.whenFlag ? { when_flag: f.whenFlag } : {}) }
      : { field: f.field, threshold: Number(f.threshold), ...(f.unit ? { unit: f.unit } : {}) };
  const act = useAction(() => publishComplianceRule({ code: f.code, label: f.label, kind: f.kind, appliesTo: applies, params, source: f.source,
    synthetic: f.synthetic, explanation: f.explanation, reason: f.reason }), {
    success: (r) => `${r.code} v${r.version} is active.`, invalidate: [['compliance-rules'], ['matrix']], onSuccess: onClose,
  });
  const fields = [...new Set((types.data ?? []).filter((t) => applies.includes(t.code)).flatMap((t) => t.form_schema.map((x) => x.key)))];
  const needsThreshold = f.kind !== 'consistency_gt';
  const valid = /^[a-z][a-z0-9_]*$/.test(f.code) && f.label.trim().length >= 3 && applies.length > 0 && f.field && (f.kind === 'min' || f.kind === 'max' || f.other)
    && (!needsThreshold || f.threshold.trim() !== '') && f.source.trim().length >= 5 && f.reason.trim().length >= 10;
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title={base ? `New version of ${base.code}` : 'New Deficiency Matrix rule'}
      description="The server checks that the fields exist on every selected form and that a source is given."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!valid} onClick={() => act.mutate(undefined)}>Publish rule</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Code" required value={f.code} onChange={set('code')} disabled={!!base} hint="lower_case_with_underscores" />
        <TextField label="Label" required value={f.label} onChange={set('label')} />
        <SelectField label="Kind" required value={f.kind} onChange={set('kind')}>
          {Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Applies to <span className="text-danger">*</span></legend>
          <div className="flex flex-wrap gap-2">{(types.data ?? []).map((t) => {
            const on = applies.includes(t.code);
            return <label key={t.code} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${on ? 'border-primary bg-primary-soft' : 'border-line'}`}>
              <input type="checkbox" className="accent-[#1e3a8a]" checked={on} onChange={() => setApplies(on ? applies.filter((x) => x !== t.code) : [...applies, t.code])} />{t.code}</label>;
          })}</div>
        </fieldset>
        <SelectField label={f.kind === 'ratio_max' ? 'Numerator field' : 'Field'} required value={f.field} onChange={set('field')}>
          <option value="">Select a form field</option>{fields.map((x) => <option key={x} value={x}>{x}</option>)}
        </SelectField>
        {f.kind === 'ratio_max' || f.kind === 'consistency_gt' ? (
          <SelectField label={f.kind === 'ratio_max' ? 'Denominator field' : 'Compared with'} required value={f.other} onChange={set('other')}>
            <option value="">Select a form field</option>{fields.map((x) => <option key={x} value={x}>{x}</option>)}
          </SelectField>
        ) : <TextField label="Unit" value={f.unit} onChange={set('unit')} />}
        {needsThreshold && <TextField label="Threshold" type="number" required value={f.threshold} onChange={set('threshold')} />}
        {f.kind === 'ratio_max' && <TextField label="Target as shown" value={f.target} onChange={set('target')} hint="e.g. 1:20" />}
        {f.kind === 'consistency_gt' && <TextField label="Only when this flag is declared" value={f.whenFlag} onChange={set('whenFlag')} hint="Optional boolean form field" />}
        <div className="sm:col-span-2"><TextField label="Source reference" required value={f.source} onChange={set('source')} hint="Where the requirement comes from. State plainly if it is a demonstration value." /></div>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="accent-[#1e3a8a]" checked={f.synthetic} onChange={(e) => setF({ ...f, synthetic: e.target.checked })} />Synthetic demonstration rule (shown with a "Synthetic rule" label)</label>
        <div className="sm:col-span-2"><TextField label="Extra explanation shown with the result" value={f.explanation} onChange={set('explanation')} /></div>
        <div className="sm:col-span-2"><TextAreaField label="Reason for publishing" required rows={2} value={f.reason} onChange={set('reason')} /></div>
      </div>
    </Dialog>
  );
}

function RetireRuleDialog({ r, onClose }: { r: ComplianceRule; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const act = useAction(() => retireComplianceRule(r.code, reason), { success: `${r.code} retired.`, invalidate: [['compliance-rules'], ['matrix']], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Retire ${r.code}`} description="The rule stops appearing in the matrix. Its versions stay on record."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Retire rule</Button></>}>
      <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  );
}
