import { useRef, useState } from 'react';
import { BookOpen, Search, X } from 'lucide-react';
import { Drawer } from '@/components/ui/Workspace';
import { Input } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/States';

const TERMS = [
  ['Application', 'The record used to request an approval. An approval dossier is the application together with its supporting documents.'],
  ['EoA — Extension of Approval', 'An application category for extending approval. Other application categories use the same Applications workspace.'],
  ['APH — Approval Process Handbook', 'The handbook referenced by approval requirements. Rules in this prototype are demonstration configuration and require verification before real use.'],
  ['Regional Officer', 'The officer a case is assigned to (shown as Assigned officer in earlier versions). The internal assignment is unchanged; only the label differs.'],
  ['Scrutiny Committee', 'Display name of the scrutiny responsibility, including each concurrent review that requires it. The stored responsibility key is still "scrutiny".'],
  ['Central AICTE Desk', 'Display name of the decision responsibility, which records the decision on a case. The stored responsibility key is still "decision".'],
  ['RO — Regional Office', 'The regional office responsible for work within its authorised scope. The Officer workspace supports scrutiny and other assigned responsibilities.'],
  ['EVC — Expert Visit Committee', 'The expert committee involved in a visit where the application route requires one. Scheduling, participants, and outcomes are recorded separately.'],
  ['SAC / SHC', 'Standing Appellate Committee / Standing Hearing Committee. Committee stages are used only where the configured route requires them; applicability follows the relevant authorised process.'],
  ['Deficiency', 'An issue recorded by an officer, or by a configured rule. Called a query when the officer asks the institution for a clarification; the institution\'s answer is the clarification. A replacement upload does not resolve it until the officer reviews the clarification.'],
  ['Response window', 'The time (48 hours as configured) the institution has to answer a query. After it closes, uploads and clarifications are disabled until an officer reopens the window, once.'],
  ['Obligation', 'A compliance requirement with evidence to submit and a due date, such as an undertaking or document renewal.'],
  ['Decision', 'An outcome recorded by an authorised officer with reasons. A successful pre-check is not an approval or a decision.'],
  ['Stage target', 'The configured internal deadline for the current workflow stage. It is distinct from a correction deadline or an EVC appointment.'],
  ['Scrutiny', 'Review of an application and its evidence by the responsible officer or review team.'],
  ['Pre-check', 'A preliminary check for supported file types, completeness, readable content, and configured rules. It does not establish authenticity or guarantee approval.'],
  ['Escalation', 'A recorded follow-up triggered by a configured deadline rule and routed to the responsible people.'],
];

export function Glossary() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const terms = TERMS.filter((t) => t.join(' ').toLowerCase().includes(search.trim().toLowerCase()));
  return <>
    <button onClick={() => setOpen(true)} className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink-soft hover:bg-surface-muted" aria-label="Open glossary"><BookOpen className="h-4 w-4" aria-hidden /><span className="hidden xl:inline">Glossary</span></button>
    <Drawer open={open} onOpenChange={setOpen} title="Portal glossary" subtitle="Plain-language help for the terms used in your workspace.">
      <div className="relative mb-6"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-faint" aria-hidden /><Input ref={ref} aria-label="Search glossary" placeholder="Search a term or abbreviation" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 pr-11" />{search && <button aria-label="Clear glossary search" onClick={() => { setSearch(''); ref.current?.focus(); }} className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-lg hover:bg-surface-muted"><X className="h-4 w-4" /></button>}</div>
      <p role="status" className="mb-4 text-sm text-ink-soft">{terms.length} terms</p>
      {terms.length ? <dl className="divide-y divide-line">{terms.map(([term, definition]) => <div key={term} className="py-4"><dt className="font-semibold text-ink">{term}</dt><dd className="mt-2 text-sm leading-relaxed text-ink-soft">{definition}</dd></div>)}</dl> : <EmptyState title="No matching terms" body="Try an abbreviation such as EVC, or clear the search." />}
    </Drawer>
  </>;
}
