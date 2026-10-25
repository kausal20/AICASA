// Supabase Edge Function: document-precheck
// POST { document_version_id } with the user's Authorization header.
// 1. Opens a check run *as the user* (start_document_check enforces ownership).
// 2. Downloads the private object with the service role, runs the deterministic engine.
// 3. Records the result with complete_document_check (service-role only).
// The file never leaves the platform; no AI/OCR provider is called unless configured.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { runPrecheck, sha256Hex, ENGINE_VERSION, type Requirement } from '../_shared/precheck.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Sign in is required.' }, 401);

  let body: { document_version_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  if (!body.document_version_id || !/^[0-9a-f-]{36}$/.test(body.document_version_id)) {
    return json({ error: 'document_version_id is required.' }, 400);
  }

  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const admin = createClient(url, service, { auth: { persistSession: false } });

  const { data: run, error: startErr } = await asUser.rpc('start_document_check', { p_document_version_id: body.document_version_id });
  if (startErr) return json({ error: startErr.message }, 403);

  const fail = async (message: string) => {
    await admin.rpc('complete_document_check', {
      p_run_id: run.id, p_engine: ENGINE_VERSION, p_status: 'failed', p_extraction_status: 'not_attempted',
      p_extraction_method: null, p_steps: [], p_limitations: [], p_summary: {}, p_findings: [], p_error: message,
    });
    return json({ run_id: run.id, status: 'failed', error: message }, 200);
  };

  try {
    const { data: ver } = await admin.from('document_versions')
      .select('id, storage_bucket, storage_path, file_name, mime_type, size_bytes, sha256, document:documents(id, doc_type, title, application_id, institution_id)')
      .eq('id', body.document_version_id).single();
    if (!ver) return await fail('Document version not found.');
    const doc = ver.document as unknown as { id: string; doc_type: string; title: string; application_id: string | null; institution_id: string };

    const { data: inst } = await admin.from('institutions').select('name').eq('id', doc.institution_id).single();
    let requirement: Requirement | null = null;
    let academicYear: string | null = null;
    let otherHashes: { sha256: string; title: string }[] = [];
    if (doc.application_id) {
      const { data: app } = await admin.from('applications')
        .select('application_type_code, checklist_version, academic_year').eq('id', doc.application_id).single();
      academicYear = app?.academic_year ?? null;
      const { data: reqRow } = await admin.from('document_requirements')
        .select('doc_type, name, allowed_mime_types, max_bytes, expiry_tracked, required_fields')
        .eq('application_type_code', app?.application_type_code).eq('checklist_version', app?.checklist_version)
        .eq('doc_type', doc.doc_type).maybeSingle();
      requirement = reqRow as Requirement | null;
      const { data: others } = await admin.from('documents')
        .select('id, title, current_version, document_versions(version, sha256)').eq('application_id', doc.application_id).neq('id', doc.id);
      otherHashes = (others ?? []).flatMap((d: { title: string; current_version: number; document_versions: { version: number; sha256: string | null }[] }) =>
        d.document_versions.filter((v) => v.version === d.current_version && v.sha256).map((v) => ({ sha256: v.sha256!, title: d.title })));
    }

    const { data: blob, error: dlErr } = await admin.storage.from(ver.storage_bucket).download(ver.storage_path);
    if (dlErr || !blob) return await fail('The stored file could not be read. Retry, or ask for manual review.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // The recorded fingerprint comes from the browser. Recompute it from the stored bytes and use the computed value.
    const computedSha = await sha256Hex(bytes);
    const fingerprintMismatch = ver.sha256 !== null && ver.sha256 !== computedSha;
    const sha = computedSha;

    const { data: ocr } = await admin.from('integration_settings').select('status').eq('code', 'ocr').maybeSingle();
    const result = await runPrecheck(
      { fileName: ver.file_name, mimeType: ver.mime_type, sizeBytes: ver.size_bytes, sha256: sha, bytes },
      requirement,
      {
        institutionName: inst?.name ?? '',
        academicYear,
        today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        otherHashes,
        ocrAvailable: ocr?.status === 'configured',
      },
    );

    if (fingerprintMismatch) {
      result.findings.push({
        check_code: 'fingerprint', check_name: 'Recorded file fingerprint', outcome: 'potential_issue', severity: 'high',
        explanation: 'The fingerprint recorded at upload does not match the stored file. Duplicate and same-content checks that rely on it may be wrong.',
        suggestion: 'An officer should treat this upload with caution and re-check it manually.',
      });
      result.summary.potential_issue = (result.summary.potential_issue ?? 0) + 1;
    }
    const { error: doneErr } = await admin.rpc('complete_document_check', {
      p_run_id: run.id, p_engine: result.engine, p_status: result.status, p_extraction_status: result.extraction_status,
      p_extraction_method: result.extraction_method, p_steps: result.steps, p_limitations: result.limitations,
      p_summary: result.summary, p_findings: result.findings, p_error: null, p_extracted_text: result.extracted_text,
    });
    if (doneErr) return json({ error: doneErr.message }, 500);
    return json({ run_id: run.id, status: result.status, summary: result.summary });
  } catch (e) {
    return await fail('The pre-check could not complete: ' + (e instanceof Error ? e.message : 'unknown error'));
  }
});
