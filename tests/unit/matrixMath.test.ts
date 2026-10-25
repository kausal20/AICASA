import { describe, expect, it } from 'vitest';
import { cadreSplit, requiredCount, requiredCountMessage } from '@/lib/matrixMath';

describe('requiredCount', () => {
  it('divisor: 1:4 computers for 480 students is 120; rounds up', () => {
    expect(requiredCount(480, { divisor: 4 })).toBe(120);
    expect(requiredCount(481, { divisor: 4 })).toBe(121);
    expect(requiredCount(0, { divisor: 4 })).toBe(0);
  });
  it('factor: base x factor, rounded up, immune to floating-point noise', () => {
    expect(requiredCount(480, { factor: 10 })).toBe(4800);
    expect(requiredCount(10, { factor: 0.7 })).toBe(7); // 10 * 0.7 = 7.000000000000001 in floating point
    expect(requiredCount(3, { factor: 0.1 })).toBe(1);
  });
  it('rejects bad configuration and bad input', () => {
    expect(() => requiredCount(10, {})).toThrow(/exactly one/);
    expect(() => requiredCount(10, { factor: 2, divisor: 2 })).toThrow(/exactly one/);
    expect(() => requiredCount(10, { divisor: 0 })).toThrow(/greater than zero/);
    expect(() => requiredCount(10, { factor: -1 })).toThrow(/greater than zero/);
    expect(() => requiredCount(-1, { divisor: 4 })).toThrow(/non-negative/);
    expect(() => requiredCount(Number.NaN, { divisor: 4 })).toThrow(/finite/);
  });
  it('message matches the deficiency style', () => {
    expect(requiredCountMessage('Sanctioned intake', 120, 'computers', 95)).toBe('Sanctioned intake requires 120 computers, only 95 declared — Deficiency detected.');
    expect(requiredCountMessage('Sanctioned intake', 120, 'computers', 120)).toBe('Sanctioned intake requires 120 computers; 120 declared.');
  });
});

describe('cadreSplit', () => {
  it('worked example: S = 480 -> 24 faculty -> 3 Professors / 5 Associate / 16 Assistant', () => {
    expect(cadreSplit(480, 20)).toEqual({ total: 24, parts: [3, 5, 16] });
  });
  it('programme-dependent divisors: PG Engg 1:15, Diploma 1:25', () => {
    expect(cadreSplit(300, 15)).toEqual({ total: 20, parts: [2, 5, 13] });
    expect(cadreSplit(250, 25)).toEqual({ total: 10, parts: [1, 2, 7] });
  });
  it('parts always add up to the total and follow the ratio within one person', () => {
    for (let s = 0; s <= 1500; s += 7) {
      for (const d of [15, 20, 25]) {
        const { total, parts } = cadreSplit(s, d);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(total).toBe(Math.ceil(s / d));
        [1, 2, 6].forEach((r, i) => expect(Math.abs(parts[i] - (total * r) / 9)).toBeLessThan(1));
      }
    }
  });
  it('zero intake needs no faculty; bad input is rejected', () => {
    expect(cadreSplit(0, 20)).toEqual({ total: 0, parts: [0, 0, 0] });
    expect(() => cadreSplit(-1, 20)).toThrow();
    expect(() => cadreSplit(100, 0)).toThrow();
    expect(() => cadreSplit(100, 20, [1, 0, 6])).toThrow();
    expect(() => cadreSplit(100, 20, [1, 2.5, 6])).toThrow();
  });
});
