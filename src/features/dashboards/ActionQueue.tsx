import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, CheckCircle2, Clock3, Focus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { getWorkQueue } from '@/services/workQueue';
import { type WorkBucket } from '@/lib/workQueue';
import { Panel } from '@/components/ui/Workspace';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { DueBadge } from '@/components/ui/Badge';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';

const GROUPS = [
  { value: 'now', label: 'Act now', icon: Focus, description: 'Overdue work and items ready for your attention.' },
  { value: 'week', label: 'Due this week', icon: Clock3, description: 'Upcoming deadlines through Sunday, in Indian Standard Time. Some items may also need action now.' },
  { value: 'waiting', label: 'Waiting on someone else', icon: ArrowUpRight, description: 'Submitted work waiting for the next person or an assignment.' },
  { value: 'completed', label: 'Recently completed', icon: CheckCircle2, description: 'Applications closed and assigned tasks completed in the last seven days.' },
] as const;

export function ActionQueue({ region }: { region?: string }) {
  const { workspace, session, institution } = useAuth();
  const [bucket, setBucket] = useState<WorkBucket>('now');
  const [visible, setVisible] = useState(5);
  const q = useQuery({ queryKey: ['action-queue', workspace, session?.user.id, institution?.id, region, bucket],
    enabled: !!workspace && !!session && (workspace !== 'institution' || !!institution), refetchInterval: 60_000,
    queryFn: () => getWorkQueue({ role: workspace!, userId: session!.user.id, institutionId: institution?.id, region, bucket }) });
  const group = GROUPS.find((g) => g.value === bucket)!;
  return <Panel className="mb-7" title="Your action queue" description={workspace === 'admin' ? 'Follow-up across your selected administrative scope.' : 'A focused view of the work that moves your applications forward.'}
    action={<Button variant="ghost" size="sm" aria-label="Refresh action queue" onClick={() => q.refetch()} disabled={q.isFetching} icon={<RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} />}>Refresh</Button>}>
    <div className="grid grid-cols-2 gap-2 border-b border-line bg-page/50 p-3 lg:grid-cols-4" role="group" aria-label="Action queue categories">{GROUPS.map((g) => <button key={g.value} aria-pressed={bucket === g.value} onClick={() => { setBucket(g.value); setVisible(5); }} className={`flex min-h-12 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${bucket === g.value ? 'bg-primary text-white shadow-card' : 'text-ink-soft hover:bg-primary-soft'}`}><g.icon className="h-4 w-4 shrink-0" aria-hidden />{g.label}</button>)}</div>
    <p className="px-5 pt-4 text-sm text-ink-soft">{group.description}</p>
    {q.isLoading ? <LoadingRows rows={3} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title={bucket === 'now' ? 'Nothing needs immediate attention' : 'No work in this category'} body={bucket === 'now' ? 'Check upcoming deadlines or work waiting for someone else.' : 'Try another category to see the rest of your work.'} /> : <>
      <ul className="mt-3 divide-y divide-line" aria-busy={q.isFetching}>{q.data.items.slice(0, visible).map((r) => <li key={r.id}><Link to={r.to} className="work-item flex flex-wrap items-center justify-between gap-3 px-5 transition-colors hover:bg-primary-soft/40"><div className="min-w-0 flex-1 basis-60"><p className="mb-1 text-xs font-medium text-accent">{r.kind}</p><p className="text-sm font-semibold leading-relaxed">{r.title}</p><p className="mt-1 text-sm text-ink-soft">{r.detail}</p></div><div className="flex items-center gap-4">{r.completed ? <span className="text-sm text-success">Completed {fmtDate(r.date)}</span> : bucket === 'waiting' ? <span className="text-sm text-ink-soft">Awaiting response</span> : r.date ? <DueBadge due={r.date} /> : <span className="text-sm text-accent">Ready to work</span>}<ArrowRight className="h-4 w-4 shrink-0 text-accent" aria-hidden /></div></Link></li>)}</ul>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3"><p className="text-xs text-ink-soft">Showing {Math.min(visible, q.data.items.length)} of {q.data.total} matching work items. Applications and their tasks are counted separately.</p>{visible < q.data.items.length && <Button variant="ghost" size="sm" onClick={() => setVisible(visible + 5)}>Show more</Button>}{visible >= q.data.items.length && q.data.total > q.data.items.length && <Link className="text-sm font-medium text-accent hover:underline" to={workspace === 'officer' ? '/app/tasks' : '/app/applications'}>Open full work lists</Link>}</div>
    </>}
  </Panel>;
}
