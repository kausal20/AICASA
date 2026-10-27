export const DISPLAY_TZ = (import.meta.env.VITE_DISPLAY_TIMEZONE as string | undefined) ?? 'Asia/Kolkata';

/*
 * One date/time format for the whole app: "27 Oct 2026" and "27 Oct 2026, 1:20 PM IST".
 * Deadlines follow one date-only policy: a due date is compared at 23:59:59 IST, so something due today is "Due today",
 * never overdue, and every page counts days between IST calendar dates with the same function (calendarDaysUntil).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const partsFmt = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: DISPLAY_TZ,
});

function toDate(v: string | Date): Date {
  if (v instanceof Date) return v;
  // a bare date (YYYY-MM-DD) is a calendar date in IST, not UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00+05:30`);
  // Postgres text form: "2026-10-26 08:30:00+00" (space separator, hour-only offset)
  return new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
}

function parts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: p.hour, min: p.minute, ap: (p.dayPeriod ?? '').toUpperCase() };
}

/** "27 Oct 2026" */
export function fmtDate(v?: string | Date | null): string {
  if (!v) return '—';
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return '—';
  const p = parts(d);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** "27 Oct 2026, 1:20 PM IST" */
export function fmtDateTime(v?: string | Date | null): string {
  if (!v) return '—';
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return '—';
  const p = parts(d);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}, ${p.h}:${p.min} ${p.ap} IST`;
}

/** IST calendar date (YYYY-MM-DD) of an instant or a bare date. */
export function istDay(v: string | Date): string {
  const d = toDate(v);
  const p = parts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function todayLocal(now: Date = new Date()): string {
  return istDay(now);
}

/** Whole IST calendar days from today to the due date: 0 = due today, negative = that many days overdue. */
export function calendarDaysUntil(v?: string | Date | null, now: Date = new Date()): number | null {
  if (!v) return null;
  const d = toDate(v);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((Date.parse(`${istDay(d)}T00:00:00Z`) - Date.parse(`${istDay(now)}T00:00:00Z`)) / 86_400_000);
}

/** @deprecated use calendarDaysUntil; kept for callers that only need the sign. */
export const daysUntil = (v?: string | null) => calendarDaysUntil(v);

/** "2 days", "1 day", "1 item needs", "3 items need": every count-driven phrase goes through here. */
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : many ?? `${one}s`}`;
}
export function verb(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';
export function dueState(v?: string | Date | null, now: Date = new Date()): DueState {
  const n = calendarDaysUntil(v, now);
  if (n === null) return 'none';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return n <= 3 ? 'soon' : 'later';
}

/** "Due today", "Due tomorrow", "5 days left", "14 days overdue". */
export function relativeDue(v?: string | Date | null, now: Date = new Date()): string {
  const n = calendarDaysUntil(v, now);
  if (n === null) return 'No due date';
  if (n < 0) return `${plural(-n, 'day')} overdue`;
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  return `${plural(n, 'day')} left`;
}

/** For past/future events that are not deadlines (expiry dates, sessions): "14 days ago", "in 41 days", "today". */
export function relativeDay(v?: string | Date | null, now: Date = new Date()): string {
  const n = calendarDaysUntil(v, now);
  if (n === null) return '—';
  if (n === 0) return 'today';
  return n < 0 ? `${plural(-n, 'day')} ago` : `in ${plural(n, 'day')}`;
}

/** Plain words for internal codes people would otherwise read (rule codes, programme levels, document types, field keys). */
const CODE_LABELS: Record<string, string> = {
  ug_engg: 'UG Engineering', pg_engg: 'PG Engineering', diploma: 'Diploma',
  STAGE_DUE_REMINDER: 'Stage due reminder', STAGE_OVERDUE_ESCALATION: 'Stage overdue', DEFICIENCY_DUE_REMINDER: 'Query due reminder',
  DEFICIENCY_OVERDUE_ESCALATION: 'Query overdue', DEFICIENCY_WINDOW_EXPIRED: 'Query window expired', EVC_SCHEDULING_REMINDER: 'EVC scheduling reminder',
  EVC_OVERDUE_ESCALATION: 'EVC overdue', OBLIGATION_DUE_REMINDER: 'Obligation due reminder', OBLIGATION_OVERDUE_ESCALATION: 'Obligation overdue',
  VALIDITY_RENEWAL_REMINDER: 'Renewal reminder', VALIDITY_EXPIRED_ESCALATION: 'Document expired',
  student_count: 'students', faculty_count: 'faculty', computer_count: 'computers', library_book_count: 'library books', lab_count: 'laboratories',
  approved_intake: 'approved intake', proposed_intake: 'proposed intake', intake_increase: 'an intake increase', land_area_acres: 'land area',
  built_up_area_sqm: 'built-up area', programme_level: 'programme level', principal_count: 'Principals',
  faculty_professors: 'Professors', faculty_associate_professors: 'Associate Professors', faculty_assistant_professors: 'Assistant Professors',
  file_type: 'File type', file_size: 'File size', land_lease_deed: 'Land lease deed', annual_return: 'Annual return',
  fire_safety_certificate: 'Fire safety certificate', building_plan_approval: 'Building plan approval', bank_solvency_certificate: 'Bank solvency certificate',
  board_resolution: 'Governing body resolution', compliance_report: 'Compliance report', occupancy_certificate: 'Occupancy certificate',
  faculty_list: 'Faculty list', affidavit: 'Affidavit',
};
export function codeLabel(code?: string | null): string {
  if (!code) return '—';
  return CODE_LABELS[code] ?? humanize(code.toLowerCase());
}

/**
 * Text produced by the server or extracted from documents, made readable: known codes become words, ISO timestamps and
 * day-first dates (05/01/2026) become "5 Jan 2026". Nothing else is changed.
 */
export function plainText(s?: string | null): string {
  if (!s) return '';
  return s
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}(:?\d{2})?|Z)?\b/g, (m) => fmtDateTime(m))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => fmtDate(m))
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d, mo, y) => (Number(mo) >= 1 && Number(mo) <= 12 ? `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}` : m))
    .replace(/\b[A-Za-z]+(?:_[A-Za-z]+)+\b/g, (m) => CODE_LABELS[m] ?? m.replace(/_/g, ' '));
}

export function humanize(s?: string | null): string {
  if (!s) return '—';
  if (CODE_LABELS[s]) return CODE_LABELS[s].charAt(0).toUpperCase() + CODE_LABELS[s].slice(1);
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

/** datetime-local input value (IST wall clock) → ISO */
export function localDateTimeToIso(v: string): string {
  return new Date(`${v}:00+05:30`).toISOString();
}

/** "Due 1 Nov 2026" / "Session 22 Oct 2026, 7:30 AM IST" for a notification, from the live record. Time-precise subjects keep the time. */
export function notificationDue(n: { subject_due_at?: string | null; subject_due_label?: string | null; entity_type?: string | null }): string | null {
  if (!n.subject_due_at) return null;
  const precise = ['deficiency', 'deficiency_window', 'evc', 'evc_schedule'].includes(n.entity_type ?? '');
  return `${n.subject_due_label ?? 'Due'} ${precise ? fmtDateTime(n.subject_due_at) : fmtDate(n.subject_due_at)}`;
}
