#!/usr/bin/env node
// Adds the concurrent-review demo case to a project that was provisioned before the CHANGE_SITE route existed.
// Everything goes through the public functions as the synthetic Sahyadri representative (anon key + DEMO_ACCOUNT_PASSWORD):
// create draft → upload synthetic PDFs to private storage → register versions → submit → run the deployed pre-check.
//   node scripts/demo-parallel-case.mjs
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
const TITLE = 'Change of site — Sahyadri College to the Survey 310 campus';
const DOCS = { P1_lease: ['land_lease_deed', 'new_site_lease_deed.pdf'], P1_plan: ['building_plan_approval', 'new_site_building_plan.pdf'], P1_fire: ['fire_safety_certificate', 'new_site_fire_certificate.pdf'] };

const login = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'inst.sahyadri@aicasa-demo.test', password: PW }) });
const session = await login.json();
if (!login.ok) { console.error('Sign-in failed:', session.error_description ?? session.msg ?? login.status); process.exit(1); }
const H = { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
async function rest(path, init = {}) {
  const r = await fetch(`${URL_}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const t = await r.text();
  const body = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
  return body;
}
const rpc = (fn, args) => rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const [inst] = await rest('/rest/v1/institutions?select=id&code=eq.DEMO-WR-002');
const existing = await rest(`/rest/v1/applications?select=id,status&title=eq.${encodeURIComponent(TITLE)}`);
if (existing.length) { console.log(`Already present (${existing[0].status}); nothing to do.`); process.exit(0); }

let app = await rpc('create_application_draft', { p_institution_id: inst.id, p_type_code: 'CHANGE_SITE', p_title: TITLE, p_academic_year: '2027-28',
  p_form_data: { proposed_site_address: 'Survey 310, Demo Nagar Phase II, Nashik', land_area_acres: 3.4, built_up_area_sqm: 4800 } });
const versions = [];
for (const [key, [docType, fileName]] of Object.entries(DOCS)) {
  const spec = DEMO_DOCUMENTS.find((d) => d.key === key);
  const bytes = makeTextPdf(spec.lines);
  const path = `${inst.id}/${randomUUID()}.pdf`;
  const up = await fetch(`${URL_}/storage/v1/object/institution-documents/${path}`, { method: 'POST',
    headers: { apikey: ANON, Authorization: H.Authorization, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: bytes });
  if (!up.ok) throw new Error(`upload ${key}: ${up.status} ${await up.text()}`);
  const v = await rpc('register_document_version', { p_institution_id: inst.id, p_application_id: app.id, p_doc_type: docType, p_title: null,
    p_storage_path: path, p_file_name: fileName, p_sha256: createHash('sha256').update(bytes).digest('hex'), p_replaced_reason: null });
  versions.push(v.id);
}
[app] = await rest(`/rest/v1/applications?select=id,row_version&id=eq.${app.id}`);
app = await rpc('submit_application', { p_application_id: app.id, p_expected_version: app.row_version });
for (const id of versions) {
  const r = await fetch(`${URL_}/functions/v1/document-precheck`, { method: 'POST', headers: H, body: JSON.stringify({ document_version_id: id }) });
  if (!r.ok) console.error(`  pre-check ${id}: ${r.status} ${await r.text()}`);
}
console.log(`Created ${app.reference} (${app.status}, stage ${app.current_stage}) with ${versions.length} documents.`);
