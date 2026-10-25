import type { AuditRow } from '@/types/domain';
import { humanize } from './format';

/**
 * Display labels for the pitch vocabulary. Internal capability keys (`scrutiny`, `decision`, ...) are never renamed:
 * they are stored in role assignments, route configuration, review tasks and audit entries. Only what people read changes.
 *
 *   scrutiny  → Scrutiny Committee
 *   decision  → Central AICTE Desk
 *   (the case-level assigned officer, `applications.assigned_officer_id`) → Regional Officer
 */
export const RESPONSIBILITY_LABELS: Readonly<Record<string, string>> = {
  scrutiny: 'Scrutiny Committee',
  decision: 'Central AICTE Desk',
};

/** The officer a case is assigned to (the RO), shown wherever the case-level assignment is labelled. */
export const REGIONAL_OFFICER_LABEL = 'Regional Officer';

/** Display name for a responsibility key; keys without a pitch label keep their plain wording (Compliance, EVC, Committee…). */
export function responsibilityLabel(key?: string | null): string {
  if (!key) return '—';
  return RESPONSIBILITY_LABELS[key] ?? humanize(key);
}

/** Audit actions that concern the case-level assignment get the Regional Officer wording; everything else keeps its plain name. */
const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  assignment_changed: `${REGIONAL_OFFICER_LABEL} assignment changed`,
};
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? humanize(action);
}

/** Responsibilities mentioned in an audit entry's recorded state or metadata (for example the ones granted by `role_granted`). */
export function auditResponsibilities(row: Pick<AuditRow, 'before_state' | 'after_state' | 'metadata'>): string[] {
  const found = new Set<string>();
  const scan = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.capabilities)) for (const c of o.capabilities) if (typeof c === 'string') found.add(c);
    for (const k of ['required_capability', 'capability', 'responsible_capability']) if (typeof o[k] === 'string') found.add(o[k] as string);
  };
  scan(row.before_state); scan(row.after_state); scan(row.metadata);
  return [...found].map(responsibilityLabel);
}
