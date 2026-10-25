import { useState } from 'react';
import { AlertOctagon, FileUp, Timer } from 'lucide-react';
import type { Deficiency, DocumentVersion } from '@/types/domain';
import { Button } from '@/components/ui/Button';
import { TextAreaField } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';
import { DocumentUploader } from '@/features/documents/DocumentUploader';
import { useAction } from '@/hooks/useAction';
import { submitCorrection } from '@/services/operations';
import { cn } from '@/lib/cn';
import { formatRemaining } from '@/lib/queryWindow';
import { fmtDateTime, humanize } from '@/lib/format';
import { useNow, useQueryWindow } from './QueryWindow';

/** Query number shown to the institution, derived from the deficiency id so it is stable across sessions. */
export function memoNumber(id: string): string {
  return `RO-${1000 + (parseInt(id.replace(/-/g, '').slice(0, 4), 16) % 9000)}`;
}

/**
 * Query & Clarification, institution side. Left: the officer's query. Right: the clarification (upload and response).
 * The response window comes from the server; once it has closed the upload and the submit button are disabled
 * (the server refuses them as well) until an officer reopens the window.
 */
export function CorrectionCycle({ d, institutionId }: { d: Deficiency; institutionId: string }) {
  const memo = memoNumber(d.id);
  const win = useQueryWindow(d);
  const now = useNow();
  // queries raised before the window existed keep their plain deadline
  const legacyMs = !d.window_closes_at && d.due_at ? new Date(d.due_at).getTime() - now : null;
  const expired = win?.closed ?? false;
  const remainingMs = win?.remainingMs ?? legacyMs;

  const [text, setText] = useState('');
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const act = useAction(() => submitCorrection(d.id, text, version?.id ?? null), {
    success: 'Clarification submitted. The officer has been notified.', invalidate: [['deficiencies'], ['application'], ['applications'], ['matrix'], ['documents']],
    onSuccess: () => { setText(''); setVersion(null); },
  });

  return (
    <div className="border-t border-line">
      {remainingMs !== null && (
        <div role="timer" aria-live="off"
          className={cn('flex flex-wrap items-center gap-2 px-5 py-2.5 text-[13px] font-semibold',
            remainingMs <= 0 ? 'bg-danger-soft text-danger' : remainingMs < 12 * 3_600_000 ? 'bg-warning-soft text-[#7a5100]' : 'bg-primary-soft text-primary-ink')}>
          <Timer className="h-4 w-4 shrink-0" aria-hidden />
          {remainingMs <= 0 ? <>Response window expired</> : <>Response window: <span className="tabular">{formatRemaining(remainingMs)}</span></>}
          <span className="font-normal opacity-80">· {d.window_closes_at ? 'closes' : 'deadline'} {fmtDateTime(d.window_closes_at ?? d.due_at)}</span>
          {d.window_reopen_count > 0 && <span className="font-normal opacity-80">· reopened {d.window_reopen_count}×</span>}
        </div>
      )}

      <div className="grid md:grid-cols-2 md:divide-x md:divide-line">
        <section aria-label={`Query #${memo}`} className="min-w-0 bg-danger-soft/40 px-5 py-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-danger">
            <AlertOctagon className="h-3.5 w-3.5" aria-hidden />Query
          </p>
          <div className="mt-2 rounded-lg border border-[#f3c9c4] bg-surface px-4 py-3">
            <p className="text-[13.5px] font-semibold text-danger">Query #{memo}: {d.reason}</p>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div><dt className="text-xs text-ink-soft">Requirement / source</dt><dd>{d.requirement_source}</dd></div>
              <div><dt className="text-xs text-ink-soft">Clarification or correction requested</dt><dd className="font-medium">{d.requested_correction}</dd></div>
              <div><dt className="text-xs text-ink-soft">Raised</dt><dd>{fmtDateTime(d.raised_at)} · stage {humanize(d.stage_code)}</dd></div>
            </dl>
          </div>
        </section>

        <section aria-label={`Clarification for Query #${memo}`} className="min-w-0 px-5 py-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <FileUp className="h-3.5 w-3.5" aria-hidden />Clarify and upload for Query #{memo}
          </p>
          {expired ? (
            <div className="mt-2 space-y-3">
              <Notice tone="danger" title="Window expired">
                The response window for this query has closed, so uploads and clarifications are disabled. Contact the officer: they can reopen the window once.
              </Notice>
            </div>
          ) : (
            <div className="mt-2 space-y-3">
              {d.doc_type ? (
                <>
                  <DocumentUploader institutionId={institutionId} applicationId={d.application_id} docType={d.doc_type} requireReason onUploaded={setVersion} />
                  <p className="text-xs text-ink-soft">
                    {version ? `Version ${version.version} uploaded and attached.` : 'A new version of this document is required before you can submit.'}
                    {' '}Earlier versions stay on file and are compared by the officer.
                  </p>
                </>
              ) : (
                <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-soft">This query asks for a written clarification; no replacement document type is attached.</p>
              )}
              <TextAreaField label="Your clarification" required rows={3} value={text} onChange={(e) => setText(e.target.value)}
                hint="Uploading a file alone does not resolve the query; the officer reviews your clarification." />
              <div className="flex justify-end">
                <Button size="sm" loading={act.isPending} disabled={text.trim().length < 10 || (!!d.doc_type && !version)} onClick={() => act.mutate(undefined)}>Submit clarification</Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
