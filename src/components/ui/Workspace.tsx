import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import * as RD from '@radix-ui/react-dialog';
import * as DM from '@radix-ui/react-dropdown-menu';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/** Right-hand side drawer for record detail. Focus-trapped, Escape closes, slides 16px with fade. */
export function Drawer({ open, onOpenChange, title, subtitle, children, footer, width = 'md' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode;
  footer?: ReactNode; width?: 'md' | 'lg';
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-[#17211D]/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            </RD.Overlay>
            <RD.Content asChild forceMount>
              <motion.aside
                className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface shadow-pop', width === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-xl')}
                initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 24 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
                <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
                  <div className="min-w-0">
                    <RD.Title className="text-[17px] font-semibold leading-snug text-ink">{title}</RD.Title>
                    {subtitle ? <RD.Description className="mt-1 text-[13px] text-ink-soft">{subtitle}</RD.Description> : <RD.Description className="sr-only">Details</RD.Description>}
                  </div>
                  <RD.Close className="rounded-lg p-1.5 text-ink-soft hover:bg-surface-muted hover:text-ink" aria-label="Close panel"><X className="h-4 w-4" /></RD.Close>
                </header>
                <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
                {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-muted/60 px-6 py-3">{footer}</footer>}
              </motion.aside>
            </RD.Content>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}

type KpiTone = 'neutral' | 'primary' | 'warning' | 'danger' | 'accent';
const KPI_TONE: Record<KpiTone, { chip: string; value: string; bar: string }> = {
  neutral: { chip: 'bg-surface-muted text-ink-soft', value: 'text-ink', bar: 'bg-line-strong' },
  primary: { chip: 'bg-primary-soft text-primary', value: 'text-ink', bar: 'bg-primary' },
  warning: { chip: 'bg-warning-soft text-warning', value: 'text-ink', bar: 'bg-warning' },
  danger: { chip: 'bg-danger-soft text-danger', value: 'text-danger', bar: 'bg-danger' },
  accent: { chip: 'bg-accent-soft text-accent', value: 'text-ink', bar: 'bg-accent' },
};

/** Metric tile. When `to` is set the whole tile navigates to the matching filtered list. */
export function Kpi({ label, value, hint, icon: Icon, tone = 'neutral', to, loading }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: KpiTone; to?: string; loading?: boolean;
}) {
  const t = KPI_TONE[tone];
  const body = (
    <>
      <span className={cn('absolute inset-y-3 left-0 w-[3px] rounded-r-full', t.bar)} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-soft">{label}</p>
        {Icon && <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', t.chip)}><Icon className="h-4 w-4" aria-hidden /></span>}
      </div>
      <p className={cn('mt-1 text-[30px] font-semibold leading-none tracking-tight tabular', t.value)}>{loading ? <span className="inline-block h-7 w-10 animate-pulse rounded bg-surface-sunken" /> : value}</p>
      {hint && <p className="mt-2 text-xs text-ink-soft">{hint}</p>}
      {to && <ChevronRight className="absolute bottom-3 right-3 h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5" aria-hidden />}
    </>
  );
  const cls = 'group relative block overflow-hidden rounded-card border border-line bg-surface px-4 pb-4 pt-3.5 shadow-card';
  if (!to) return <div className={cls}>{body}</div>;
  return (
    <motion.div whileHover={{ y: -2 }} transition={{ duration: 0.15 }}>
      <Link to={to} className={cn(cls, 'transition-[box-shadow,border-color] duration-150 hover:border-line-strong hover:shadow-lift')}>{body}</Link>
    </motion.div>
  );
}

/** Card with a titled header row; the standard container on every workspace screen. */
export function Panel({ title, description, action, children, className, bodyClassName, tone }: {
  title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <section className={cn('min-w-0 overflow-hidden rounded-card border bg-surface shadow-card', tone === 'attention' ? 'border-[#eedcb1]' : 'border-line', className)}>
      {(title || action) && (
        <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5', tone === 'attention' ? 'border-[#f2e3bd] bg-warning-soft/50' : 'border-line')}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-ink-soft">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type SortDir = 'asc' | 'desc';
/** Column header that sorts server-side; announces the sort state to assistive tech. */
export function SortHeader({ label, field, sort, dir, onSort, className }: {
  label: string; field: string; sort: string; dir: SortDir; onSort: (field: string, dir: SortDir) => void; className?: string;
}) {
  const active = sort === field;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('border-b border-line bg-surface-muted/70 px-4 py-2.5 text-xs font-semibold text-ink-soft', className)}>
      <button className={cn('inline-flex items-center gap-1 rounded hover:text-ink', active && 'text-ink')}
        onClick={() => onSort(field, active && dir === 'asc' ? 'desc' : 'asc')}>
        {label}<Icon className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );
}

export interface RowAction { label: string; icon?: LucideIcon; onSelect: () => void; disabled?: boolean; hint?: string }
/** Overflow menu for contextual row actions. Stops row-click propagation. */
export function RowMenu({ actions, label = 'Row actions' }: { actions: RowAction[]; label?: string }) {
  return (
    <DM.Root>
      <DM.Trigger onClick={(e) => e.stopPropagation()} aria-label={label}
        className="rounded-md p-1.5 text-ink-soft hover:bg-surface-sunken hover:text-ink data-[state=open]:bg-surface-sunken">
        <MoreHorizontal className="h-4 w-4" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} onClick={(e) => e.stopPropagation()} className="z-50 min-w-[200px] rounded-xl border border-line bg-surface p-1 shadow-pop">
          {actions.map((a) => (
            <DM.Item key={a.label} disabled={a.disabled} onSelect={a.onSelect}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-[13px] text-ink outline-none data-[disabled]:cursor-not-allowed data-[disabled]:text-ink-faint hover:bg-surface-muted focus:bg-surface-muted">
              {a.icon && <a.icon className="h-3.5 w-3.5" aria-hidden />}
              <span className="flex-1">{a.label}{a.hint && <span className="block text-xs text-ink-faint">{a.hint}</span>}</span>
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <motion.span layout initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
      className="inline-flex items-center gap-1 rounded-full border border-[#c9e0d9] bg-primary-soft py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary-ink">
      {label}
      <button onClick={onRemove} className="rounded-full p-0.5 hover:bg-white/70" aria-label={`Remove filter ${label}`}><X className="h-3 w-3" /></button>
    </motion.span>
  );
}

/** Segmented quick-filter bar (e.g. All / Needs action / Overdue). */
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-xl bg-surface-sunken p-1">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn('relative rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors', value === o.value ? 'text-ink' : 'text-ink-soft hover:text-ink')}>
          {value === o.value && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 rounded-lg bg-surface shadow-card" transition={{ duration: 0.2 }} />}
          <span className="relative">{o.label}{o.count !== undefined && <span className="ml-1.5 tabular text-ink-faint">{o.count}</span>}</span>
        </button>
      ))}
    </div>
  );
}

/** Expandable group, used for blocked actions and secondary detail. */
export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left text-[13px] font-medium text-ink-soft hover:text-ink">
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />{summary}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="pt-2">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Page heading band used across the workspace. */
export function PageTitle({ title, description, actions, meta }: { title: string; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-[14px] leading-relaxed text-ink-soft">{description}</p>}
        {meta && <div className="mt-2.5 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
