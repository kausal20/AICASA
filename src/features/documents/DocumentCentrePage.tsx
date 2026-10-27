import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthProvider';
import { listDocuments } from '@/services/documents';
import { listApplications } from '@/services/applications';
import { DocumentsSection } from './DocumentsSection';
import { DocumentUploader } from './DocumentUploader';
import { PrecheckPanel } from './PrecheckPanel';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/Page';
import { EmptyState, ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { SelectField, TextField } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/Badge';
import { fmtDateTime } from '@/lib/format';

export function DocumentCentrePage() {
  const { institution } = useAuth();
  const docs = useQuery({ queryKey: ['documents', 'inst', institution?.id], queryFn: () => listDocuments({ institutionId: institution!.id }), enabled: !!institution });
  const apps = useQuery({ queryKey: ['applications', 'inst-all', institution?.id], queryFn: () => listApplications({ institutionId: institution!.id }, 0), enabled: !!institution });
  const [docType, setDocType] = useState('');
  const [title, setTitle] = useState('');
  if (!institution) return null;
  const byApp = new Map<string, typeof docs.data>();
  for (const d of docs.data ?? []) {
    const k = d.application_id ?? 'general';
    byApp.set(k, [...(byApp.get(k) ?? []), d]);
  }
  const appRef = (id: string) => apps.data?.rows.find((a) => a.id === id);
  const valid = /^[a-z][a-z0-9_]*$/.test(docType) && title.trim().length >= 3;

  return (
    <div>
      <PageHeader title="Document centre" description="Every document your institution has uploaded, grouped by application, with complete version history. Files are stored privately and opened through short-lived links." />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {docs.isLoading ? <Card><LoadingRows /></Card> : docs.error ? <Card><ErrorState error={docs.error} onRetry={() => docs.refetch()} /></Card> : !docs.data?.length ? (
            <Card><EmptyState title="No documents yet" body="Documents you upload to applications or as compliance evidence appear here." /></Card>
          ) : [...byApp.entries()].map(([k, list]) => {
            const a = k === 'general' ? null : appRef(k);
            return (
              <Card key={k}>
                <CardHeader
                  title={k === 'general' ? 'Institution records & compliance evidence' : a ? <Link className="text-accent hover:underline" to={`/app/applications/${k}`}>{a.reference} · {a.title}</Link> : 'Application'}
                  action={a && <StatusBadge status={a.status} />}
                  description={a ? `${list!.length} document${list!.length > 1 ? 's' : ''} · updated ${fmtDateTime(a.updated_at)}` : undefined} />
                <CardBody>
                  <DocumentsSection docs={list!} institutionId={institution.id} applicationId={k === 'general' ? null : k}
                    canUpload={k === 'general' || ['draft', 'returned_for_correction'].includes(a?.status ?? '')} canRunCheck />
                </CardBody>
              </Card>
            );
          })}
        </div>
        <Card className="h-fit">
          <CardHeader title="Upload an institution record" description="For evidence or records not tied to one application, e.g. a lease deed whose validity you want tracked." />
          <CardBody className="space-y-3">
            <SelectField label="Document type" required value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="">Select…</option>
              <option value="land_lease_deed">Land lease deed</option>
              <option value="fire_safety_certificate">Fire safety certificate</option>
              <option value="occupancy_certificate">Occupancy certificate</option>
              <option value="annual_return">Annual return</option>
              <option value="evidence">Other compliance evidence</option>
            </SelectField>
            <TextField label="Title" required value={title} onChange={(e) => setTitle(e.target.value)} />
            {valid ? <DocumentUploader institutionId={institution.id} applicationId={null} docType={docType} title={title} /> :
              <p className="text-xs text-ink-soft">Choose a type and title to upload.</p>}
            <Notice tone="info">To track a document's expiry and get renewal reminders, record its validity under Document validity after uploading.</Notice>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export function PrecheckPage() {
  const { institution } = useAuth();
  const docs = useQuery({ queryKey: ['documents', 'inst', institution?.id], queryFn: () => listDocuments({ institutionId: institution!.id }), enabled: !!institution });
  const [docId, setDocId] = useState('');
  const [sel, setSel] = useState('');
  const list = (docs.data ?? []).filter((d) => (d.document_versions ?? []).length > 0);
  const doc = list.find((d) => d.id === docId) ?? list[0];
  const versions = (doc?.document_versions ?? []).map((v) => ({ v, d: doc! }));
  const chosen = versions.find((x) => x.v.id === sel) ?? versions.find((x) => x.v.version === x.d.current_version) ?? versions[0];
  return (
    <div>
      <PageHeader title="Pre-submission document check"
        description="Run the configured checklist on an uploaded document before you submit. It checks file type and size, readability, required fields, dates and consistency with the application." />
      <Notice tone="info" title="Advisory only">
        Results help you spot obvious gaps. They do not verify authenticity, signatures or legal sufficiency, and passing does not guarantee acceptance. Official scrutiny is separate.
      </Notice>
      <Card className="mt-5">
        <CardHeader title="Document" />
        <CardBody className="space-y-5">
          {docs.isLoading ? <LoadingRows rows={2} /> : !list.length ? (
            <EmptyState title="No uploaded documents" body="Upload documents in an application draft or the document centre first." />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="Document" required value={doc?.id ?? ''} onChange={(e) => { setDocId(e.target.value); setSel(''); }}>
                  {list.map((d) => <option key={d.id} value={d.id}>{d.title} · {d.applications?.reference ?? 'Institution record'}</option>)}
                </SelectField>
                <SelectField label="Version" required value={chosen?.v.id ?? ''} onChange={(e) => setSel(e.target.value)}>
                  {versions.map(({ v, d }) => <option key={v.id} value={v.id}>Version {v.version} · {v.file_name}{v.version === d.current_version ? ' (current)' : ''}</option>)}
                </SelectField>
              </div>
              {chosen && <PrecheckPanel key={chosen.v.id} versionId={chosen.v.id} fileLabel={`${chosen.d.title} · v${chosen.v.version}`} />}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
