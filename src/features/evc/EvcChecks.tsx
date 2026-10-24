import { AlertOctagon, CheckCircle2, Info, ScanEye } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import type { CheckStatus, EvcAssignmentCheck } from '@/types/domain';

const REASON: Record<CheckStatus, { tone: Tone; icon: typeof Info; label: string }> = {
  ok: { tone: 'success', icon: CheckCircle2, label: 'OK' },
  info: { tone: 'neutral', icon: Info, label: 'Note' },
  manual_review: { tone: 'info', icon: ScanEye, label: 'Manual review' },
  blocked: { tone: 'danger', icon: AlertOctagon, label: 'Blocked' },
};
const PERSON: Record<'eligible' | 'manual_review' | 'blocked', { tone: Tone; label: string }> = {
  eligible: { tone: 'success', label: 'Eligible' },
  manual_review: { tone: 'info', label: 'Manual review required' },
  blocked: { tone: 'danger', label: 'Blocked' },
};
const LABEL: Record<string, string> = {
  stage: 'Case stage', deficiencies: 'Open deficiencies', documents: 'Required documents', slot: 'Session slot', policy: 'Assignment policy',
  external_sources: 'External sources', authorised: 'Authorisation', conflict_of_interest: 'Conflict of interest', schedule_overlap: 'Other EVCs',
  unavailable: 'Recorded unavailability', availability: 'Availability', workload: 'Workload',
};

/** Readiness and per-person eligibility for a proposed EVC slot, with the reason for every outcome. */
export function EvcCheckView({ check }: { check: EvcAssignmentCheck }) {
  return (
    <div className="space-y-3">
      <section aria-label="Readiness">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">Readiness</p>
        <ul className="space-y-1">{check.readiness.map((r) => <ReasonLine key={r.code} code={r.code} status={r.status} detail={r.detail} />)}</ul>
      </section>
      {check.people.map((p) => (
        <section key={p.user_id} aria-label={p.name} className={cn('rounded-lg border px-3 py-2.5',
          p.status === 'blocked' ? 'border-[#f3c9c4] bg-danger-soft/40' : p.status === 'manual_review' ? 'border-[#cfe0ee] bg-accent-soft/40' : 'border-line')}>
          <p className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px] font-medium">{p.name}
            <Badge tone={PERSON[p.status].tone}>{PERSON[p.status].label}</Badge>
            {p.status === 'eligible' && p.reasons.some((r) => r.status === 'info') && <span className="text-xs font-normal text-ink-soft">Some checks could not be made automatically</span>}
            {p.status === 'blocked' && <span className="text-xs font-normal text-ink-soft">{p.overridable ? 'Can proceed only with a recorded override reason' : 'Cannot be overridden'}</span>}
          </p>
          <ul className="space-y-1">{p.reasons.map((r) => <ReasonLine key={r.code} code={r.code} status={r.status} detail={r.detail} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function ReasonLine({ code, status, detail }: { code: string; status: CheckStatus; detail: string }) {
  const s = REASON[status] ?? REASON.info;
  const Icon = s.icon;
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', status === 'blocked' ? 'text-danger' : status === 'ok' ? 'text-success' : status === 'manual_review' ? 'text-accent' : 'text-ink-faint')} aria-label={s.label} />
      <span><span className="font-medium text-ink">{LABEL[code] ?? code}:</span> <span className="text-ink-soft">{detail}</span></span>
    </li>
  );
}
