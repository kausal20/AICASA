/**
 * Expert panel matcher. Pure functions over the facts returned by `expert_match_inputs`.
 *
 * Hard exclusions (never ranked, reason always shown):
 *   - affiliated:        the expert's home institution is the institute
 *   - declared_conflict: a conflict of interest against the institute is on record (self-declared or entered by an officer)
 *   - same_district:     the expert's home district (and state) equals the institute's district
 * Eligible experts are ranked by specialization match to the institute's programmes, then by region proximity, then by name.
 * The server re-checks the same three rules when an expert is assigned (`assign_evc_expert`), so these rules also hold without the UI.
 */

export interface MatchInstitution {
  id: string; name: string; district: string | null; state: string; region_code: string; programmes: string[];
}

export interface MatchExpert {
  id: string; full_name: string; specializations: string[];
  home_district: string; home_state: string; home_institution_id: string | null; home_institution_name: string | null;
  region_code: string; profile_id?: string | null;
  /** Declared conflicts against *this* institute only (the server filters them). */
  declared_conflicts: { id: string; nature: string; declared_at: string }[];
  availability: { kind: 'available' | 'unavailable'; starts_at: string; ends_at: string; note?: string | null }[];
  assigned?: boolean;
}

export type ExclusionCode = 'affiliated' | 'declared_conflict' | 'same_district';

export const EXCLUSION_TEXT: Record<ExclusionCode, string> = {
  same_district: 'Excluded — same district as institute',
  declared_conflict: 'Excluded — declared conflict',
  affiliated: 'Excluded — affiliated with this institute',
};

export type SessionFit = 'available' | 'unavailable' | 'unknown';

export interface Recommendation {
  expert: MatchExpert; rank: number; matchedTags: string[]; proximity: 0 | 1 | 2; sessionFit: SessionFit;
}
export interface Excluded { expert: MatchExpert; reasons: ExclusionCode[]; labels: string[] }
export interface MatchResult { recommended: Recommendation[]; excluded: Excluded[]; programmeTags: string[] }

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const TAG_ALIASES: Record<string, string> = {
  cse: 'CSE', 'computer science': 'CSE', cs: 'CSE', computer: 'CSE',
  ece: 'ECE', electronics: 'ECE', eee: 'EEE', electrical: 'EEE',
  civil: 'Civil', 'civil engineering': 'Civil',
  mechanical: 'Mechanical', mech: 'Mechanical',
  pharmacy: 'Pharmacy', pharm: 'Pharmacy', 'b.pharm': 'Pharmacy',
  management: 'Management', mba: 'Management',
  architecture: 'Architecture', 'b.arch': 'Architecture',
};

/** Canonical form of a specialization or programme tag so "computer science", "CSE" and "cse" compare equal. */
export function canonicalTag(tag: string): string {
  const k = norm(tag);
  return TAG_ALIASES[k] ?? tag.trim();
}

/** Programme tags mentioned in free text, e.g. "B.E. Mechanical (demo)" or "MBA Business Analytics". */
export function inferTags(text: string | null | undefined): string[] {
  const t = norm(text);
  if (!t) return [];
  const found = new Set<string>();
  const rules: [RegExp, string][] = [
    [/computer|\bcse\b|\bcs\b|information technology|data science|artificial intelligence/, 'CSE'],
    [/electronics|\bece\b|communication/, 'ECE'], [/electrical|\beee\b/, 'EEE'],
    [/civil|structural/, 'Civil'], [/mechanical|\bmech\b/, 'Mechanical'],
    [/pharm/, 'Pharmacy'], [/management|\bmba\b|business/, 'Management'], [/architect|b\.arch/, 'Architecture'],
  ];
  for (const [re, tag] of rules) if (re.test(t)) found.add(tag);
  return [...found];
}

/** Demo configuration: which regions border each other. Same region ranks first, a neighbouring region second, any other third. */
const NEIGHBOURS: Record<string, string[]> = {
  WR: ['CR', 'SR', 'NR'], SR: ['CR', 'ER', 'WR'], ER: ['CR', 'NR', 'SR'], NR: ['CR', 'ER', 'WR'], CR: ['NR', 'SR', 'ER', 'WR'],
};
export function regionProximity(institutionRegion: string, expertRegion: string): 0 | 1 | 2 {
  if (institutionRegion === expertRegion) return 0;
  return NEIGHBOURS[institutionRegion]?.includes(expertRegion) ? 1 : 2;
}

/** The hard exclusions that apply to one expert for one institute, in the order they are reported. Empty = eligible. */
export function exclusionsFor(inst: MatchInstitution, e: MatchExpert): ExclusionCode[] {
  const out: ExclusionCode[] = [];
  if (e.home_institution_id === inst.id || (!!norm(e.home_institution_name) && norm(e.home_institution_name) === norm(inst.name))) out.push('affiliated');
  if (e.declared_conflicts.length > 0) out.push('declared_conflict');
  if (!!norm(inst.district) && norm(e.home_district) === norm(inst.district) && norm(e.home_state) === norm(inst.state)) out.push('same_district');
  return out;
}

function sessionFit(e: MatchExpert, start?: string | null, end?: string | null): SessionFit {
  if (!start || !end) return 'unknown';
  const s = new Date(start).getTime(), f = new Date(end).getTime();
  const overlaps = (w: MatchExpert['availability'][number]) => new Date(w.starts_at).getTime() < f && new Date(w.ends_at).getTime() > s;
  if (e.availability.some((w) => w.kind === 'unavailable' && overlaps(w))) return 'unavailable';
  if (e.availability.some((w) => w.kind === 'available' && new Date(w.starts_at).getTime() <= s && new Date(w.ends_at).getTime() >= f)) return 'available';
  return 'unknown';
}

export function matchExperts(
  inst: MatchInstitution, experts: MatchExpert[],
  opts: { programmeText?: string | null; sessionStart?: string | null; sessionEnd?: string | null } = {},
): MatchResult {
  const programmeTags = [...new Set([...inst.programmes.map(canonicalTag), ...inferTags(opts.programmeText)])];
  const recommended: Omit<Recommendation, 'rank'>[] = [];
  const excluded: Excluded[] = [];
  for (const expert of experts) {
    const reasons = exclusionsFor(inst, expert);
    if (reasons.length) { excluded.push({ expert, reasons, labels: reasons.map((r) => EXCLUSION_TEXT[r]) }); continue; }
    const matchedTags = [...new Set(expert.specializations.map(canonicalTag))].filter((t) => programmeTags.includes(t));
    recommended.push({ expert, matchedTags, proximity: regionProximity(inst.region_code, expert.region_code), sessionFit: sessionFit(expert, opts.sessionStart, opts.sessionEnd) });
  }
  recommended.sort((a, b) => b.matchedTags.length - a.matchedTags.length || a.proximity - b.proximity || a.expert.full_name.localeCompare(b.expert.full_name));
  excluded.sort((a, b) => a.expert.full_name.localeCompare(b.expert.full_name));
  return { recommended: recommended.map((r, i) => ({ ...r, rank: i + 1 })), excluded, programmeTags };
}
