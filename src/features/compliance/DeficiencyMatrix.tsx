import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertOctagon, CheckCircle2, CircleDashed, CircleHelp, FileWarning, ListChecks, MessageSquareWarning, ScanEye, TriangleAlert } from 'lucide-react';
import { getDeficiencyMatrix, recheckMatrixDeficiencies } from '@/services/operations';
import { useAuth } from '@/features/auth/AuthProvider';
import { useAction } from '@/hooks/useAction';
import { Button } from '@/components/ui/Button';
import { Badge, type Tone } from '@/components/ui/Badge';
import { Disclosure, Panel } from '@/components/ui/Workspace';
import { humanize, plainText, plural, verb } from '@/lib/format';
import { ErrorState, LoadingRows } from '@/components/ui/States';
import { cn } from '@/lib/cn';
import type { MatrixResult, MatrixRow } from '@/types/domain';

export const RESULT: Record<MatrixResult, { label: string; tone: Tone; icon: typeof CheckCircle2 }> = {
  failed_validation: { label: 'Failed validation', tone: 'danger', icon: AlertOctagon },
  potential_issue: { label: 'Potential issue', tone: 'warning', icon: TriangleAlert },
  manual_review: { label: 'Manual review required', tone: 'info', icon: ScanEye },
  extraction_failed: { label: 'Extraction failed', tone: 'warning', icon: FileWarning },
  not_checked: { label: 'Not checked', tone: 'neutral', icon: CircleDashed },
  not_applicable: { label: 'Not applicable', tone: 'neutral', icon: CircleDashed },
  passed: { label: 'Passed', tone: 'success', icon: CheckCircle2 },
};
const ORDER: MatrixResult[] = ['failed_validation', 'potential_issue', 'manual_review', 'extraction_failed', 'not_checked', 'not_applicable', 'passed'];
const SECTIONS: Record<MatrixRow['section'], string> = {
  form: 'Form fields', documents: 'Checklist documents', duplicates: 'Duplicate files', precheck: 'Document pre-check', rules: 'Configured rules',
};

/**
 * Server-evaluated checks; evaluations reconcile rule queries for cases under processing.
 * `audience` adjusts the next-action wording for the institution (before submitting) or the scrutinising officer.
 */
/** What an officer needs to raise a query on one failing matrix row, in plain language. */
export interface RuleQueryDraft { title: string; reason: string; source: string; correction: string }
export function ruleQueryDraft(r: MatrixRow, reference: string): RuleQueryDraft {
  const label = r.label;
  return {
    title: `${label}: requirement not met`,
    reason: `${reference}: ${label}. Declared ${plainText(r.input_value)}; required ${plainText(r.requirement)}. ${plainText(r.explanation)}`.trim(),
    source: `Deficiency Matrix rule: ${label} (${r.is_synthetic ? 'demonstration configuration' : plainText(r.source)})`,
    correction: `Correct the declared figure for "${label}" or upload evidence that the requirement (${plainText(r.requirement)}) is met.`,
  };
}

export function DeficiencyMatrix({ applicationId, audience, onRaiseQuery }: {
  applicationId: string; audience: 'institution' | 'staff'; onRaiseQuery?: (r: MatrixRow) => void;
}) {
  const q = useQuery({ queryKey: ['matrix', applicationId], queryFn: () => getDeficiencyMatrix(applicationId) });
  const qc = useQueryClient();
  useEffect(() => {
    if (!q.dataUpdatedAt) return;
    for (const key of ['deficiencies', 'application', 'applications', 'navcounts']) void qc.invalidateQueries({ queryKey: [key] });
  }, [q.dataUpdatedAt, qc]);
  const { workspace, can } = useAuth();
  const canRecheck = audience === 'staff' && workspace === 'officer' && can('scrutiny') && !!onRaiseQuery;
  const recheck = useAction(() => recheckMatrixDeficiencies(applicationId), {
    success: (r) => r.skipped ? r.skipped : `Rules re-checked: ${r.created} opened, ${r.updated} updated, ${r.resolved} resolved.`,
    invalidate: [['matrix'], ['deficiencies'], ['application'], ['applications'], ['navcounts']],
  });
  const [showPassed, setShowPassed] = useState(false);
  const rows = useMemo(() => (q.data ?? []).slice().sort((a, b) => a.sort_order - b.sort_order), [q.data]);
  const counts = useMemo(() => Object.fromEntries(ORDER.map((r) => [r, rows.filter((x) => x.result === r).length])) as Record<MatrixResult, number>, [rows]);
  const visible = showPassed ? rows : rows.filter((r) => r.result !== 'passed');

  const failed = counts.failed_validation;
  const attention = counts.potential_issue + counts.manual_review + counts.extraction_failed;
  const next = failed
    ? audience === 'institution' ? `Correct ${plural(failed, 'failed item')} before submitting.` : `${plural(failed, 'item')} failed validation; consider raising a query.`
    : attention
      ? audience === 'institution' ? `Review ${plural(attention, 'flagged item')}; the officer will look at ${verb(attention, 'it', 'them')} during scrutiny.` : `${plural(attention, 'item')} ${verb(attention, 'needs', 'need')} your judgement.`
      : 'No failed or flagged items in the checks that could be run.';

  return (
    <Panel className="mb-4" bodyClassName="p-0"
      title={<span className="flex items-center gap-2"><ListChecks className="h-4 w-4 text-primary" aria-hidden />Deficiency Matrix</span>}
      description="Pre-submission checks on the form, documents, file fingerprints, pre-check results and configured rules."
      action={rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-ink-soft">
            <input type="checkbox" className="h-4 w-4 accent-[#1e3a8a]" checked={showPassed} onChange={(e) => setShowPassed(e.target.checked)} />
            Show passed ({counts.passed})
          </label>
          {canRecheck && <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={recheck.isPending} onClick={() => recheck.mutate(undefined)}>Re-check rules</Button>}
        </div>
      )}>
      {q.isLoading ? <div className="p-4"><LoadingRows rows={3} /></div> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div role="status" className={cn('flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-5 py-3',
            failed ? 'border-[#f3c9c4] bg-danger-soft' : attention ? 'border-[#eedcb1] bg-warning-soft' : 'border-[#c3e5d8] bg-success-soft')}>
            <p className={cn('flex min-w-[min(100%,16rem)] flex-1 items-start gap-2 text-[13.5px] font-semibold',
              failed ? 'text-danger' : attention ? 'text-[#7a5100]' : 'text-[#0f6b53]')}>
              {failed ? <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : attention ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
              <span>Next: {next}</span>
            </p>
            <ul className="flex w-full flex-wrap gap-1.5 sm:w-auto" aria-label="Result counts">
              {ORDER.filter((r) => r !== 'passed' && counts[r]).map((r) => (
                <li key={r}><Badge tone={RESULT[r].tone}>{counts[r]} {RESULT[r].label.toLowerCase()}</Badge></li>
              ))}
            </ul>
          </div>

          {!visible.length ? (
            <p className="px-5 py-4 text-[13px] text-ink-soft">{rows.length ? 'Every check that could be run passed.' : 'No checks apply to this case yet.'}</p>
          ) : (
            (Object.keys(SECTIONS) as MatrixRow['section'][]).map((sec) => {
              const items = visible.filter((r) => r.section === sec);
              if (!items.length) return null;
              return (
                <section key={sec} aria-label={SECTIONS[sec]}>
                  <h3 className="border-b border-line bg-surface-muted/60 px-5 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-soft">{SECTIONS[sec]}</h3>
                  {sec === 'form' && <p className="border-b border-line px-5 py-1.5 text-xs text-ink-soft">Form fields check presence and format only (“Provided”); the configured rules below check the quantities.</p>}
                  <ul className="divide-y divide-line">
                    <AnimatePresence initial={false}>
                      {items.map((r) => <MatrixItem key={r.check_code} r={r} onRaiseQuery={onRaiseQuery} />)}
                    </AnimatePresence>
                  </ul>
                  {sec === 'rules' && items.some((r) => r.check_code.startsWith('rule:faculty_cadre_ratio')) && (
                    <p className="border-t border-line px-5 py-2 text-xs text-ink-soft">Cadre numbers are rounded up per post — totals may differ from the raw ratio.</p>
                  )}
                </section>
              );
            })
          )}

          <p className="border-t border-line bg-surface-muted/50 px-5 py-2.5 text-xs leading-relaxed text-ink-soft">
            A configured rule that is not met is recorded as an open deficiency on the case, citing the rule and its version, and it is resolved automatically when a re-check shows the rule is met
            (see the Deficiencies tab). The matrix never rejects an application, and passing it does not mean approval: scrutiny and decisions stay with authorised officers.
            Figures are as declared by the institution, not verified measurements.{audience === 'institution' && ' Rule results become deficiencies when you submit.'}
          </p>
        </>
      )}
    </Panel>
  );
}

function MatrixItem({ r, onRaiseQuery }: { r: MatrixRow; onRaiseQuery?: (r: MatrixRow) => void }) {
  const base = RESULT[r.result] ?? { label: humanize(r.result), tone: 'neutral' as Tone, icon: CircleHelp };
  // a form-field "pass" is a presence check, not a rule outcome
  const s = r.section === 'form' && r.result === 'passed' ? { ...base, label: 'Provided' } : base;
  const Icon = s.icon;
  const failing = r.section === 'rules' && ['potential_issue', 'failed_validation'].includes(r.result);
  return (
    <motion.li layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium text-ink">{r.label}</p>
        <p className="mt-0.5 text-xs text-ink-soft tabular">
          Input: <span className="font-medium text-ink">{plainText(r.input_value)}</span> <span aria-hidden>·</span> Requirement: {plainText(r.requirement)}
        </p>
        <p className="mt-1 text-[13px] text-ink-soft">{plainText(r.explanation)}</p>
        <div className="mt-1"><Disclosure summary={<span className="text-[11.5px]">Technical details</span>}>
          <p className="text-[11.5px] text-ink-faint">Rule {r.rule_ref} · Source: {r.source}</p>
        </Disclosure></div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end sm:pt-0.5">
        <Badge tone={s.tone} icon={<Icon className="h-3 w-3" aria-hidden />}>{s.label}</Badge>
        {failing && onRaiseQuery && <Button size="sm" variant="secondary" icon={<MessageSquareWarning className="h-3.5 w-3.5" />} onClick={() => onRaiseQuery(r)}>Raise query on this rule</Button>}
      </div>
    </motion.li>
  );
}
