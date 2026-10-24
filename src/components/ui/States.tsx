import type { ReactNode } from 'react';
import { AlertCircle, Inbox, Lock, RefreshCw } from 'lucide-react';
import { Button } from './Button';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-sunken', className)} aria-hidden />;
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-ink-soft">{icon ?? <Inbox className="h-5 w-5" aria-hidden />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {body && <p className="mt-1 max-w-md text-[13px] text-ink-soft">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this information' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger"><AlertCircle className="h-5 w-5" aria-hidden /></div>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-ink-soft">{errorMessage(error)}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function PermissionState({ body }: { body?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-ink-soft"><Lock className="h-5 w-5" aria-hidden /></div>
      <p className="text-sm font-medium text-ink">Access restricted</p>
      <p className="mt-1 max-w-md text-[13px] text-ink-soft">{body ?? 'Your current role does not include this area. If you need access, ask an administrator in your region.'}</p>
    </div>
  );
}

export function Notice({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children: ReactNode; icon?: ReactNode }) {
  const map = {
    info: 'bg-accent-soft border-[#cfe0ee] text-[#1d4f71]',
    warning: 'bg-warning-soft border-[#eedcb1] text-[#6b4700]',
    danger: 'bg-danger-soft border-[#f3c9c4] text-[#8f1c13]',
    success: 'bg-success-soft border-[#c3e5d8] text-[#0f5e49]',
  };
  return (
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-[13px] leading-relaxed', map[tone])}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div>
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}
