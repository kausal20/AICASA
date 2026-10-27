import { useEffect, useState } from 'react';
import { RotateCcw, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextAreaField } from '@/components/ui/Field';
import { useAction } from '@/hooks/useAction';
import { formatRemaining, windowState, type WindowState } from '@/lib/queryWindow';
import { reopenDeficiencyWindow } from '@/services/operations';
import type { Deficiency } from '@/types/domain';
import { Notice } from '@/components/ui/States';
import { fmtDateTime } from '@/lib/format';
import { queryDeadline, windowKind, WINDOW_LABEL, WINDOWS_EXPLAINED } from '@/lib/queries';

export { AWAITING } from '@/lib/queries';
import { AWAITING } from '@/lib/queries';

/** Re-renders every 30 seconds so countdowns stay live without a refetch. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Window state of a query that is still waiting for the institution; null once it has been answered or when it has no window. */
export function useQueryWindow(d: Pick<Deficiency, 'status' | 'window_closes_at'>): WindowState | null {
  const now = useNow();
  if (!d.window_closes_at || !AWAITING.includes(d.status)) return null;
  return windowState(d.window_closes_at, now);
}

/** "37h 12m left" or "Window expired", for both the officer and the institution view. */
export function WindowBadge({ d }: { d: Deficiency }) {
  const w = useQueryWindow(d);
  if (!w) return null;
  return (
    <Badge tone={w.closed ? 'danger' : w.remainingMs < 12 * 3_600_000 ? 'warning' : 'primary'} icon={<Timer className="h-3 w-3" aria-hidden />}>
      <span role="timer" aria-live="off">{formatRemaining(w.remainingMs)}</span>
    </Badge>
  );
}

/**
 * Which window applies to a query, its deadline and a live countdown, in the same format for the institution and the officer.
 * Officer queries run on the 48-hour window; rule-raised deficiencies run to their correction due date.
 */
export function QueryClock({ d }: { d: Deficiency }) {
  const now = useNow();
  const kind = windowKind(d);
  const deadline = queryDeadline(d);
  const remaining = new Date(deadline).getTime() - now;
  const tone = remaining <= 0 ? 'danger' : remaining < 12 * 3_600_000 ? 'warning' : 'primary';
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <Badge tone={tone} icon={<Timer className="h-3 w-3" aria-hidden />}>
        <span role="timer" aria-live="off">{formatRemaining(remaining, kind === 'query_window' ? 'Window expired' : 'Past due date')}</span>
      </Badge>
      <span className="text-[11px] text-ink-soft">{WINDOW_LABEL[kind]}</span>
      <span className="text-[11px] tabular text-ink-soft">{kind === 'query_window' ? 'Closes' : 'Due'} {fmtDateTime(deadline)}</span>
    </div>
  );
}

/** One plain-language explanation of the two response windows, shown on both sides of Query & Clarification. */
export function ResponseWindowsNote() {
  return <Notice tone="info" icon={<Timer className="h-4 w-4" aria-hidden />} title="Two kinds of response window">{WINDOWS_EXPLAINED}</Notice>;
}

export function ReopenWindowButton({ d }: { d: Deficiency }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const act = useAction(() => reopenDeficiencyWindow(d.id, reason, d.row_version), {
    success: 'Window reopened with a fresh response period.', invalidate: [['deficiencies'], ['application'], ['applications'], ['tasks']], onSuccess: () => setOpen(false),
  });
  return (
    <>
      <Button size="sm" variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setOpen(true)}>Reopen window</Button>
      {open && (
        <Dialog open onOpenChange={setOpen} title="Reopen the response window" description={d.title}
          footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={act.isPending} disabled={reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Reopen window</Button></>}>
          <div className="space-y-3">
            <p className="text-[13px] text-ink-soft">This gives the institution a fresh response window. A window can be reopened once; the reason is recorded in the audit log.</p>
            <TextAreaField label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 10 characters." />
          </div>
        </Dialog>
      )}
    </>
  );
}
