import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, RefreshCw, UploadCloud, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadDocument, ALLOWED_TYPES } from '@/services/documents';
import { errorMessage } from '@/lib/errors';
import { fmtBytes } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { cn } from '@/lib/cn';
import type { DocumentVersion } from '@/types/domain';

type Phase = { kind: 'idle' } | { kind: 'uploading'; pct: number } | { kind: 'registering' } | { kind: 'done'; version: number } | { kind: 'failed'; message: string };

/**
 * Upload with real byte progress, then server-side registration. A failed upload leaves the
 * application untouched; the user can retry with the same file.
 */
export function DocumentUploader({ institutionId, applicationId, docType, title, allowed, maxBytes, requireReason, onUploaded, compact }: {
  institutionId: string; applicationId: string | null; docType: string; title?: string; allowed?: string[]; maxBytes?: number;
  requireReason?: boolean; onUploaded?: (v: DocumentVersion) => void; compact?: boolean;
}) {
  const id = useId();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const types = allowed ?? ALLOWED_TYPES;
  const limit = maxBytes ?? 10485760;
  const typeNames = types.map((t) => (t === 'text/plain' ? 'TXT' : t.split('/')[1].toUpperCase())).join(', ');

  const start = async (f: File) => {
    if (!types.includes(f.type)) { setPhase({ kind: 'failed', message: `This document accepts ${typeNames} only.` }); return; }
    if (f.size > limit) { setPhase({ kind: 'failed', message: `File is ${fmtBytes(f.size)}; the limit is ${fmtBytes(limit)}.` }); return; }
    if (requireReason && reason.trim().length < 5) { setPhase({ kind: 'failed', message: 'Explain briefly why this document is being replaced.' }); return; }
    setPhase({ kind: 'uploading', pct: 0 });
    try {
      const v = await uploadDocument({
        file: f, institutionId, applicationId, docType, title, replacedReason: requireReason ? reason : undefined,
        onProgress: (pct) => setPhase(pct >= 100 ? { kind: 'registering' } : { kind: 'uploading', pct }),
      });
      setPhase({ kind: 'done', version: v.version });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['application'] });
      onUploaded?.(v);
    } catch (e) {
      setPhase({ kind: 'failed', message: errorMessage(e) });
    }
  };

  const busy = phase.kind === 'uploading' || phase.kind === 'registering';
  return (
    <div className="space-y-2">
      {requireReason && (
        <div>
          <label htmlFor={`${id}-reason`} className="text-xs font-medium text-ink">Reason for replacement <span className="text-danger">*</span></label>
          <Textarea id={`${id}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Renewed certificate issued on 2 Oct 2026" className="mt-1" />
        </div>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !busy) { setFile(f); start(f); } }}
        className={cn('flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface-muted/50 px-3', compact ? 'py-2' : 'py-3')}
      >
        <UploadCloud className="h-5 w-5 text-ink-soft" aria-hidden />
        <div className="min-w-0 flex-1 text-[13px]">
          {file ? <span className="font-medium text-ink">{file.name} <span className="font-normal text-ink-soft">· {fmtBytes(file.size)}</span></span>
            : <span className="text-ink-soft">Drop a file here or choose one · {typeNames} · up to {fmtBytes(limit)}</span>}
        </div>
        <input ref={input} id={id} type="file" className="sr-only" accept={types.join(',')} disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); start(f); } e.target.value = ''; }} />
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()} aria-controls={id}>
          {file ? 'Choose another' : 'Choose file'}
        </Button>
      </div>
      <div aria-live="polite" className="min-h-0">
        <AnimatePresence mode="wait">
          {phase.kind === 'uploading' && (
            <motion.div key="up" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-1">
              <div className="flex justify-between text-xs text-ink-soft"><span>Uploading to private storage</span><span className="tabular">{phase.pct}%</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuenow={phase.pct} aria-valuemin={0} aria-valuemax={100}>
                <motion.div className="h-full bg-primary" animate={{ width: `${phase.pct}%` }} transition={{ duration: 0.15 }} />
              </div>
            </motion.div>
          )}
          {phase.kind === 'registering' && (
            <motion.p key="reg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-xs text-ink-soft">Validating file type and size on the server…</motion.p>
          )}
          {phase.kind === 'done' && (
            <motion.p key="done" initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5 text-xs font-medium text-success">
              <motion.span initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ duration: 0.2 }}><CheckCircle2 className="h-4 w-4" aria-hidden /></motion.span>
              Saved as version {phase.version}. Earlier versions are kept.
            </motion.p>
          )}
          {phase.kind === 'failed' && (
            <motion.div key="fail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
              <XCircle className="h-4 w-4" aria-hidden /><span className="font-medium">{phase.message}</span>
              {file && <button className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => start(file)}><RefreshCw className="h-3 w-3" />Retry</button>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
