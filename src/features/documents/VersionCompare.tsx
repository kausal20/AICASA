import { useQuery } from '@tanstack/react-query';
import { ArrowRight, FileDiff, Info } from 'lucide-react';
import { compareVersions } from '@/services/operations';
import { Badge } from '@/components/ui/Badge';
import { ErrorState, LoadingRows } from '@/components/ui/States';
import { fmtBytes, fmtDateTime, humanize } from '@/lib/format';

/**
 * Two versions of the same document side by side. Field-level differences appear only when both versions were read
 * reliably by the pre-check; otherwise the reason is shown and no content comparison is claimed.
 */
export function VersionCompare({ oldVersionId, newVersionId }: { oldVersionId: string; newVersionId: string }) {
  const q = useQuery({ queryKey: ['version-compare', oldVersionId, newVersionId], queryFn: () => compareVersions(oldVersionId, newVersionId) });
  if (q.isLoading) return <LoadingRows rows={2} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  return (
    <div className="space-y-3 text-[13px]">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
        {[c.old, c.new].map((v, i) => (
          <div key={v.id} className={i === 1 ? 'min-w-0 sm:order-3' : 'min-w-0'}>
            <div className="rounded-lg border border-line bg-surface px-3 py-2">
              <p className="font-medium">Version {v.version}{i === 0 ? ' (on file when the memo was raised)' : ' (submitted)'}</p>
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
      {c.content.available ? (
        c.content.fields.length ? (
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
        ) : <p className="text-xs text-ink-soft">Both versions were read, but no comparable fields were extracted.</p>
      ) : (
        <p className="flex items-start gap-1.5 rounded-md bg-surface-muted px-3 py-2 text-xs text-ink-soft">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>No content comparison: {c.content.reason} The officer compares the files directly.</span>
        </p>
      )}
    </div>
  );
}
