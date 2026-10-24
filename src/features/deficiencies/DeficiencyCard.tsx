import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import type { Deficiency, DeficiencySubmission } from '@/types/domain';

/** The version a submission replaced: the one attached to the previous attempt, else the one on file when the memo was raised. */
export function previousVersionId(d: Deficiency, s: DeficiencySubmission): string | null {
  const earlier = (d.deficiency_submissions ?? []).filter((x) => x.attempt < s.attempt && x.document_version_id).at(-1);
  return earlier?.document_version_id ?? d.affected_document_version_id ?? null;
}
import { StatusBadge, DueBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextAreaField, SelectField } from '@/components/ui/Field';
import { Disclosure } from '@/components/ui/Workspace';
import { VersionCompare } from '@/features/documents/VersionCompare';
import { CorrectionCycle } from './CorrectionCycle';
import { useAction } from '@/hooks/useAction';
import { reviewCorrection } from '@/services/operations';
import { getDirectory } from '@/services/applications';
import { fmtDateTime, humanize } from '@/lib/format';

export function DeficiencyCard({ d, mode, institutionId, canReview }: {
  d: Deficiency; mode: 'institution' | 'staff'; institutionId?: string; canReview?: boolean;
}) {
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });
  const name = (id: string | null) => dir.data?.find((p) => p.id === id)?.full_name ?? 'Officer';
  const [review, setReview] = useState(false);
  const awaitingInstitution = ['open', 'still_deficient', 'needs_clarification'].includes(d.status);
  const appReturned = d.applications?.status === 'returned_for_correction';

  return (
    <article className="rounded-card border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          {d.applications && (
            <Link to={`/app/applications/${d.application_id}`} className="text-xs font-medium text-accent hover:underline">{d.applications.reference} · {d.applications.title}</Link>
          )}
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink">{d.title}</h3>
          <p className="text-xs text-ink-soft">Raised {fmtDateTime(d.raised_at)} by {name(d.raised_by)} · stage {humanize(d.stage_code)}</p>
        </div>
        <div className="flex items-start gap-3">
          <StatusBadge status={d.status} />
          {awaitingInstitution && <DueBadge due={d.due_at} />}
        </div>
      </header>
      <div className="grid gap-4 px-5 py-4 md:grid-cols-3">
        <div><p className="text-xs text-ink-soft">Reason</p><p className="mt-0.5 text-[13.5px]">{d.reason}</p></div>
        <div><p className="text-xs text-ink-soft">Requirement / source</p><p className="mt-0.5 text-[13.5px]">{d.requirement_source}</p></div>
        <div><p className="text-xs text-ink-soft">Correction requested</p><p className="mt-0.5 text-[13.5px] font-medium">{d.requested_correction}</p></div>
      </div>

      {mode === 'institution' && awaitingInstitution && appReturned && institutionId && <CorrectionCycle d={d} institutionId={institutionId} />}

      {(d.deficiency_submissions?.length ?? 0) > 0 && (
        <div className="border-t border-line px-5 py-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Response history</p>
          <ol className="space-y-3">
            {d.deficiency_submissions!.map((s) => {
              const r = d.deficiency_reviews?.find((x) => x.submission_id === s.id);
              return (
                <li key={s.id} className="rounded-lg bg-surface-muted px-4 py-3 text-[13px]">
                  <p className="font-medium">Attempt {s.attempt} · submitted {fmtDateTime(s.submitted_at)}</p>
                  <p className="mt-1 text-ink-soft">{s.response_text}</p>
                  {s.document_version_id && (() => {
                    const prev = previousVersionId(d, s);
                    return prev && prev !== s.document_version_id ? (
                      <div className="mt-2"><Disclosure summary="Compare with the earlier version">
                        {d.deficiency_submissions!.some((x) => x.attempt < s.attempt && x.document_version_id) || d.affected_version_basis === 'captured_at_raise' ? null : (
                          <p className="mb-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-[#7a5100]">The earlier version is inferred, not proven: the system did not record which version was on file when this memo was raised.</p>
                        )}
                        <VersionCompare oldVersionId={prev} newVersionId={s.document_version_id} />
                      </Disclosure></div>
                    ) : <p className="mt-1 text-xs text-ink-soft">New document version attached. No earlier version is linked to this memo, so there is nothing to compare.</p>;
                  })()}
                  {r ? (
                    <p className="mt-2 text-xs"><StatusBadge status={r.outcome} /> <span className="ml-1 text-ink-soft">{name(r.reviewed_by)}, {fmtDateTime(r.reviewed_at)}: {r.reason}</span></p>
                  ) : <p className="mt-2 text-xs text-ink-soft">Awaiting officer review.</p>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {mode === 'institution' && awaitingInstitution && !appReturned && <p className="text-xs text-ink-soft">The officer has not yet returned the case for correction.</p>}
        {mode === 'staff' && d.status === 'correction_submitted' && canReview && (
          <Button size="sm" icon={<ScanSearch className="h-4 w-4" />} onClick={() => setReview(true)}>Review correction</Button>
        )}
        {mode === 'staff' && awaitingInstitution && <p className="text-xs text-ink-soft">Waiting for the institution's response.</p>}
        {d.status === 'resolved' && <p className="text-xs text-ink-soft">Resolved {fmtDateTime(d.resolved_at)}</p>}
      </footer>
      {review && <ReviewDialog d={d} onClose={() => setReview(false)} />}
    </article>
  );
}

function ReviewDialog({ d, onClose }: { d: Deficiency; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'resolved' | 'still_deficient' | 'needs_clarification'>('resolved');
  const [reason, setReason] = useState('');
  const act = useAction(() => reviewCorrection(d.id, outcome, reason), {
    success: 'Review recorded.', invalidate: [['deficiencies'], ['application'], ['applications'], ['tasks']], onSuccess: onClose,
  });
  const latest = d.deficiency_submissions?.at(-1);
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Review correction" description={d.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Record outcome</Button></>}>
      <div className="space-y-4">
        {latest && <div className="rounded-lg bg-surface-muted px-4 py-3 text-[13px]"><p className="font-medium">Institution's response (attempt {latest.attempt})</p><p className="mt-1 text-ink-soft">{latest.response_text}</p></div>}
        {latest?.document_version_id && previousVersionId(d, latest) && (
          <div className="rounded-lg border border-line px-4 py-3"><p className="mb-2 text-[13px] font-medium">Document versions</p>
            <VersionCompare oldVersionId={previousVersionId(d, latest)!} newVersionId={latest.document_version_id} /></div>
        )}
        <p className="text-xs text-ink-soft">Choose "still deficient" or "needs clarification" if the response is incomplete; the memo then stays open for the institution.</p>
        <SelectField label="Outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="resolved">Resolved — correction accepted</option>
          <option value="still_deficient">Still deficient — further correction required</option>
          <option value="needs_clarification">Needs clarification</option>
        </SelectField>
        <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the case timeline and audit log with your name." />
      </div>
    </Dialog>
  );
}
