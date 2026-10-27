import type { ApplicationRow, AvailableTransition, Deficiency } from '@/types/domain';
import { AWAITING } from './queries';
import { plural } from './format';

const REVIEW_STAGES = ['scrutiny', 'evc', 'committee', 'decision'];
const CLOSED = ['completed', 'closed', 'draft', 'withdrawn'];

export interface OfficerCaseState {
  /** The officer holds the current stage's responsibility in the case's region (the server's rule for every case action). */
  responsible: boolean;
  routing: AvailableTransition[];
  blocked: AvailableTransition[];
  canRaiseQuery: boolean;
  /** Open queries that "Return to institution" would send; 0 = the action is not offered. */
  returnCount: number;
  /** Answers waiting for this officer's re-review. */
  reviewCount: number;
  hasAction: boolean;
  /** The single most important thing to do, or why there is nothing to do. */
  headline: string;
}

/**
 * Everything the officer case view says about "what can I do here" comes from this one function: the next-action card,
 * the actions panel and every banner. They cannot contradict each other.
 */
export function officerCaseState(a: ApplicationRow, transitions: AvailableTransition[] | undefined, defs: Deficiency[], responsible: boolean): OfficerCaseState {
  const closed = CLOSED.includes(a.status);
  const routing = responsible && !closed ? (transitions ?? []).filter((t) => t.permitted) : [];
  const blocked = responsible && !closed ? (transitions ?? []).filter((t) => !t.permitted) : [];
  const reviewStage = REVIEW_STAGES.includes(a.stage_kind ?? '');
  const canRaiseQuery = responsible && !closed && reviewStage;
  const openToSend = defs.filter((d) => AWAITING.includes(d.status)).length;
  const returnCount = canRaiseQuery && a.status !== 'returned_for_correction' ? openToSend : 0;
  const reviewCount = responsible ? defs.filter((d) => d.status === 'correction_submitted').length : 0;
  const hasAction = routing.length > 0 || canRaiseQuery || returnCount > 0 || reviewCount > 0;
  const headline = closed ? 'Processing complete — no further action'
    : reviewCount > 0 ? `Review ${plural(reviewCount, 'submitted correction')}`
      : returnCount > 0 ? `Return the case to send ${plural(returnCount, 'open query', 'open queries')} to the institution`
        : routing.length > 0 ? `${routing[0].name}${routing.length > 1 ? ` (or ${plural(routing.length - 1, 'other action')})` : ''}`
          : canRaiseQuery ? (a.status === 'returned_for_correction' ? 'Waiting for the institution; you can raise a further query' : 'Scrutinise the case; raise a query if anything is deficient')
            : !responsible ? 'This stage is handled by another responsibility; nothing for you to do here'
              : 'Nothing for you to do on this case right now';
  return { responsible, routing, blocked, canRaiseQuery, returnCount, reviewCount, hasAction, headline };
}
