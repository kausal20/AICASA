export const DISPLAY_TZ = (import.meta.env.VITE_DISPLAY_TIMEZONE as string | undefined) ?? 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: DISPLAY_TZ });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DISPLAY_TZ,
});

export function fmtDate(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

export function fmtDateTime(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : `${dateTimeFmt.format(d)} IST`;
}

/** Days from now until the date (negative = past). */
export function daysUntil(v?: string | null): number | null {
  if (!v) return null;
  return Math.round((new Date(v).getTime() - Date.now()) / 86400000);
}

export function relativeDue(v?: string | null): string {
  const d = daysUntil(v);
  if (d === null) return 'No due date';
  if (d < -1) return `${-d} days overdue`;
  if (d === -1) return '1 day overdue';
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `Due in ${d} days`;
}

export function humanize(s?: string | null): string {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Outcome wording for a decision recorded by an officer. "EoA Issued" is used only for an Extension of Approval
 * (EOA) dossier whose recorded decision is an approval; other application types keep neutral wording.
 */
export function decisionLabel(decision: string, applicationType?: string): string {
  const eoa = applicationType === 'EOA';
  switch (decision) {
    case 'approved': return eoa ? 'EoA Issued' : 'Approved';
    case 'approved_with_conditions': return eoa ? 'EoA Issued (with conditions)' : 'Approved with conditions';
    case 'not_approved': return 'Dossier Rejected / Non-Compliant';
    case 'deferred': return 'Deferred';
    default: return humanize(decision);
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Local date (YYYY-MM-DD) → ISO timestamp at end of that day in the display timezone (IST is fixed +05:30). */
export function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59+05:30`).toISOString();
}

export function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });
}

/** datetime-local input value (IST wall clock) → ISO */
export function localDateTimeToIso(v: string): string {
  return new Date(`${v}:00+05:30`).toISOString();
}
