import { describe, expect, it } from 'vitest';
import { changesOnly, diffLines, diffStats, textLines } from '@/lib/textDiff';
import { formatRemaining, windowCloseAt, windowState } from '@/lib/queryWindow';

const OLD = ['FIRE SAFETY CERTIFICATE', 'Issued to Sahyadri College', 'Valid till 31/03/2026', 'Hostel block: A', 'Inspector: R. Kulkarni'].join('\n');
const NEW = ['FIRE SAFETY CERTIFICATE', 'Issued to Sahyadri College', 'Valid till 31/03/2029', 'Inspector: R. Kulkarni', 'Renewed on 02/10/2026'].join('\n');

describe('diffLines', () => {
  it('reports one changed line, one removed line and one added line; unchanged lines stay out of the changes', () => {
    const d = diffLines(OLD, NEW);
    expect(changesOnly(d).map((x) => `${x.kind === 'added' ? '+' : '-'} ${x.text}`)).toEqual([
      '- Valid till 31/03/2026',
      '- Hostel block: A',
      '+ Valid till 31/03/2029',
      '+ Renewed on 02/10/2026',
    ]);
    expect(diffStats(d)).toEqual({ added: 2, removed: 2, unchanged: 3 });
  });
  it('numbers lines from both texts and ignores trailing whitespace and blank lines', () => {
    const d = diffLines('a  \nb\n\n', 'a\nb\nc');
    expect(d).toEqual([
      { kind: 'same', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'same', text: 'b', oldNo: 2, newNo: 2 },
      { kind: 'added', text: 'c', newNo: 3 },
    ]);
  });
  it('identical texts have no changes; empty texts are handled', () => {
    expect(changesOnly(diffLines(OLD, OLD))).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
    expect(diffLines('', 'x').map((l) => l.kind)).toEqual(['added']);
    expect(diffLines('x', '').map((l) => l.kind)).toEqual(['removed']);
    expect(textLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('query window helpers', () => {
  it('close time is exactly open + 48 hours', () => {
    const open = new Date('2026-10-25T04:10:00.000Z');
    expect(windowCloseAt(open, 48).toISOString()).toBe('2026-10-27T04:10:00.000Z');
  });
  it('formats the remaining time and the expired state', () => {
    expect(formatRemaining((37 * 60 + 12) * 60_000 + 59_000)).toBe('37h 12m left');
    expect(formatRemaining(59 * 60_000)).toBe('0h 59m left');
    expect(formatRemaining(30_000)).toBe('<1m left');
    expect(formatRemaining(0)).toBe('Window expired');
    expect(formatRemaining(-5)).toBe('Window expired');
  });
  it('a missing window means no window; the window is closed exactly at its close time', () => {
    expect(windowState(null).hasWindow).toBe(false);
    const close = '2026-10-27T04:10:00.000Z';
    const at = new Date(close).getTime();
    expect(windowState(close, at - 1)).toMatchObject({ hasWindow: true, closed: false });
    expect(windowState(close, at)).toMatchObject({ closed: true });
  });
});
