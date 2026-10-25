/**
 * Arithmetic behind the "Required count" and "Cadre ratio" Deficiency Matrix rule kinds.
 * The database evaluates the real rules (deficiency_matrix); this module mirrors the same arithmetic so the rule editor can
 * preview a worked example and so the formulas have unit tests. A database test checks both implementations agree.
 */

export interface RequiredCountRule { factor?: number; divisor?: number }

/** required = ceil(base x factor) or ceil(base / divisor). Exactly one of factor / divisor must be given and positive. */
export function requiredCount(base: number, rule: RequiredCountRule): number {
  const { factor, divisor } = rule;
  if ((factor === undefined) === (divisor === undefined)) throw new Error('Give exactly one of factor or divisor.');
  const k = factor ?? divisor!;
  if (!Number.isFinite(k) || k <= 0) throw new Error('The factor or divisor must be a finite number greater than zero.');
  if (!Number.isFinite(base) || base < 0) throw new Error('The base figure must be a finite, non-negative number.');
  const raw = factor !== undefined ? base * factor : base / divisor!;
  // trim binary floating-point noise (10 x 0.7 = 7.000000000000001) before rounding up
  return Math.ceil(Number(raw.toFixed(9)));
}

export interface CadreSplit { total: number; parts: number[] }

/**
 * Required faculty = ceil(intake / divisor), split by the cadre ratio using largest-remainder rounding so the parts always
 * add up to the total. Worked example (UG Engg, divisor 20, ratio 1:2:6): intake 480 -> 24 faculty -> 3 / 5 / 16.
 * Ties between equal remainders go to the larger ratio part.
 */
export function cadreSplit(intake: number, divisor: number, ratios: number[] = [1, 2, 6]): CadreSplit {
  if (!Number.isFinite(intake) || intake < 0) throw new Error('The intake must be a finite, non-negative number.');
  if (!Number.isFinite(divisor) || divisor <= 0) throw new Error('The divisor must be a finite number greater than zero.');
  if (ratios.length === 0 || ratios.some((r) => !Number.isInteger(r) || r <= 0)) throw new Error('Cadre ratio parts must be positive whole numbers.');
  const total = Math.ceil(Number((intake / divisor).toFixed(9)));
  const sum = ratios.reduce((a, b) => a + b, 0);
  const parts = ratios.map((r) => Math.floor((total * r) / sum));
  const rem = ratios.map((r) => (total * r) % sum);
  let left = total - parts.reduce((a, b) => a + b, 0);
  while (left > 0) {
    let best = 0;
    for (let i = 1; i < ratios.length; i++) if (rem[i] > rem[best] || (rem[i] === rem[best] && ratios[i] > ratios[best])) best = i;
    parts[best] += 1;
    rem[best] = -1;
    left -= 1;
  }
  return { total, parts };
}

/** The sentence a failing Required-count rule produces, in the style the deficiency list uses. */
export function requiredCountMessage(subject: string, required: number, noun: string, declared: number): string {
  return declared >= required
    ? `${subject} requires ${required} ${noun}; ${declared} declared.`
    : `${subject} requires ${required} ${noun}, only ${declared} declared — Deficiency detected.`;
}
