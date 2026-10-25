#!/usr/bin/env node
// Adds the two Deficiency Matrix demo cases (computers shortfall; faculty cadre shortfall) to an existing project.
// Requires migration 20261026000100 to be applied first. Submitting each case records its deficiency automatically.
// Everything goes through the public functions as the synthetic Sahyadri representative (anon key + DEMO_ACCOUNT_PASSWORD):
// create draft → upload synthetic PDFs to private storage → register versions → submit → run the deployed pre-check.
//   node scripts/demo-matrix-cases.mjs
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { DEMO_DOCUMENTS } from './demo-documents.mjs';
import { makeTextPdf } from '../supabase/functions/_shared/precheck.ts';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const URL_ = process.env.VITE_SUPABASE_URL, ANON = process.env.VITE_SUPABASE_ANON_KEY, PW = process.env.DEMO_ACCOUNT_PASSWORD;
if (!URL_ || !ANON || !PW) { console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / DEMO_ACCOUNT_PASSWORD'); process.exit(1); }

const FORM = { approved_intake: 480, intake_increase: false, programme_level: 'ug_engg', student_count: 480, faculty_count: 24, computer_count: 120,
  library_book_count: 4800, lab_count: 5, faculty_professors: 3, faculty_associate_professors: 5, faculty_assistant_professors: 16 };
const CASES = [
  { email: 'inst.sahyadri@aicasa-demo.test', inst: 'DEMO-WR-002', title: 'Extension of approval — computing capacity review (demo)', form: { ...FORM, computer_count: 95 }, docs: { M1_affidavit: ['affidavit', 'affidavit_computing_review.pdf'], M1_fire: ['fire_safety_certificate', 'fire_certificate_computing_review.pdf'] } },
  { email: 'inst.nirmala@aicasa-demo.test', inst: 'DEMO-WR-001', title: 'Extension of approval — faculty cadre review (demo)', form: { ...FORM, faculty_professors: 0 }, docs: { M2_affidavit: ['affidavit', 'affidavit_cadre_review.pdf'], M2_fire: ['fire_safety_certificate', 'fire_certificate_cadre_review.pdf'] } },
];

for (const c of CASES) {
  const login = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.email, password: PW }) });
  const session = await login.json();
  if (!login.ok) { console.error('Sign-in failed for', c.email); process.exit(1); }
  const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
  const rest = async (path, init = {}) => {
    const r = await fetch(`${URL_}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    const t = await r.text(); const body = t ? JSON.parse(t) : null;
    if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
    return body;
  };
  const rpc = (fn, args) => rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
  const [inst] = await rest(`/rest/v1/institutions?select=id&code=eq.${c.inst}`);
  const existing = await rest(`/rest/v1/applications?select=id,status&title=eq.${encodeURIComponent(c.title)}`);
  if (existing.length) { console.log(`Already present: ${c.title}`); continue; }
  let app = await rpc('create_application_draft', { p_institution_id: inst.id, p_type_code: 'EOA', p_title: c.title, p_academic_year: '2027-28', p_form_data: c.form });
  const versions = [];
  for (const [key, [docType, fileName]] of Object.entries(c.docs)) {
    const bytes = makeTextPdf(DEMO_DOCUMENTS.find((d) => d.key === key).lines);
    const path = `${inst.id}/${randomUUID()}.pdf`;
    const up = await fetch(`${URL_}/storage/v1/object/institution-documents/${path}`, { method: 'POST', headers: { apikey: ANON, Authorization: H.Authorization, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: bytes });
    if (!up.ok) throw new Error(`upload ${key}: ${up.status} ${await up.text()}`);
    const v = await rpc('register_document_version', { p_institution_id: inst.id, p_application_id: app.id, p_doc_type: docType, p_title: null, p_storage_path: path, p_file_name: fileName, p_sha256: createHash('sha256').update(bytes).digest('hex'), p_replaced_reason: null });
    versions.push(v.id);
  }
  [app] = await rest(`/rest/v1/applications?select=id,row_version&id=eq.${app.id}`);
  app = await rpc('submit_application', { p_application_id: app.id, p_expected_version: app.row_version });
  for (const id of versions) await fetch(`${URL_}/functions/v1/document-precheck`, { method: 'POST', headers: H, body: JSON.stringify({ document_version_id: id }) });
  console.log(`Created ${app.reference} (${app.status}): ${c.title}`);
}
