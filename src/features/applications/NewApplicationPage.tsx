import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Route, Save, Send } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import {
  createDraft, getActiveRouteForType, getApplication, getApplicationTypes, getRequirements, submitApplication, updateDraft,
} from '@/services/applications';
import { listDocuments } from '@/services/documents';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Field, Input, TextField } from '@/components/ui/Field';
import { Notice, LoadingRows, ErrorState } from '@/components/ui/States';
import { PageHeader } from '@/components/ui/Page';
import { Dialog } from '@/components/ui/Dialog';
import { StatusBadge } from '@/components/ui/Badge';
import { DocumentsSection } from '@/features/documents/DocumentsSection';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';
import type { Application, ApplicationType } from '@/types/domain';
import { toast } from 'sonner';

const STEPS = ['Application type', 'Details', 'Documents & pre-check', 'Review & submit'];

export function NewApplicationPage() {
  const { institution } = useAuth();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const draftId = params.get('draft');
  const [step, setStep] = useState(draftId ? 1 : 0);
  const [typeCode, setTypeCode] = useState<string>('');
  const [title, setTitle] = useState('');
  const [year, setYear] = useState('2027-28');
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitted, setSubmitted] = useState<Application | null>(null);

  const types = useQuery({ queryKey: ['types'], queryFn: getApplicationTypes });
  const draft = useQuery({ queryKey: ['application', draftId, 'raw'], queryFn: () => getApplication(draftId!), enabled: !!draftId });
  useEffect(() => {
    if (draft.data) {
      setTypeCode(draft.data.application_type_code); setTitle(draft.data.title); setYear(draft.data.academic_year);
      setForm(draft.data.form_data ?? {}); setDirty(false);
    }
  }, [draft.data]);

  const type = types.data?.find((t) => t.code === typeCode);
  const route = useQuery({ queryKey: ['route-for-type', type?.workflow_definition_id], queryFn: () => getActiveRouteForType(type!.workflow_definition_id), enabled: !!type });
  const checklistVersion = draft.data?.checklist_version ?? type?.checklist_version;
  const reqs = useQuery({ queryKey: ['requirements', typeCode, checklistVersion], queryFn: () => getRequirements(typeCode, checklistVersion!), enabled: !!typeCode && !!checklistVersion });
  const docs = useQuery({ queryKey: ['documents', 'app', draftId], queryFn: () => listDocuments({ applicationId: draftId! }), enabled: !!draftId });

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const missingDocs = useMemo(() => (reqs.data ?? []).filter((r) => r.is_required && !(docs.data ?? []).some((d) => d.doc_type === r.doc_type && d.current_version > 0)), [reqs.data, docs.data]);

  if (!institution) return <Notice tone="warning">Your account is not linked to an institution.</Notice>;
  if (draftId && draft.isLoading) return <Card><LoadingRows /></Card>;
  if (draftId && (draft.error || !draft.data)) return <Card><ErrorState error={draft.error ?? 'Draft not found or not accessible.'} /></Card>;
  if (draft.data && draft.data.status !== 'draft') {
    return <Notice tone="info" title="Already submitted">This application has been submitted. <Link className="font-medium underline" to={`/app/applications/${draft.data.id}`}>Open it</Link>.</Notice>;
  }

  const validate = () => {
    const e: Record<string, string> = {};
    if (title.trim().length < 5) e.title = 'Enter a title of at least 5 characters.';
    if (!/^\d{4}-\d{2}$/.test(year)) e.year = 'Use the format 2027-28.';
    for (const f of type?.form_schema ?? []) {
      const v = form[f.key];
      if (f.required && (v === undefined || v === null || String(v).trim() === '')) e[f.key] = `${f.label} is required.`;
      if (f.type === 'number' && v !== undefined && v !== '' && (Number.isNaN(Number(v)) || Number(v) < 0)) e[f.key] = 'Enter a positive number.';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async (): Promise<string | null> => {
    if (!validate()) { toast.error('Fix the highlighted fields.'); return null; }
    setSaving(true);
    try {
      const data = Object.fromEntries((type?.form_schema ?? []).map((f) => [f.key, f.type === 'number' && form[f.key] !== '' && form[f.key] !== undefined ? Number(form[f.key]) : form[f.key] ?? (f.type === 'boolean' ? false : '')]));
      let app: Application;
      if (draftId && draft.data) app = await updateDraft({ id: draftId, version: draft.data.row_version, title, academicYear: year, formData: data });
      else {
        app = await createDraft({ institutionId: institution.id, typeCode, title, academicYear: year, formData: data });
        setParams({ draft: app.id }, { replace: true });
      }
      qc.setQueryData(['application', app.id, 'raw'], app);
      qc.invalidateQueries({ queryKey: ['applications'] });
      setDirty(false);
      toast.success(`Draft saved · ${app.reference}`);
      return app.id;
    } catch (e) { toast.error(errorMessage(e)); return null; } finally { setSaving(false); }
  };

  const doSubmit = async () => {
    if (!draft.data) return;
    setSaving(true);
    try {
      const r = await submitApplication(draft.data.id, draft.data.row_version);
      setSubmitted(r);
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['application'] });
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  if (submitted) {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="mx-auto max-w-xl">
          <CardBody className="py-10 text-center">
            <motion.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.25 }}
              className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success"><CheckCircle2 className="h-6 w-6" /></motion.div>
            <h1 className="text-xl font-semibold">Application submitted</h1>
            <p className="mt-2 text-sm text-ink-soft">Reference <span className="font-semibold text-ink">{submitted.reference}</span></p>
            <div className="mt-3 flex justify-center"><StatusBadge status={submitted.status} /></div>
            <p className="mt-3 text-[13px] text-ink-soft">Current stage: {submitted.current_stage}. {submitted.next_action}</p>
            <p className="mt-1 text-xs text-ink-soft">Submission does not replace official scrutiny; officers review every document independently.</p>
            <div className="mt-6 flex justify-center gap-2">
              <ButtonLink to={`/app/applications/${submitted.id}`}>Open application</ButtonLink>
              <ButtonLink to="/app" variant="secondary">Dashboard</ButtonLink>
            </div>
          </CardBody>
        </Card>
      </motion.div>
    );
  }

  return (
    <div>
      <PageHeader title={draftId ? `Draft ${draft.data?.reference ?? ''}` : 'New application'} description={`For ${institution.name}`}
        meta={dirty ? <span className="text-xs font-medium text-warning">Unsaved changes</span> : draftId ? <span className="text-xs text-ink-soft">All changes saved</span> : null} />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button disabled={i > 0 && !draftId && i !== step} onClick={() => (draftId || i === 0) && setStep(i)}
              className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors',
                i === step ? 'border-primary bg-primary-soft text-primary-ink' : i < step ? 'border-line bg-surface text-ink' : 'border-line bg-surface text-ink-faint')}
              aria-current={i === step ? 'step' : undefined}>
              <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[11px]', i < step ? 'bg-primary text-white' : 'bg-surface-muted')}>{i < step ? <Check className="h-3 w-3" /> : i + 1}</span>{s}
            </button>
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.18 }}>
          {step === 0 && (
            <Card>
              <CardHeader title="Choose the application type" description="The processing route is fixed by the configured rules for each type. It cannot be chosen." />
              <CardBody>
                {types.isLoading ? <LoadingRows /> : (
                  <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="Application type">
                    {(types.data ?? []).map((t) => <TypeOption key={t.code} t={t} selected={typeCode === t.code} disabled={!!draftId} onSelect={() => { setTypeCode(t.code); setForm({}); setDirty(true); }} />)}
                  </div>
                )}
                {type && route.data && <RoutePreview stages={route.data.stages.map((s) => s.name)} version={route.data.version} conditional={route.data.transitions.some((t) => t.prerequisites.some((p) => p.startsWith('form_flag:')))} />}
              </CardBody>
              <div className="flex justify-end border-t border-line px-5 py-3"><Button disabled={!typeCode} onClick={() => setStep(1)} icon={<ArrowRight className="h-4 w-4" />}>Continue</Button></div>
            </Card>
          )}

          {step === 1 && type && (
            <Card>
              <CardHeader title="Application details" description={type.name} />
              <CardBody className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2"><TextField label="Title" required value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} error={errors.title} /></div>
                <TextField label="Academic year" required value={year} onChange={(e) => { setYear(e.target.value); setDirty(true); }} error={errors.year} placeholder="2027-28" />
                <Field label="Institution" required><Input value={`${institution.name} (${institution.code})`} disabled /></Field>
                {type.form_schema.map((f) => (
                  f.type === 'boolean' ? (
                    <label key={f.key} className="flex items-start gap-3 rounded-lg border border-line p-3 md:col-span-2">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#176B5B]" checked={!!form[f.key]} onChange={(e) => { setForm({ ...form, [f.key]: e.target.checked }); setDirty(true); }} />
                      <span><span className="block text-[13px] font-medium">{f.label}</span>{f.help && <span className="block text-xs text-ink-soft">{f.help}</span>}</span>
                    </label>
                  ) : (
                    <TextField key={f.key} label={f.label} required={f.required} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                      value={String(form[f.key] ?? '')} hint={f.help} error={errors[f.key]} onChange={(e) => { setForm({ ...form, [f.key]: e.target.value }); setDirty(true); }} />
                  )
                ))}
              </CardBody>
              <div className="flex justify-between border-t border-line px-5 py-3">
                <Button variant="ghost" disabled={!!draftId} onClick={() => setStep(0)} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <div className="flex gap-2">
                  <Button variant="secondary" loading={saving} onClick={save} icon={<Save className="h-4 w-4" />}>Save draft</Button>
                  <Button loading={saving} onClick={async () => { const id = await save(); if (id) setStep(2); }} icon={<ArrowRight className="h-4 w-4" />}>Save and continue</Button>
                </div>
              </div>
            </Card>
          )}

          {step === 2 && draftId && (
            <Card>
              <CardHeader title="Documents and pre-submission check" description={`Checklist version ${checklistVersion}. Upload each document, then run the pre-check to catch obvious issues before submission.`} />
              <CardBody>
                <Notice tone="info">The pre-check is advisory. It looks for completeness and obvious inconsistencies; it does not verify authenticity or guarantee acceptance.</Notice>
                <div className="mt-2">
                  {docs.isLoading || reqs.isLoading ? <LoadingRows /> : (
                    <DocumentsSection docs={docs.data ?? []} requirements={reqs.data} institutionId={institution.id} applicationId={draftId} canUpload canRunCheck />
                  )}
                </div>
              </CardBody>
              <div className="flex justify-between border-t border-line px-5 py-3">
                <Button variant="ghost" onClick={() => setStep(1)} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <Button onClick={() => setStep(3)} icon={<ArrowRight className="h-4 w-4" />}>Review</Button>
              </div>
            </Card>
          )}

          {step === 3 && draft.data && type && (
            <Card>
              <CardHeader title="Review and submit" />
              <CardBody className="space-y-4">
                <dl className="grid gap-3 text-[13.5px] sm:grid-cols-2">
                  <div><dt className="text-xs text-ink-soft">Reference</dt><dd>{draft.data.reference}</dd></div>
                  <div><dt className="text-xs text-ink-soft">Type</dt><dd>{type.name}</dd></div>
                  <div><dt className="text-xs text-ink-soft">Title</dt><dd>{draft.data.title}</dd></div>
                  <div><dt className="text-xs text-ink-soft">Academic year</dt><dd>{draft.data.academic_year}</dd></div>
                  {type.form_schema.map((f) => <div key={f.key}><dt className="text-xs text-ink-soft">{f.label}</dt><dd>{f.type === 'boolean' ? (draft.data!.form_data[f.key] ? 'Yes' : 'No') : String(draft.data!.form_data[f.key] ?? '—')}</dd></div>)}
                </dl>
                {missingDocs.length > 0 ? (
                  <Notice tone="warning" title="Required documents missing">{missingDocs.map((d) => d.name).join(', ')}. The server will reject submission until they are uploaded.</Notice>
                ) : <Notice tone="success">All required documents are uploaded.</Notice>}
                {dirty && <Notice tone="warning">You have unsaved changes on the details step. Save them before submitting.</Notice>}
              </CardBody>
              <div className="flex justify-between border-t border-line px-5 py-3">
                <Button variant="ghost" onClick={() => setStep(2)} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
                <Button disabled={missingDocs.length > 0 || dirty} onClick={() => setConfirm(true)} icon={<Send className="h-4 w-4" />}>Submit application</Button>
              </div>
            </Card>
          )}
        </motion.div>
      </AnimatePresence>

      <Dialog open={confirm} onOpenChange={setConfirm} title="Submit this application?" description="After submission the application can no longer be edited. Corrections are made only if an officer requests them."
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button><Button loading={saving} onClick={doSubmit}>Confirm submission</Button></>}>
        <p className="text-[13px] text-ink-soft">The server checks required fields and documents again, records the submission, routes the case under the configured route and notifies you.</p>
      </Dialog>
    </div>
  );
}

function TypeOption({ t, selected, onSelect, disabled }: { t: ApplicationType; selected: boolean; onSelect: () => void; disabled: boolean }) {
  return (
    <motion.button type="button" role="radio" aria-checked={selected} disabled={disabled && !selected} onClick={onSelect} whileHover={disabled ? undefined : { y: -1 }}
      className={cn('rounded-card border p-4 text-left transition-[border-color,box-shadow] duration-150',
        selected ? 'border-primary bg-primary-soft/40 shadow-lift' : 'border-line bg-surface hover:border-line-strong hover:shadow-lift', disabled && !selected && 'opacity-50')}>
      <span className="flex items-start justify-between gap-3">
        <span className="text-[14px] font-semibold text-ink">{t.name}</span>
        <span className={cn('mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border', selected ? 'border-primary bg-primary' : 'border-line-strong')}>{selected && <Check className="h-3 w-3 text-white" />}</span>
      </span>
      <span className="mt-1 block text-[13px] text-ink-soft">{t.description}</span>
    </motion.button>
  );
}

function RoutePreview({ stages, version, conditional }: { stages: string[]; version: number; conditional: boolean }) {
  return (
    <div className="mt-5 rounded-lg bg-surface-muted px-4 py-3">
      <p className="flex items-center gap-1.5 text-[13px] font-medium"><Route className="h-4 w-4 text-primary" aria-hidden />Configured route (version {version})</p>
      <p className="mt-1 text-[13px] text-ink-soft">{stages.join(' → ')}</p>
      {conditional && <p className="mt-1 text-xs text-ink-soft">Some stages apply only when a route condition you declare in the form is met (for example, an intake increase triggers an expert visit).</p>}
    </div>
  );
}
