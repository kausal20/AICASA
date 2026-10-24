import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { extractText, findDates, makeTextPdf, runPrecheck, sha256Hex, type Requirement } from '@shared/precheck';

const fireReq: Requirement = {
  doc_type: 'fire_safety_certificate', name: 'Fire safety certificate',
  allowed_mime_types: ['application/pdf', 'image/png'], max_bytes: 5 * 1048576, expiry_tracked: true,
  required_fields: ['institution_name', 'issue_date', 'expiry_date'],
};
const affReq: Requirement = {
  doc_type: 'affidavit', name: 'Affidavit', allowed_mime_types: ['application/pdf'], max_bytes: 5 * 1048576,
  expiry_tracked: false, required_fields: ['institution_name', 'academic_year', 'notary'],
};
const ctx = { institutionName: 'Nirmala Institute of Technology (Demo)', academicYear: '2027-28', today: '2026-10-23' };

function pdfFile(lines: string[], name = 'doc.pdf') {
  const bytes = makeTextPdf(lines);
  return { fileName: name, mimeType: 'application/pdf', sizeBytes: bytes.length, bytes };
}

describe('date parsing', () => {
  it('reads Indian day-first and long-form dates and rejects impossible ones', () => {
    expect(findDates('Issued 05/01/2026').map((d) => d.iso)).toEqual(['2026-01-05']);
    expect(findDates('valid till 31.03.2029').map((d) => d.iso)).toEqual(['2029-03-31']);
    expect(findDates('on 12 March 2026 and 2026-04-01').map((d) => d.iso)).toEqual(['2026-03-12', '2026-04-01']);
    expect(findDates('31/02/2026')).toEqual([]);
  });
});

describe('extraction', () => {
  it('extracts text from an uncompressed PDF', async () => {
    const ex = await extractText(pdfFile(['Hello AICASA', 'Second line']));
    expect(ex.status).toBe('succeeded');
    expect(ex.text).toContain('Hello AICASA');
  });

  it('extracts text from a Flate-compressed PDF stream', async () => {
    const content = 'BT /F1 12 Tf 72 700 Td (Compressed text Nirmala) Tj ET';
    const z = deflateSync(Buffer.from(content, 'latin1'));
    const head = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
    const tail = Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1');
    const bytes = new Uint8Array(Buffer.concat([head, z, tail]));
    const ex = await extractText({ fileName: 'z.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, bytes });
    expect(ex.text).toContain('Compressed text Nirmala');
  });

  it('reports images as unreadable without OCR instead of guessing', async () => {
    const ex = await extractText({ fileName: 's.png', mimeType: 'image/png', sizeBytes: 10, bytes: new Uint8Array(10) });
    expect(ex.status).toBe('unavailable');
    expect(ex.text).toBe('');
  });

  it('fails honestly for a PDF with no text layer', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF');
    const ex = await extractText({ fileName: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, bytes });
    expect(ex.status).toBe('failed');
  });
});

describe('runPrecheck', () => {
  it('flags a missing expiry date on an expiry-tracked document, with evidence and suggestion', async () => {
    const r = await runPrecheck(pdfFile([
      'FIRE SAFETY CERTIFICATE (SYNTHETIC DEMO DOCUMENT)',
      'Issued to: Nirmala Institute of Technology (Demo)', 'Date of issue: 05/01/2026',
    ]), fireReq, ctx);
    const exp = r.findings.find((f) => f.check_code === 'field:expiry_date')!;
    expect(exp.outcome).toBe('missing_information');
    expect(exp.suggestion).toMatch(/validity/);
    expect(r.findings.find((f) => f.check_code === 'field:institution_name')!.outcome).toBe('passed');
    expect(r.findings.find((f) => f.check_code === 'field:issue_date')!.outcome).toBe('passed');
    expect(r.extraction_status).toBe('succeeded');
  });

  it('flags an expired document and an academic-year mismatch', async () => {
    const fire = await runPrecheck(pdfFile(['Issued to Nirmala Institute of Technology', 'Date of issue: 01/04/2023', 'Valid till 31/03/2026']), fireReq, ctx);
    expect(fire.findings.find((f) => f.check_code === 'expiry')!.outcome).toBe('potential_issue');
    const aff = await runPrecheck(pdfFile(['Affidavit by Nirmala Institute of Technology', 'Academic year 2026-27', 'Sworn before Notary Public']), affReq, ctx);
    const yr = aff.findings.find((f) => f.check_code === 'academic_year_match')!;
    expect(yr.outcome).toBe('potential_issue');
    expect(yr.explanation).toContain('2026-27');
  });

  it('passes a complete document but still states its limitations', async () => {
    const r = await runPrecheck(pdfFile(['Affidavit by Nirmala Institute of Technology', 'Academic year 2027-28', 'Sworn before Notary Public, Pune']), affReq, ctx);
    expect(r.findings.filter((f) => f.outcome !== 'passed')).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/does not verify authenticity/);
    expect(JSON.stringify(r)).not.toMatch(/guarantee|will be approved|authentic document/i);
  });

  it('marks field checks as not checked when text cannot be read, never as passed', async () => {
    const r = await runPrecheck({ fileName: 'scan.png', mimeType: 'image/png', sizeBytes: 1000, bytes: new Uint8Array(1000) }, fireReq, ctx);
    expect(r.findings.find((f) => f.check_code === 'readability')!.outcome).toBe('extraction_failed');
    for (const f of r.findings.filter((x) => x.check_code.startsWith('field:'))) expect(f.outcome).toBe('not_checked');
    expect(r.findings.every((f) => f.confidence === undefined || f.confidence === null || typeof f.confidence === 'number')).toBe(true);
  });

  it('rejects disallowed file types and oversized files', async () => {
    const r = await runPrecheck({ fileName: 'x.docx', mimeType: 'application/msword', sizeBytes: 9 * 1048576, bytes: new Uint8Array(5) }, fireReq, ctx);
    expect(r.findings.find((f) => f.check_code === 'file_type')!.outcome).toBe('potential_issue');
    expect(r.findings.find((f) => f.check_code === 'file_size')!.outcome).toBe('potential_issue');
    expect(r.steps.find((s) => s.code === 'extract')!.status).toBe('skipped');
  });

  it('detects duplicate uploads by fingerprint', async () => {
    const f = pdfFile(['Nirmala Institute of Technology']);
    const h = await sha256Hex(f.bytes);
    const r = await runPrecheck({ ...f, sha256: h }, affReq, { ...ctx, otherHashes: [{ sha256: h, title: 'Fire safety certificate' }] });
    expect(r.findings.find((x) => x.check_code === 'duplicate')!.outcome).toBe('potential_issue');
  });

  it('lists only steps actually performed', async () => {
    const r = await runPrecheck(pdfFile(['Nirmala Institute of Technology']), affReq, ctx);
    expect(r.steps.map((s) => s.code)).toEqual(['validate_file', 'duplicates', 'extract', 'fields', 'consistency']);
    expect(r.steps.find((s) => s.code === 'duplicates')!.status).toBe('skipped');
  });
});
