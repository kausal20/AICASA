import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, CircleDashed, FileSearch, Info, Loader2, XCircle } from 'lucide-react';
import { listCheckRuns, runPrecheck } from '@/services/documents';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/Badge';
import { Notice } from '@/components/ui/States';
import { errorMessage } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import type { CheckFinding, CheckRun, FindingOutcome } from '@/types/domain';

const ORDER: FindingOutcome[] = ['potential_issue', 'missing_information', 'extraction_failed', 'manual_review', 'not_checked', 'passed'];
const GROUP_LABEL: Record<FindingOutcome, string> = {
  potential_issue: 'Potential issues', missing_information: 'Missing information', extraction_failed: 'Extraction failed',
  manual_review: 'Manual review needed', not_checked: 'Not checked', passed: 'Passed checks',
};

export function FindingsList({ run }: { run: CheckRun }) {
  const findings = [...(run.document_check_findings ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const groups = ORDER.map((o) => ({ outcome: o, items: findings.filter((f) => f.outcome === o) })).filter((g) => g.items.length);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {groups.map((g) => <StatusBadge key={g.outcome} status={g.outcome} label={`${GROUP_LABEL[g.outcome]}: ${g.items.length}`} />)}
      </div>
      {groups.map((g) => (
        <section key={g.outcome} aria-label={GROUP_LABEL[g.outcome]}>
          <h4 className="mb-2 text-[13px] font-semibold text-ink">{GROUP_LABEL[g.outcome]}</h4>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {g.items.map((f) => <FindingItem key={f.id} f={f} />)}
          </ul>
        </section>
      ))}
      <div className="rounded-lg bg-surface-muted px-4 py-3 text-xs leading-relaxed text-ink-soft">
        <p className="mb-1 font-medium text-ink">What this check does not do</p>
        <ul className="list-disc space-y-0.5 pl-4">{run.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-2">Engine {run.engine} · checklist v{run.checklist_version ?? '—'} · extraction {run.extraction_status.replace('_', ' ')}{run.extraction_method ? ` (${run.extraction_method})` : ''} · {fmtDateTime(run.completed_at ?? run.started_at)}</p>
      </div>
    </div>
  );
}

function FindingItem({ f }: { f: CheckFinding }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink">{f.check_name}</p>
        <StatusBadge status={f.outcome} />
      </div>
      <p className="mt-1 text-[13px] text-ink-soft">{f.explanation}</p>
      {(f.evidence || f.confidence !== null) && (
        <p className="mt-1.5 text-xs text-ink-soft">
          {f.evidence && <>Evidence: <span className="rounded bg-surface-muted px-1.5 py-0.5 text-ink">{f.evidence}</span></>}
          {f.confidence !== null && <span className="ml-2">Readable-text ratio (heuristic): {(f.confidence * 100).toFixed(0)}%</span>}
        </p>
      )}
      {f.suggestion && <p className="mt-1.5 text-xs font-medium text-accent">Suggested action: {f.suggestion}</p>}
      <p className="mt-1 text-[11px] text-ink-faint">Rule: {f.check_code}</p>
    </li>
  );
}

/** Run panel: shows only the steps the service reports it actually performed. */
export function PrecheckPanel({ versionId, fileLabel }: { versionId: string; fileLabel?: string }) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['checkruns', versionId], queryFn: () => listCheckRuns([versionId]) });
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const latest = runs.data?.[0];

  const run = async () => {
    setErr(null); setRunning(true);
    try {
      await runPrecheck(versionId);
      await qc.invalidateQueries({ queryKey: ['checkruns', versionId] });
    } catch (e) { setErr(errorMessage(e)); } finally { setRunning(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-ink-soft">{fileLabel}{latest ? ` · last checked ${fmtDateTime(latest.completed_at ?? latest.started_at)}` : ' · not checked yet'}</div>
        <Button size="sm" icon={<FileSearch className="h-4 w-4" />} loading={running} onClick={run}>{latest ? 'Run again' : 'Run pre-check'}</Button>
      </div>
      <div aria-live="polite">
        <AnimatePresence>
          {running && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              <Notice tone="info" icon={<Loader2 className="h-4 w-4 animate-spin" />}>
                Sent to the document-check service. It validates the file, reads any machine-readable text and applies the configured checklist. Results appear when it reports back.
              </Notice>
            </motion.div>
          )}
        </AnimatePresence>
        {err && <Notice tone="danger" title="Pre-check could not run">{err}</Notice>}
      </div>
      {runs.isLoading ? <p className="text-sm text-ink-soft">Loading previous checks…</p> : latest && (
        latest.status === 'failed' ? (
          <Notice tone="warning" title="The last check did not complete">{latest.error ?? 'Unknown error.'} The uploaded file is preserved. Retry, or continue — officers review every document independently.</Notice>
        ) : latest.status === 'running' ? (
          <Notice tone="info">A check started at {fmtDateTime(latest.started_at)} has not reported back yet.</Notice>
        ) : (
          <>
            <ol className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs" aria-label="Steps performed">
              {latest.steps.map((s) => (
                <li key={s.code} className="flex items-center gap-1.5 text-ink-soft" title={s.detail}>
                  {s.status === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden /> : s.status === 'failed' ? <XCircle className="h-3.5 w-3.5 text-danger" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
                  {s.label}{s.status !== 'done' && <span className="text-ink-faint">({s.status})</span>}
                </li>
              ))}
            </ol>
            <FindingsList run={latest} />
          </>
        )
      )}
      {(runs.data?.length ?? 0) > 1 && (
        <p className="flex items-center gap-1.5 text-xs text-ink-soft"><Info className="h-3.5 w-3.5" aria-hidden />{runs.data!.length - 1} earlier check run{runs.data!.length > 2 ? 's are' : ' is'} kept for this version.</p>
      )}
    </div>
  );
}
