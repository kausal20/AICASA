import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileDiff, Info } from 'lucide-react';
import { compareVersions } from '@/services/operations';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingRows } from '@/components/ui/States';
import { Segmented } from '@/components/ui/Workspace';
import { cn } from '@/lib/cn';
import { changesOnly, diffLines, diffStats } from '@/lib/textDiff';
import { fmtBytes, fmtDateTime, humanize } from '@/lib/format';

/**
 * Two versions of the same document side by side. Where the pre-check stored the extracted text of both versions the view shows a
 * line-level diff (changes only by default). Otherwise it is a metadata-only comparison and says why.
 */
export function VersionCompare({ oldVersionId, newVersionId }: { oldVersionId: string; newVersionId: string }) {
  const q = useQuery({ queryKey: ['version-compare', oldVersionId, newVersionId], queryFn: () => compareVersions(oldVersionId, newVersionId) });
  const [view, setView] = useState<'changes' | 'full'>('changes');
  const text = q.data?.content;
  const diff = useMemo(() => (text?.text_available && text.old_text != null && text.new_text != null ? diffLines(text.old_text, text.new_text) : null), [text]);
  if (q.isLoading) return <LoadingRows rows={2} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const stats = diff ? diffStats(diff) : null;
  const shown = diff ? (view === 'changes' ? changesOnly(diff) : diff) : [];
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
        {[c.old, c.new].map((v, i) => (
          <div key={v.id} className={i === 1 ? 'min-w-0 sm:order-3' : 'min-w-0'}>
            <div className="rounded-lg border border-line bg-surface px-3 py-2">
              <p className="font-medium">Version {v.version}{i === 0 ? ' (on file when the query was raised)' : ' (submitted)'}</p>
              <p className="truncate text-xs text-ink-soft">{v.file_name} · {fmtBytes(v.size_bytes)} · {fmtDateTime(v.uploaded_at)}</p>
              {v.replaced_reason && <p className="mt-0.5 text-xs text-ink-soft">Reason: {v.replaced_reason}</p>}
            </div>
          </div>
        ))}
        <ArrowRight className="hidden h-4 w-4 text-ink-faint sm:order-2 sm:block" aria-hidden />
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
        <FileDiff className="h-3.5 w-3.5" aria-hidden />
        {c.identical_file ? <Badge tone="warning">Identical file (same SHA-256)</Badge>
          : c.metadata_changes.length ? c.metadata_changes.map((m) => `${m.field}: ${m.old} → ${m.new}`).join(' · ') : 'No metadata differences recorded.'}
      </p>

      {diff && stats ? (
        <section aria-label="Content changes" className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-muted/50 px-3 py-2">
            <p className="text-xs font-medium text-ink">Content comparison (extracted text) · <span className="text-success">{stats.added} added</span> · <span className="text-danger">{stats.removed} removed</span> · {stats.unchanged} unchanged</p>
            <Segmented<'changes' | 'full'> label="Diff view" value={view} onChange={setView} options={[{ value: 'changes', label: 'Changes only' }, { value: 'full', label: 'Full text' }]} />
          </div>
          {!shown.length ? (
            <p className="px-3 py-3 text-xs text-ink-soft">The extracted text of the two versions is identical.</p>
          ) : (
            <ol className="max-h-72 overflow-auto font-mono text-[12px] leading-6">
              {shown.map((l, i) => (
                <li key={i} className={cn('flex gap-2 px-3', l.kind === 'added' && 'bg-success-soft text-[#0f5e49]', l.kind === 'removed' && 'bg-danger-soft text-[#8f1c13]', l.kind === 'same' && 'text-ink-soft')}>
                  <span className="w-5 shrink-0 select-none text-right opacity-60" aria-hidden>{l.oldNo ?? ''}</span>
                  <span className="w-5 shrink-0 select-none text-right opacity-60" aria-hidden>{l.newNo ?? ''}</span>
                  <span className="w-4 shrink-0 select-none font-semibold" aria-hidden>{l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '}</span>
                  <span className="sr-only">{l.kind === 'added' ? 'Added: ' : l.kind === 'removed' ? 'Removed: ' : 'Unchanged: '}</span>
                  <span className="min-w-0 whitespace-pre-wrap break-words">{l.text || ' '}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : (
        <p className="flex items-start gap-1.5 rounded-md bg-surface-muted px-3 py-2 text-xs text-ink-soft">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span><span className="font-semibold text-ink">Metadata-only comparison.</span> No line-level content comparison: {c.content.text_reason ?? c.content.reason} The officer compares the files directly.</span>
        </p>
      )}

      {c.content.available && c.content.fields.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead><tr className="text-ink-soft"><th className="py-1 font-medium">Extracted field</th><th className="py-1 font-medium">Version {c.old.version}</th><th className="py-1 font-medium">Version {c.new.version}</th></tr></thead>
          <tbody className="divide-y divide-line">
            {c.content.fields.map((f) => (
              <tr key={f.check_code} className={f.changed ? 'bg-warning-soft/40' : ''}>
                <td className="py-1.5 pr-2">{f.label}{f.changed && <span className="ml-1.5 font-medium text-[#7a5100]">changed</span>}</td>
                <td className="py-1.5 pr-2 tabular">{f.old ?? humanize(f.old_outcome ?? 'not found')}</td>
                <td className="py-1.5 tabular">{f.new ?? humanize(f.new_outcome ?? 'not found')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
