import { supabase } from '@/lib/supabase';
import { unwrap } from '@/lib/errors';
import type { MatchExpert, MatchInstitution } from '@/lib/expertMatch';
import type { EvcPanelExpert, EvcReport, Expert, ExpertAvailability } from '@/types/domain';

export const EVC_REPORT_BUCKET = 'evc-reports';

export async function listExperts() {
  return unwrap(await supabase.from('experts').select('*, institutions(name)').order('full_name')) as Expert[];
}

export async function listExpertAvailability() {
  return unwrap(await supabase.from('expert_availability').select('*').is('withdrawn_at', null).gt('ends_at', new Date().toISOString())
    .order('starts_at')) as ExpertAvailability[];
}

export async function upsertExpert(input: {
  id?: string | null; fullName: string; specializations: string[]; homeDistrict: string; homeState: string;
  homeInstitutionId?: string | null; homeInstitutionName?: string | null; region: string; isActive: boolean; profileId?: string | null;
}) {
  return unwrap(await supabase.rpc('upsert_expert', {
    p_id: input.id ?? null, p_full_name: input.fullName, p_specializations: input.specializations, p_home_district: input.homeDistrict,
    p_home_state: input.homeState, p_home_institution_id: input.homeInstitutionId ?? null, p_home_institution_name: input.homeInstitutionName ?? null,
    p_region_code: input.region, p_profile_id: input.profileId ?? null, p_is_active: input.isActive,
  }));
}

export async function recordExpertAvailability(input: { expertId: string; kind: 'available' | 'unavailable'; start: string; end: string; note: string }) {
  return unwrap(await supabase.rpc('record_expert_availability', { p_expert_id: input.expertId, p_kind: input.kind, p_start: input.start, p_end: input.end, p_note: input.note }));
}

export async function withdrawExpertAvailability(id: string, reason: string) {
  return unwrap(await supabase.rpc('withdraw_expert_availability', { p_id: id, p_reason: reason }));
}

export async function declareExpertConflict(expertId: string, institutionId: string, nature: string) {
  return unwrap(await supabase.rpc('declare_expert_conflict', { p_expert_id: expertId, p_institution_id: institutionId, p_nature: nature }));
}

export interface MatchInputs {
  evc: { id: string; status: string; scheduled_start: string | null; scheduled_end: string | null };
  institution: MatchInstitution; programme_text: string; experts: (MatchExpert & { assigned: boolean })[];
}
export async function getExpertMatchInputs(evcId: string) {
  return unwrap(await supabase.rpc('expert_match_inputs', { p_evc_id: evcId })) as MatchInputs;
}

export async function listEvcPanelExperts(evcId: string) {
  return unwrap(await supabase.from('evc_panel_experts').select('*, experts(id, full_name, specializations, region_code, home_district)')
    .eq('evc_id', evcId).order('assigned_at')) as EvcPanelExpert[];
}

export async function assignEvcExpert(evcId: string, expertId: string, version: number) {
  return unwrap(await supabase.rpc('assign_evc_expert', { p_evc_id: evcId, p_expert_id: expertId, p_expected_version: version }));
}

export async function setEvcPanelChair(evcId: string, expertId: string) {
  return unwrap(await supabase.rpc('set_evc_panel_chair', { p_evc_id: evcId, p_expert_id: expertId }));
}

export async function removeEvcExpert(evcId: string, expertId: string, reason: string) {
  return unwrap(await supabase.rpc('remove_evc_expert', { p_evc_id: evcId, p_expert_id: expertId, p_reason: reason }));
}

export async function listEvcReports(opts: { evcId?: string } = {}) {
  let q = supabase.from('evc_reports').select('*').order('uploaded_at', { ascending: false });
  if (opts.evcId) q = q.eq('evc_id', opts.evcId);
  const rows = unwrap(await q) as EvcReport[];
  return rows.map((r) => ({ ...r, latitude: Number(r.latitude), longitude: Number(r.longitude), geo_accuracy_m: r.geo_accuracy_m == null ? null : Number(r.geo_accuracy_m) })) as (EvcReport & { latitude: number; longitude: number })[];
}

export interface GeoFix { latitude: number; longitude: number; accuracy: number | null; source: 'browser' | 'manual' }

/** Browser geolocation (asks the user's permission). Rejects with a readable message so the form can fall back to manual entry. */
export function captureLocation(): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject(new Error('This browser cannot provide a location. Enter the coordinates manually.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null, source: 'browser' }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'Location permission was declined. Enter the coordinates manually.'
        : e.code === e.TIMEOUT ? 'Finding the location timed out. Retry or enter the coordinates manually.'
        : 'The location could not be determined. Enter the coordinates manually.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

async function sha256(file: File): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload the inspection report (PDF) to private storage, then register it with its geo-tag. The server stamps the upload time;
 * the browser clock is never sent.
 */
export async function uploadEvcReport(input: { evcId: string; file: File; geo: GeoFix; note?: string; onProgress?: (pct: number) => void }): Promise<EvcReport> {
  const { file } = input;
  if (file.type !== 'application/pdf') throw new Error('The inspection report must be a PDF.');
  if (file.size === 0 || file.size > 10 * 1024 * 1024) throw new Error('The report must be between 1 byte and 10 MB.');
  const hash = await sha256(file);
  const path = `${input.evcId}/${crypto.randomUUID()}.pdf`;
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error('Your session has expired. Sign in again.');
  const base = import.meta.env.VITE_SUPABASE_URL as string;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/storage/v1/object/${EVC_REPORT_BUCKET}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY as string);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
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
  return unwrap(await supabase.rpc('register_evc_report', {
    p_evc_id: input.evcId, p_storage_path: path, p_file_name: file.name, p_sha256: hash,
    p_latitude: input.geo.latitude, p_longitude: input.geo.longitude, p_geo_source: input.geo.source,
    p_accuracy_m: input.geo.accuracy, p_note: input.note ?? null,
  })) as EvcReport;
}

/** Short-lived (60 s) signed URL; storage RLS decides whether it is issued. */
export async function openEvcReport(path: string) {
  const { data, error } = await supabase.storage.from(EVC_REPORT_BUCKET).createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('Could not open the report.');
  window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
}
