import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthProvider';
import { listDeficiencies } from '@/services/operations';
import { DeficiencyCard } from './DeficiencyCard';
import { ResponseWindowsNote } from './QueryWindow';
import { PageHeader, Tabs } from '@/components/ui/Page';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { queryState, stageResponsibility, type QueryState } from '@/lib/queries';
import type { Capability, Deficiency } from '@/types/domain';

/** Whether the signed-in officer holds the responsibility the case's current stage needs, in its region (the server's rule). */
export function useCanReview() {
  const { workspace, canIn } = useAuth();
  return (d: Pick<Deficiency, 'applications'>) =>
    workspace === 'officer' && canIn(stageResponsibility(d.applications?.current_stage) as Capability, d.applications?.region_code);
}

const INSTITUTION_TABS: { value: QueryState; label: string; empty: string }[] = [
  { value: 'needs_response', label: 'Needs your response', empty: 'You have no queries waiting for your answer.' },
  { value: 'with_aicte', label: 'With AICTE — no action needed yet', empty: 'Nothing is waiting with AICTE.' },
  { value: 'with_officer', label: 'With officer', empty: 'No answers are waiting for re-review.' },
  { value: 'closed', label: 'Resolved', empty: 'No resolved queries yet.' },
];

export function DeficienciesPage() {
  const { workspace, institution } = useAuth();
  const staff = workspace !== 'institution';
  const canReview = useCanReview();
  const [tab, setTab] = useState<string>(staff ? 'review' : 'needs_response');
  const q = useQuery({ queryKey: ['deficiencies', 'all'], queryFn: () => listDeficiencies() });
  const loading = q.isLoading;
  const count = (n: number) => (loading ? '…' : String(n));

  if (!staff) {
    const mine = (q.data ?? []).filter((d) => d.applications?.institution_id === institution?.id);
    const list = mine.filter((d) => queryState(d) === tab);
    const current = INSTITUTION_TABS.find((t) => t.value === tab)!;
    return (
      <div>
        <PageHeader title="Query & Clarification" description="Queries raised by AICTE on your applications. Answer each one on its card: reply, upload a corrected document, then submit it for re-review." />
        <div className="mb-4"><ResponseWindowsNote /></div>
        <Tabs value={tab} onValueChange={setTab} tabs={INSTITUTION_TABS.map((t) => ({ value: t.value, label: `${t.label} (${count(mine.filter((d) => queryState(d) === t.value).length)})` }))}>
          {tab === 'with_aicte' && <p className="mb-3 text-[13px] text-ink-soft">These were recorded by AICTE but have not been sent to you. When the officer returns the case, they move to “Needs your response” and you are notified.</p>}
          <List loading={loading} error={q.error} retry={() => q.refetch()} rows={list} empty={current.empty}
            render={(d) => <DeficiencyCard key={d.id} d={d} mode="institution" institutionId={d.applications?.institution_id} />} />
        </Tabs>
      </div>
    );
  }

  const all = q.data ?? [];
  const groups = {
    review: all.filter((d) => d.status === 'correction_submitted' && canReview(d)),
    action: all.filter((d) => ['needs_response', 'with_aicte'].includes(queryState(d))),
    closed: all.filter((d) => queryState(d) === 'closed'),
  };
  const list = groups[tab as keyof typeof groups] ?? [];
  return (
    <div>
      <PageHeader title="Clarification reviews"
        description="Answers submitted by institutions to queries on cases at a stage you are responsible for. Review each one and record the outcome with a reason." />
      <div className="mb-4"><ResponseWindowsNote /></div>
      <Tabs value={tab} onValueChange={setTab} tabs={[
        { value: 'review', label: `Corrections to review (${count(groups.review.length)})` },
        { value: 'action', label: `Awaiting institution (${count(groups.action.length)})` },
        { value: 'closed', label: `Resolved (${count(groups.closed.length)})` },
      ]}>
        <List loading={loading} error={q.error} retry={() => q.refetch()} rows={list} empty={tab === 'review' ? 'No corrections are waiting for your review.' : 'No queries in this group.'}
          render={(d) => <DeficiencyCard key={d.id} d={d} mode="staff" institutionId={d.applications?.institution_id} canReview={canReview(d)} />} />
      </Tabs>
    </div>
  );
}

function List({ loading, error, retry, rows, empty, render }: {
  loading: boolean; error: unknown; retry: () => void; rows: Deficiency[]; empty: string; render: (d: Deficiency) => JSX.Element;
}) {
  if (loading) return <Card><LoadingRows /></Card>;
  if (error) return <Card><ErrorState error={error} onRetry={retry} /></Card>;
  if (!rows.length) return <Card><EmptyState title="Nothing here" body={empty} /></Card>;
  return <div className="space-y-4">{rows.map(render)}</div>;
}
