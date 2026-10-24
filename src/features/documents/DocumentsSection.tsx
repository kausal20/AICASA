import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, FileText, History } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { listCheckRuns, openDocument } from '@/services/documents';
import type { DocumentRecord, DocumentRequirement } from '@/types/domain';
import { Button } from '@/components/ui/Button';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/States';
import { DocumentUploader } from './DocumentUploader';
import { FindingsList, PrecheckPanel } from './PrecheckPanel';
import { fmtBytes, fmtDateTime, humanize } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { toast } from 'sonner';

/** Checklist-aware document list with versions, pre-check results and (when allowed) replacement upload. */
export function DocumentsSection({ docs, requirements, institutionId, applicationId, canUpload, canRunCheck }: {
  docs: DocumentRecord[]; requirements?: DocumentRequirement[]; institutionId: string; applicationId: string | null;
  canUpload: boolean; canRunCheck: boolean;
}) {
  const currentIds = docs.map((d) => d.document_versions?.find((v) => v.version === d.current_version)?.id).filter(Boolean) as string[];
  const runs = useQuery({ queryKey: ['checkruns', 'many', currentIds.join(',')], queryFn: () => listCheckRuns(currentIds), enabled: currentIds.length > 0 });

  const reqs = requirements ?? [];
  const extra = docs.filter((d) => !reqs.some((r) => r.doc_type === d.doc_type));
  const items = [
    ...reqs.map((r) => ({ key: r.doc_type, req: r as DocumentRequirement | undefined, doc: docs.find((d) => d.doc_type === r.doc_type) })),
    ...extra.map((d) => ({ key: d.id, req: undefined, doc: d as DocumentRecord | undefined })),
  ];
  if (!items.length) return <EmptyState title="No documents yet" body="Documents uploaded for this record appear here with their full version history." />;

  return (
    <ul className="divide-y divide-line">
      {items.map(({ key, req, doc }) => (
        <DocRow key={key} req={req} doc={doc} institutionId={institutionId} applicationId={applicationId} canUpload={canUpload}
          canRunCheck={canRunCheck} latestRun={runs.data?.find((r) => r.document_version_id === doc?.document_versions?.find((v) => v.version === doc.current_version)?.id)} />
      ))}
    </ul>
  );
}

function DocRow({ req, doc, institutionId, applicationId, canUpload, canRunCheck, latestRun }: {
  req?: DocumentRequirement; doc?: DocumentRecord; institutionId: string; applicationId: string | null; canUpload: boolean; canRunCheck: boolean;
  latestRun?: import('@/types/domain').CheckRun;
}) {
  const [open, setOpen] = useState(false);
  const current = doc?.document_versions?.find((v) => v.version === doc.current_version);
  const issues = latestRun ? Object.entries(latestRun.summary).filter(([k]) => k !== 'passed').reduce((a, [, n]) => a + n, 0) : 0;
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-ink">{req?.name ?? doc?.title}
              {req && (req.is_required ? <Badge tone="neutral" className="ml-2">Required</Badge> : <Badge tone="neutral" className="ml-2">Optional</Badge>)}
              {req?.expiry_tracked && <Badge tone="accent" className="ml-1">Validity tracked</Badge>}
            </p>
            {current ? (
              <p className="mt-0.5 text-xs text-ink-soft">v{current.version} · {current.file_name} · {fmtBytes(current.size_bytes)} · uploaded {fmtDateTime(current.uploaded_at)}</p>
            ) : <p className="mt-0.5 text-xs text-warning">{req?.is_required ? 'Not uploaded — required before submission' : 'Not uploaded'}</p>}
            {req?.description && <p className="mt-0.5 text-xs text-ink-faint">{req.description}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latestRun?.status === 'completed' && (issues ? <StatusBadge status="potential_issue" label={`Pre-check: ${issues} to review`} /> : <StatusBadge status="passed" label="Pre-check passed" />)}
          {current && <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={() => openDocument(current.storage_path).catch((e) => toast.error(errorMessage(e)))}>Open</Button>}
          {(doc || canUpload) && (
            <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}
              icon={<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />}>
              {doc ? 'Details' : 'Upload'}
            </Button>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="mt-4 space-y-5 pl-8">
              {canUpload && (
                <div>
                  <p className="mb-1.5 text-[13px] font-medium">{doc ? 'Upload a replacement' : 'Upload document'}</p>
                  <DocumentUploader institutionId={institutionId} applicationId={applicationId} docType={req?.doc_type ?? doc!.doc_type}
                    title={req?.name ?? doc?.title} allowed={req?.allowed_mime_types} maxBytes={req?.max_bytes} requireReason={!!doc && doc.current_version > 0} />
                </div>
              )}
              {current && (canRunCheck ? <PrecheckPanel versionId={current.id} fileLabel={`Version ${current.version}`} />
                : latestRun?.status === 'completed' ? <div><p className="mb-2 text-[13px] font-medium">Institution's latest pre-check (advisory only)</p><FindingsList run={latestRun} /></div> : null)}
              {(doc?.document_versions?.length ?? 0) > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium"><History className="h-3.5 w-3.5" aria-hidden />Version history</p>
                  <ol className="space-y-1.5 text-xs text-ink-soft">
                    {doc!.document_versions!.map((v) => (
                      <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-medium text-ink">v{v.version}</span><span>{v.file_name}</span><span>{fmtDateTime(v.uploaded_at)}</span>
                        {v.replaced_reason && <span>Reason: {v.replaced_reason}</span>}
                        <span>Scan: {humanize(v.scan_status)}</span>
                        <button className="font-medium text-accent hover:underline" onClick={() => openDocument(v.storage_path).catch((e) => toast.error(errorMessage(e)))}>Open</button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}
