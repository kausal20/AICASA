import { motion } from 'motion/react';
import { AlertTriangle, Check, RotateCcw, Split } from 'lucide-react';
import type { ApplicationStatus, StageHistory, WorkflowStage, WorkflowTransition } from '@/types/domain';
import { cn } from '@/lib/cn';
import { dueState, fmtDate } from '@/lib/format';

type State = 'completed' | 'active' | 'returned' | 'overdue' | 'upcoming' | 'conditional' | 'skipped';

/**
 * Stage tracker drawn from the application's own route version. A stage is "conditional" when every
 * transition into it carries a route condition, so the tracker never implies all routes use all stages.
 */
export function WorkflowTracker({ stages, transitions, history, current, status, stageDueAt, formData = {} }: {
  stages: WorkflowStage[]; transitions: WorkflowTransition[]; history: StageHistory[];
  current: string; status: ApplicationStatus; stageDueAt: string | null; formData?: Record<string, unknown>;
}) {
  const visited = new Set(history.map((h) => h.stage_code));
  const currentSeq = stages.find((s) => s.code === current)?.sequence ?? 0;
  const draft = status === 'draft';

  const stateOf = (s: WorkflowStage): State => {
    if (draft) return s.kind === 'intake' ? 'active' : isConditional(s) ? 'conditional' : 'upcoming';
    if (s.code === current) {
      if (s.kind === 'terminal') return 'completed';
      if (status === 'returned_for_correction') return 'returned';
      if (stageDueAt && dueState(stageDueAt) === 'overdue') return 'overdue';
      return 'active';
    }
    if (s.sequence < currentSeq) return visited.has(s.code) ? 'completed' : 'skipped';
    return isConditional(s) ? 'conditional' : 'upcoming';
  };
  function isConditional(s: WorkflowStage) {
    const incoming = transitions.filter((t) => t.to_stage === s.code && t.from_stage !== s.code);
    const flags = incoming.flatMap((t) => t.prerequisites.filter((p) => p.startsWith('form_flag:')).map((p) => p.slice(10)));
    // The stage is only conditional while none of its declared route conditions is met by this application.
    return incoming.length > 0 && incoming.every((t) => t.prerequisites.some((p) => p.startsWith('form_flag:')))
      && !flags.some((f) => formData[f] === true);
  }

  const label: Record<State, string> = {
    completed: 'Completed', active: 'Current stage', returned: 'Returned for correction', overdue: 'Current — past target date',
    upcoming: 'Upcoming', conditional: 'Only if route condition applies', skipped: 'Not on this route',
  };

  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:items-start" aria-label="Application stages">
      {stages.map((s, i) => {
        const st = stateOf(s);
        const h = [...history].reverse().find((x) => x.stage_code === s.code);
        return (
          <li key={s.code} className="relative flex flex-1 gap-3 pb-4 sm:flex-col sm:items-center sm:gap-2 sm:pb-0 sm:text-center"
            aria-current={st === 'active' || st === 'returned' || st === 'overdue' ? 'step' : undefined}>
            {i < stages.length - 1 && (
              <span aria-hidden className={cn('absolute left-[15px] top-8 h-[calc(100%-24px)] w-0.5 sm:left-[calc(50%+18px)] sm:top-[15px] sm:h-0.5 sm:w-[calc(100%-36px)]',
                st === 'completed' ? 'bg-primary' : 'bg-line')} />
            )}
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center">
              {(st === 'active' || st === 'returned' || st === 'overdue') && (
                <motion.span key={`${s.code}-${status}`} className={cn('absolute inset-0 rounded-full',
                  st === 'returned' ? 'bg-warning/20' : st === 'overdue' ? 'bg-danger/15' : 'bg-primary/15')}
                  initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1.25, opacity: 1 }} transition={{ duration: 0.6, ease: 'easeOut' }} />
              )}
              <span className={cn('relative flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold',
                st === 'completed' && 'border-primary bg-primary text-white',
                st === 'active' && 'border-primary bg-surface text-primary',
                st === 'returned' && 'border-warning bg-warning-soft text-warning',
                st === 'overdue' && 'border-danger bg-danger-soft text-danger',
                st === 'upcoming' && 'border-line-strong bg-surface text-ink-faint',
                st === 'conditional' && 'border-dashed border-line-strong bg-surface text-ink-faint',
                st === 'skipped' && 'border-dashed border-line bg-surface-muted text-ink-faint')}>
                {st === 'completed' ? <Check className="h-3.5 w-3.5" aria-hidden /> :
                  st === 'returned' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> :
                    st === 'overdue' ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> :
                      st === 'conditional' ? <Split className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
            </span>
            <span className="min-w-0 sm:px-1">
              <span className={cn('block text-[13px] font-medium', st === 'upcoming' || st === 'conditional' || st === 'skipped' ? 'text-ink-soft' : 'text-ink')}>{s.name}</span>
              <span className="block text-xs text-ink-soft">{label[st]}</span>
              {h && h.entered_at && <span className="block text-[11px] text-ink-faint tabular">{fmtDate(h.entered_at)}{h.exited_at ? ` – ${fmtDate(h.exited_at)}` : ''}</span>}
              {!h && s.sla_days && st !== 'skipped' && <span className="block text-[11px] text-ink-faint">Target {s.sla_days} days</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
