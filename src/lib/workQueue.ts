export type WorkBucket = 'now' | 'week' | 'waiting' | 'completed';
export interface WorkItem { id: string; title: string; detail: string; to: string; date: string | null; kind: string; completed?: boolean; caseId?: string | null }
export interface WorkCounts { applications: number; tasks: number; obligations: number; escalations: number }

/** Monday–Sunday calendar week in IST; independent of the browser timezone. */
export function workWindow(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const days = (7 - ist.getUTCDay()) % 7;
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days + 1) - 330 * 60_000;
  const todayStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000;
  return {
    now: now.toISOString(), weekStart: new Date(end - 7 * 86400_000).toISOString(), weekEnd: new Date(end).toISOString(),
    recent: new Date(now.getTime() - 7 * 86400_000).toISOString(),
    /** Start of today in IST: anything due before it is overdue under the date-only policy. */
    todayStart: new Date(todayStart).toISOString(),
  };
}

export function orderWork(items: WorkItem[], bucket: WorkBucket) {
  return [...items].sort((a, b) => {
    const x = a.date ? Date.parse(a.date) : Number.POSITIVE_INFINITY;
    const y = b.date ? Date.parse(b.date) : Number.POSITIVE_INFINITY;
    return (bucket === 'completed' ? y - x : x - y) || a.id.localeCompare(b.id);
  });
}

/** A case appears once: its most urgent item (the first after ordering) stands for it; items without a case are kept. */
export function onePerCase(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (!i.caseId) return true;
    if (seen.has(i.caseId)) return false;
    seen.add(i.caseId);
    return true;
  });
}
