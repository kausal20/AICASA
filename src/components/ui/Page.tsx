import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as RT from '@radix-ui/react-tabs';
import { motion } from 'motion/react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { LinkCard } from './Card';

export function PageHeader({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'neutral', to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'neutral' | 'warning' | 'danger' | 'primary'; to?: string }) {
  const toneCls = { neutral: 'text-ink', warning: 'text-warning', danger: 'text-danger', primary: 'text-primary' }[tone];
  const inner = (
    <>
      <p className="text-[13px] text-ink-soft">{label}</p>
      <p className={cn('mt-1 text-[28px] font-semibold leading-none tabular', toneCls)}>{value}</p>
      {hint && <p className="mt-2 text-xs text-ink-soft">{hint}</p>}
    </>
  );
  if (to) return <LinkCard to={to} className="px-4 py-4">{inner}</LinkCard>;
  return <div className="rounded-card border border-line bg-surface px-4 py-4 shadow-card">{inner}</div>;
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-[13px] text-ink-soft">
      <span className="tabular">{from}–{to} of {total}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page" icon={<ChevronLeft className="h-4 w-4" />} />
        <span className="tabular px-1">Page {page + 1} of {pages}</span>
        <Button variant="ghost" size="sm" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" icon={<ChevronRight className="h-4 w-4" />} />
      </div>
    </div>
  );
}

export function Tabs({ value, onValueChange, tabs, children }: { value: string; onValueChange: (v: string) => void; tabs: { value: string; label: ReactNode }[]; children: ReactNode }) {
  return (
    <RT.Root value={value} onValueChange={onValueChange}>
      <RT.List className="mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Sections">
        {tabs.map((t) => (
          <RT.Trigger key={t.value} value={t.value}
            className="relative whitespace-nowrap px-3 pb-2.5 pt-1 text-sm font-medium text-ink-soft transition-colors hover:text-ink data-[state=active]:text-ink">
            {t.label}
            {value === t.value && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" transition={{ duration: 0.2 }} />}
          </RT.Trigger>
        ))}
      </RT.List>
      {children}
    </RT.Root>
  );
}
export const TabPanel = RT.Content;

export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('relative overflow-x-auto', className)}>
      <table className="w-full min-w-[720px] border-collapse text-left text-[13.5px]">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={cn('border-b border-line bg-surface-muted/70 px-4 py-2.5 text-xs font-semibold text-ink-soft', className)}>{children}</th>;
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('border-b border-line px-4 py-3 align-top text-ink', className)}>{children}</td>;
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label}>
          <dt className="text-xs text-ink-soft">{i.label}</dt>
          <dd className="mt-0.5 text-sm text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}
