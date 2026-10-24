import { useEffect, useState } from 'react';
import { AlertOctagon, FileUp, Timer } from 'lucide-react';
import type { Deficiency, DocumentVersion } from '@/types/domain';
import { Button } from '@/components/ui/Button';
import { TextAreaField } from '@/components/ui/Field';
import { DocumentUploader } from '@/features/documents/DocumentUploader';
import { useAction } from '@/hooks/useAction';
import { submitCorrection } from '@/services/operations';
import { cn } from '@/lib/cn';
import { fmtDateTime, humanize } from '@/lib/format';

/** Memo number shown to the institution, derived from the deficiency id so it is stable across sessions. */
export function memoNumber(id: string): string {
  return `RO-${1000 + (parseInt(id.replace(/-/g, '').slice(0, 4), 16) % 9000)}`;
}

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

function span(ms: number): string {
  const mins = Math.floor(Math.abs(ms) / 60_000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * Split-screen correction cycle for the institution: the officer's deficiency memo on the left, the
 * amendment upload and response on the right, with the live window taken from the real due date.
 */
export function CorrectionCycle({ d, institutionId }: { d: Deficiency; institutionId: string }) {
  const memo = memoNumber(d.id);
  const now = useNow();
  const remaining = d.due_at ? new Date(d.due_at).getTime() - now : null;
  const elapsed = remaining !== null && remaining < 0;
  const urgent = remaining !== null && remaining < 24 * 3_600_000;

  const [text, setText] = useState('');
  const [version, setVersion] = useState<DocumentVersion | null>(null);
  const act = useAction(() => submitCorrection(d.id, text, version?.id ?? null), {
    success: 'Amendment submitted. The officer has been notified.', invalidate: [['deficiencies'], ['application'], ['applications'], ['matrix'], ['documents']],
    onSuccess: () => { setText(''); setVersion(null); },
  });

  return (
    <div className="border-t border-line">
      {remaining !== null && (
        <div role="timer" aria-live="off"
          className={cn('flex flex-wrap items-center gap-2 px-5 py-2.5 text-[13px] font-semibold',
            elapsed ? 'bg-danger-soft text-danger' : urgent ? 'bg-warning-soft text-[#7a5100]' : 'bg-primary-soft text-primary-ink')}>
          <Timer className="h-4 w-4 shrink-0" aria-hidden />
          {elapsed
            ? <>Correction window elapsed {span(remaining)} ago</>
            : <>Correction window: <span className="tabular">{span(remaining)}</span> remaining</>}
          <span className="font-normal opacity-80">· deadline on the memo: {fmtDateTime(d.due_at)}</span>
        </div>
      )}

      <div className="grid md:grid-cols-2 md:divide-x md:divide-line">
        <section aria-label={`Deficiency Memo #${memo}`} className="min-w-0 bg-danger-soft/40 px-5 py-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-danger">
            <AlertOctagon className="h-3.5 w-3.5" aria-hidden />Query log
          </p>
          <div className="mt-2 rounded-lg border border-[#f3c9c4] bg-surface px-4 py-3">
            <p className="text-[13.5px] font-semibold text-danger">Deficiency Memo #{memo}: {d.reason}</p>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div><dt className="text-xs text-ink-soft">Requirement / source</dt><dd>{d.requirement_source}</dd></div>
              <div><dt className="text-xs text-ink-soft">Correction required</dt><dd className="font-medium">{d.requested_correction}</dd></div>
              <div><dt className="text-xs text-ink-soft">Raised</dt><dd>{fmtDateTime(d.raised_at)} · stage {humanize(d.stage_code)}</dd></div>
            </dl>
          </div>
        </section>

        <section aria-label={`Rectify and upload amendment for Memo #${memo}`} className="min-w-0 px-5 py-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <FileUp className="h-3.5 w-3.5" aria-hidden />Rectify and Upload Amendment for Memo #{memo}
          </p>
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
              <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-soft">This memo asks for a written response; no replacement document type is attached.</p>
            )}
            <TextAreaField label="Describe the correction" required rows={3} value={text} onChange={(e) => setText(e.target.value)}
              hint="Uploading a file alone does not resolve the memo; the officer reviews your response. Earlier versions stay on file." />
            <div className="flex justify-end">
              <Button size="sm" loading={act.isPending} disabled={text.trim().length < 10 || (!!d.doc_type && !version)} onClick={() => act.mutate(undefined)}>Submit amendment</Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
