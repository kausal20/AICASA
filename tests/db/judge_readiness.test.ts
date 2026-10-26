import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { makeTextPdf, runPrecheck } from '@shared/precheck';
import { changesOnly, diffLines } from '../../src/lib/textDiff';
import { matchExperts, type MatchExpert, type MatchInstitution } from '../../src/lib/expertMatch';
import { showsInferredCaveat } from '../../src/features/deficiencies/DeficiencyCard';
import type { Deficiency } from '../../src/types/domain';

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';

const N2 = 'Extension of approval with intake increase 2027-28'; // DEMO-WR-2026-01002 on the deployed demo
const HERO = [
  N2,
  'Extension of approval 2027-28',                                          // 01005 (Sahyadri)
  'Extension of approval — University Department of Technology',           // 01010
  'Change of site — Sahyadri College to the Survey 310 campus',            // 01011
  'Extension of approval — computing capacity review (demo)',              // 01012
  'Extension of approval — faculty cadre review (demo)',                   // 01013
];

let t: TestDb;
let nirmala: string;
const caseId = async (title: string) => (await t.owner<{ id: string }>(`select id from applications where title = $1 and is_demo`, [title]))[0].id;
const sync = async (id: string) => (await t.owner<{ r: { created: number; resolved: number; updated: number } }>(`select app.sync_matrix_deficiencies($1) as r`, [id]))[0].r;
const autoDefs = (id: string) => t.owner<{ id: string; rule_code: string; status: string; title: string; reason: string; requirement_source: string; rule_version: number; rule_id: string }>(
  `select id, rule_code, status, title, reason, requirement_source, rule_version, rule_id from deficiencies where application_id = $1 and auto_generated order by rule_code`, [id]);
const sha = (c: string) => c.repeat(64);

async function stub(instId: string) {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`, [name, JSON.stringify({ size: 2048, mimetype: 'application/pdf' })]);
  return name;
}
async function upload(app: string, docType: string, file: string, reason: string | null, hash: string) {
  return (await t.as<{ v: { id: string; version: number } }>(NIRMALA,
    `select to_jsonb(register_document_version($1, $2, $3, null, $4, $5, $6, $7)) as v`, [nirmala, app, docType, await stub(nirmala), file, hash, reason]))[0].v;
}
/** Records a pre-check for one version exactly as the Edge Function would: same deterministic engine, same RPC pair. */
const FIRE_REQ = { doc_type: 'fire_safety_certificate', name: 'Fire safety certificate', allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg'], max_bytes: 5242880, expiry_tracked: true,
  required_fields: ['institution_name', 'issue_date', 'expiry_date'] };
async function precheck(versionId: string, lines: string[]) {
  const bytes = makeTextPdf(lines);
  const res = await runPrecheck({ fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: bytes.length, bytes }, FIRE_REQ,
    { institutionName: 'Nirmala Institute of Technology (Demo)', academicYear: '2027-28', today: '2026-10-25' });
  const run = (await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [versionId]))[0].r;
  await t.service(`select complete_document_check($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)`,
    [run.id, res.engine, res.status, res.extraction_status, res.extraction_method, JSON.stringify(res.steps), res.limitations, JSON.stringify(res.summary),
      JSON.stringify(res.findings), res.extracted_text]);
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('fix 1: stranded matrix failures become open queries', () => {
  const failing = { approved_intake: 180, intake_increase: false, programme_level: 'ug_engg', land_area_acres: 2, built_up_area_sqm: 4800, student_count: 900,
    faculty_count: 40, computer_count: 450, lab_count: 5, library_book_count: 9500, faculty_professors: 10, faculty_associate_professors: 20,
    faculty_assistant_professors: 60, principal_count: 1 };
  let id: string;

  it('a 01002-like case evaluated before auto-raise existed gets exactly two queries; a second run adds none; resolved items stay resolved', async () => {
    const draft = (await t.as<{ a: { id: string } }>(NIRMALA, `select to_jsonb(create_application_draft($1, 'EOA', 'Stranded failures fixture', '2027-28', $2)) as a`,
      [nirmala, JSON.stringify({ ...failing, land_area_acres: 3, student_count: 400 })]))[0].a.id;
    id = draft;
    await upload(id, 'affidavit', 'aff.pdf', null, sha('a'));
    await upload(id, 'fire_safety_certificate', 'fire.pdf', null, sha('b'));
    const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]))[0].row_version;
    await t.as(NIRMALA, `select submit_application($1, $2)`, [id, v]);
    expect(await autoDefs(id)).toHaveLength(0); // passing figures: nothing raised yet
    // a previously resolved, manually raised query on the same case
    await t.as(SCRUTINY, `select raise_deficiency($1, 'Fire certificate validity missing', 'The certificate states no validity period.', 'Checklist EOA/fire_safety_certificate', 'Upload a certificate that states its validity.', 'fire_safety_certificate', now() + interval '3 days')`, [id]);
    await t.owner(`update deficiencies set status = 'resolved', resolved_at = now() where application_id = $1 and not auto_generated`, [id]);

    // the figures are the ones 01002 declares; nothing has evaluated them since
    await t.owner(`update applications set form_data = form_data || $2::jsonb where id = $1`, [id, JSON.stringify({ land_area_acres: 2, student_count: 900 })]);
    expect(await autoDefs(id)).toHaveLength(0);

    expect(await sync(id)).toMatchObject({ created: 2, resolved: 0 });
    const rows = await autoDefs(id);
    expect(rows.map((r) => r.rule_code)).toEqual(['land_area_min', 'student_faculty_ratio']);
    const rule = (c: string) => t.owner<{ id: string; version: number }>(`select id, version from compliance_rules where code = $1 and status = 'active'`, [c]).then((x) => x[0]);
    const land = rows[0], ratio = rows[1];
    expect(land).toMatchObject({ status: 'open', title: 'Matrix rule not met: Declared land area' });
    expect(land.requirement_source).toContain(`land_area_min v${(await rule('land_area_min')).version}`);
    expect(land.requirement_source).toContain((await rule('land_area_min')).id);
    expect(land.reason).toContain('2 acres');
    expect(land.reason).toContain('Min 2.5 acres');
    expect(ratio.title).toBe('Matrix rule not met: Student-to-faculty ratio (declared figures)');
    expect(ratio.reason).toContain('1:22.5');
    expect(ratio.requirement_source).toContain('student_faculty_ratio v');

    // idempotent: running the one routine again over this case, and over every case, creates nothing
    const before = (await t.owner<{ n: number }>(`select count(*)::int as n from deficiencies`))[0].n;
    expect(await sync(id)).toMatchObject({ created: 0, updated: 0, resolved: 0 });
    for (const a of await t.owner<{ id: string }>(`select id from applications order by id`)) expect(await sync(a.id)).toMatchObject({ created: 0 });
    expect((await t.owner<{ n: number }>(`select count(*)::int as n from deficiencies`))[0].n).toBe(before);

    // the manual, resolved query is untouched
    expect((await t.owner<{ status: string }>(`select status from deficiencies where application_id = $1 and not auto_generated`, [id]))[0].status).toBe('resolved');

    // a rule that now passes resolves its own item and no other; a later failure does not bring a resolved item back
    await t.owner(`update applications set form_data = form_data || '{"land_area_acres": 3}' where id = $1`, [id]);
    expect(await sync(id)).toMatchObject({ created: 0, resolved: 1 });
    expect((await autoDefs(id)).map((r) => `${r.rule_code}:${r.status}`)).toEqual(['land_area_min:resolved', 'student_faculty_ratio:open']);
    await t.owner(`update applications set form_data = form_data || '{"land_area_acres": 1}' where id = $1`, [id]);
    expect(await sync(id)).toMatchObject({ created: 0 });
    expect((await autoDefs(id)).find((r) => r.rule_code === 'land_area_min')!.status).toBe('resolved');
  });

  it('the seeded 01002 carries exactly the two rule queries, each citing its rule and version', async () => {
    const rows = await autoDefs(await caseId(N2));
    expect(rows.map((r) => [r.rule_code, r.status, r.rule_version])).toEqual([['land_area_min', 'open', 1], ['student_faculty_ratio', 'open', expect.any(Number)]]);
    expect(rows[0].reason).toContain('Min 2.5 acres');
    expect(rows[1].reason).toContain('1:22.5');
  });

  it('one source for the counts: the Applications list value is the number of unresolved queries the case tab lists', async () => {
    const id = await caseId(N2);
    const list = (await t.as<{ n: number }>(SCRUTINY, `select open_deficiencies as n from v_applications where id = $1`, [id]))[0].n;
    const tab = (await t.as(SCRUTINY, `select id from deficiencies where application_id = $1 and status not in ('resolved', 'withdrawn')`, [id])).length;
    expect(list).toBe(3); // the officer's fire-certificate query plus the two rule queries
    expect(tab).toBe(list);
  });
});

describe('fix 2: the compare view reads real content with provenance', () => {
  it('compare on the seeded 01002 fire certificate returns added and removed lines and no "inferred" caveat', async () => {
    const id = await caseId(N2);
    const def = (await t.owner<Deficiency & { id: string }>(`select * from deficiencies where application_id = $1 and doc_type = 'fire_safety_certificate'`, [id]))[0];
    expect(def.affected_version_basis).toBe('captured_at_raise');
    const v1 = (await t.owner<{ id: string }>(`select id from document_versions where id = $1`, [def.affected_document_version_id]))[0].id;
    const v2 = await upload(id, 'fire_safety_certificate', 'fire_certificate_renewed_2026.pdf', 'Renewed certificate states its validity', sha('c'));
    const S = 'SYNTHETIC DEMO DOCUMENT - NOT A REAL RECORD';
    await precheck(v1, [S, 'FIRE SAFETY CERTIFICATE', 'Issued to: Nirmala Institute of Technology (Demo)', 'Date of issue: 05/01/2026', 'Building: Main academic block']);
    await precheck(v2.id, [S, 'FIRE SAFETY CERTIFICATE RENEWED', 'Issued to: Nirmala Institute of Technology (Demo)', 'Date of issue: 20/10/2026', 'Valid till 31/03/2029']);

    const cmp = (await t.as<{ c: { content: { text_available: boolean; old_text: string; new_text: string; text_reason: string | null } } }>(SCRUTINY,
      `select compare_document_versions($1, $2) as c`, [v1, v2.id]))[0].c;
    expect(cmp.content.text_available).toBe(true);
    expect(cmp.content.text_reason).toBeNull();
    const changes = changesOnly(diffLines(cmp.content.old_text, cmp.content.new_text));
    expect(changes.filter((l) => l.kind === 'added').map((l) => l.text)).toContain('Valid till 31/03/2029');
    expect(changes.filter((l) => l.kind === 'removed').map((l) => l.text)).toContain('Building: Main academic block');

    // provenance: the version on file at raise time is stored, so the card shows no caveat
    expect(showsInferredCaveat(def, { attempt: 1, document_version_id: v2.id } as never)).toBe(false);
    expect(showsInferredCaveat({ ...def, affected_version_basis: 'seed_fixture_verified' }, { attempt: 1 } as never)).toBe(false);
    expect(showsInferredCaveat({ ...def, affected_version_basis: 'inferred_unverified' }, { attempt: 1 } as never)).toBe(true);
  });

  it('no seeded query is left on an unproven document link', async () => {
    const n = (await t.owner<{ n: number }>(`select count(*)::int as n from deficiencies where doc_type is not null and affected_version_basis is distinct from 'captured_at_raise' and affected_version_basis is distinct from 'seed_fixture_verified'`))[0].n;
    expect(n).toBe(0);
  });
});

describe('fix 3: matrix completeness, provenance labels and the panel matcher', () => {
  it('none of the six hero cases shows a "Not checked" row, and every rule applicable to the case evaluates to pass or fail', async () => {
    for (const title of HERO) {
      const rows = await t.as<{ check_code: string; section: string; result: string; explanation: string }>(SCRUTINY, `select * from deficiency_matrix($1)`, [await caseId(title)]);
      expect(rows.filter((r) => r.result === 'not_checked').map((r) => r.check_code), title).toEqual([]);
      const rules = rows.filter((r) => r.section === 'rules');
      expect(rules.length, title).toBeGreaterThan(0);
      for (const r of rules) expect(['passed', 'potential_issue', 'failed_validation', 'not_applicable'], `${title} ${r.check_code}`).toContain(r.result);
      for (const r of rows.filter((x) => x.result === 'not_applicable')) expect(r.explanation.trim().length).toBeGreaterThan(10);
    }
  });

  it('a rule whose condition does not apply is "Not applicable" with a one-line reason', async () => {
    const rows = await t.as<{ check_code: string; result: string; explanation: string }>(SCRUTINY, `select * from deficiency_matrix($1)`, [await caseId('Extension of approval 2027-28')]);
    const row = rows.find((r) => r.check_code === 'rule:proposed_intake_consistency')!;
    expect(row.result).toBe('not_applicable');
    expect(row.explanation).toMatch(/intake increase/i);
  });

  it('rules with handbook figures cite the Approval Process Handbook; the rest are one "Demonstration configuration" set', async () => {
    const rules = await t.owner<{ code: string; source_reference: string; is_synthetic: boolean }>(`select code, source_reference, is_synthetic from compliance_rules where status = 'active'`);
    for (const code of ['student_faculty_ratio', 'faculty_cadre_ratio']) {
      const r = rules.find((x) => x.code === code)!;
      expect(r.source_reference).toMatch(/^AICTE Approval Process Handbook 2024–27/);
      expect(r.is_synthetic).toBe(false);
    }
    for (const code of ['land_area_min', 'built_up_min', 'labs_min', 'library_books_min', 'computers_required']) {
      expect(rules.find((x) => x.code === code)).toMatchObject({ source_reference: 'Demonstration configuration', is_synthetic: true });
    }
  });

  it('no expert without a specialization match is Eligible on any seeded Recommend panel; the Pharmacy expert is not eligible for Nirmala', async () => {
    const evcs = await t.owner<{ id: string; title: string }>(`select e.id, a.title from evc_records e join applications a on a.id = e.application_id where a.region_code = 'WR'`);
    expect(evcs.length).toBeGreaterThan(2);
    for (const e of evcs) {
      const r = (await t.as<{ r: { institution: MatchInstitution; programme_text: string; experts: MatchExpert[] } }>(EVC, `select expert_match_inputs($1) as r`, [e.id]))[0].r;
      const m = matchExperts(r.institution, r.experts, { programmeText: r.programme_text });
      for (const x of m.recommended) expect(x.matchedTags.length, `${e.title}: ${x.expert.full_name}`).toBeGreaterThan(0);
      const pharmacy = m.excluded.find((x) => x.expert.full_name.startsWith('Dr. Meenal Kapoor'));
      if (r.institution.name.startsWith('Nirmala')) expect(pharmacy?.labels).toContain('Excluded — no specialization match');
    }
  });
});
