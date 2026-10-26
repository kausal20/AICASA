#!/usr/bin/env node
// Runs the existing document-precheck Edge Function as each demo institution.
// It is safe to repeat: completed extracted versions are skipped.
import { existsSync, readFileSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
const password = process.env.DEMO_ACCOUNT_PASSWORD;
if (!url || !key || !password) throw new Error('VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and DEMO_ACCOUNT_PASSWORD are required.');
const accounts = ['inst.nirmala@aicasa-demo.test', 'inst.sahyadri@aicasa-demo.test', 'univ.deccan@aicasa-demo.test', 'inst.coromandel@aicasa-demo.test'];

async function request(path, token, init = {}) {
  const response = await fetch(`${url}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${response.status}: ${body?.error ?? body?.message ?? 'request failed'}`);
  return body;
}
let complete = 0;
for (const email of accounts) {
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = await login.json();
  if (!login.ok) throw new Error(`Could not sign in ${email}: ${session.error_description ?? session.message}`);
  const docs = await request('/rest/v1/documents?select=document_versions(id,document_check_runs(status,extracted_text))', session.access_token);
  for (const doc of docs) for (const version of doc.document_versions ?? []) {
    const finished = (version.document_check_runs ?? []).some((run) => run.status === 'completed' && run.extracted_text != null);
    if (finished) continue;
    const output = await request('/functions/v1/document-precheck', session.access_token, { method: 'POST', body: JSON.stringify({ document_version_id: version.id }) });
    if (output.status !== 'completed') throw new Error(`Pre-check failed for ${version.id}: ${output.error ?? output.status}`);
    complete++;
  }
}
console.log(`Completed ${complete} document pre-checks.`);
