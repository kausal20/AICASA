/** Helpers for the Query & Clarification response window (opens when a query is raised, closes after a configured number of hours). */

/** Close time = open time + whole hours, exactly. */
export function windowCloseAt(openedAt: Date, hours: number): Date {
  return new Date(openedAt.getTime() + hours * 3_600_000);
}

export interface WindowState { hasWindow: boolean; closed: boolean; remainingMs: number }

export function windowState(closesAt: string | null | undefined, now: number = Date.now()): WindowState {
  if (!closesAt) return { hasWindow: false, closed: false, remainingMs: 0 };
  const remainingMs = new Date(closesAt).getTime() - now;
  return { hasWindow: true, closed: remainingMs <= 0, remainingMs };
}

/** "37h 12m left", "<1m left" or "Window expired". Minutes are rounded down. */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'Window expired';
  const mins = Math.floor(remainingMs / 60_000);
  if (mins < 1) return '<1m left';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m left`;
}
