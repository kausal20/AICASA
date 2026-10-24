import { describe, expect, it } from 'vitest';
import { orderWork, workWindow, type WorkItem } from '../../src/lib/workQueue';

describe('work queue calendar boundaries', () => {
  it('ends the week at Monday midnight IST across a UTC day boundary', () => {
    expect(workWindow(new Date('2026-10-25T18:29:59Z')).weekEnd).toBe('2026-10-25T18:30:00.000Z');
    expect(workWindow(new Date('2026-10-25T18:30:00Z')).weekEnd).toBe('2026-11-01T18:30:00.000Z');
  });
  it('handles year rollover and a rolling seven-day completed window', () => {
    const window = workWindow(new Date('2026-12-31T12:00:00Z'));
    expect(window.weekEnd).toBe('2027-01-03T18:30:00.000Z');
    expect(window.recent).toBe('2026-12-24T12:00:00.000Z');
  });
});
describe('work queue ordering', () => {
  const item = (id: string, date: string | null): WorkItem => ({ id, date, title: id, detail: '', kind: 'Application', to: '/app' });
  it('puts earlier deadlines first, undated work last, without mutating input', () => {
    const items = [item('undated', null), item('later', '2026-10-25'), item('earlier', '2026-10-20')];
    expect(orderWork(items, 'now').map((r) => r.id)).toEqual(['earlier', 'later', 'undated']);
    expect(items[0].id).toBe('undated');
  });
  it('shows the most recent completion first and breaks ties predictably', () => {
    const items = [item('old', '2026-10-20'), item('b', '2026-10-24'), item('a', '2026-10-24')];
    expect(orderWork(items, 'completed').map((r) => r.id)).toEqual(['a', 'b', 'old']);
  });
});
