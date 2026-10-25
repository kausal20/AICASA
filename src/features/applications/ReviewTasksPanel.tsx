import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Undo2, UserRoundCog, CheckCheck, UsersRound } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { completeReviewTask, listReviewTasks, reassignReviewTask, startReviewTask } from '@/services/operations';
import { getDirectory } from '@/services/applications';
import { Badge, DueBadge, type Tone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField } from '@/components/ui/Field';
import { ErrorState, LoadingRows } from '@/components/ui/States';
import { Disclosure, Panel } from '@/components/ui/Workspace';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, humanize } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import type { Capability, ReviewTask, ReviewTaskStatus } from '@/types/domain';

export const REVIEW_STATUS: Record<ReviewTaskStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'neutral' },
  in_review: { label: 'In review', tone: 'accent' },
  returned: { label: 'Returned', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const INVALIDATE = [['review-tasks'], ['application'], ['applications'], ['navcounts']];

/**
 * Concurrent reviews configured on the route for the current stage. Shown only when the route configures them.
 * Every action is checked again by the server (responsibility, region, assignee and row version).
 */
export function ReviewTasksPanel({ applicationId }: { applicationId: string }) {
  const { session, can, workspace } = useAuth();
  const me = session?.user.id;
  const q = useQuery({ queryKey: ['review-tasks', applicationId], queryFn: () => listReviewTasks({ applicationId }) });
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });
  const name = (id: string | null) => (id ? dir.data?.find((p) => p.id === id)?.full_name ?? 'Officer' : 'Unassigned');
  const [dialog, setDialog] = useState<{ kind: 'complete' | 'reassign'; task: ReviewTask } | null>(null);
  const start = useAction((t: ReviewTask) => startReviewTask(t.id, t.row_version), { success: 'Review started. It is now assigned to you.', invalidate: INVALIDATE });

  if (q.isLoading) return <Panel className="mb-4" title="Concurrent reviews"><div className="p-4"><LoadingRows rows={2} /></div></Panel>;
  if (q.error) return <Panel className="mb-4" title="Concurrent reviews"><ErrorState error={q.error} onRetry={() => q.refetch()} /></Panel>;
  const all = q.data ?? [];
  if (!all.length) return null;

  // the newest stage entry is the current round; earlier rounds stay visible as history
  const latest = all.reduce((a, b) => (a.created_at > b.created_at ? a : b)).stage_history_id;
  const current = all.filter((t) => t.stage_history_id === latest).sort((a, b) => a.name.localeCompare(b.name));
  const earlier = all.filter((t) => t.stage_history_id !== latest);
  const done = current.filter((t) => t.status === 'completed').length;

  return (
    <Panel className="mb-4" bodyClassName="p-0"
      title={<span className="flex items-center gap-2"><UsersRound className="h-4 w-4 text-primary" aria-hidden />Concurrent reviews</span>}
      description={`${done} of ${current.length} complete. Routing out of this stage waits for every configured review.`}>
      <div className="h-1.5 bg-surface-muted" aria-hidden>
        <div className="h-full bg-success transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(done / current.length) * 100}%` }} />
      </div>
      <ul className="divide-y divide-line">
        {current.map((t) => {
          const holds = workspace === 'officer' && can(t.required_capability as Capability);
          const mine = t.assignee_id === me;
          return (
            <li key={t.id} className="px-5 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-ink">{t.name}</p>
                  <p className="text-xs text-ink-soft">{responsibilityLabel(t.required_capability)} · {name(t.assignee_id)}{mine ? ' (you)' : ''}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={REVIEW_STATUS[t.status].tone}>{REVIEW_STATUS[t.status].label}</Badge>
                  {t.status !== 'completed' && <DueBadge due={t.due_at} />}
                </div>
              </div>
              {t.outcome_note && <p className="mt-1.5 rounded-md bg-surface-muted px-3 py-2 text-[13px] text-ink-soft">{t.outcome_note}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {holds && (mine || !t.assignee_id) && ['pending', 'returned'].includes(t.status) && (
                  <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} loading={start.isPending}
                    onClick={() => start.mutate(t)}>{t.status === 'returned' ? 'Resume review' : 'Start review'}</Button>
                )}
                {holds && mine && t.status === 'in_review' && (
                  <Button size="sm" icon={<CheckCheck className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'complete', task: t })}>Record outcome</Button>
                )}
                {can('assignment') && !['completed', 'cancelled'].includes(t.status) && (
                  <Button size="sm" variant="ghost" icon={<UserRoundCog className="h-3.5 w-3.5" />} onClick={() => setDialog({ kind: 'reassign', task: t })}>Reassign</Button>
                )}
                {!!t.review_task_history?.length && (
                  <div className="w-full pt-1">
                    <Disclosure summary={`History (${t.review_task_history.length})`}>
                      <ol className="space-y-1 text-xs text-ink-soft">
                        {t.review_task_history.map((h) => (
                          <li key={h.id}>{fmtDateTime(h.created_at)} · {humanize(h.action)} by {h.actor_id ? name(h.actor_id) : 'System'}{h.reason ? ` — ${h.reason}` : ''}</li>
                        ))}
                      </ol>
                    </Disclosure>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {earlier.length > 0 && (
        <div className="border-t border-line px-5 py-3">
          <Disclosure summary={`Earlier rounds (${earlier.length})`}>
            <ul className="space-y-1 text-xs text-ink-soft">
              {earlier.map((t) => <li key={t.id}>{t.name} · {REVIEW_STATUS[t.status].label} · {name(t.completed_by ?? t.assignee_id)}{t.completed_at ? `, ${fmtDateTime(t.completed_at)}` : ''}</li>)}
            </ul>
          </Disclosure>
        </div>
      )}
      {dialog?.kind === 'complete' && <CompleteReviewDialog task={dialog.task} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'reassign' && <ReassignReviewDialog task={dialog.task} onClose={() => setDialog(null)} />}
    </Panel>
  );
}

function CompleteReviewDialog({ task, onClose }: { task: ReviewTask; onClose: () => void }) {
  const [outcome, setOutcome] = useState<'completed' | 'returned'>('completed');
  const [note, setNote] = useState('');
  const act = useAction(() => completeReviewTask(task.id, task.row_version, outcome, note), {
    success: outcome === 'completed' ? 'Review completed.' : 'Review returned with issues.', invalidate: INVALIDATE, onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Record review outcome" description={task.name}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={act.isPending} disabled={note.trim().length < 10} icon={outcome === 'returned' ? <Undo2 className="h-4 w-4" /> : undefined}
          onClick={() => act.mutate(undefined)}>{outcome === 'completed' ? 'Complete review' : 'Return with issues'}</Button></>}>
      <div className="space-y-4">
        <SelectField label="Outcome" required value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="completed">Completed — no issue in this review</option>
          <option value="returned">Returned — issues found; routing stays blocked</option>
        </SelectField>
        <TextAreaField label="Basis of the outcome" required rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          hint="At least 10 characters. Recorded with your name in the task history and the audit log." />
        {outcome === 'returned' && <p className="text-xs text-ink-soft">Record any deficiency for the institution separately; a returned review only holds the route.</p>}
      </div>
    </Dialog>
  );
}

function ReassignReviewDialog({ task, onClose }: { task: ReviewTask; onClose: () => void }) {
  const dir = useQuery({ queryKey: ['directory'], queryFn: getDirectory, staleTime: 300_000 });
  const officers = (dir.data ?? []).filter((p) => p.roles?.includes('officer'));
  const [officer, setOfficer] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction(() => reassignReviewTask(task.id, officer, reason, task.row_version), { success: 'Review reassigned.', invalidate: INVALIDATE, onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Reassign review" description={`${task.name} · needs the ${responsibilityLabel(task.required_capability)} responsibility in region ${task.region_code}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={act.isPending} disabled={!officer || reason.trim().length < 10} onClick={() => act.mutate(undefined)}>Reassign</Button></>}>
      <div className="space-y-4">
        <SelectField label="Officer" required value={officer} onChange={(e) => setOfficer(e.target.value)} hint="The server accepts only officers holding the required responsibility for this region.">
          <option value="">Select an officer</option>
          {officers.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.designation ? ` — ${p.designation}` : ''}</option>)}
        </SelectField>
        <TextAreaField label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}
