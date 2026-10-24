#!/usr/bin/env node
// Controlled provisioning of the synthetic demo environment. Run once against a Supabase project
// AFTER the migrations and supabase/seed.sql have been applied.
//
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DEMO_ACCOUNT_PASSWORD
//   are read from the environment or from .env.local. The service-role key is used only here,
//   on your machine; it never reaches the browser bundle.
//
// Steps: create demo auth users → grant demo roles → upload synthetic documents to private storage →
// seed demo cases through the real workflow functions → run genuine pre-checks on application documents.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { DEMO_DOCUMENTS, SCAN_PNG } from './demo-documents.mjs';
import { makeTextPdf, runPrecheck } from '../supabase/functions/_shared/precheck.ts';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv();
const URL_ = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD;
if (!URL_ || !ANON || !SERVICE || !PASSWORD) {
  console.error('Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY or DEMO_ACCOUNT_PASSWORD.');
  process.exit(1);
}
if (PASSWORD.length < 12) { console.error('DEMO_ACCOUNT_PASSWORD must be at least 12 characters.'); process.exit(1); }

const EMAILS = [
  'inst.nirmala@aicasa-demo.test', 'inst.sahyadri@aicasa-demo.test', 'univ.deccan@aicasa-demo.test', 'inst.coromandel@aicasa-demo.test',
  'officer.wr.scrutiny@aicasa-demo.test', 'officer.wr.evc@aicasa-demo.test', 'officer.wr.compliance@aicasa-demo.test', 'officer.sr@aicasa-demo.test',
  'admin.national@aicasa-demo.test', 'admin.wr@aicasa-demo.test',
];

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function call(path, init = {}, headers = svcHeaders) {
  const r = await fetch(`${URL_}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}
const rpc = (fn, args = {}, headers = svcHeaders) => call(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }, headers);
const select = (q) => call(`/rest/v1/${q}`);

async function ensureUsers() {
  const existing = await call('/auth/v1/admin/users?per_page=1000');
  const have = new Set((existing.users ?? []).map((u) => u.email));
  for (const email of EMAILS) {
    if (have.has(email)) { console.log(`  user exists  ${email}`); continue; }
    await call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD, email_confirm: true, user_metadata: { is_demo: true } }) });
    console.log(`  user created ${email}`);
  }
}

async function upload(instId, bytes, mime) {
  const ext = mime === 'image/png' ? '.png' : '.pdf';
  const path = `${instId}/${randomUUID()}${ext}`;
  const r = await fetch(`${URL_}/storage/v1/object/institution-documents/${path}`, {
    method: 'POST', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': mime, 'x-upsert': 'false' }, body: bytes,
  });
  if (!r.ok) throw new Error(`upload failed ${r.status}: ${await r.text()}`);
  return path;
}

async function signIn(email) {
  const r = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password: PASSWORD }) }, { apikey: ANON, 'Content-Type': 'application/json' });
  return { apikey: ANON, Authorization: `Bearer ${r.access_token}`, 'Content-Type': 'application/json' };
}

async function main() {
  console.log('1/5 Demo accounts');
  await ensureUsers();

  console.log('2/5 Demo roles');
  console.log('  ', JSON.stringify(await rpc('provision_demo_access')));

  const existingApps = await select('applications?select=id&is_demo=eq.true&limit=1');
  if (existingApps.length) { console.log('Demo cases already exist; nothing else to do.'); return; }

  console.log('3/5 Synthetic documents → private storage');
  const insts = await select('institutions?select=id,code,name');
  const byCode = Object.fromEntries(insts.map((i) => [i.code, i]));
  const uploads = {};
  const bytesByPath = {};
  for (const d of DEMO_DOCUMENTS) {
    const bytes = d.mime === 'image/png' ? SCAN_PNG : makeTextPdf(d.lines);
    const path = await upload(byCode[d.inst].id, bytes, d.mime);
    uploads[d.key] = path;
    bytesByPath[path] = bytes;
  }
  console.log(`   ${Object.keys(uploads).length} files uploaded`);

  console.log('4/5 Demo cases via the workflow engine');
  const seeded = await rpc('seed_demo_cases', { p_uploads: uploads });
  console.log('  ', JSON.stringify({ ok: seeded.ok, applications: seeded.applications, scan: seeded.scan?.stats }));

  console.log('5/5 Pre-checks on application documents (deterministic engine, same code as the Edge Function)');
  const versions = await select('document_versions?select=id,storage_path,file_name,mime_type,size_bytes,document:documents(doc_type,application_id,institution_id)');
  const reps = { 'DEMO-WR-001': 'inst.nirmala@aicasa-demo.test', 'DEMO-WR-002': 'inst.sahyadri@aicasa-demo.test', 'DEMO-WR-003': 'univ.deccan@aicasa-demo.test', 'DEMO-SR-001': 'inst.coromandel@aicasa-demo.test' };
  const sessions = {};
  let n = 0;
  for (const v of versions) {
    if (!v.document.application_id || !bytesByPath[v.storage_path]) continue;
    const inst = insts.find((i) => i.id === v.document.institution_id);
    const app = (await select(`applications?select=application_type_code,checklist_version,academic_year&id=eq.${v.document.application_id}`))[0];
    const req = (await select(`document_requirements?select=doc_type,name,allowed_mime_types,max_bytes,expiry_tracked,required_fields&application_type_code=eq.${app.application_type_code}&checklist_version=eq.${app.checklist_version}&doc_type=eq.${v.document.doc_type}`))[0] ?? null;
    const bytes = bytesByPath[v.storage_path];
    sessions[inst.code] ??= await signIn(reps[inst.code]);
    const run = await rpc('start_document_check', { p_document_version_id: v.id }, sessions[inst.code]);
    const res = await runPrecheck(
      { fileName: v.file_name, mimeType: v.mime_type, sizeBytes: v.size_bytes, sha256: createHash('sha256').update(bytes).digest('hex'), bytes },
      req, { institutionName: inst.name, academicYear: app.academic_year, today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }), ocrAvailable: false },
    );
    await rpc('complete_document_check', {
      p_run_id: run.id, p_engine: res.engine, p_status: res.status, p_extraction_status: res.extraction_status, p_extraction_method: res.extraction_method,
      p_steps: res.steps, p_limitations: res.limitations, p_summary: res.summary, p_findings: res.findings, p_error: null,
    });
    n++;
  }
  console.log(`   ${n} check runs recorded`);
  console.log('\nDone. Sign in with any demo email and DEMO_ACCOUNT_PASSWORD. All data is synthetic.');
}

main().catch((e) => { console.error('\nProvisioning failed:', e.message); process.exit(1); });
