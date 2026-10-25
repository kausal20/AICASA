import { describe, expect, it } from 'vitest';
import { EXCLUSION_TEXT, exclusionsFor, inferTags, matchExperts, regionProximity, type MatchExpert, type MatchInstitution } from '../../src/lib/expertMatch';

const inst: MatchInstitution = {
  id: 'inst-1', name: 'Sahyadri College of Engineering (Demo)', district: 'Nashik', state: 'Maharashtra', region_code: 'WR',
  programmes: ['CSE', 'Mechanical', 'Civil'],
};

let n = 0;
const expert = (over: Partial<MatchExpert> = {}): MatchExpert => ({
  id: `e${++n}`, full_name: `Expert ${String.fromCharCode(64 + n)}`, specializations: ['CSE'],
  home_district: 'Coimbatore', home_state: 'Tamil Nadu', home_institution_id: null, home_institution_name: 'Somewhere Institute',
  region_code: 'SR', declared_conflicts: [], availability: [], ...over,
});

describe('hard exclusions', () => {
  it('excludes an expert whose home district is the institute district, even with no declaration', () => {
    const e = expert({ home_district: 'Nashik', home_state: 'Maharashtra' });
    const r = matchExperts(inst, [e]);
    expect(r.recommended).toHaveLength(0);
    expect(r.excluded[0].reasons).toEqual(['same_district']);
    expect(r.excluded[0].labels).toEqual(['Excluded — same district as institute']);
  });

  it('compares district and state: the same district name in another state is not excluded', () => {
    const e = expert({ home_district: 'Nashik', home_state: 'Elsewhere' });
    expect(exclusionsFor(inst, e)).toEqual([]);
    expect(exclusionsFor(inst, expert({ home_district: '  nashik ', home_state: 'MAHARASHTRA' }))).toEqual(['same_district']);
  });

  it('excludes an expert with a declared conflict against the institute', () => {
    const e = expert({ declared_conflicts: [{ id: 'c1', nature: 'Co-author with a trustee', declared_at: '2026-10-01T00:00:00Z' }] });
    const r = matchExperts(inst, [e]);
    expect(r.recommended).toHaveLength(0);
    expect(r.excluded[0].labels).toEqual(['Excluded — declared conflict']);
  });

  it('excludes an expert whose home institution is the institute (by id, and by name when the institute is not linked)', () => {
    const byId = expert({ home_institution_id: 'inst-1' });
    const byName = expert({ home_institution_id: null, home_institution_name: 'sahyadri college of engineering (demo)' });
    const r = matchExperts(inst, [byId, byName]);
    expect(r.recommended).toHaveLength(0);
    expect(r.excluded.map((x) => x.labels)).toEqual([['Excluded — affiliated with this institute'], ['Excluded — affiliated with this institute']]);
  });

  it('reports every reason that applies, in a fixed order', () => {
    const e = expert({ home_district: 'Nashik', home_state: 'Maharashtra', home_institution_id: 'inst-1',
      declared_conflicts: [{ id: 'c1', nature: 'x', declared_at: '2026-10-01T00:00:00Z' }] });
    expect(exclusionsFor(inst, e)).toEqual(['affiliated', 'declared_conflict', 'same_district']);
    expect(matchExperts(inst, [e]).excluded[0].labels).toEqual([EXCLUSION_TEXT.affiliated, EXCLUSION_TEXT.declared_conflict, EXCLUSION_TEXT.same_district]);
  });

  it('cannot apply the district rule when the institute has no district on record', () => {
    const e = expert({ home_district: 'Nashik', home_state: 'Maharashtra' });
    expect(exclusionsFor({ ...inst, district: null }, e)).toEqual([]);
  });

  it('exclusion strings are exactly the ones shown to the officer', () => {
    expect(EXCLUSION_TEXT).toEqual({
      same_district: 'Excluded — same district as institute',
      declared_conflict: 'Excluded — declared conflict',
      affiliated: 'Excluded — affiliated with this institute',
    });
  });
});

describe('ranking', () => {
  it('ranks specialization match first, then region proximity, then name', () => {
    const sameRegionOneMatch = expert({ full_name: 'Same region, one match', specializations: ['CSE'], region_code: 'WR' });
    const neighbourTwoMatches = expert({ full_name: 'Neighbour, two matches', specializations: ['Mechanical', 'Civil'], region_code: 'SR' });
    const sameRegionTwoMatches = expert({ full_name: 'Same region, two matches', specializations: ['CSE', 'Mechanical'], region_code: 'WR' });
    const noMatch = expert({ full_name: 'No match', specializations: ['Pharmacy'], region_code: 'WR' });
    const farOneMatch = expert({ full_name: 'Far, one match', specializations: ['Civil'], region_code: 'ER' });
    const r = matchExperts(inst, [noMatch, farOneMatch, sameRegionOneMatch, neighbourTwoMatches, sameRegionTwoMatches]);
    expect(r.recommended.map((x) => x.expert.full_name)).toEqual([
      'Same region, two matches', 'Neighbour, two matches', 'Same region, one match', 'Far, one match', 'No match',
    ]);
    expect(r.recommended.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.recommended[0].matchedTags).toEqual(['CSE', 'Mechanical']);
    expect(r.recommended[4].matchedTags).toEqual([]);
  });

  it('a specialization match outranks being in the same region', () => {
    const nearButWrong = expert({ full_name: 'Near, wrong field', specializations: ['Pharmacy'], region_code: 'WR' });
    const farButRight = expert({ full_name: 'Far, right field', specializations: ['CSE'], region_code: 'ER' });
    expect(matchExperts(inst, [nearButWrong, farButRight]).recommended[0].expert.full_name).toBe('Far, right field');
  });

  it('excluded experts never appear in the ranking, whatever their match', () => {
    const perfectButSameDistrict = expert({ full_name: 'Perfect match', specializations: ['CSE', 'Mechanical', 'Civil'], region_code: 'WR',
      home_district: 'Nashik', home_state: 'Maharashtra' });
    const ok = expert({ full_name: 'Weak match', specializations: ['Pharmacy'] });
    const r = matchExperts(inst, [perfectButSameDistrict, ok]);
    expect(r.recommended.map((x) => x.expert.full_name)).toEqual(['Weak match']);
    expect(r.excluded.map((x) => x.expert.full_name)).toEqual(['Perfect match']);
  });

  it('treats specialization names as equal across spellings and adds tags read from the application programme text', () => {
    const e = expert({ specializations: ['computer science'] });
    expect(matchExperts(inst, [e]).recommended[0].matchedTags).toEqual(['CSE']);
    const pharma = expert({ specializations: ['Pharmacy'] });
    const r = matchExperts({ ...inst, programmes: [] }, [pharma], { programmeText: 'B.Pharm programme (demo)' });
    expect(r.programmeTags).toEqual(['Pharmacy']);
    expect(r.recommended[0].matchedTags).toEqual(['Pharmacy']);
  });

  it('notes whether a recorded window covers, or clashes with, the session', () => {
    const start = '2026-11-10T04:00:00Z', end = '2026-11-10T09:00:00Z';
    const covered = expert({ availability: [{ kind: 'available', starts_at: '2026-11-01T00:00:00Z', ends_at: '2026-12-01T00:00:00Z' }] });
    const clash = expert({ availability: [{ kind: 'unavailable', starts_at: '2026-11-09T00:00:00Z', ends_at: '2026-11-12T00:00:00Z' }] });
    const none = expert();
    const r = matchExperts(inst, [covered, clash, none], { sessionStart: start, sessionEnd: end });
    const fit = (e: MatchExpert) => r.recommended.find((x) => x.expert.id === e.id)!.sessionFit;
    expect([fit(covered), fit(clash), fit(none)]).toEqual(['available', 'unavailable', 'unknown']);
  });
});

describe('helpers', () => {
  it('region proximity: same region, neighbour, other', () => {
    expect([regionProximity('WR', 'WR'), regionProximity('WR', 'SR'), regionProximity('WR', 'ER')]).toEqual([0, 1, 2]);
  });
  it('infers programme tags from free text', () => {
    expect(inferTags('B.E. Mechanical (demo)')).toEqual(['Mechanical']);
    expect(inferTags('MBA Business Analytics (demo)')).toEqual(['Management']);
    expect(inferTags('B.Arch (demo)')).toEqual(['Architecture']);
    expect(inferTags('')).toEqual([]);
  });
});
