import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitBranchPlus } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listWorkflowDefinitions, publishWorkflowVersion } from '@/services/admin';
import { getRoute } from '@/services/applications';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { Input, Select, TextAreaField, TextField } from '@/components/ui/Field';
import { ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, humanize } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import type { WorkflowStage, WorkflowTransition, WorkflowVersion } from '@/types/domain';

export function WorkflowsPage() {
  const { can, isNational } = useAuth();
  const defs = useQuery({ queryKey: ['workflow-defs'], queryFn: listWorkflowDefinitions });
  const [selected, setSelected] = useState<string | null>(null);
  const def = defs.data?.find((d) => d.id === selected) ?? defs.data?.[0];
  const versions = [...(def?.workflow_definition_versions ?? [])].sort((a, b) => b.version - a.version);
  const active = versions.find((v) => v.status === 'active');
  const [viewVersion, setViewVersion] = useState<string | null>(null);
  const shown = versions.find((v) => v.id === viewVersion) ?? active;
  const route = useQuery({ queryKey: ['route', shown?.id], queryFn: () => getRoute(shown!.id), enabled: !!shown });
  const [edit, setEdit] = useState(false);
  const canEdit = isNational && can('workflow_config');

  return (
    <div>
      <PageHeader title="Workflow routes" description="Versioned, rule-driven routes. Each case keeps the version it started with; publishing a change creates a new version and never rewrites history." />
      <Notice tone="warning">All routes, stage targets and prerequisites shown are demonstration configuration. They must be verified against the current Approval Process Handbook before any real use.</Notice>
      {defs.isLoading ? <Card className="mt-5"><LoadingRows /></Card> : defs.error ? <Card className="mt-5"><ErrorState error={defs.error} /></Card> : (
        <div className="mt-5 grid gap-6 lg:grid-cols-[260px_1fr]">
          <Card className="h-fit">
            <ul className="p-2">
              {defs.data!.map((d) => (
                <li key={d.id}>
                  <button onClick={() => { setSelected(d.id); setViewVersion(null); }} className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors ${def?.id === d.id ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}>
                    <p className="text-[13.5px] font-medium">{d.name}</p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {def && (
            <div className="space-y-6">
              <Card>
                <CardHeader title={def.name} description={def.description}
                  action={canEdit && active && route.data && shown?.id === active.id && <Button icon={<GitBranchPlus className="h-4 w-4" />} onClick={() => setEdit(true)}>Publish new version</Button>} />
                <CardBody>
                  <div className="mb-4 flex flex-wrap gap-2">
                    {versions.map((v) => (
                      <button key={v.id} onClick={() => setViewVersion(v.id)} className={`rounded-full border px-3 py-1 text-[13px] ${shown?.id === v.id ? 'border-primary bg-primary-soft' : 'border-line'}`}>
                        v{v.version} · {v.status}
                      </button>
                    ))}
                  </div>
                  {shown && <VersionMeta v={shown} />}
                </CardBody>
              </Card>
              {route.isLoading ? <Card><LoadingRows /></Card> : route.data && <RouteTables stages={route.data.stages} transitions={route.data.transitions} />}
            </div>
          )}
        </div>
      )}
      {edit && def && route.data && <PublishDialog definitionId={def.id} stages={route.data.stages} transitions={route.data.transitions} onClose={() => setEdit(false)} />}
    </div>
  );
}

function VersionMeta({ v }: { v: WorkflowVersion }) {
  return (
    <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
      <div><dt className="text-xs text-ink-soft">Source reference</dt><dd>{v.source_reference}</dd></div>
      <div><dt className="text-xs text-ink-soft">Change summary</dt><dd>{v.change_summary}</dd></div>
      <div><dt className="text-xs text-ink-soft">Effective</dt><dd>{fmtDateTime(v.effective_from)}{v.effective_to ? ` – ${fmtDateTime(v.effective_to)}` : ''}</dd></div>
      <div><dt className="text-xs text-ink-soft">Status</dt><dd><Badge tone={v.status === 'active' ? 'success' : 'neutral'}>{humanize(v.status)}</Badge></dd></div>
    </dl>
  );
}

export function RouteTables({ stages, transitions }: { stages: WorkflowStage[]; transitions: WorkflowTransition[] }) {
  return (
    <>
      <Card>
        <CardHeader title="Stages" />
        <DataTable><thead><tr><Th>#</Th><Th>Stage</Th><Th>Kind</Th><Th>Internal target</Th><Th>Responsibility</Th><Th>Concurrent reviews</Th></tr></thead>
          <tbody>{stages.map((s) => <tr key={s.id}><Td className="tabular">{s.sequence}</Td><Td className="font-medium">{s.name}<p className="text-xs text-ink-soft">{s.code}</p></Td><Td>{humanize(s.kind)}</Td><Td>{s.sla_days ? `${s.sla_days} days` : '—'}</Td><Td>{s.responsible_capability ? responsibilityLabel(s.responsible_capability) : '—'}</Td>
            <Td>{s.reviews?.length ? <ul className="space-y-0.5 text-[13px]">{s.reviews.map((r) => <li key={r.code}>{r.name} <span className="text-xs text-ink-soft">· {responsibilityLabel(r.required_capability)}</span></li>)}</ul> : '—'}</Td></tr>)}</tbody>
        </DataTable>
      </Card>
      <Card>
        <CardHeader title="Transitions" description="Allowed source → destination, who may act, prerequisites and whether a reason is mandatory." />
        <DataTable><thead><tr><Th>Transition</Th><Th>From → to</Th><Th>Actor</Th><Th>Prerequisites</Th><Th>Reason</Th></tr></thead>
          <tbody>{transitions.map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">{t.name}{t.records_decision && <p className="text-xs text-ink-soft">Records the decision</p>}</Td>
              <Td className="text-[13px]">{t.from_stage} → {t.to_stage}</Td>
              <Td className="text-[13px]">{t.is_automatic ? <Badge tone="accent">Automatic</Badge> : `${humanize(t.allowed_role)}${t.required_capability ? ` · ${responsibilityLabel(t.required_capability)}` : ''}`}</Td>
              <Td><div className="flex flex-wrap gap-1">{t.prerequisites.length ? t.prerequisites.map((p) => <Badge key={p} tone="neutral">{p}</Badge>) : '—'}</div></Td>
              <Td>{t.requires_reason ? 'Required' : 'Optional'}</Td>
            </tr>
          ))}</tbody>
        </DataTable>
      </Card>
    </>
  );
}

function PublishDialog({ definitionId, stages, transitions, onClose }: { definitionId: string; stages: WorkflowStage[]; transitions: WorkflowTransition[]; onClose: () => void }) {
  // configured concurrent reviews travel with their stage so a new version keeps them
  const [st, setSt] = useState(stages.map(({ code, name, kind, sequence, sla_days, responsible_capability, description, reviews }) => ({ code, name, kind, sequence, sla_days, responsible_capability, description, reviews: reviews ?? [] })));
  const [tr, setTr] = useState(transitions.map(({ code, name, from_stage, to_stage, allowed_role, required_capability, requires_reason, is_automatic, prerequisites, records_decision, sort_order }) =>
    ({ code, name, from_stage, to_stage, allowed_role, required_capability, requires_reason, is_automatic, prerequisites, records_decision, sort_order })));
  const [source, setSource] = useState('');
  const [summary, setSummary] = useState('');
  const act = useAction(() => publishWorkflowVersion(definitionId, st, tr, source, summary), { success: (v) => `Version ${v.version} is now active. Existing cases keep their version.`, invalidate: [['workflow-defs'], ['route']], onSuccess: onClose });
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Publish a new route version" description="Edit stage targets, responsibilities and reason requirements. Structural changes are validated on the server."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={source.trim().length < 5 || summary.trim().length < 10} onClick={() => act.mutate(undefined)}>Publish version</Button></>}>
      <div className="space-y-5">
        <div>
          <p className="mb-2 text-[13px] font-semibold">Stages</p>
          <div className="space-y-2">
            {st.map((s, i) => (
              <div key={s.code} className="grid grid-cols-[1fr_110px_150px] items-center gap-2">
                <Input aria-label={`${s.code} name`} value={s.name} onChange={(e) => setSt(st.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <Input aria-label={`${s.code} target days`} type="number" min={1} placeholder="days" value={s.sla_days ?? ''} disabled={s.kind === 'intake' || s.kind === 'terminal'}
                  onChange={(e) => setSt(st.map((x, j) => j === i ? { ...x, sla_days: e.target.value ? Number(e.target.value) : null } : x))} />
                <Select aria-label={`${s.code} responsibility`} value={s.responsible_capability ?? ''} disabled={s.kind === 'intake' || s.kind === 'terminal'}
                  onChange={(e) => setSt(st.map((x, j) => j === i ? { ...x, responsible_capability: e.target.value || null } : x))}>
                  <option value="">None</option>{['scrutiny', 'evc', 'committee', 'decision'].map((c) => <option key={c} value={c}>{responsibilityLabel(c)}</option>)}
                </Select>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold">Transitions</p>
          <ul className="space-y-1.5">
            {tr.map((t, i) => (
              <li key={t.code} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-[13px]">
                <span>{t.name} <span className="text-xs text-ink-soft">({t.from_stage} → {t.to_stage}{t.is_automatic ? ', automatic' : ''})</span></span>
                {!t.is_automatic && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" className="accent-[#1e3a8a]" checked={t.requires_reason} disabled={t.records_decision}
                  onChange={(e) => setTr(tr.map((x, j) => j === i ? { ...x, requires_reason: e.target.checked } : x))} />Reason required</label>}
              </li>
            ))}
          </ul>
        </div>
        <TextField label="Source reference" required value={source} onChange={(e) => setSource(e.target.value)} hint="The authorised circular, handbook section or decision this change implements." />
        <TextAreaField label="Change summary" required rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
    </Dialog>
  );
}
