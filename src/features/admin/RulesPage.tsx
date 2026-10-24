import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listRules, updateRule } from '@/services/admin';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, humanize } from '@/lib/format';
import type { EscalationRule } from '@/types/domain';
import { ComplianceRulesPanel } from './ComplianceRulesPanel';

export function offsetText(h: number) {
  const abs = Math.abs(h);
  const v = abs % 24 === 0 ? `${abs / 24} day${abs / 24 === 1 ? '' : 's'}` : `${abs} hours`;
  return h === 0 ? 'At the due time' : h < 0 ? `${v} before due` : `${v} after due`;
}

export function RulesPage() {
  const { isNational, can } = useAuth();
  const q = useQuery({ queryKey: ['rules'], queryFn: listRules });
  const [edit, setEdit] = useState<EscalationRule | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const active = (q.data ?? []).filter((r) => r.is_active || !(q.data ?? []).some((x) => x.code === r.code && x.version > r.version));
  const canEdit = isNational && can('escalation');
  return (
    <div>
      <PageHeader title="Reminder and escalation rules" description="Lead times, thresholds, recipients and repeat limits used by the deadline scanner. Every change creates a new rule version; alerts already raised keep the version that raised them." />
      <Notice tone="warning">These rules are demonstration settings, not statutory deadlines. AICASA does not invent deadlines that are not configured here.</Notice>
      <Card className="mt-5">
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} /> : (
          <DataTable>
            <thead><tr><Th>Rule</Th><Th>Applies to</Th><Th>Fires</Th><Th>Recipient</Th><Th>Repeats</Th><Th>Channel</Th><Th /></tr></thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id}>
                  <Td><p className="font-medium">{r.code}</p><p className="text-xs text-ink-soft">v{r.version} · {r.is_active ? 'active' : 'disabled'} · <button className="text-accent hover:underline" onClick={() => setHistory(r.code)}>history</button></p></Td>
                  <Td><Badge tone={r.rule_kind === 'escalation' ? 'danger' : 'warning'}>{humanize(r.rule_kind)}</Badge><p className="mt-1 text-xs text-ink-soft">{humanize(r.entity_type)}</p></Td>
                  <Td className="text-[13px]">{offsetText(r.offset_hours)}</Td>
                  <Td className="text-[13px]">{humanize(r.recipient)}{r.recipient_capability ? ` (${r.recipient_capability})` : ''}</Td>
                  <Td className="text-[13px]">{r.max_repeats}×{r.repeat_interval_hours ? ` every ${r.repeat_interval_hours}h` : ''}</Td>
                  <Td className="text-[13px]">{r.channel === 'in_app' ? 'In-app' : 'In-app + email*'}</Td>
                  <Td className="text-right">{canEdit && <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(r)}>Change</Button>}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-ink-soft">* Email is attempted only when an email provider is configured; otherwise each attempt is logged as skipped.</p>
      </Card>
      <ComplianceRulesPanel />
      {edit && <EditRule r={edit} onClose={() => setEdit(null)} />}
      {history && (
        <Dialog open onOpenChange={() => setHistory(null)} title={`${history} — version history`}>
          <ul className="space-y-3 text-[13px]">
            {(q.data ?? []).filter((r) => r.code === history).map((r) => (
              <li key={r.id} className="rounded-lg bg-surface-muted px-4 py-3">
                <p className="font-medium">v{r.version} {r.is_active && <Badge tone="success">Active</Badge>}</p>
                <p className="text-ink-soft">{offsetText(r.offset_hours)} · {humanize(r.recipient)} · {r.max_repeats}×</p>
                <p className="mt-1">{r.change_summary}</p>
                <p className="text-xs text-ink-faint">{fmtDateTime(r.created_at)} · {r.source_reference}</p>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  );
}

function EditRule({ r, onClose }: { r: EscalationRule; onClose: () => void }) {
  const [f, setF] = useState({ offset: String(r.offset_hours), recipient: r.recipient, cap: r.recipient_capability ?? '', channel: r.channel, repeats: String(r.max_repeats), interval: String(r.repeat_interval_hours ?? ''), active: r.is_active, source: r.source_reference, summary: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction(() => updateRule({ code: r.code, offsetHours: Number(f.offset), recipient: f.recipient, recipientCapability: f.cap || null, channel: f.channel, maxRepeats: Number(f.repeats), repeatIntervalHours: f.interval ? Number(f.interval) : null, active: f.active, source: f.source, summary: f.summary }),
    { success: (n) => `${n.code} v${n.version} saved.`, invalidate: [['rules']], onSuccess: onClose });
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title={`Change ${r.code}`} description={`${humanize(r.rule_kind)} for ${humanize(r.entity_type)}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={f.summary.trim().length < 10 || Number.isNaN(Number(f.offset))} onClick={() => act.mutate(undefined)}>Save as new version</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Offset (hours from due; negative = before)" type="number" required value={f.offset} onChange={set('offset')} hint={offsetText(Number(f.offset) || 0)} />
        <SelectField label="Recipient" required value={f.recipient} onChange={set('recipient')}>
          {['institution', 'assigned_officer', 'capability_officers', 'regional_admin', 'national_admin'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </SelectField>
        {f.recipient === 'capability_officers' && <SelectField label="Officer responsibility" required value={f.cap} onChange={set('cap')}>
          <option value="">Select…</option>{['scrutiny', 'evc', 'committee', 'compliance', 'decision'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </SelectField>}
        <SelectField label="Channel" required value={f.channel} onChange={set('channel')}><option value="in_app">In-app</option><option value="in_app_and_email">In-app and email</option></SelectField>
        <TextField label="Maximum notices" type="number" min={1} max={10} required value={f.repeats} onChange={set('repeats')} />
        <TextField label="Repeat interval (hours)" type="number" min={1} value={f.interval} onChange={set('interval')} />
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="accent-[#1e3a8a]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Rule active</label>
        <div className="sm:col-span-2"><TextField label="Source reference" value={f.source} onChange={set('source')} /></div>
        <div className="sm:col-span-2"><TextAreaField label="Change summary" required rows={2} value={f.summary} onChange={set('summary')} /></div>
      </div>
    </Dialog>
  );
}
