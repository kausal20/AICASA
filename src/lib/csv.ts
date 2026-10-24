/** RFC 4180 CSV with formula-injection protection for spreadsheet apps. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[], meta: string[] = []): string {
  const lines = meta.map((m) => csvEscape(`# ${m}`));
  lines.push(columns.map((c) => csvEscape(c.label)).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvEscape(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
