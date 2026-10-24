#!/usr/bin/env node
// Alternative provisioning step when no service-role key is available locally:
// signs in as each synthetic institution representative (anon key + DEMO_ACCOUNT_PASSWORD) and uploads
// the synthetic documents through the normal storage RLS path. Prints the {key: path} map that
// seed_demo_cases(p_uploads) expects. Run the SQL step (see README) with that JSON afterwards.
//   node scripts/demo-upload-as-users.mjs > .taste-skill/uploads.json
// After seeding:  node scripts/demo-upload-as-users.mjs --precheck   (runs the deployed Edge Function as each user)
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEMO_DOCUMENTS, SCAN_PNG } from './demo-documents.mjs';
import { makeTextPdf } from '../supabase/functions/_shared/precheck.ts';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const URL_ = process.env.VITE_SUPABASE_URL, ANON = process.env.VITE_SUPABASE_ANON_KEY, PW = process.env.DEMO_ACCOUNT_PASSWORD;
if (!URL_ || !ANON || !PW) { console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / DEMO_ACCOUNT_PASSWORD'); process.exit(1); }
const REPS = { 'DEMO-WR-001': 'inst.nirmala@aicasa-demo.test', 'DEMO-WR-002': 'inst.sahyadri@aicasa-demo.test', 'DEMO-WR-003': 'univ.deccan@aicasa-demo.test', 'DEMO-SR-001': 'inst.coromandel@aicasa-demo.test' };

async function token(email) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}
const tokens = {};
const auth = async (code) => (tokens[code] ??= await token(REPS[code]));

async function get(path, code) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${await auth(code)}` } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

if (process.argv.includes('--precheck')) {
  let n = 0;
  for (const code of Object.keys(REPS)) {
    const docs = await get('documents?select=id,current_version,application_id,document_versions(id,version)&application_id=not.is.null', code);
    for (const d of docs) {
      const v = d.document_versions.find((x) => x.version === d.current_version);
      if (!v) continue;
      const r = await fetch(`${URL_}/functions/v1/document-precheck`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${await auth(code)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ document_version_id: v.id }) });
      const j = await r.json();
      if (!r.ok) console.error(`  ${code} ${v.id}: ${r.status} ${JSON.stringify(j)}`); else n++;
    }
  }
  console.error(`${n} pre-check runs completed through the Edge Function`);
  process.exit(0);
}

const uploads = {};
for (const d of DEMO_DOCUMENTS) {
  const [inst] = await get(`institutions?select=id&code=eq.${d.inst}`, d.inst);
  const bytes = d.mime === 'image/png' ? SCAN_PNG : makeTextPdf(d.lines);
  const path = `${inst.id}/${randomUUID()}${d.mime === 'image/png' ? '.png' : '.pdf'}`;
  const r = await fetch(`${URL_}/storage/v1/object/institution-documents/${path}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${await auth(d.inst)}`, 'Content-Type': d.mime, 'x-upsert': 'false' }, body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${d.key}: ${r.status} ${await r.text()}`);
  uploads[d.key] = path;
}
process.stdout.write(JSON.stringify(uploads));
console.error(`\n${Object.keys(uploads).length} files uploaded as their institution representatives`);
