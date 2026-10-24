import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthProvider';
import { listDeliveryAttempts, listIntegrations, listJobRuns, runScanNow } from '@/services/admin';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { DataTable, PageHeader, Td, Th } from '@/components/ui/Page';
import { EmptyState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { fmtDateTime, humanize } from '@/lib/format';

export function SystemPage() {
  const { can } = useAuth();
  const ints = useQuery({ queryKey: ['integrations'], queryFn: listIntegrations });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: listJobRuns });
  const del = useQuery({ queryKey: ['deliveries'], queryFn: listDeliveryAttempts, enabled: can('escalation') });
  const scan = useAction(runScanNow, { invalidate: [['jobs'], ['escalations'], ['notifications']], success: (r) => `Deadline scan ${r.status}.` });
  return (
    <div>
      <PageHeader title="Integration and system status" description="What is connected, what is simulated and what is not configured. Nothing here claims a live AICTE integration." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Integrations" />
          {ints.isLoading ? <LoadingRows /> : (
            <ul className="divide-y divide-line">
              {(ints.data ?? []).map((i) => (
                <li key={i.code} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div><p className="text-[13.5px] font-medium">{i.name}</p><p className="text-xs text-ink-soft">{i.notes}</p></div>
                  <Badge tone={i.status === 'configured' ? 'success' : i.status === 'mock' ? 'warning' : i.status === 'error' ? 'danger' : 'neutral'}>{i.status === 'mock' ? 'Mock / demo' : humanize(i.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Deadline scanner runs" description="Scheduled every 30 minutes via pg_cron where available. Runs are idempotent."
            action={can('escalation') && <Button size="sm" variant="secondary" icon={<Play className="h-3.5 w-3.5" />} loading={scan.isPending} onClick={() => scan.mutate(undefined)}>Run now</Button>} />
          {jobs.isLoading ? <LoadingRows /> : !jobs.data?.length ? <EmptyState title="No runs recorded" body="If pg_cron is not enabled on this project, trigger the scan manually." /> : (
            <DataTable className="[&_table]:min-w-0">
              <thead><tr><Th>Started</Th><Th>Trigger</Th><Th>Status</Th><Th>Result</Th></tr></thead>
              <tbody>{jobs.data.map((j) => (
                <tr key={j.id}><Td className="text-[13px] tabular">{fmtDateTime(j.started_at)}</Td><Td className="text-[13px]">{humanize(j.trigger_source)}</Td>
                  <Td><StatusBadge status={j.status === 'succeeded' ? 'completed' : j.status === 'failed' ? 'still_deficient' : 'submitted'} label={humanize(j.status)} /></Td>
                  <Td className="text-xs text-ink-soft">{j.error ?? Object.entries(j.stats ?? {}).map(([k, v]) => `${humanize(k)} ${v}`).join(' · ')}</Td></tr>
              ))}</tbody>
            </DataTable>
          )}
        </Card>
        {can('escalation') && (
          <Card className="xl:col-span-2">
            <CardHeader title="External delivery attempts" description="Email attempts with their real outcome. Failed or skipped attempts are never shown as sent." />
            {!del.data?.length ? <EmptyState title="No delivery attempts" /> : (
              <DataTable>
                <thead><tr><Th>When</Th><Th>Notification</Th><Th>Channel</Th><Th>Status</Th><Th>Detail</Th></tr></thead>
                <tbody>{del.data.slice(0, 25).map((d) => (
                  <tr key={d.id}><Td className="text-[13px] tabular">{fmtDateTime(d.attempted_at)}</Td><Td className="text-[13px]">{d.notifications?.title}</Td><Td className="text-[13px]">{d.channel}</Td>
                    <Td><Badge tone={d.status === 'sent' ? 'success' : d.status === 'failed' ? 'danger' : 'neutral'}>{humanize(d.status)}</Badge></Td><Td className="text-xs text-ink-soft">{d.error ?? '—'}</Td></tr>
                ))}</tbody>
              </DataTable>
            )}
          </Card>
        )}
      </div>
      <div className="mt-6"><Notice tone="info">Timezone policy: all timestamps are stored in UTC and shown in IST (Asia/Kolkata). Date-only deadlines are interpreted as 23:59:59 IST on that date.</Notice></div>
    </div>
  );
}
