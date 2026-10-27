import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import type { Deficiency, DeficiencySubmission } from '@/types/domain';

/** The version a submission replaced: the one attached to the previous attempt, else the one on file when the memo was raised. */
export function previousVersionId(d: Deficiency, s: DeficiencySubmission): string | null {
  const earlier = (d.deficiency_submissions ?? []).filter((x) => x.attempt < s.attempt && x.document_version_id).at(-1);
  return earlier?.document_version_id ?? d.affected_document_version_id ?? null;
}
/** The "inferred, not proven" caveat is only for legacy records: a stored version (captured at raise, or proven from the seed sequence) or an earlier attempt is proof enough. */
export function showsInferredCaveat(d: Deficiency, s: DeficiencySubmission): boolean {
  const hasEarlierAttempt = (d.deficiency_submissions ?? []).some((x) => x.attempt < s.attempt && x.document_version_id);
  return !hasEarlierAttempt && d.affected_version_basis !== 'captured_at_raise' && d.affected_version_basis !== 'seed_fixture_verified';
}
import { StatusBadge } from '@/components/ui/Badge';
import { QueryClock, ReopenWindowButton, useQueryWindow } from './QueryWindow';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextAreaField, SelectField } from '@/components/ui/Field';
import { Disclosure } from '@/components/ui/Workspace';
import { VersionCompare } from '@/features/documents/VersionCompare';
import { CorrectionCycle } from './CorrectionCycle';
import { useAction } from '@/hooks/useAction';
import { reviewCorrection } from '@/services/operations';
import { getDirectory } from '@/services/applications';
import { fmtDateTime, humanize, plainText } from '@/lib/format';
import { AWAITING, queryState } from '@/lib/queries';
import { cn } from '@/lib/cn';

export function DeficiencyCard({ d, mode, institutionId, canReview }: {
  d: Deficiency; mode: 'institution' | 'staff'; institutionId?: string; canReview?: boolean;
}) {
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });
  const name = (id: string | null) => dir.data?.find((p) => p.id === id)?.full_name ?? 'Officer';
  const [review, setReview] = useState(false);
  const win = useQueryWindow(d);
  const state = queryState(d);
  const awaitingInstitution = AWAITING.includes(d.status);
  const ref = useRef<HTMLElement>(null);
  const [params] = useSearchParams();
  const focused = params.get('query') === d.id;
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [focused]);

  return (
    <article ref={ref} id={`query-${d.id}`} className={cn('scroll-mt-24 rounded-card border bg-surface shadow-card', focused ? 'border-primary ring-2 ring-primary/20' : 'border-line')}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          {d.applications && (
            <Link to={`/app/applications/${d.application_id}?tab=deficiencies&query=${d.id}`} className="text-xs font-medium text-accent hover:underline">{d.applications.reference} · {d.applications.title}</Link>
          )}
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink">{d.title}</h3>
          <p className="text-xs text-ink-soft">Raised {fmtDateTime(d.raised_at)} {d.auto_generated ? 'automatically by a Deficiency Matrix rule' : <>by {name(d.raised_by)}</>} · stage {humanize(d.stage_code)}
            {d.sent_at ? <> · sent to the institution {fmtDateTime(d.sent_at)}{d.sent_by ? <> by {name(d.sent_by)}</> : null}</> : awaitingInstitution ? ' · not yet sent to the institution' : null}</p>
        </div>
        <div className="flex items-start gap-3">
          <StatusBadge status={d.status} />
          {awaitingInstitution && <QueryClock d={d} />}
        </div>
      </header>
      <div className="grid gap-4 px-5 py-4 md:grid-cols-3">
        <div><p className="text-xs text-ink-soft">Reason</p><p className="mt-0.5 text-[13.5px]">{plainText(d.reason)}</p></div>
        <div><p className="text-xs text-ink-soft">Requirement / source</p><p className="mt-0.5 text-[13.5px]">{d.auto_generated ? 'Deficiency Matrix rule (see technical details for the rule and its version).' : plainText(d.requirement_source)}</p></div>
        <div><p className="text-xs text-ink-soft">Clarification or correction requested</p><p className="mt-0.5 text-[13.5px] font-medium">{d.requested_correction}</p></div>
      </div>
      {d.auto_generated && (
        <div className="px-5 pb-3"><Disclosure summary="Technical details">
          <p className="text-xs text-ink-soft">Rule {d.rule_code} version {d.rule_version}. {d.requirement_source}</p>
        </Disclosure></div>
      )}

      {mode === 'institution' && state === 'needs_response' && institutionId && <CorrectionCycle d={d} institutionId={institutionId} />}

      {(d.deficiency_submissions?.length ?? 0) > 0 && (
        <div className="border-t border-line px-5 py-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Answers and reviews</p>
          <ol className="space-y-3">
            {d.deficiency_submissions!.map((s) => {
              const r = d.deficiency_reviews?.find((x) => x.submission_id === s.id);
              return (
                <li key={s.id} className="rounded-lg bg-surface-muted px-4 py-3 text-[13px]">
                  <p className="font-medium">Answer {s.attempt} · submitted {fmtDateTime(s.submitted_at)}</p>
                  <p className="mt-1 text-ink-soft">{s.response_text}</p>
                  {s.document_version_id && (() => {
                    const prev = previousVersionId(d, s);
                    return prev && prev !== s.document_version_id ? (
                      <div className="mt-2"><Disclosure summary="Compare with the earlier version">
                        {!showsInferredCaveat(d, s) ? null : (
                          <p className="mb-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-[#7a5100]">The earlier version is inferred, not proven: the system did not record which version was on file when this memo was raised.</p>
                        )}
                        <VersionCompare oldVersionId={prev} newVersionId={s.document_version_id} />
                      </Disclosure></div>
                    ) : <p className="mt-1 text-xs text-ink-soft">New document version attached. No earlier version is linked to this query, so there is nothing to compare.</p>;
                  })()}
                  {r ? (
                    <p className="mt-2 text-xs"><StatusBadge status={r.outcome} /> <span className="ml-1 text-ink-soft">{name(r.reviewed_by)}, {fmtDateTime(r.reviewed_at)}: {r.reason}</span></p>
                  ) : <p className="mt-2 text-xs font-medium text-accent">Correction submitted — awaiting officer re-review.</p>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
        {mode === 'institution' && state === 'with_aicte' && <p className="text-xs text-ink-soft">With AICTE — no action needed from you yet. When the officer sends it to you, it moves to “Needs your response” and you are notified.</p>}
        {mode === 'institution' && state === 'with_officer' && <p className="text-xs text-ink-soft">Submitted. The officer will mark it resolved or raise a follow-up; you will be notified either way.</p>}
        {mode === 'staff' && d.status === 'correction_submitted' && canReview && (
          <Button size="sm" icon={<ScanSearch className="h-4 w-4" />} onClick={() => setReview(true)}>Review correction</Button>
        )}
        {mode === 'staff' && state === 'needs_response' && <p className="text-xs text-ink-soft">Sent to the institution; waiting for its answer.</p>}
        {mode === 'staff' && state === 'with_aicte' && <p className="text-xs text-ink-soft">Not yet sent: return the case to the institution to send it.</p>}
        {mode === 'staff' && win?.closed && canReview && d.window_reopen_count < 1 && <ReopenWindowButton d={d} />}
        {mode === 'staff' && win?.closed && d.window_reopen_count >= 1 && <p className="text-xs text-ink-soft">The window was already reopened once; raise a new query if more time is needed.</p>}
        {d.status === 'resolved' && <p className="text-xs text-ink-soft">Resolved {fmtDateTime(d.resolved_at)}</p>}
      </footer>
      {review && canReview && <ReviewDialog d={d} onClose={() => setReview(false)} />}
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
        {latest && <div className="rounded-lg bg-surface-muted px-4 py-3 text-[13px]"><p className="font-medium">Institution's clarification ({latest.attempt})</p><p className="mt-1 text-ink-soft">{latest.response_text}</p></div>}
        {latest?.document_version_id && previousVersionId(d, latest) && (
          <div className="rounded-lg border border-line px-4 py-3"><p className="mb-2 text-[13px] font-medium">Document versions</p>
            <VersionCompare oldVersionId={previousVersionId(d, latest)!} newVersionId={latest.document_version_id} /></div>
        )}
        <p className="text-xs text-ink-soft">Choose "still deficient" or "needs clarification" if the clarification is incomplete; the query then stays open and a fresh response window starts.</p>
        <SelectField label="Outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="resolved">Resolved — clarification accepted</option>
          <option value="still_deficient">Raise a follow-up — still deficient</option>
          <option value="needs_clarification">Raise a follow-up — needs clarification</option>
        </SelectField>
        <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the case timeline and audit log with your name." />
      </div>
    </Dialog>
  );
}
