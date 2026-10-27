import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Terminal } from 'lucide-react';
import { latestDocumentHashes, listAudit } from '@/services/admin';
import type { AuditRow } from '@/types/domain';
import { codeLabel, fmtDateTime } from '@/lib/format';
import { auditActionLabel } from '@/lib/responsibilities';

type Channel = 'SYSTEM' | 'SECURITY' | 'PIPELINE';

function channelOf(action: string): Channel {
  if (/^document_(uploaded|replaced)$|role|decision|workflow|export|login/.test(action)) return 'SECURITY';
  if (/^(stage_|transition|application_|returned_|deficiency_|correction_|observation_)/.test(action)) return 'PIPELINE';
  return 'SYSTEM';
}

const WARN = /escalation|overdue|returned_for_correction|deficiency_raised|still_deficient|rejected/;

/** What distinguishes two entries of the same action on the same case (for example which stage was entered). */
function detail(r: AuditRow): string | null {
  const after = (r.after_state ?? {}) as Record<string, unknown>;
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  if (r.action === 'stage_entered' && typeof after.stage === 'string') return `→ ${codeLabel(after.stage)}`;
  if (typeof meta.rule_code === 'string') return codeLabel(meta.rule_code);
  if (typeof meta.rule === 'string') return codeLabel(meta.rule);
  if (typeof after.status === 'string') return `→ ${codeLabel(after.status)}`;
  return null;
}

function line(r: AuditRow, hashes: Record<string, string>, hashed: Set<number>): string {
  const parts = [`[${fmtDateTime(r.created_at)}]`, channelOf(r.action).padEnd(8), auditActionLabel(r.action)];
  const extra = detail(r);
  if (extra) parts.push(extra);
  if (r.application_reference) parts.push(r.application_reference);
  parts.push(`by ${r.actor_kind === 'system' ? 'System' : r.actor_name ?? 'user'}`);
  if (hashed.has(r.id) && r.entity_id && hashes[r.entity_id]) parts.push(`sha256:${hashes[r.entity_id].slice(0, 16)}…`);
  return parts.join('  ');
}

/**
 * Immutability event stream: the most recent rows of the append-only audit log, one line per entry (by entry id).
 * Hashes are the stored SHA-256 of the document, shown only on the newest upload/replace event of each document.
 */
export function AuditStream() {
  const q = useQuery({
    queryKey: ['audit', 'stream'],
    queryFn: async () => {
      const { rows: raw, total } = await listAudit({}, 0, 30);
      const rows = raw.filter((r, i) => raw.findIndex((x) => x.id === r.id) === i);
      const docIds = [...new Set(rows.filter((r) => /^document_(uploaded|replaced)$/.test(r.action) && r.entity_id).map((r) => r.entity_id!))];
      const hashes = await latestDocumentHashes(docIds).catch(() => ({} as Record<string, string>));
      const seen = new Set<string>();
      const hashed = new Set<number>();
      for (const r of rows) {
        if (/^document_(uploaded|replaced)$/.test(r.action) && r.entity_id && !seen.has(r.entity_id)) { seen.add(r.entity_id); hashed.add(r.id); }
      }
      return { rows, total, hashes, hashed };
    },
    refetchInterval: 15_000,
  });

  return (
    <section aria-label="Immutability event stream" className="min-w-0 overflow-hidden rounded-card border border-neutral-800 bg-neutral-900 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-4 py-2.5 font-mono text-xs text-neutral-400">
        <span className="flex items-center gap-2 text-neutral-200"><Terminal className="h-3.5 w-3.5" aria-hidden />Immutability Event Stream</span>
        <span>live from the audit log · append-only · refreshes every 15 s{q.data ? ` · ${q.data.total.toLocaleString('en-IN')} events on record` : ''}</span>
      </header>
      <div className="max-h-72 overflow-auto px-4 py-3 font-mono text-[12px] leading-6" role="log" aria-live="off" tabIndex={0}>
        {q.isLoading && <p className="text-neutral-500">$ connecting to audit log…</p>}
        {q.error && <p className="text-amber-500">$ audit log unavailable for this account: {(q.error as Error).message}</p>}
        {q.data && !q.data.rows.length && <p className="text-neutral-500">$ no events recorded yet</p>}
        {q.data?.rows.map((r) => (
          <p key={r.id} className={`whitespace-pre ${WARN.test(r.action) ? 'text-amber-500' : 'text-emerald-400'}`}>
            {r.application_id
              ? <Link to={`/app/applications/${r.application_id}?tab=audit`} className="hover:underline focus-visible:underline">{line(r, q.data.hashes, q.data.hashed)}</Link>
              : line(r, q.data.hashes, q.data.hashed)}
          </p>
        ))}
        {q.data && <p className="text-neutral-500 motion-safe:animate-pulse">$ ▌</p>}
      </div>
    </section>
  );
}
