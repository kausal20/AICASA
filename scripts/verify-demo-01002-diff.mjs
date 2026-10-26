import { readFileSync } from 'node:fs';
for (const file of ['.env.local', '.env']) {
  try { for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } } catch { /* optional */ }
}
const url = process.env.VITE_SUPABASE_URL, key = process.env.VITE_SUPABASE_ANON_KEY, password = process.env.DEMO_ACCOUNT_PASSWORD;
const login = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'inst.nirmala@aicasa-demo.test', password }) });
const session = await login.json(); if (!login.ok) throw new Error(session.error_description ?? 'Login failed');
const h = { apikey: key, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
const docs = await (await fetch(`${url}/rest/v1/documents?application_id=eq.110075ba-8b45-49b4-acb5-4734170a4e28&doc_type=eq.fire_safety_certificate&select=document_versions(id,version)`, { headers: h })).json();
const versions = docs[0].document_versions.sort((a, b) => a.version - b.version);
const response = await fetch(`${url}/rest/v1/rpc/compare_document_versions`, { method: 'POST', headers: h, body: JSON.stringify({ p_old_version_id: versions[0].id, p_new_version_id: versions[1].id }) });
const diff = await response.json(); if (!response.ok) throw new Error(diff.message ?? 'Comparison failed');
console.log(JSON.stringify({ available: diff.content.available, text_available: diff.content.text_available, old_has_validity: diff.content.old_text.includes('Valid'), new_has_validity: diff.content.new_text.includes('Valid till 31/03/2029') }));
