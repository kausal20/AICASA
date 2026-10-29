import type { AuditRow } from '@/types/domain';
import { codeLabel, humanize } from './format';

/** What makes an audit entry different from another of the same action on the same case: the document, the stage, the notices. */
export function auditDetail(r: Pick<AuditRow, 'action' | 'after_state' | 'detail'>): string | null {
  if (r.detail) return r.detail;
  const after = (r.after_state ?? {}) as Record<string, unknown>;
  if (r.action === 'escalation_triggered' && Array.isArray(after.notices)) {
    const byRule = new Map<string, number[]>();
    for (const n of after.notices as { rule?: string; notice?: number }[]) byRule.set(n.rule ?? '', [...(byRule.get(n.rule ?? '') ?? []), n.notice ?? 0]);
    return [...byRule].map(([rule, ns]) => `${codeLabel(rule)} · ${ns.length === 1 ? `notice ${ns[0]}` : `notices ${ns.join(', ')}`}`).join('; ');
  }
  if (typeof after.status === 'string' && r.action !== 'document_check_completed') return `→ ${humanize(after.status)}`;
  return null;
}

/** An entry is shown once: same case, action, actor, timestamp and detail collapse to a single row. */
export function uniqueAudit<T extends Pick<AuditRow, 'id' | 'action' | 'application_id' | 'actor_id' | 'actor_kind' | 'created_at' | 'detail' | 'after_state' | 'before_state' | 'entity_id'>>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    // the same case, action, actor, timestamp and state change (entity and before/after) is one event
    const sig = [r.application_id, r.action, r.actor_kind, r.actor_id, r.created_at, r.entity_id, auditDetail(r), JSON.stringify(r.before_state), JSON.stringify(r.after_state)].join('|');
    if (seen.has(String(r.id)) || seen.has(sig)) return false;
    seen.add(String(r.id)); seen.add(sig);
    return true;
  });
}
