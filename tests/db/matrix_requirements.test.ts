import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectSqlError, type TestDb } from './harness';
import { cadreSplit, requiredCount } from '../../src/lib/matrixMath';

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SAHYADRI = 'inst.sahyadri@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const SR = 'officer.sr@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';

const COMPUTERS = 'Extension of approval — computing capacity review (demo)';
const CADRE = 'Extension of approval — faculty cadre review (demo)';

let t: TestDb;
let nirmala: string;
type Row = { check_code: string; label: string; result: string; input_value: string; requirement: string; explanation: string; rule_ref: string };
type Def = { id: string; status: string; reason: string; title: string; requirement_source: string; rule_id: string; rule_code: string; rule_version: number; auto_generated: boolean; raised_by: string | null; due_at: string };

const caseId = async (title: string) => (await t.owner<{ id: string }>(`select id from applications where title = $1`, [title]))[0].id;
const matrix = (who: string, id: string) => t.as<Row>(who, `select * from deficiency_matrix($1)`, [id]);
const defs = (id: string) => t.owner<Def>(`select id, status, reason, title, requirement_source, rule_id, rule_code, rule_version, auto_generated, raised_by, due_at from deficiencies where application_id = $1 and auto_generated order by rule_code`, [id]);
const recheck = (who: string, id: string) => t.as<{ r: { created: number; updated: number; resolved: number; skipped: string | null } }>(who, `select recheck_matrix_deficiencies($1) as r`, [id]).then((x) => x[0].r);
const form = { approved_intake: 100, intake_increase: false, programme_level: 'ug_engg', student_count: 100, faculty_count: 5, computer_count: 25, library_book_count: 1000, lab_count: 4,
  faculty_professors: 1, faculty_associate_professors: 1, faculty_assistant_professors: 3 };
async function draft(title: string, over: object = {}, who = NIRMALA, inst = nirmala, type = 'EOA') {
  return (await t.as<{ a: { id: string } }>(who, `select to_jsonb(create_application_draft($1, $2, $3, '2027-28', $4)) as a`, [inst, type, title, JSON.stringify({ ...form, ...over })]))[0].a.id;
}
const rule = async (who: string, id: string, code: string) => (await matrix(who, id)).filter((x) => x.check_code === `rule:${code}` || x.check_code.startsWith(`rule:${code}:`));

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('new application fields', () => {
  it('EOA and NEW_INST forms carry the library, laboratory, cadre and programme-level fields; other types do not', async () => {
    const keys = ['library_book_count', 'lab_count', 'faculty_professors', 'faculty_associate_professors', 'faculty_assistant_professors', 'programme_level'];
    for (const type of ['EOA', 'NEW_INST']) {
      const r = await t.owner<{ k: string }>(`select f ->> 'key' as k from application_types a, jsonb_array_elements(a.form_schema) f where a.code = $1`, [type]);
      for (const k of keys) expect(r.map((x) => x.k), `${type}.${k}`).toContain(k);
      expect(r.map((x) => x.k)).toContain('faculty_count'); // the existing total is kept
    }
    const other = await t.owner<{ k: string }>(`select f ->> 'key' as k from application_types a, jsonb_array_elements(a.form_schema) f where a.code = 'CHANGE_NAME'`);
    expect(other.map((x) => x.k)).not.toContain('lab_count');
  });
});

describe('Required count rule', () => {
  it('seeded demo case reproduces the exact deficiency message', async () => {
    const id = await caseId(COMPUTERS);
    const [row] = await rule(SCRUTINY, id, 'computers_required');
    expect(row.result).toBe('potential_issue');
    expect(row.explanation).toBe('Sanctioned intake requires 120 computers, only 95 declared — Deficiency detected.');
    const [d] = (await defs(id)).filter((x) => x.rule_code === 'computers_required');
    expect(d.reason).toBe('Sanctioned intake requires 120 computers, only 95 declared — Deficiency detected.');
  });

  it('boundaries and bad values (SQL), and agreement with the TypeScript arithmetic', async () => {
    const check = async (students: unknown, computers: unknown, title: string) => (await rule(NIRMALA, await draft(title, { student_count: students, computer_count: computers }), 'computers_required'))[0];
    expect((await check(480, 120, 'Req exact')).result).toBe('passed');
    expect((await check(481, 120, 'Req 481 short')).explanation).toMatch(/requires 121 computers, only 120 declared/);
    expect((await check(481, 121, 'Req 481 ok')).result).toBe('passed');
    expect((await check(0, 0, 'Req zero')).result).toBe('passed');
    expect((await check(480, 'x', 'Req malformed')).result).toBe('failed_validation');
    expect((await check(-4, 10, 'Req negative')).result).toBe('failed_validation');
    expect((await check(480, undefined, 'Req missing')).result).toBe('not_checked');
    for (const s of [1, 3, 4, 5, 99, 100, 479, 480, 481, 1000]) {
      const r = await check(s, 0, `Parity ${s}`);
      expect(r.requirement).toContain(`Required ${requiredCount(s, { divisor: 4 })} computers`);
    }
  });

  it('library rule uses the configured demo factor and is labelled as a demo value', async () => {
    const id = await draft('Library short', { student_count: 100, library_book_count: 999 });
    const [r] = await rule(NIRMALA, id, 'library_books_min');
    expect(r.explanation).toBe('Sanctioned intake requires 1000 library books, only 999 declared — Deficiency detected.');
    expect(await t.owner(`select 1 from compliance_rules where code = 'library_books_min' and is_synthetic and source_reference like 'DEMO VALUE%'`)).toHaveLength(1);
  });

  it('laboratory minimum is an ordinary min rule on lab_count', async () => {
    expect((await rule(NIRMALA, await draft('Labs 3', { lab_count: 3 }), 'labs_min'))[0].result).toBe('potential_issue');
    expect((await rule(NIRMALA, await draft('Labs 4', { lab_count: 4 }), 'labs_min'))[0].result).toBe('passed');
  });
});

describe('Cadre ratio rule', () => {
  it('seeded demo case reports 0 of 3 Professors', async () => {
    const id = await caseId(CADRE);
    const rows = await rule(SCRUTINY, id, 'faculty_cadre_ratio');
    const prof = rows.find((r) => r.check_code.endsWith('faculty_professors'))!;
    expect(prof).toMatchObject({ result: 'potential_issue', explanation: '0 of 3 Professors — cadre violation.' });
    expect(rows.find((r) => r.check_code.endsWith('faculty_associate_professors'))!.result).toBe('passed');
    expect(rows.find((r) => r.check_code.endsWith('faculty_assistant_professors'))!.result).toBe('passed');
    expect(rows.find((r) => r.check_code.endsWith(':principal'))!.result).toBe('not_checked');
  });

  it('worked example S = 480 -> 24 faculty -> 3 / 5 / 16 (+1 Principal), each shortfall reported separately', async () => {
    const id = await draft('Cadre 480', { approved_intake: 480, faculty_professors: 1, faculty_associate_professors: 5, faculty_assistant_professors: 10 });
    const rows = await rule(NIRMALA, id, 'faculty_cadre_ratio');
    const by = (k: string) => rows.find((r) => r.check_code.endsWith(k))!;
    expect(by('faculty_professors').explanation).toBe('1 of 3 Professors — cadre violation.');
    expect(by('faculty_associate_professors').explanation).toBe('5 of 5 Associate Professors — meets the requirement.');
    expect(by('faculty_assistant_professors').explanation).toBe('10 of 16 Assistant Professors — cadre violation.');
    expect(by(':principal').explanation).toMatch(/One Principal is also required/);
  });

  it('agrees with the TypeScript split for UG, PG and Diploma and for awkward intakes', async () => {
    const levels: [string, number][] = [['ug_engg', 20], ['pg_engg', 15], ['diploma', 25]];
    for (const [level, div] of levels) {
      for (const s of [1, 60, 100, 250, 300, 480, 481, 777]) {
        const rows = await rule(NIRMALA, await draft(`Cadre ${level} ${s}`, { approved_intake: s, programme_level: level }), 'faculty_cadre_ratio');
        const want = cadreSplit(s, div).parts;
        const got = ['faculty_professors', 'faculty_associate_professors', 'faculty_assistant_professors'].map((k) =>
          Number(rows.find((r) => r.check_code.endsWith(k))!.requirement.match(/Required (\d+)/)![1]));
        expect(got, `${level} ${s}`).toEqual(want);
      }
    }
  });

  it('missing, malformed and negative declared counts are never a pass', async () => {
    const mk = async (over: object, title: string) => (await rule(NIRMALA, await draft(title, { approved_intake: 480, ...over }), 'faculty_cadre_ratio')).find((r) => r.check_code.endsWith('faculty_professors'))!;
    expect((await mk({ faculty_professors: undefined }, 'Cad missing')).result).toBe('not_checked');
    expect((await mk({ faculty_professors: 'many' }, 'Cad malformed')).result).toBe('failed_validation');
    expect((await mk({ faculty_professors: -2 }, 'Cad negative')).result).toBe('failed_validation');
    const noBase = await rule(NIRMALA, await draft('Cad no base', { approved_intake: undefined }), 'faculty_cadre_ratio');
    expect(noBase).toHaveLength(1);
    expect(noBase[0].result).toBe('not_checked');
  });
});

describe('programme-dependent student-to-faculty ratio', () => {
  const sfr = async (level: unknown, students: number, faculty: number, title: string) =>
    (await rule(NIRMALA, await draft(title, { programme_level: level, student_count: students, faculty_count: faculty }), 'student_faculty_ratio'))[0];
  it('UG 1:20, PG 1:15, Diploma 1:25, default UG when undeclared, unknown level -> manual review', async () => {
    expect((await sfr('ug_engg', 400, 20, 'SFR ug ok')).result).toBe('passed');
    expect((await sfr('ug_engg', 401, 20, 'SFR ug bad')).result).toBe('potential_issue');
    expect((await sfr('pg_engg', 300, 20, 'SFR pg ok')).result).toBe('passed');
    expect((await sfr('pg_engg', 301, 20, 'SFR pg bad')).result).toBe('potential_issue');
    expect((await sfr('diploma', 500, 20, 'SFR dip ok')).result).toBe('passed');
    expect((await sfr('Diploma', 501, 20, 'SFR dip bad')).result).toBe('potential_issue');
    const undeclared = await sfr(undefined, 400, 20, 'SFR default');
    expect(undeclared.result).toBe('passed');
    expect(undeclared.requirement).toMatch(/assumed from rule configuration/);
    expect((await sfr('phd', 400, 20, 'SFR unknown')).result).toBe('manual_review');
  });
});

describe('rule publication for the new kinds', () => {
  const publish = (code: string, kind: string, params: object) =>
    t.as<{ r: { version: number } }>(ADMIN, `select to_jsonb(publish_compliance_rule($1, 'Test rule', $2, array['EOA'], $3, 'SYNTHETIC DEMO RULE for tests', true, '', 'Publishing for the matrix tests')) as r`, [code, kind, JSON.stringify(params)]);
  it('validates fields, factor/divisor, ratio parts and programme maps', async () => {
    const base = { base_field: 'student_count', declared_field: 'lab_count', noun: 'labs', subject: 'Sanctioned intake' };
    await expectSqlError(publish('rc_a', 'required_count', { ...base }), /exactly one/);
    await expectSqlError(publish('rc_b', 'required_count', { ...base, factor: 2, divisor: 2 }), /exactly one/);
    await expectSqlError(publish('rc_c', 'required_count', { ...base, divisor: 0 }), /greater than zero/);
    await expectSqlError(publish('rc_d', 'required_count', { ...base, divisor: 4, declared_field: 'not_a_field' }), /not on the EOA form/);
    await expectSqlError(publish('rc_e', 'required_count', { ...base, divisor: 4, noun: '' }), /counted item/);
    const cad = { base_field: 'approved_intake', divisor: 20, names: ['A', 'B', 'C'], fields: ['faculty_professors', 'faculty_associate_professors', 'faculty_assistant_professors'], ratios: [1, 2, 6] };
    await expectSqlError(publish('cr_a', 'cadre_ratio', { ...cad, ratios: [1, 2.5, 6] }), /whole numbers/);
    await expectSqlError(publish('cr_b', 'cadre_ratio', { ...cad, fields: ['faculty_professors'] }), /three cadre fields/);
    await expectSqlError(publish('cr_c', 'cadre_ratio', { ...cad, divisor: undefined }), /positive divisor/);
    await expectSqlError(publish('cr_d', 'cadre_ratio', { ...cad, fields: ['faculty_professors', 'faculty_associate_professors', 'nope'] }), /not on the EOA form/);
    await expectSqlError(publish('sf_a', 'ratio_max', { numerator: 'student_count', denominator: 'faculty_count', threshold_by_level: { ug: 0 }, level_field: 'programme_level' }), /greater than zero/);
    await expectSqlError(publish('sf_b', 'ratio_max', { numerator: 'student_count', denominator: 'faculty_count', threshold_by_level: { ug: 20 } }), /programme level/);
    await expectSqlError(publish('sf_c', 'ratio_max', { numerator: 'student_count', denominator: 'faculty_count', threshold_by_level: { ug: 20 }, level_field: 'programme_level', default_level: 'pg' }), /default programme level/);
    const ok = await publish('rc_ok', 'required_count', { ...base, divisor: 10 });
    expect(ok[0].r.version).toBe(1);
    await t.as(ADMIN, `select retire_compliance_rule('rc_ok', 'Removing the scratch rule used by this test')`);
  });
  it('the new fields are valid rule fields (they appear in the dialog field lists)', async () => {
    for (const f of ['library_book_count', 'lab_count']) {
      const r = await t.as<{ r: { version: number } }>(ADMIN, `select to_jsonb(publish_compliance_rule($1, 'Field check', 'min', array['EOA','NEW_INST'], $2, 'SYNTHETIC DEMO RULE for tests', true, '', 'Checking the new field is usable')) as r`,
        [`field_${f}`, JSON.stringify({ field: f, threshold: 1 })]);
      expect(r[0].r.version).toBe(1);
      await t.as(ADMIN, `select retire_compliance_rule($1, 'Removing the scratch rule used by this test')`, [`field_${f}`]);
    }
  });
});

describe('breaches become deficiencies', () => {
  it('submitting the seeded cases opened one deficiency per failing rule, citing rule id and version', async () => {
    const a = await defs(await caseId(COMPUTERS));
    expect(a.map((d) => d.rule_code)).toEqual(['computers_required']);
    const rule1 = (await t.owner<{ id: string }>(`select id from compliance_rules where code = 'computers_required' and version = 1`))[0].id;
    expect(a[0]).toMatchObject({ status: 'open', auto_generated: true, rule_version: 1, rule_id: rule1, raised_by: null });
    expect(a[0].requirement_source).toContain('computers_required v1');
    expect(a[0].requirement_source).toContain(rule1);
    expect(a[0].title).toBe('Matrix rule not met: Computers for the sanctioned intake');
    const b = await defs(await caseId(CADRE));
    expect(b.map((d) => d.rule_code)).toEqual(['faculty_cadre_ratio']);
    expect(b[0].reason).toBe('0 of 3 Professors — cadre violation.');
    expect((await t.owner(`select 1 from audit_logs where action = 'deficiency_auto_raised' and entity_id = $1`, [a[0].id])).length).toBe(1);
  });

  it('a failing rule creates an open deficiency, repeat checks do not duplicate it, and a passing re-check resolves it', async () => {
    const id = await caseId(COMPUTERS);
    expect(await recheck(SCRUTINY, id)).toMatchObject({ created: 0, updated: 0, resolved: 0 });
    expect(await defs(id)).toHaveLength(1);
    // the institution's figures are corrected (simulated here at the data level), then the officer re-checks
    await t.owner(`update applications set form_data = form_data || '{"computer_count": 120}' where id = $1`, [id]);
    expect(await recheck(SCRUTINY, id)).toMatchObject({ created: 0, resolved: 1 });
    const [d] = await defs(id);
    expect(d.status).toBe('resolved');
    expect((await t.owner(`select 1 from application_events where application_id = $1 and event_type = 'deficiency_auto_resolved'`, [id])).length).toBe(1);
    expect((await t.owner(`select 1 from audit_logs where action = 'deficiency_auto_resolved' and entity_id = $1`, [d.id])).length).toBe(1);
    // and it breaks again -> a NEW open deficiency (history kept)
    await t.owner(`update applications set form_data = form_data || '{"computer_count": 90}' where id = $1`, [id]);
    expect(await recheck(SCRUTINY, id)).toMatchObject({ created: 1 });
    expect((await defs(id)).map((x) => x.status).sort()).toEqual(['open', 'resolved']);
  });

  it('a new rule version updates the open deficiency and cites the new version; retiring the rule resolves it', async () => {
    const id = await caseId(CADRE);
    await t.as(ADMIN, `select publish_compliance_rule('faculty_cadre_ratio', 'Faculty cadre ratio', 'cadre_ratio', array['EOA'],
      (select params from compliance_rules where code = 'faculty_cadre_ratio' and status = 'active'), 'Supplied by the project team from APH 2024-27; not verified', true, 'Second version for the test', 'Republishing to test version citation')`);
    await t.owner(`update applications set form_data = form_data || '{"approved_intake": 740}' where id = $1`, [id]);
    expect(await recheck(SCRUTINY, id)).toMatchObject({ updated: 1 });
    const [d] = await defs(id);
    expect(d).toMatchObject({ status: 'open', rule_version: 2 });
    expect(d.reason).toContain('0 of 4 Professors — cadre violation.');
    expect(d.requirement_source).toContain('faculty_cadre_ratio v2');
    await t.as(ADMIN, `select retire_compliance_rule('faculty_cadre_ratio', 'Retiring the rule for the matrix test run')`);
    expect(await recheck(SCRUTINY, id)).toMatchObject({ resolved: 1 });
    expect((await defs(id))[0].status).toBe('resolved');
  });

  it('resolving the last open deficiency returns a returned case to its review stage', async () => {
    const id = await caseId(COMPUTERS);
    await t.owner(`update applications set form_data = form_data || '{"computer_count": 90}' where id = $1`, [id]);
    await recheck(SCRUTINY, id);
    const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]))[0].row_version;
    await t.as(SCRUTINY, `select return_for_correction($1, $2, 'Computers are short of the requirement; please correct.')`, [id, v]);
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [id]))[0].status).toBe('returned_for_correction');
    await t.owner(`update applications set form_data = form_data || '{"computer_count": 120}' where id = $1`, [id]);
    await recheck(SCRUTINY, id);
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [id]))[0].status).toBe('under_scrutiny');
  });

  it('only the responsible officer can trigger a re-check; drafts get no deficiencies; a missing default period records nothing', async () => {
    const id = await caseId(CADRE);
    await expectSqlError(t.as(NIRMALA, `select recheck_matrix_deficiencies($1)`, [id]), /Only an officer/);
    await expectSqlError(t.as(SR, `select recheck_matrix_deficiencies($1)`, [id]), /region WR|not found/i);
    await expectSqlError(t.as(EVC, `select recheck_matrix_deficiencies($1)`, [id]), /scrutiny/);
    const dr = await draft('Draft with breaches', { computer_count: 1 });
    expect((await t.owner(`select 1 from deficiencies where application_id = $1`, [dr])).length).toBe(0);
    // no default correction period configured: the breach is reported as skipped, not invented
    const sid = await caseId(CADRE);
    await t.owner(`delete from system_settings where key = 'deficiency.correction_period'`);
    await t.owner(`update applications set form_data = form_data || '{"faculty_professors": 0}' where id = $1`, [sid]);
    await t.as(ADMIN, `select publish_compliance_rule('faculty_cadre_ratio', 'Faculty cadre ratio', 'cadre_ratio', array['EOA'],
      (select params from compliance_rules where code = 'faculty_cadre_ratio' order by version desc limit 1), 'Supplied by the project team from APH 2024-27; not verified', true, '', 'Re-publishing the cadre rule for the period test')`);
    const r = await recheck(SCRUTINY, sid);
    expect(r.created).toBe(0);
    expect(r.skipped).toMatch(/no default correction period/);
  });

  it('browser roles cannot create or edit rule deficiencies directly', async () => {
    const id = await caseId(COMPUTERS);
    const [d] = await defs(id);
    await expectSqlError(t.as(SCRUTINY, `update deficiencies set status = 'resolved' where id = $1`, [d.id]), /permission denied/);
    await expectSqlError(t.as(SAHYADRI, `insert into deficiencies (application_id, stage_code, title, reason, requirement_source, requested_correction, due_at) values ($1, 'scrutiny', 'x', 'y', 'z', 'w', now())`, [id]), /permission denied/);
  });
});
