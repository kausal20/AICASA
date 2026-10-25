import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Crosshair, FileText, MapPin, UploadCloud, XCircle } from 'lucide-react';
import { captureLocation, listEvcReports, openEvcReport, uploadEvcReport, type GeoFix } from '@/services/experts';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { TextField } from '@/components/ui/Field';
import { errorMessage } from '@/lib/errors';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import type { EvcReport } from '@/types/domain';

export const fmtCoord = (n: number | string) => Number(n).toFixed(6);
export const mapLink = (lat: number | string, lng: number | string) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

/** Geo-tag and server time-stamp of one report, shown the same way on the EVC tab, the timeline and the list of sessions. */
export function ReportStamp({ at, lat, lng, source }: { at: string; lat: number | string; lng: number | string; source?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-soft">
      <span><span className="font-medium text-ink">Server time-stamp</span> {fmtDateTime(at)}</span>
      <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden /><span className="font-medium text-ink">Geo-tag</span>
        <a className="tabular text-accent hover:underline" href={mapLink(lat, lng)} target="_blank" rel="noopener noreferrer">{fmtCoord(lat)}, {fmtCoord(lng)}</a>
        {source && <span>({source === 'browser' ? 'browser location' : 'entered manually'})</span>}</span>
    </span>
  );
}

export function useEvcReports(evcId: string) {
  return useQuery({ queryKey: ['evc-reports', evcId], queryFn: () => listEvcReports({ evcId }) });
}

/** Inspection reports of one session, with the upload form for a panel member. */
export function EvcReports({ evcId, canUpload, hasStarted, status }: { evcId: string; canUpload: boolean; hasStarted: boolean; status: string }) {
  const q = useEvcReports(evcId);
  const reports = q.data ?? [];
  return (
    <div className="mt-4 border-t border-line pt-4" aria-label="Inspection reports">
      <h3 className="text-[13px] font-semibold">Inspection reports</h3>
      {q.isLoading ? <p className="mt-2 text-xs text-ink-soft">Loading…</p> : !reports.length ? (
        <p className="mt-2 text-[13px] text-ink-soft">No report uploaded yet. {status === 'scheduled' && 'The session cannot be marked completed until at least one inspection report is uploaded.'}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-surface-muted/40 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline" onClick={() => openEvcReport(r.storage_path).catch(() => undefined)}>
                  <FileText className="h-4 w-4" aria-hidden />{r.file_name}</button>
                <span className="text-xs text-ink-soft">{fmtBytes(r.size_bytes)}</span>
              </div>
              <div className="mt-1"><ReportStamp at={r.uploaded_at} lat={r.latitude} lng={r.longitude} source={r.geo_source} />
                {r.geo_accuracy_m != null && <span className="ml-3 text-xs text-ink-soft">accuracy ±{Math.round(Number(r.geo_accuracy_m))} m</span>}</div>
            </li>
          ))}
        </ul>
      )}
      {canUpload && status === 'scheduled' && (hasStarted ? <ReportUpload evcId={evcId} /> : (
        <p className="mt-3 text-xs text-ink-soft">The report can be uploaded once the session has started.</p>
      ))}
    </div>
  );
}

type Phase = { kind: 'idle' } | { kind: 'uploading'; pct: number } | { kind: 'done' } | { kind: 'failed'; message: string };

function ReportUpload({ evcId }: { evcId: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const locate = async () => {
    setLocating(true); setGeoMsg(null);
    try {
      const g = await captureLocation();
      setFix(g); setLat(g.latitude.toFixed(6)); setLng(g.longitude.toFixed(6));
    } catch (e) { setFix(null); setGeoMsg(errorMessage(e)); }
    finally { setLocating(false); }
  };
  const nLat = Number(lat), nLng = Number(lng);
  const validCoord = lat.trim() !== '' && lng.trim() !== '' && Number.isFinite(nLat) && Number.isFinite(nLng) && Math.abs(nLat) <= 90 && Math.abs(nLng) <= 180;
  // a hand-edited value is a manual entry, whatever the browser reported first
  const edited = !!fix && (Number(fix.latitude.toFixed(6)) !== nLat || Number(fix.longitude.toFixed(6)) !== nLng);
  const geo: GeoFix | null = !validCoord ? null : fix && !edited ? fix : { latitude: nLat, longitude: nLng, accuracy: null, source: 'manual' };

  const submit = async () => {
    if (!file || !geo) return;
    setPhase({ kind: 'uploading', pct: 0 });
    try {
      await uploadEvcReport({ evcId, file, geo, onProgress: (pct) => setPhase({ kind: 'uploading', pct }) });
      setPhase({ kind: 'done' }); setFile(null);
      for (const k of ['evc-reports', 'evc', 'application', 'events', 'timeline']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) { setPhase({ kind: 'failed', message: errorMessage(e) }); }
  };
  const busy = phase.kind === 'uploading';
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-dashed border-line-strong px-3 py-3">
      <p className="text-[13px] font-medium">Upload the inspection report (PDF)</p>
      <div className="flex flex-wrap items-center gap-3">
        <UploadCloud className="h-5 w-5 text-ink-soft" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-soft">{file ? `${file.name} · ${fmtBytes(file.size)}` : 'No file chosen · PDF up to 10 MB'}</span>
        <input ref={input} type="file" accept="application/pdf" className="sr-only" aria-label="Inspection report PDF" disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; setPhase({ kind: 'idle' }); if (f && f.type !== 'application/pdf') { setFile(null); setPhase({ kind: 'failed', message: 'The inspection report must be a PDF.' }); } else setFile(f ?? null); e.target.value = ''; }} />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>{file ? 'Choose another' : 'Choose file'}</Button>
      </div>
      <fieldset className="space-y-2">
        <legend className="flex flex-wrap items-center gap-2 text-[13px] font-medium">Location of the inspection
          <Button size="sm" variant="secondary" loading={locating} icon={<Crosshair className="h-3.5 w-3.5" />} onClick={locate}>Use my location</Button></legend>
        {geoMsg && <p role="alert" className="text-xs text-warning">{geoMsg}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Latitude" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} hint="−90 to 90, e.g. 19.997500" />
          <TextField label="Longitude" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} hint="−180 to 180, e.g. 73.789800" />
        </div>
        <p className="text-xs text-ink-soft">{geo ? <>Geo-tag source: <Badge tone={geo.source === 'browser' ? 'success' : 'neutral'}>{geo.source === 'browser' ? `Browser location${geo.accuracy != null ? ` (±${Math.round(geo.accuracy)} m)` : ''}` : 'Entered manually'}</Badge> The upload time is recorded by the server.</>
          : 'Allow the browser location, or type the coordinates. A geo-tag is required.'}</p>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2" aria-live="polite">
        <span className="text-xs">
          {phase.kind === 'uploading' && <span className="text-ink-soft">Uploading to private storage… <span className="tabular">{phase.pct}%</span></span>}
          {phase.kind === 'done' && <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />Report saved with its geo-tag and server time-stamp.</span>}
          {phase.kind === 'failed' && <span role="alert" className="inline-flex items-center gap-1 font-medium text-danger"><XCircle className="h-4 w-4" aria-hidden />{phase.message}</span>}
        </span>
        <Button size="sm" loading={busy} disabled={!file || !geo} onClick={submit}>Upload report</Button>
      </div>
    </div>
  );
}

export function reportCount(reports: EvcReport[] | undefined) { return reports?.length ?? 0; }
