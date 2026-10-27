import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/AuthProvider';
import { listTasks } from '@/services/operations';
import { Card } from '@/components/ui/Card';
import { DueBadge, Badge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Tabs, Td, Th } from '@/components/ui/Page';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { humanize, plural, verb } from '@/lib/format';
import { responsibilityLabel } from '@/lib/responsibilities';
import type { TaskRow } from '@/types/domain';

function linkFor(t: TaskRow) {
  if (t.task_type === 'compliance_verification') return '/app/compliance';
  if (t.task_type.startsWith('evc')) return '/app/evc';
  if (t.task_type === 'escalation_followup') return '/app/escalations';
  return t.application_id ? `/app/applications/${t.application_id}` : '/app';
}

export function TasksPage() {
  const { session } = useAuth();
  const [tab, setTab] = useState('mine');
  const q = useQuery({ queryKey: ['tasks', tab], queryFn: () => listTasks({ mine: tab === 'mine' ? session?.user.id : undefined }) });
  const rows = q.data ?? [];
  const overdue = rows.filter((r) => r.is_overdue);
  return (
    <div>
      <PageHeader title="Tasks and deadlines" description="Work items created by the workflow engine: stage reviews, correction reviews, EVC scheduling and outcomes, compliance verification and escalation follow-up." />
      <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'mine', label: 'Assigned to me' }, { value: 'region', label: 'Open in my scope' }]}>
        <Card>
          {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? <EmptyState title="No open tasks" /> : (
            <>
              {overdue.length > 0 && <p className="border-b border-line bg-danger-soft px-5 py-2.5 text-[13px] font-medium text-danger">{plural(overdue.length, 'task')} {verb(overdue.length, 'is', 'are')} past due.</p>}
              <DataTable>
                <thead><tr><Th>Task</Th><Th>Type</Th><Th>Case</Th><Th>Assignee</Th><Th>Due</Th></tr></thead>
                <tbody>
                  {[...overdue, ...rows.filter((r) => !r.is_overdue)].map((t) => (
                    <tr key={t.id} className="hover:bg-surface-muted/60">
                      <Td><Link className="font-medium text-accent hover:underline" to={linkFor(t)}>{t.title}</Link></Td>
                      <Td><Badge tone="neutral">{humanize(t.task_type)}</Badge></Td>
                      <Td className="text-[13px]">{t.application_reference ?? '—'}</Td>
                      <Td className="text-[13px]">{t.assignee_name ?? (t.required_capability ? `Any ${responsibilityLabel(t.required_capability)} officer (${t.region_code})` : t.region_code)}</Td>
                      <Td><DueBadge due={t.due_at} /></Td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </>
          )}
        </Card>
      </Tabs>
    </div>
  );
}
