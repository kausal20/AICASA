import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthProvider';
import { listDeficiencies } from '@/services/operations';
import { DeficiencyCard } from './DeficiencyCard';
import { PageHeader, Tabs } from '@/components/ui/Page';
import { Card } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';

export function DeficienciesPage() {
  const { workspace, institution } = useAuth();
  const staff = workspace !== 'institution';
  const [tab, setTab] = useState(staff ? 'review' : 'action');
  const q = useQuery({ queryKey: ['deficiencies', 'all'], queryFn: () => listDeficiencies() });
  const all = (q.data ?? []).filter((d) => staff || d.applications?.institution_id === institution?.id);
  const groups = {
    action: all.filter((d) => ['open', 'still_deficient', 'needs_clarification'].includes(d.status)),
    review: all.filter((d) => d.status === 'correction_submitted'),
    closed: all.filter((d) => ['resolved', 'withdrawn'].includes(d.status)),
  };
  const tabs = staff
    ? [{ value: 'review', label: `Clarifications to review (${groups.review.length})` }, { value: 'action', label: `Awaiting institution (${groups.action.length})` }, { value: 'closed', label: `Resolved (${groups.closed.length})` }]
    : [{ value: 'action', label: `Needs your response (${groups.action.length})` }, { value: 'review', label: `With officer (${groups.review.length})` }, { value: 'closed', label: `Resolved (${groups.closed.length})` }];
  const list = groups[tab as keyof typeof groups];

  return (
    <div>
      <PageHeader title={staff ? 'Clarification reviews' : 'Query & Clarification'}
        description={staff ? 'Clarifications submitted by institutions to your queries, for applications in your scope. Review each one and record the outcome with a reason.'
          : 'Queries raised by AICTE officers on your applications, with what is asked and the response window for your clarification.'} />
      <Tabs value={tab} onValueChange={setTab} tabs={tabs}>
        {q.isLoading ? <Card><LoadingRows /></Card> : q.error ? <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card> : !list.length ? (
          <Card><EmptyState title="Nothing here" body={tab === 'action' && !staff ? 'You have no queries awaiting your clarification.' : 'No queries in this group.'} /></Card>
        ) : (
          <div className="space-y-4">
            {list.map((d) => <DeficiencyCard key={d.id} d={d} mode={staff ? 'staff' : 'institution'} institutionId={d.applications?.institution_id} canReview={workspace === 'officer'} />)}
          </div>
        )}
      </Tabs>
    </div>
  );
}
