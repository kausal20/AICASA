import type { ReactNode } from 'react';
import {
  AlertTriangle, CheckCircle2, CircleDashed, CircleDot, Clock, FileQuestion, FileWarning, HelpCircle, Lock, RotateCcw, Send, XCircle,
  CalendarCheck, CalendarClock, Eye, Ban,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { dueState, fmtDate, humanize, relativeDue } from '@/lib/format';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary' | 'accent';

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-soft border-line',
  info: 'bg-info-soft text-info border-[#d6dde1]',
  success: 'bg-success-soft text-[#0f6b53] border-[#c3e5d8]',
  warning: 'bg-warning-soft text-[#7a5100] border-[#eedcb1]',
  danger: 'bg-danger-soft text-danger border-[#f3c9c4]',
  primary: 'bg-primary-soft text-primary-ink border-[#c7d3ee]',
  accent: 'bg-accent-soft text-accent border-[#cfe0ee]',
};

export function Badge({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-5', tones[tone], className)}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

const I = 'h-3.5 w-3.5 shrink-0';

// Every status carries text plus an icon: colour is never the only signal.
const STATUS: Record<string, { label: string; tone: Tone; icon: ReactNode }> = {
  draft: { label: 'Draft', tone: 'neutral', icon: <CircleDashed className={I} aria-hidden /> },
  submitted: { label: 'Awaiting RO Scrutiny', tone: 'info', icon: <Send className={I} aria-hidden /> },
  under_scrutiny: { label: 'Under RO Scrutiny', tone: 'accent', icon: <Eye className={I} aria-hidden /> },
  returned_for_correction: { label: 'Deficiencies Flagged', tone: 'warning', icon: <RotateCcw className={I} aria-hidden /> },
  correction_submitted: { label: 'Correction submitted — awaiting re-review', tone: 'info', icon: <Send className={I} aria-hidden /> },
  awaiting_verification: { label: 'Awaiting verification', tone: 'info', icon: <Clock className={I} aria-hidden /> },
  ready_for_next_stage: { label: 'Ready for next stage', tone: 'primary', icon: <CircleDot className={I} aria-hidden /> },
  evc_required: { label: 'EVC required', tone: 'warning', icon: <CalendarClock className={I} aria-hidden /> },
  evc_scheduled: { label: 'EVC scheduled', tone: 'accent', icon: <CalendarCheck className={I} aria-hidden /> },
  evc_completed: { label: 'EVC Completed', tone: 'primary', icon: <CheckCircle2 className={I} aria-hidden /> },
  committee_review: { label: 'Committee review', tone: 'accent', icon: <Eye className={I} aria-hidden /> },
  awaiting_decision: { label: 'Awaiting decision', tone: 'accent', icon: <Clock className={I} aria-hidden /> },
  completed: { label: 'Completed', tone: 'success', icon: <CheckCircle2 className={I} aria-hidden /> },
  closed: { label: 'Closed', tone: 'neutral', icon: <Lock className={I} aria-hidden /> },
  withdrawn: { label: 'Withdrawn', tone: 'neutral', icon: <Ban className={I} aria-hidden /> },
  // deficiencies
  open: { label: 'Open', tone: 'warning', icon: <AlertTriangle className={I} aria-hidden /> },
  still_deficient: { label: 'Still deficient', tone: 'danger', icon: <XCircle className={I} aria-hidden /> },
  needs_clarification: { label: 'Needs clarification', tone: 'warning', icon: <HelpCircle className={I} aria-hidden /> },
  resolved: { label: 'Resolved', tone: 'success', icon: <CheckCircle2 className={I} aria-hidden /> },
  // EVC
  awaiting_scheduling: { label: 'Awaiting scheduling', tone: 'warning', icon: <CalendarClock className={I} aria-hidden /> },
  proposed: { label: 'Proposed', tone: 'info', icon: <CalendarClock className={I} aria-hidden /> },
  scheduled: { label: 'Scheduled', tone: 'accent', icon: <CalendarCheck className={I} aria-hidden /> },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: <Ban className={I} aria-hidden /> },
  // compliance
  upcoming: { label: 'Upcoming', tone: 'neutral', icon: <Clock className={I} aria-hidden /> },
  due_soon: { label: 'Due soon', tone: 'warning', icon: <Clock className={I} aria-hidden /> },
  awaiting_submission: { label: 'Awaiting submission', tone: 'info', icon: <Clock className={I} aria-hidden /> },
  under_verification: { label: 'Under verification', tone: 'accent', icon: <Eye className={I} aria-hidden /> },
  verified: { label: 'Verified', tone: 'success', icon: <CheckCircle2 className={I} aria-hidden /> },
  correction_required: { label: 'Correction required', tone: 'warning', icon: <RotateCcw className={I} aria-hidden /> },
  overdue: { label: 'Overdue', tone: 'danger', icon: <AlertTriangle className={I} aria-hidden /> },
  // validity
  valid: { label: 'Valid', tone: 'success', icon: <CheckCircle2 className={I} aria-hidden /> },
  expiring_soon: { label: 'Expiring soon', tone: 'warning', icon: <Clock className={I} aria-hidden /> },
  expired: { label: 'Expired', tone: 'danger', icon: <AlertTriangle className={I} aria-hidden /> },
  superseded: { label: 'Superseded', tone: 'neutral', icon: <Lock className={I} aria-hidden /> },
  // escalations
  acknowledged: { label: 'Acknowledged', tone: 'info', icon: <Eye className={I} aria-hidden /> },
  // pre-check
  passed: { label: 'Passed check', tone: 'success', icon: <CheckCircle2 className={I} aria-hidden /> },
  potential_issue: { label: 'Potential issue', tone: 'warning', icon: <AlertTriangle className={I} aria-hidden /> },
  missing_information: { label: 'Missing information', tone: 'danger', icon: <FileQuestion className={I} aria-hidden /> },
  extraction_failed: { label: 'Extraction failed', tone: 'danger', icon: <FileWarning className={I} aria-hidden /> },
  manual_review: { label: 'Manual review needed', tone: 'info', icon: <Eye className={I} aria-hidden /> },
  not_checked: { label: 'Not checked', tone: 'neutral', icon: <CircleDashed className={I} aria-hidden /> },
};

export function StatusBadge({ status, label, className }: { status: string; label?: string; className?: string }) {
  const s = STATUS[status] ?? { label: humanize(status), tone: 'neutral' as Tone, icon: null };
  return <Badge tone={s.tone} icon={s.icon} className={className}>{label ?? s.label}</Badge>;
}

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? humanize(status);
}

/** Due date plus its state on the app's date-only policy (due today is never overdue). Every deadline badge uses this. */
export function DueBadge({ due, done }: { due: string | null | undefined; done?: boolean }) {
  if (!due) return <span className="text-ink-faint">—</span>;
  if (done) return <span className="tabular text-ink-soft">{fmtDate(due)}</span>;
  const state = dueState(due);
  const tone: Tone = state === 'overdue' ? 'danger' : state === 'today' || state === 'soon' ? 'warning' : 'neutral';
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="tabular text-[13px] text-ink">{fmtDate(due)}</span>
      <Badge tone={tone} className="mt-0.5 w-fit px-1.5 py-0 text-[11px]" icon={state === 'overdue' ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <Clock className="h-3 w-3" aria-hidden />}>{relativeDue(due)}</Badge>
    </span>
  );
}
