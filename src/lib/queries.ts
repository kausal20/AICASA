import type { Deficiency } from '@/types/domain';

/** Statuses in which a query waits for the institution's answer. */
export const AWAITING = ['open', 'still_deficient', 'needs_clarification'];

/**
 * Where a query stands, from the institution's point of view. One function decides it everywhere (Query & Clarification
 * lists, the institution dashboard, the sidebar badge), so a card under "Needs your response" can always be answered.
 *   needs_response — sent to the institution (the case was returned for correction) and waiting for its answer
 *   with_aicte     — recorded by AICTE but not yet sent; nothing for the institution to do yet
 *   with_officer   — answered; awaiting the officer's re-review
 *   closed         — resolved or withdrawn
 */
export type QueryState = 'needs_response' | 'with_aicte' | 'with_officer' | 'closed';
export function queryState(d: Pick<Deficiency, 'status' | 'sent_at'> & { applications?: { status: string } | null }): QueryState {
  if (d.status === 'correction_submitted') return 'with_officer';
  if (!AWAITING.includes(d.status)) return 'closed';
  return d.sent_at && d.applications?.status === 'returned_for_correction' ? 'needs_response' : 'with_aicte';
}

/** Officer-raised queries carry the 48-hour response window; rule and older deficiencies run to their correction due date. */
export type QueryWindowKind = 'query_window' | 'correction_period';
export function windowKind(d: Pick<Deficiency, 'window_closes_at'>): QueryWindowKind {
  return d.window_closes_at ? 'query_window' : 'correction_period';
}
export function queryDeadline(d: Pick<Deficiency, 'window_closes_at' | 'due_at'>): string {
  return d.window_closes_at ?? d.due_at;
}
export const WINDOW_LABEL: Record<QueryWindowKind, string> = {
  query_window: 'Officer query · respond within 48 hours',
  correction_period: 'Deficiency correction · due date set on the item',
};
export const WINDOWS_EXPLAINED = 'Officer queries: respond within 48 hours. Deficiency corrections: due date shown on each item (typically 7 days).';

/** The responsibility needed to review answers on a case at this stage (the stage code names it on every configured route). */
export function stageResponsibility(stage?: string | null): string {
  return stage && ['scrutiny', 'evc', 'committee', 'decision'].includes(stage) ? stage : 'scrutiny';
}
