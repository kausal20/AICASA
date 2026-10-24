import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCheck } from 'lucide-react';
import { listNotifications, markRead } from '@/services/operations';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/Page';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/States';
import { fmtDateTime, humanize } from '@/lib/format';
import { cn } from '@/lib/cn';

export function NotificationsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'all'], queryFn: () => listNotifications(200) });
  const unread = (q.data ?? []).filter((n) => !n.read_at).length;
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  return (
    <div>
      <PageHeader title="Notifications" description="In-app notices generated from real case events and the deadline scanner. Email delivery is shown only where a provider is configured."
        actions={unread > 0 && <Button variant="secondary" icon={<CheckCheck className="h-4 w-4" />} onClick={async () => { await markRead(null); refresh(); }}>Mark all read ({unread})</Button>} />
      <Card>
        {q.isLoading ? <LoadingRows /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState title="No notifications" /> : (
          <ul className="divide-y divide-line">
            <AnimatePresence initial={false}>
              {q.data.map((n) => (
                <motion.li key={n.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <button className={cn('flex w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-surface-muted/60', !n.read_at && 'bg-accent-soft/40')}
                    onClick={async () => { if (!n.read_at) { await markRead([n.id]); refresh(); } if (n.link) nav(n.link); }}>
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-line' : 'bg-accent')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2"><span className="text-[13.5px] font-medium text-ink">{n.title}</span><Badge tone={n.kind === 'escalation' ? 'danger' : n.kind === 'reminder' ? 'warning' : 'neutral'}>{humanize(n.kind)}</Badge>{!n.read_at && <span className="sr-only">Unread</span>}</span>
                      <span className="mt-0.5 block text-[13px] text-ink-soft">{n.body}</span>
                      <span className="mt-1 block text-xs text-ink-faint">{fmtDateTime(n.created_at)}</span>
                    </span>
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Card>
    </div>
  );
}
