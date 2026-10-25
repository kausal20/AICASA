import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, MapPin, Sparkles, UserPlus } from 'lucide-react';
import { assignEvcExpert, getExpertMatchInputs } from '@/services/experts';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Dialog } from '@/components/ui/Dialog';
import { ErrorState, LoadingRows, Notice } from '@/components/ui/States';
import { useAction } from '@/hooks/useAction';
import { matchExperts, type Excluded, type Recommendation } from '@/lib/expertMatch';

const PROXIMITY = ['Same region', 'Neighbouring region', 'Other region'] as const;

/**
 * "Recommend panel": eligible experts ranked by specialization match to the institute's programmes, then region proximity.
 * Anyone from the institute's district, affiliated with it, or with a declared conflict is shown as excluded, with the reason.
 * The server applies the same three rules again when an expert is assigned.
 */
export function RecommendPanelDialog({ evcId, version, canAssign, onClose }: { evcId: string; version: number; canAssign: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: ['expert-match', evcId], queryFn: () => getExpertMatchInputs(evcId) });
  const result = useMemo(() => q.data && matchExperts(q.data.institution, q.data.experts, {
    programmeText: q.data.programme_text, sessionStart: q.data.evc.scheduled_start, sessionEnd: q.data.evc.scheduled_end,
  }), [q.data]);
  const assignedIds = new Set((q.data?.experts ?? []).filter((e) => e.assigned).map((e) => e.id));
  const assign = useAction((expertId: string) => assignEvcExpert(evcId, expertId, version), {
    success: 'Expert added to the panel.', invalidate: [['expert-match'], ['evc'], ['evc-panel'], ['application']],
  });
  const inst = q.data?.institution;
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="Recommended panel"
      description={inst ? `${inst.name} · ${inst.district ?? 'district not recorded'}, ${inst.state} · ${inst.region_code}` : undefined}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {q.isLoading ? <LoadingRows rows={4} /> : q.error || !result || !inst ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="space-y-5">
          <p className="text-[13px] text-ink-soft">
            Ranked by match to the institute&rsquo;s programmes{result.programmeTags.length ? <> ({result.programmeTags.map((t) => <Badge key={t} tone="primary" className="mx-0.5">{t}</Badge>)})</> : ' (none recorded)'}, then by region.
            Matching is a suggestion; the coordinator decides the panel.
          </p>
          {!inst.district && <Notice tone="warning" title="District not recorded">This institute has no district on file, so the same-district exclusion cannot be applied. Affiliation and declared conflicts are still checked.</Notice>}

          <section aria-label="Eligible experts">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold"><Sparkles className="h-4 w-4 text-primary" aria-hidden />Eligible ({result.recommended.length})</h3>
            {!result.recommended.length ? <p className="rounded-lg border border-dashed border-line-strong px-4 py-3 text-[13px] text-ink-soft">No eligible expert in the registry.</p> : (
              <ol className="divide-y divide-line rounded-lg border border-line">
                {result.recommended.map((r) => <EligibleRow key={r.expert.id} r={r} assigned={assignedIds.has(r.expert.id)} canAssign={canAssign}
                  busy={assign.isPending} onAssign={() => assign.mutate(r.expert.id)} />)}
              </ol>
            )}
          </section>

          <section aria-label="Excluded experts">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold"><Ban className="h-4 w-4 text-danger" aria-hidden />Excluded ({result.excluded.length})</h3>
            {!result.excluded.length ? <p className="text-[13px] text-ink-soft">Nobody in the registry is excluded for this institute.</p> : (
              <ul className="divide-y divide-line rounded-lg border border-line">{result.excluded.map((x) => <ExcludedRow key={x.expert.id} x={x} />)}</ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function EligibleRow({ r, assigned, canAssign, busy, onAssign }: { r: Recommendation; assigned: boolean; canAssign: boolean; busy: boolean; onAssign: () => void }) {
  const e = r.expert;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium"><span className="mr-2 tabular text-ink-faint">#{r.rank}</span>{e.full_name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {e.specializations.map((s) => <Badge key={s} tone={r.matchedTags.includes(s) ? 'success' : 'neutral'} icon={r.matchedTags.includes(s) ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : undefined}>{s}</Badge>)}
          {r.matchedTags.length === 0 && <span className="text-xs text-warning">No specialization match</span>}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-soft">
          <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />{e.home_district}, {e.home_state} · {e.region_code} · {PROXIMITY[r.proximity]}</span>
          {e.home_institution_name && <span>{e.home_institution_name}</span>}
          {r.sessionFit === 'available' && <span className="text-success">Available for the session</span>}
          {r.sessionFit === 'unavailable' && <span className="text-danger">Unavailable during the session</span>}
          {r.sessionFit === 'unknown' && <span>Availability for the session not recorded</span>}
        </p>
      </div>
      {assigned ? <Badge tone="success">On the panel</Badge>
        : canAssign && <Button size="sm" variant="secondary" loading={busy} icon={<UserPlus className="h-3.5 w-3.5" />} onClick={onAssign}>Add to panel</Button>}
    </li>
  );
}

function ExcludedRow({ x }: { x: Excluded }) {
  const e = x.expert;
  return (
    <li className="bg-danger-soft/30 px-4 py-3">
      <p className="text-[13.5px] font-medium">{e.full_name}</p>
      <ul className="mt-1 space-y-0.5">
        {x.labels.map((l) => <li key={l} className="flex items-center gap-1.5 text-[13px] font-medium text-danger"><Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />{l}</li>)}
      </ul>
      <p className="mt-1 text-xs text-ink-soft">
        {e.specializations.join(', ')} · {e.home_district}, {e.home_state}{e.home_institution_name ? ` · ${e.home_institution_name}` : ''}
        {e.declared_conflicts[0] && <> · “{e.declared_conflicts[0].nature}”</>}
      </p>
    </li>
  );
}
