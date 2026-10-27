import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, FileUp, Send } from 'lucide-react';
import type { Deficiency, DocumentVersion } from '@/types/domain';
import { Button } from '@/components/ui/Button';
import { SelectField, TextAreaField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';
import { DocumentUploader } from '@/features/documents/DocumentUploader';
import { useAction } from '@/hooks/useAction';
import { submitCorrection } from '@/services/operations';
import { getRequirements } from '@/services/applications';
import { fmtDateTime, humanize, plainText } from '@/lib/format';
import { useQueryWindow } from './QueryWindow';

/** Query number shown to the institution, derived from the deficiency id so it is stable across sessions. */
export function memoNumber(id: string): string {
  return `RO-${1000 + (parseInt(id.replace(/-/g, '').slice(0, 4), 16) % 9000)}`;
}

const SUPPORTING = 'supporting_evidence';

/**
 * Query & Clarification, institution side: the officer's query, then the answer — a reply, a corrected document (saved as a
 * new version, visible in the Document Centre and in Version Compare), and "Submit for re-review". The server re-checks
 * everything, including the response window, which disables the controls once it has closed.
 */
export function CorrectionCycle({ d, institutionId }: { d: Deficiency; institutionId: string }) {
  const memo = memoNumber(d.id);
  const win = useQueryWindow(d);
  const expired = win?.closed ?? false;
  const reqs = useQuery({
    queryKey: ['requirements', d.applications?.application_type_code, d.applications?.checklist_version],
    queryFn: () => getRequirements(d.applications!.application_type_code!, d.applications!.checklist_version!),
    enabled: !d.doc_type && !!d.applications?.application_type_code && d.applications?.checklist_version != null,
  });
  const [text, setText] = useState('');
  const [docType, setDocType] = useState(d.doc_type ?? '');
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const act = useAction(() => submitCorrection(d.id, text, version?.id ?? null), {
    success: 'Submitted for re-review. The officer has been notified.', invalidate: [['deficiencies'], ['application'], ['applications'], ['matrix'], ['documents'], ['navcounts'], ['notifications']],
    onSuccess: () => { setText(''); setVersion(null); },
  });
  const reply = text.trim();
  const replyOk = reply.length >= 10;
  const ready = d.doc_type ? !!version && (reply.length === 0 || replyOk) : (replyOk || (!!version && reply.length === 0));

  return (
    <div className="grid border-t border-line md:grid-cols-2 md:divide-x md:divide-line">
      <section aria-label={`Query #${memo}`} className="min-w-0 bg-danger-soft/40 px-5 py-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-danger">
          <AlertOctagon className="h-3.5 w-3.5" aria-hidden />Query #{memo}
        </p>
        <div className="mt-2 rounded-lg border border-[#f3c9c4] bg-surface px-4 py-3">
          <p className="text-[13.5px] font-semibold text-danger">{plainText(d.reason)}</p>
          <dl className="mt-3 space-y-2 text-[13px]">
            <div><dt className="text-xs text-ink-soft">Clarification or correction requested</dt><dd className="font-medium">{d.requested_correction}</dd></div>
            <div><dt className="text-xs text-ink-soft">Sent to you</dt><dd>{fmtDateTime(d.sent_at ?? d.raised_at)} · stage {humanize(d.stage_code)}</dd></div>
          </dl>
        </div>
      </section>

      <section aria-label={`Answer to Query #${memo}`} className="min-w-0 px-5 py-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <FileUp className="h-3.5 w-3.5" aria-hidden />Your answer
        </p>
        {expired ? (
          <div className="mt-2">
            <Notice tone="danger" title="Window expired">
              The response window for this query has closed, so uploads and replies are disabled. Contact the officer: they can reopen the window once.
            </Notice>
          </div>
        ) : (
          <div className="mt-2 space-y-3">
            <TextAreaField label="Reply" rows={3} value={text} onChange={(e) => setText(e.target.value)}
              hint={d.doc_type ? 'Optional with the corrected document; at least 10 characters if you write one.' : 'Explain the correction (at least 10 characters), or upload a corrected document below.'} />
            <div className="rounded-lg border border-line px-3 py-3">
              <p className="mb-2 text-[13px] font-medium">Upload corrected document</p>
              {!d.doc_type && (
                <SelectField label="Document" value={docType} onChange={(e) => { setDocType(e.target.value); setVersion(null); }}>
                  <option value="">Choose the document you are correcting…</option>
                  {(reqs.data ?? []).map((r) => <option key={r.doc_type} value={r.doc_type}>{r.name}</option>)}
                  <option value={SUPPORTING}>Other supporting evidence</option>
                </SelectField>
              )}
              {docType ? (
                <div className={d.doc_type ? '' : 'mt-3'}>
                  <DocumentUploader key={docType} institutionId={institutionId} applicationId={d.application_id} docType={docType}
                    title={docType === SUPPORTING ? 'Supporting evidence' : undefined} requireReason onUploaded={setVersion} compact />
                  <p className="mt-2 text-xs text-ink-soft">
                    {version ? `Version ${version.version} uploaded and attached to this answer.` : d.doc_type ? 'This query needs a new version of this document.' : 'Optional.'}
                    {' '}Earlier versions stay on file; the officer compares them.
                  </p>
                </div>
              ) : <p className="mt-2 text-xs text-ink-soft">Optional for this query.</p>}
            </div>
            <div className="flex items-center justify-end gap-3">
              {!ready && <p className="text-xs text-ink-soft">{d.doc_type ? 'Upload the corrected document to submit.' : 'Write a reply or upload a document to submit.'}</p>}
              <Button size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={act.isPending} disabled={!ready} onClick={() => act.mutate(undefined)}>Submit for re-review</Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
