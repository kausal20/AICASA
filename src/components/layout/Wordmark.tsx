import { cn } from '@/lib/cn';

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7', className)} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#176B5B" />
      <path d="M9 22 16 9l7 13" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 18h8" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ invert, compact }: { invert?: boolean; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Mark />
      <span className="leading-tight">
        <span className={cn('block text-[15px] font-semibold tracking-tight', invert ? 'text-white' : 'text-ink')}>AICASA</span>
        {!compact && <span className={cn('block text-[11px]', invert ? 'text-white/70' : 'text-ink-soft')}>SIH26262 prototype</span>}
      </span>
    </span>
  );
}
