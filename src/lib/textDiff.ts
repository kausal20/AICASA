/**
 * Line-level text comparison for the "Compare with the earlier version" view. Works on the text the document pre-check
 * extracted from each version; it says nothing about layout, images, signatures or seals.
 */
export type DiffKind = 'same' | 'added' | 'removed';
export interface DiffLine { kind: DiffKind; text: string; oldNo?: number; newNo?: number }

/** Splits into lines, trims trailing whitespace and drops trailing blank lines so formatting noise is not a change. */
export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence diff. Removed lines come before the added lines that replace them. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = textLines(oldText);
  const b = textLines(newText);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ kind: 'removed', text: a[i], oldNo: i + 1 }); i++; }
    else { out.push({ kind: 'added', text: b[j], newNo: j + 1 }); j++; }
  }
  while (i < n) { out.push({ kind: 'removed', text: a[i], oldNo: i + 1 }); i++; }
  while (j < m) { out.push({ kind: 'added', text: b[j], newNo: j + 1 }); j++; }
  return out;
}

/** The changed lines only (the officer's default view). */
export function changesOnly(diff: DiffLine[]): DiffLine[] {
  return diff.filter((d) => d.kind !== 'same');
}

export function diffStats(diff: DiffLine[]): { added: number; removed: number; unchanged: number } {
  return {
    added: diff.filter((d) => d.kind === 'added').length,
    removed: diff.filter((d) => d.kind === 'removed').length,
    unchanged: diff.filter((d) => d.kind === 'same').length,
  };
}
