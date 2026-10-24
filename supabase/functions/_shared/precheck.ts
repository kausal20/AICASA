// AICASA document pre-check engine (deterministic, provider-independent).
// Runs in the Edge Function (Deno), in the provisioning script (Node) and in unit tests.
// Pure TypeScript with no imports so every runtime can load it unchanged.
//
// What it does: validates the file, extracts text where it honestly can (plain text, simple text-based
// PDFs), then runs the configured checklist rules. What it never does: judge authenticity, legal
// sufficiency or approval. Anything it cannot read is reported as such and routed to manual review.

export type FindingOutcome =
  | 'passed'
  | 'potential_issue'
  | 'missing_information'
  | 'extraction_failed'
  | 'manual_review'
  | 'not_checked';

export interface Finding {
  check_code: string;
  check_name: string;
  outcome: FindingOutcome;
  severity: 'info' | 'low' | 'medium' | 'high';
  explanation: string;
  evidence?: string | null;
  page_ref?: string | null;
  suggestion?: string | null;
  confidence?: number | null;
}

export interface CheckStep {
  code: string;
  label: string;
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
}

export interface Requirement {
  doc_type: string;
  name: string;
  allowed_mime_types: string[];
  max_bytes: number;
  expiry_tracked: boolean;
  required_fields: string[];
}

export interface CheckContext {
  institutionName: string;
  academicYear?: string | null;
  /** Dates are compared against this day (YYYY-MM-DD) so tests are reproducible. */
  today: string;
  /** sha256 of other current documents on the same application, to spot duplicate uploads. */
  otherHashes?: { sha256: string; title: string }[];
  ocrAvailable?: boolean;
}

export interface FileInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string | null;
  bytes: Uint8Array;
}

export interface CheckResult {
  engine: string;
  status: 'completed' | 'failed';
  extraction_status: 'not_attempted' | 'succeeded' | 'partial' | 'failed' | 'unavailable';
  extraction_method: string | null;
  steps: CheckStep[];
  limitations: string[];
  findings: Finding[];
  summary: Record<string, number>;
  extracted_text_chars: number;
}

export const ENGINE_VERSION = 'aicasa-deterministic-v1';

const LIMITATIONS = [
  'This pre-check looks for completeness and obvious inconsistencies only.',
  'It does not verify authenticity, signatures, seals or legal sufficiency.',
  'Passing every check does not mean the document will be accepted during official scrutiny.',
];

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

interface Extraction {
  status: CheckResult['extraction_status'];
  method: string | null;
  text: string;
  pages: number | null;
  quality: number | null; // share of readable characters in extracted text, 0–1
  detail: string;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function decodePdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[c] ?? c)
    .replace(/\\([0-7]{1,3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
}

function textFromContentStream(content: string): string {
  const out: string[] = [];
  // (text) Tj   and   [(te) -20 (xt)] TJ   and  ' / " operators; T* / Td start new lines
  const re = /\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|T\*|Td|TD|ET/g;
  let m: RegExpExecArray | null;
  let line = '';
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (tok === 'T*' || tok === 'Td' || tok === 'TD' || tok === 'ET') {
      if (line.trim()) out.push(line.trim());
      line = '';
      continue;
    }
    if (m[1] !== undefined) {
      const parts = m[1].match(/\((?:\\.|[^\\)])*\)/g) ?? [];
      line += parts.map((p) => decodePdfString(p.slice(1, -1))).join('');
    } else {
      const s = tok.match(/^\(((?:\\.|[^\\)])*)\)/);
      if (s) line += decodePdfString(s[1]);
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.join('\n');
}

async function extractPdf(bytes: Uint8Array): Promise<Extraction> {
  const raw = latin1(bytes);
  if (!raw.startsWith('%PDF-')) {
    return { status: 'failed', method: 'pdf-text', text: '', pages: null, quality: null, detail: 'File does not start with a PDF header.' };
  }
  if (/\/Encrypt\b/.test(raw)) {
    return { status: 'failed', method: 'pdf-text', text: '', pages: null, quality: null, detail: 'PDF is encrypted or password-protected.' };
  }
  const pages = (raw.match(/\/Type\s*\/Page\b/g) ?? []).length || null;
  const texts: string[] = [];
  const streamRe = /<<((?:(?!>>)[\s\S])*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let unreadable = 0;
  while ((m = streamRe.exec(raw))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dict)) continue;
    let stop = end;
    while (stop > start && (raw[stop - 1] === '\n' || raw[stop - 1] === '\r')) stop--;
    let data = bytes.subarray(start, stop);
    if (/\/FlateDecode/.test(dict)) {
      const inflated = await inflate(data);
      if (!inflated) { unreadable++; continue; }
      data = inflated;
    } else if (/\/Filter/.test(dict)) {
      unreadable++;
      continue;
    }
    const t = textFromContentStream(latin1(data));
    if (t) texts.push(t);
  }
  const text = texts.join('\n');
  if (!text.trim()) {
    return {
      status: 'failed', method: 'pdf-text', text: '', pages, quality: null,
      detail: 'No machine-readable text found. The PDF may be a scanned image; OCR is required.',
    };
  }
  const printable = text.replace(/[^\x20-\x7E -ɏ\n]/g, '').length;
  const quality = Math.round((printable / Math.max(text.length, 1)) * 1000) / 1000;
  const partial = unreadable > 0 || quality < 0.85;
  return {
    status: partial ? 'partial' : 'succeeded', method: 'pdf-text', text, pages, quality,
    detail: partial
      ? 'Some content could not be read (unsupported encoding, images or very little text).'
      : `Read text from ${pages ?? 'the'} page${pages === 1 ? '' : 's'}.`,
  };
}

export async function extractText(file: FileInput, ocrAvailable = false): Promise<Extraction> {
  if (file.mimeType === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes);
    return { status: 'succeeded', method: 'plain-text', text, pages: null, quality: 1, detail: 'Read plain text.' };
  }
  if (file.mimeType === 'application/pdf') return extractPdf(file.bytes);
  if (file.mimeType.startsWith('image/')) {
    return {
      status: 'unavailable', method: ocrAvailable ? 'ocr' : null, text: '', pages: 1, quality: null,
      detail: ocrAvailable ? 'OCR adapter not yet connected.' : 'No OCR provider is configured, so images cannot be read.',
    };
  }
  return { status: 'unavailable', method: null, text: '', pages: null, quality: null, detail: 'Unsupported format for extraction.' };
}

// ---------------------------------------------------------------------------
// Field detectors (configured by document_requirements.required_fields)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export interface FoundDate { iso: string; raw: string; index: number }

function validDate(y: number, mo: number, d: number): string | null {
  if (y < 1950 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** Dates written as DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD or "12 March 2026". Indian day-first order. */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const re = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let iso: string | null = null;
    if (m[1]) iso = validDate(+m[3], +m[2], +m[1]);
    else if (m[4]) iso = validDate(+m[4], +m[5], +m[6]);
    else if (m[7]) {
      const mo = MONTHS[m[8].toLowerCase().slice(0, m[8].toLowerCase() === 'sept' ? 4 : 3)];
      if (mo) iso = validDate(+m[9], mo, +m[7]);
    }
    if (iso) out.push({ iso, raw: m[0], index: m.index });
  }
  return out;
}

function dateNear(text: string, labels: RegExp): FoundDate | null {
  const dates = findDates(text);
  let best: FoundDate | null = null;
  let bestDist = Infinity;
  let lm: RegExpExecArray | null;
  const re = new RegExp(labels.source, 'gi');
  while ((lm = re.exec(text))) {
    for (const d of dates) {
      const dist = d.index - lm.index;
      if (dist >= 0 && dist < 80 && dist < bestDist) { best = d; bestDist = dist; }
    }
  }
  return best;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\(demo\)/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['of', 'and', 'the', 'for', 'in', 'institute', 'college', 'university']);

function snippet(text: string, index: number, len = 90): string {
  const start = Math.max(0, index - 10);
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

interface FieldResult { found: boolean; evidence?: string; value?: string; explanation: string; suggestion: string }

function detectField(field: string, text: string, ctx: CheckContext): FieldResult {
  const lower = text.toLowerCase();
  switch (field) {
    case 'institution_name': {
      const wanted = normalise(ctx.institutionName).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
      const hay = normalise(text);
      const hits = wanted.filter((w) => hay.includes(w));
      const found = wanted.length > 0 && hits.length === wanted.length;
      const idx = found ? lower.indexOf(hits[0]) : -1;
      return {
        found,
        evidence: found ? snippet(text, idx) : hits.length ? `Matched only: ${hits.join(', ')}` : undefined,
        explanation: found
          ? 'The institution name on record appears in the document.'
          : 'The institution name on record was not found in the readable text.',
        suggestion: 'Make sure the document is issued in the exact registered name of the institution.',
      };
    }
    case 'academic_year': {
      const m = text.match(/\b(20\d{2})\s*[-–/]\s*(\d{2}|20\d{2})\b/);
      return {
        found: !!m, value: m ? `${m[1]}-${m[2].slice(-2)}` : undefined, evidence: m ? m[0] : undefined,
        explanation: m ? 'An academic year is stated.' : 'No academic year (e.g. 2027-28) was found.',
        suggestion: 'State the academic year the document applies to.',
      };
    }
    case 'issue_date': {
      const d = dateNear(text, /(date of issue|issued on|issue date|dated|date)/);
      return {
        found: !!d, value: d?.iso, evidence: d ? snippet(text, Math.max(0, d.index - 30)) : undefined,
        explanation: d ? 'An issue date was found.' : 'No issue date was found near an "issued/dated" label.',
        suggestion: 'Use a document that clearly states its date of issue.',
      };
    }
    case 'expiry_date': {
      const d = dateNear(text, /(valid (?:till|until|upto|up to)|validity|expir(?:y|es|ing)|valid through|lease (?:ends|end date|period ending))/);
      return {
        found: !!d, value: d?.iso, evidence: d ? snippet(text, Math.max(0, d.index - 30)) : undefined,
        explanation: d ? 'A validity/expiry date was found.' : 'No validity or expiry date was found.',
        suggestion: 'Upload a version that states its validity period or expiry date.',
      };
    }
    case 'date': {
      const d = findDates(text)[0];
      return {
        found: !!d, value: d?.iso, evidence: d?.raw,
        explanation: d ? 'The document is dated.' : 'No date was found in the readable text.',
        suggestion: 'Use a dated document.',
      };
    }
    case 'notary': {
      const m = lower.match(/notar(y|ised|ized)|sworn before|attested by/);
      return {
        found: !!m, evidence: m ? snippet(text, m.index ?? 0) : undefined,
        explanation: m ? 'Notarisation wording is present.' : 'No notarisation wording was found.',
        suggestion: 'Affidavits are expected to be notarised; upload the notarised copy.',
      };
    }
    case 'signature': {
      const m = lower.match(/signed|signature|sd\/-/);
      return {
        found: !!m, evidence: m ? snippet(text, m.index ?? 0) : undefined,
        explanation: m ? 'Signature wording is present (a signature itself cannot be verified).' : 'No signature block was found.',
        suggestion: 'Upload the signed copy.',
      };
    }
    default:
      return { found: false, explanation: `No detector is configured for "${field}".`, suggestion: 'An officer will review this item manually.' };
  }
}

const FIELD_LABELS: Record<string, string> = {
  institution_name: 'Institution name', academic_year: 'Academic year', issue_date: 'Issue date',
  expiry_date: 'Validity / expiry date', date: 'Document date', notary: 'Notarisation', signature: 'Signature block',
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runPrecheck(file: FileInput, requirement: Requirement | null, ctx: CheckContext): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const findings: Finding[] = [];
  const limitations = [...LIMITATIONS];

  // 1. File validation
  const allowed = requirement?.allowed_mime_types ?? ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
  const maxBytes = requirement?.max_bytes ?? 10485760;
  const typeOk = allowed.includes(file.mimeType);
  findings.push({
    check_code: 'file_type', check_name: 'Accepted file type', outcome: typeOk ? 'passed' : 'potential_issue',
    severity: typeOk ? 'info' : 'high',
    explanation: typeOk ? `${file.mimeType} is accepted for this document.` : `${file.mimeType} is not accepted for this document.`,
    evidence: file.fileName, suggestion: typeOk ? null : `Upload one of: ${allowed.join(', ')}.`,
  });
  const sizeOk = file.sizeBytes > 0 && file.sizeBytes <= maxBytes;
  findings.push({
    check_code: 'file_size', check_name: 'File size limit', outcome: sizeOk ? 'passed' : 'potential_issue',
    severity: sizeOk ? 'info' : 'high',
    explanation: sizeOk ? `File size ${(file.sizeBytes / 1024).toFixed(0)} KB is within the ${(maxBytes / 1048576).toFixed(0)} MB limit.`
      : `File size ${(file.sizeBytes / 1048576).toFixed(1)} MB exceeds the ${(maxBytes / 1048576).toFixed(0)} MB limit.`,
    suggestion: sizeOk ? null : 'Compress or split the document.',
  });
  steps.push({ code: 'validate_file', label: 'Checked file type and size', status: 'done' });

  // 2. Duplicate detection
  if (file.sha256 && ctx.otherHashes?.length) {
    const dup = ctx.otherHashes.find((h) => h.sha256 === file.sha256);
    findings.push({
      check_code: 'duplicate', check_name: 'Duplicate upload', outcome: dup ? 'potential_issue' : 'passed',
      severity: dup ? 'medium' : 'info',
      explanation: dup ? `This file is byte-for-byte identical to "${dup.title}" already uploaded on this application.`
        : 'No identical file is uploaded elsewhere on this application.',
      evidence: dup ? `sha256 ${file.sha256.slice(0, 12)}…` : null,
      suggestion: dup ? 'Check that the correct document was attached for each checklist item.' : null,
    });
    steps.push({ code: 'duplicates', label: 'Compared file fingerprint with other uploads', status: 'done' });
  } else {
    steps.push({ code: 'duplicates', label: 'Compared file fingerprint with other uploads', status: 'skipped',
      detail: file.sha256 ? 'No other documents to compare.' : 'No file fingerprint recorded.' });
  }

  // 3. Extraction
  const ex = typeOk ? await extractText(file, ctx.ocrAvailable) : null;
  if (!ex) {
    steps.push({ code: 'extract', label: 'Read document text', status: 'skipped', detail: 'File type not accepted.' });
  } else {
    steps.push({ code: 'extract', label: 'Read document text', status: ex.status === 'succeeded' || ex.status === 'partial' ? 'done' : 'failed', detail: ex.detail });
    if (ex.status === 'failed' || ex.status === 'unavailable') {
      findings.push({
        check_code: 'readability', check_name: 'Readable content', outcome: 'extraction_failed', severity: 'medium',
        explanation: ex.detail,
        suggestion: file.mimeType.startsWith('image/')
          ? 'Upload a text-based PDF if available. Otherwise an officer will review the image manually.'
          : 'Upload a clear, text-based PDF (not a photograph of a page).',
      });
    } else {
      findings.push({
        check_code: 'readability', check_name: 'Readable content',
        outcome: ex.status === 'partial' ? 'manual_review' : 'passed',
        severity: ex.status === 'partial' ? 'low' : 'info',
        explanation: ex.detail + (ex.pages ? ` Pages detected: ${ex.pages}.` : ''),
        evidence: `${ex.text.length} characters extracted`,
        confidence: ex.quality,
        suggestion: ex.status === 'partial' ? 'Parts of this file could not be read; an officer will check it manually.' : null,
      });
    }
  }

  const readable = ex && (ex.status === 'succeeded' || ex.status === 'partial');
  const text = readable ? ex!.text : '';

  // 4. Configured required fields
  const fields = requirement?.required_fields ?? [];
  const values: Record<string, string | undefined> = {};
  if (!requirement) {
    findings.push({
      check_code: 'checklist', check_name: 'Checklist rules', outcome: 'not_checked', severity: 'info',
      explanation: 'No checklist rule is configured for this document type, so only file checks were run.',
    });
  }
  for (const field of fields) {
    const label = FIELD_LABELS[field] ?? field;
    if (!readable) {
      findings.push({
        check_code: `field:${field}`, check_name: label, outcome: 'not_checked', severity: 'info',
        explanation: 'Not checked because the document text could not be read.',
        suggestion: 'An officer will check this item manually.',
      });
      continue;
    }
    const r = detectField(field, text, ctx);
    values[field] = r.value;
    findings.push({
      check_code: `field:${field}`, check_name: label,
      outcome: r.found ? 'passed' : (FIELD_LABELS[field] ? 'missing_information' : 'manual_review'),
      severity: r.found ? 'info' : field === 'institution_name' || field === 'expiry_date' ? 'high' : 'medium',
      explanation: r.explanation, evidence: r.evidence ?? null,
      suggestion: r.found ? null : r.suggestion,
    });
  }
  if (fields.length) steps.push({ code: 'fields', label: 'Checked required fields', status: readable ? 'done' : 'skipped' });

  // 5. Dates and consistency
  if (readable) {
    if (values.expiry_date) {
      const days = daysBetween(ctx.today, values.expiry_date);
      findings.push({
        check_code: 'expiry', check_name: 'Apparent validity', outcome: days < 0 ? 'potential_issue' : days < 90 ? 'manual_review' : 'passed',
        severity: days < 0 ? 'high' : days < 90 ? 'medium' : 'info',
        explanation: days < 0 ? `The stated expiry date (${values.expiry_date}) is ${-days} days in the past.`
          : days < 90 ? `The document appears to expire in ${days} days (${values.expiry_date}).`
          : `The stated expiry date (${values.expiry_date}) is in the future.`,
        evidence: values.expiry_date,
        suggestion: days < 0 ? 'Upload the current, renewed document.' : days < 90 ? 'Plan the renewal; a reminder will be scheduled once validity is recorded.' : null,
      });
    } else if (requirement?.expiry_tracked) {
      findings.push({
        check_code: 'expiry', check_name: 'Apparent validity', outcome: 'missing_information', severity: 'high',
        explanation: 'This document type is tracked for expiry but no validity date could be identified.',
        suggestion: 'Upload a version that states its validity period.',
      });
    }
    if (values.issue_date && values.expiry_date && values.issue_date >= values.expiry_date) {
      findings.push({
        check_code: 'date_order', check_name: 'Issue date before expiry', outcome: 'potential_issue', severity: 'medium',
        explanation: `Issue date ${values.issue_date} is not before expiry date ${values.expiry_date}.`,
        suggestion: 'Check that the dates were read correctly; an officer will review.',
      });
    }
    if (values.issue_date && values.issue_date > ctx.today) {
      findings.push({
        check_code: 'issue_future', check_name: 'Issue date not in future', outcome: 'potential_issue', severity: 'medium',
        explanation: `The issue date ${values.issue_date} is after today.`, suggestion: 'Check the issue date on the document.',
      });
    }
    if (ctx.academicYear && values.academic_year) {
      const same = values.academic_year === ctx.academicYear;
      findings.push({
        check_code: 'academic_year_match', check_name: 'Academic year matches application',
        outcome: same ? 'passed' : 'potential_issue', severity: same ? 'info' : 'high',
        explanation: same ? `The document refers to ${values.academic_year}, matching the application.`
          : `The document refers to ${values.academic_year} but the application is for ${ctx.academicYear}.`,
        evidence: values.academic_year, suggestion: same ? null : `Upload the document issued for ${ctx.academicYear}.`,
      });
    }
    steps.push({ code: 'consistency', label: 'Compared dates and values with the application', status: 'done' });
  } else {
    steps.push({ code: 'consistency', label: 'Compared dates and values with the application', status: 'skipped', detail: 'No readable text.' });
  }

  if (!ctx.ocrAvailable) limitations.push('Scanned images are not read: no OCR provider is configured.');

  const summary: Record<string, number> = {};
  for (const f of findings) summary[f.outcome] = (summary[f.outcome] ?? 0) + 1;

  return {
    engine: ENGINE_VERSION,
    status: 'completed',
    extraction_status: ex?.status ?? 'not_attempted',
    extraction_method: ex?.method ?? null,
    steps,
    limitations,
    findings,
    summary,
    extracted_text_chars: text.length,
  };
}

// ---------------------------------------------------------------------------
// Minimal PDF writer for synthetic demo/test documents (uncompressed text, Helvetica).
// ---------------------------------------------------------------------------
export function makeTextPdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 12 Tf', '14 TL', '72 760 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
