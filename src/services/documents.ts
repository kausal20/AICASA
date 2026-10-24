import { supabase, DOCUMENT_BUCKET } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type { CheckRun, DocumentRecord, DocumentVersion } from '@/types/domain';

export const ALLOWED_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'];
export const MAX_BYTES = 10 * 1024 * 1024;

export async function listDocuments(opts: { institutionId?: string; applicationId?: string | null }) {
  let q = supabase.from('documents').select('*, document_versions(*)').order('updated_at', { ascending: false });
  if (opts.institutionId) q = q.eq('institution_id', opts.institutionId);
  if (opts.applicationId === null) q = q.is('application_id', null);
  else if (opts.applicationId) q = q.eq('application_id', opts.applicationId);
  const docs = unwrap(await q) as DocumentRecord[];
  for (const d of docs) d.document_versions?.sort((a, b) => b.version - a.version);
  return docs;
}

async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFor(file: File): string {
  const m = file.name.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return m ? `.${m[1]}` : '';
}

/**
 * Upload to private storage with real progress, then register the version server-side.
 * The storage key is "<institution>/<random uuid>.<ext>"; the original filename is metadata only.
 * If registration fails the application state is unchanged and the caller can retry.
 */
export async function uploadDocument(input: {
  file: File; institutionId: string; applicationId: string | null; docType: string; title?: string;
  replacedReason?: string; onProgress?: (pct: number) => void;
}): Promise<DocumentVersion> {
  const { file } = input;
  if (!ALLOWED_TYPES.includes(file.type)) throw new Error(`Files of type ${file.type || 'unknown'} are not accepted. Use PDF, PNG, JPEG or plain text.`);
  if (file.size === 0 || file.size > MAX_BYTES) throw new Error('Files must be between 1 byte and 10 MB.');
  const hash = await sha256(file);
  const path = `${input.institutionId}/${crypto.randomUUID()}${extFor(file)}`;

  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/storage/v1/object/${DOCUMENT_BUCKET}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY as string);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) input.onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = 'Upload was rejected by storage.';
        try { msg = JSON.parse(xhr.responseText).message ?? msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection and retry.'));
    xhr.send(file);
  });

  return unwrap(await supabase.rpc('register_document_version', {
    p_institution_id: input.institutionId, p_application_id: input.applicationId, p_doc_type: input.docType,
    p_title: input.title ?? null, p_storage_path: path, p_file_name: file.name, p_sha256: hash,
    p_replaced_reason: input.replacedReason ?? null,
  })) as DocumentVersion;
}

/** Short-lived (60 s) signed URL; storage RLS decides whether it is issued. */
export async function openDocument(path: string) {
  const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('Could not open the file.');
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}

export async function listCheckRuns(versionIds: string[]) {
  if (!versionIds.length) return [] as CheckRun[];
  return unwrap(await supabase.from('document_check_runs').select('*, document_check_findings(*)')
    .in('document_version_id', versionIds).order('started_at', { ascending: false })) as CheckRun[];
}

export async function runPrecheck(versionId: string) {
  const { data, error } = await supabase.functions.invoke('document-precheck', { body: { document_version_id: versionId } });
  if (error) {
    let msg = 'The pre-check service is unavailable. Your document is saved; retry later or proceed — officers review all documents independently.';
    try {
      const body = await (error as { context?: Response }).context?.json();
      if (body?.error) msg = body.error;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data as { run_id: string; status: string; error?: string };
}
