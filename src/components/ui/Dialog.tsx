import * as RD from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Accessible modal (focus trap, Escape, labelled) with a restrained 98%→100% scale + fade. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode;
  footer?: ReactNode; size?: 'md' | 'lg';
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <RD.Portal forceMount>
            <RD.Overlay asChild forceMount>
              <motion.div className="fixed inset-0 z-50 bg-[#0F172A]/35" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
            </RD.Overlay>
            <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
              <RD.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
                <motion.div
                  className={cn('flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-pop sm:rounded-2xl', size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg')}
                  initial={{ opacity: 0, scale: 0.98, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 8 }}
                  transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                    <div>
                      <RD.Title className="text-base font-semibold text-ink">{title}</RD.Title>
                      {description ? <RD.Description className="mt-1 text-[13px] text-ink-soft">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
                    </div>
                    <RD.Close className="rounded-md p-1 text-ink-soft hover:bg-surface-muted hover:text-ink" aria-label="Close">
                      <X className="h-4 w-4" />
                    </RD.Close>
                  </div>
                  <div className="overflow-y-auto px-5 py-4">{children}</div>
                  {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-muted/60 px-5 py-3 sm:rounded-b-2xl">{footer}</div>}
                </motion.div>
              </RD.Content>
            </div>
          </RD.Portal>
        )}
      </AnimatePresence>
    </RD.Root>
  );
}
