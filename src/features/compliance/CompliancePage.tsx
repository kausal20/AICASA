import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardPlus, FileUp, ShieldCheck, Lock } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { closeObligation, createObligation, getObligationHistory, listObligations, submitEvidence, verifyCompliance, listValidities } from '@/services/operations';
import { listInstitutions } from '@/services/admin';
import { getDirectory } from '@/services/applications';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { DueBadge, StatusBadge } from '@/components/ui/Badge';
import { DataTable, KeyValue, PageHeader, Stat, Td, Th } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { DocumentUploader } from '@/features/documents/DocumentUploader';
import { useAction } from '@/hooks/useAction';
import { fmtDate, fmtDateTime, humanize, todayLocal } from '@/lib/format';
import type { DocumentVersion, ObligationRow } from '@/types/domain';

const FILTERS = ['', 'overdue', 'due_soon', 'awaiting_submission', 'upcoming', 'submitted', 'under_verification', 'correction_required', 'verified', 'closed'];

export function CompliancePage() {
  const { workspace, institution, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const filter = FILTERS.includes(sp.get('status') ?? '') ? sp.get('status')! : '';
  const setFilter = (f: string) => { const p = new URLSearchParams(sp); if (f) p.set('status', f); else p.delete('status'); setSp(p, { replace: true }); };
  const [open, setOpen] = useState<ObligationRow | null>(null);
  const [create, setCreate] = useState(false);
  const q = useQuery({ queryKey: ['obligations', workspace === 'institution' ? institution?.id : 'scope'], queryFn: () => listObligations({ institutionId: workspace === 'institution' ? institution?.id : undefined }) });
  const all = q.data ?? [];
  const rows = filter ? all.filter((r) => r.effective_status === filter) : all;
  const n = (s: string) => all.filter((r) => r.effective_status === s).length;

  return (
    <div>
      <PageHeader title={workspace === 'institution' ? 'Compliance obligations' : workspace === 'officer' ? 'Compliance verification' : 'Compliance overview'}
        description="Undertakings, conditions, periodic returns and document renewals, tracked after approval as well as during processing. Submitting evidence never verifies it; an authorised officer does."
        actions={workspace !== 'institution' && can('compliance') && <Button icon={<ClipboardPlus className="h-4 w-4" />} onClick={() => setCreate(true)}>New obligation</Button>} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Overdue" value={q.isLoading ? '…' : n('overdue')} tone={n('overdue') ? 'danger' : 'neutral'} />
        <Stat label="Due within 30 days" value={q.isLoading ? '…' : n('due_soon')} tone={n('due_soon') ? 'warning' : 'neutral'} />
        <Stat label="Awaiting verification" value={q.isLoading ? '…' : n('submitted') + n('under_verification')} />
        <Stat label="Verified" value={q.isLoading ? '…' : n('verified')} tone="primary" />
      </div>
      <Card>
        <div className="flex flex-wrap gap-1.5 border-b border-line p-3" role="toolbar" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f || 'all'} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`rounded-full px-3 py-1 text-[13px] font-medium transition-colors ${filter === f ? 'bg-primary text-white' : 'bg-surface-muted text-ink-soft hover:text-ink'}`}>
              {f ? humanize(f) : 'All'}{f && ` (${n(f)})`}
            </button>
          ))}
        </div>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? (
          <EmptyState title="No obligations here" body={filter ? 'Choose another filter.' : 'Obligations appear when an authorised officer records an undertaking, condition or renewal requirement.'} />
        ) : (
          <DataTable>
            <thead><tr><Th>Obligation</Th>{workspace !== 'institution' && <Th>Institution</Th>}<Th>Status</Th><Th>Due</Th><Th>Source</Th><Th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-muted/60">
                  <Td><button className="text-left font-medium text-accent hover:underline" onClick={() => setOpen(r)}>{r.title}</button>
                    <p className="text-xs text-ink-soft">{humanize(r.obligation_type)}{r.recurrence ? ` · recurs ${r.recurrence.replace('P1Y', 'yearly').replace('P6M', 'half-yearly').replace('P3M', 'quarterly').replace('P1M', 'monthly')}` : ''}{r.application_reference ? ` · ${r.application_reference}` : ''}</p></Td>
                  {workspace !== 'institution' && <Td className="text-[13px]">{r.institution_name}<p className="text-xs text-ink-soft">{r.region_code}</p></Td>}
                  <Td><StatusBadge status={r.effective_status} /></Td>
                  <Td><DueBadge due={r.due_at} done={['verified', 'closed'].includes(r.status)} /></Td>
                  <Td className="max-w-[220px] text-xs text-ink-soft">{r.source_reference}</Td>
                  <Td className="text-right"><Button size="sm" variant="secondary" onClick={() => setOpen(r)}>Open</Button></Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
      {open && <ObligationDialog o={open} onClose={() => setOpen(null)} />}
      {create && <CreateObligationDialog onClose={() => setCreate(false)} />}
    </div>
  );
}

function ObligationDialog({ o, onClose }: { o: ObligationRow; onClose: () => void }) {
  const { workspace, can, institution } = useAuth();
  const hist = useQuery({ queryKey: ['obligation', o.id, 'history'], queryFn: () => getObligationHistory(o.id) });
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });
  const validity = useQuery({ queryKey: ['validity', o.validity_id], queryFn: () => listValidities({ institutionId: o.institution_id }), enabled: !!o.validity_id });
  const name = (id: string) => dir.data?.find((p) => p.id === id)?.full_name ?? 'User';
  const [mode, setMode] = useState<'view' | 'submit' | 'verify' | 'close'>('view');
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const [comment, setComment] = useState('');
  const [expiry, setExpiry] = useState('');
  const [outcome, setOutcome] = useState<'verified' | 'correction_required' | 'more_information'>('verified');
  const [reason, setReason] = useState('');
  const inv = [['obligations'], ['obligation', o.id], ['validities'], ['tasks']];
  const submit = useAction(() => submitEvidence(o.id, version!.id, comment, o.validity_id ? expiry : null, o.row_version), { success: 'Evidence submitted. It now awaits verification by an officer.', invalidate: inv, onSuccess: onClose });
  const verify = useAction(() => verifyCompliance(o.id, outcome, reason, o.row_version), { success: 'Verification recorded.', invalidate: inv, onSuccess: onClose });
  const close = useAction(() => closeObligation(o.id, reason), { success: 'Obligation closed.', invalidate: inv, onSuccess: onClose });
  const isRep = workspace === 'institution' && institution?.member_role === 'representative';
  const current = validity.data?.find((v) => v.id === o.validity_id);

  return (
    <Dialog open size="lg" onOpenChange={(x) => !x && onClose()} title={o.title} description={`${o.institution_name} · ${humanize(o.obligation_type)}`}
      footer={
        mode === 'submit' ? <><Button variant="secondary" onClick={() => setMode('view')}>Back</Button><Button loading={submit.isPending} disabled={!version || (!!o.validity_id && !expiry)} onClick={() => submit.mutate(undefined)}>Submit for verification</Button></> :
        mode === 'verify' ? <><Button variant="secondary" onClick={() => setMode('view')}>Back</Button><Button loading={verify.isPending} disabled={reason.trim().length < 10} onClick={() => verify.mutate(undefined)}>Record verification</Button></> :
        mode === 'close' ? <><Button variant="secondary" onClick={() => setMode('view')}>Back</Button><Button variant="danger" loading={close.isPending} disabled={reason.trim().length < 10} onClick={() => close.mutate(undefined)}>Close obligation</Button></> :
        <>
          {isRep && ['awaiting_submission', 'correction_required'].includes(o.status) && <Button icon={<FileUp className="h-4 w-4" />} onClick={() => setMode('submit')}>Submit evidence</Button>}
          {workspace === 'officer' && can('compliance') && ['submitted', 'under_verification'].includes(o.status) && <Button icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setMode('verify')}>Verify evidence</Button>}
          {workspace === 'admin' && can('compliance') && o.status !== 'closed' && <Button variant="secondary" icon={<Lock className="h-4 w-4" />} onClick={() => setMode('close')}>Close</Button>}
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </>
      }>
      {mode === 'view' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={o.effective_status} /><DueBadge due={o.due_at} done={['verified', 'closed'].includes(o.status)} /></div>
          <KeyValue items={[
            { label: 'Conditions', value: o.description }, { label: 'Evidence required', value: o.evidence_required },
            { label: 'Source / reference', value: o.source_reference }, { label: 'Responsible contact', value: o.responsible_contact ?? '—' },
            { label: 'Effective from', value: fmtDate(o.effective_date) }, { label: 'Linked application', value: o.application_id ? <Link className="text-accent hover:underline" to={`/app/applications/${o.application_id}`}>{o.application_reference}</Link> : '—' },
          ]} />
          {current && <Notice tone="info">Renewal of “{current.title}”, currently recorded as valid until {fmtDate(current.expiry_date)}. Submit the renewed document and its new expiry date.</Notice>}
          <div>
            <p className="mb-2 text-[13px] font-semibold">Submission and verification history</p>
            {hist.isLoading ? <LoadingRows rows={2} /> : !hist.data?.submissions.length ? <p className="text-[13px] text-ink-soft">No evidence submitted yet.</p> : (
              <ol className="space-y-2">
                {hist.data.submissions.map((s) => {
                  const v = hist.data!.verifications.find((x) => x.submission_id === s.id);
                  return (
                    <li key={s.id} className="rounded-lg bg-surface-muted px-4 py-3 text-[13px]">
                      <p className="font-medium">Attempt {s.attempt} · {fmtDateTime(s.submitted_at)} · {name(s.submitted_by)}</p>
                      {s.comment && <p className="mt-0.5 text-ink-soft">{s.comment}</p>}
                      {s.renewal_expiry_date && <p className="mt-0.5 text-xs text-ink-soft">Stated new expiry: {fmtDate(s.renewal_expiry_date)}</p>}
                      {v ? <p className="mt-2 text-xs"><StatusBadge status={v.outcome === 'verified' ? 'verified' : 'correction_required'} label={humanize(v.outcome)} /><span className="ml-1 text-ink-soft"> {name(v.verified_by)}, {fmtDateTime(v.verified_at)}: {v.reason}</span></p>
                        : <p className="mt-2 text-xs text-ink-soft">Awaiting verification.</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}
      {mode === 'submit' && (
        <div className="space-y-4">
          <Notice tone="info">Required: {o.evidence_required}</Notice>
          <DocumentUploader institutionId={o.institution_id} applicationId={null} docType={o.validity_id ? (current?.doc_type ?? 'evidence') : 'evidence'} title={`Evidence — ${o.title}`} onUploaded={setVersion} />
          {o.validity_id && <TextField label="Expiry date stated on the renewed document" type="date" required value={expiry} onChange={(e) => setExpiry(e.target.value)} hint="An officer checks this against the document during verification." />}
          <TextAreaField label="Comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      )}
      {mode === 'verify' && (
        <div className="space-y-4">
          <SelectField label="Outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="verified">Verified</option><option value="correction_required">Rejected — correction required</option><option value="more_information">Needs more information</option>
          </SelectField>
          <TextAreaField label="Basis for this outcome" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded with your name and time." />
          {o.recurrence && outcome === 'verified' && <Notice tone="info">Verifying creates the next occurrence of this recurring obligation.</Notice>}
        </div>
      )}
      {mode === 'close' && <TextAreaField label="Reason for closing" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
    </Dialog>
  );
}

function CreateObligationDialog({ onClose }: { onClose: () => void }) {
  const insts = useQuery({ queryKey: ['institutions'], queryFn: listInstitutions });
  const [f, setF] = useState({ inst: '', type: 'undertaking', title: '', description: '', source: '', evidence: '', contact: '', due: '', recurrence: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const act = useAction(() => createObligation({ institutionId: f.inst, type: f.type, title: f.title, description: f.description, source: f.source, evidence: f.evidence, contact: f.contact, dueDate: f.due, recurrence: f.recurrence || null }),
    { success: 'Obligation created. The institution has been notified.', invalidate: [['obligations']], onSuccess: onClose });
  const valid = f.inst && f.title.trim().length >= 5 && f.description.trim().length >= 10 && f.source.trim().length >= 3 && f.evidence.trim().length >= 5 && f.due;
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="New compliance obligation"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!valid} onClick={() => act.mutate(undefined)}>Create</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Institution" required value={f.inst} onChange={set('inst')}>
          <option value="">Select…</option>{(insts.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.region_code})</option>)}
        </SelectField>
        <SelectField label="Type" required value={f.type} onChange={set('type')}>
          <option value="undertaking">Undertaking</option><option value="condition">Condition</option><option value="periodic_report">Periodic report</option><option value="document_renewal">Document renewal</option>
        </SelectField>
        <div className="sm:col-span-2"><TextField label="Title" required value={f.title} onChange={set('title')} /></div>
        <div className="sm:col-span-2"><TextAreaField label="Conditions / description" required value={f.description} onChange={set('description')} /></div>
        <TextField label="Source / rule reference" required value={f.source} onChange={set('source')} />
        <TextField label="Evidence required" required value={f.evidence} onChange={set('evidence')} />
        <TextField label="Responsible contact" value={f.contact} onChange={set('contact')} />
        <TextField label="Due date" type="date" required min={todayLocal()} value={f.due} onChange={set('due')} hint="End of day, IST." />
        <SelectField label="Recurrence" value={f.recurrence} onChange={set('recurrence')}>
          <option value="">None</option><option value="P1M">Monthly</option><option value="P3M">Quarterly</option><option value="P6M">Half-yearly</option><option value="P1Y">Yearly</option>
        </SelectField>
      </div>
    </Dialog>
  );
}
