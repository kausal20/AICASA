import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, createTestDb, expectSqlError, type TestDb } from './harness';

// Audit suite for the four differentiation features. Every test runs against a database built from the real migrations
// and seed. NOTE: PGlite is a single-connection engine, so tests that call the same function twice are SEQUENTIAL
// version-check tests; they do not prove race safety under genuinely concurrent sessions.

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SAHYADRI = 'inst.sahyadri@aicasa-demo.test';
const COROMANDEL = 'inst.coromandel@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const COMPLIANCE = 'officer.wr.compliance@aicasa-demo.test';
const SR = 'officer.sr@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';
const ADMIN_WR = 'admin.wr@aicasa-demo.test';

let t: TestDb;
let nirmala: string;
let sahyadri: string;

type Row = { check_code: string; result: string; input_value: string; rule_ref: string; is_synthetic: boolean; explanation: string };

async function uploadStub(instId: string) {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`,
    [name, JSON.stringify({ size: 2048, mimetype: 'application/pdf' })]);
  return name;
}
async function upload(email: string, instId: string, appId: string, docType: string, file: string, reason: string | null = null, sha: string | null = null) {
  const r = await t.as<{ v: { id: string; version: number } }>(email,
    `select to_jsonb(register_document_version($1, $2, $3, null, $4, $5, $6, $7)) as v`, [instId, appId, docType, await uploadStub(instId), file, sha, reason]);
  return r[0].v;
}
async function draft(email: string, instId: string, type: string, title: string, form: object) {
  const r = await t.as<{ a: { id: string } }>(email, `select to_jsonb(create_application_draft($1, $2, $3, '2027-28', $4)) as a`, [instId, type, title, JSON.stringify(form)]);
  return r[0].a.id;
}
const matrix = (email: string, id: string) => t.as<Row>(email, `select * from deficiency_matrix($1)`, [id]);
const rule = async (email: string, id: string, code: string) => (await matrix(email, id)).find((x) => x.check_code === `rule:${code}`)!;
const sha = (c: string) => c.repeat(64);

/** A submitted EOA case under scrutiny with its two required documents (distinct hashes). */
async function scrutinyCase(title: string) {
  const id = await draft(NIRMALA, nirmala, 'EOA', title, { approved_intake: 100, intake_increase: false });
  await upload(NIRMALA, nirmala, id, 'affidavit', 'aff.pdf', null, sha('a'));
  await upload(NIRMALA, nirmala, id, 'fire_safety_certificate', 'fire.pdf', null, sha('b'));
  const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]))[0].row_version;
  await t.as(NIRMALA, `select submit_application($1, $2)`, [id, v]);
  return id;
}
async function memoReturned(id: string, docType: string | null) {
  const d = await t.as<{ d: { id: string; row_version: number } }>(SCRUTINY,
    `select to_jsonb(raise_deficiency($1, 'Affidavit unreadable', 'The affidavit scan is not legible.', 'Demo checklist EOA/affidavit',
     'Upload a legible, notarised affidavit.', $2, now() + interval '5 days')) as d`, [id, docType]);
  const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]))[0].row_version;
  await t.as(SCRUTINY, `select return_for_correction($1, $2, 'Affidavit needs to be replaced before scrutiny continues.')`, [id, v]);
  return d[0].d.id;
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
  sahyadri = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-002'`))[0].id;
});

describe('Feature 1: Deficiency Matrix value handling', () => {
  const land = async (value: unknown, title: string) => {
    const id = await draft(NIRMALA, nirmala, 'EOA', title, { approved_intake: 100, land_area_acres: value });
    return rule(NIRMALA, id, 'land_area_min');
  };

  it('minimum rule: boundary values', async () => {
    expect((await land(2.5, 'Boundary exact')).result).toBe('passed');
    expect((await land(2.49, 'Boundary just under')).result).toBe('potential_issue');
    expect((await land('3', 'Boundary string number')).result).toBe('passed');
    expect((await land(0, 'Boundary zero')).result).toBe('potential_issue');
  });

  it('NaN, Infinity, malformed and negative values are never a pass or a silent "not declared"', async () => {
    for (const v of ['NaN', 'Infinity', 'abc', '2,5 acres', '-5', -1]) {
      const r = await land(v, `Bad value ${String(v)}`);
      expect(r.result, `value ${String(v)}`).toBe('failed_validation');
    }
  });

  it('missing value is not_checked; huge finite value passes without error', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Missing land', { approved_intake: 100 });
    expect((await rule(NIRMALA, id, 'land_area_min')).result).toBe('not_checked');
    expect((await land('1e30', 'Huge value')).result).toBe('passed');
  });

  const ratio = async (students: unknown, faculty: unknown, title: string) => {
    const id = await draft(NIRMALA, nirmala, 'EOA', title, { approved_intake: 100, student_count: students, faculty_count: faculty });
    return rule(NIRMALA, id, 'student_faculty_ratio');
  };
  it('ratio rule: boundaries, zero and negative denominators, missing and malformed values', async () => {
    expect((await ratio(400, 20, 'Ratio exact')).result).toBe('passed');
    expect((await ratio(401, 20, 'Ratio just over')).result).toBe('potential_issue');
    expect((await ratio(400, 0, 'Ratio zero denominator')).result).toBe('failed_validation');
    expect((await ratio(400, -4, 'Ratio negative denominator')).result).toBe('failed_validation');
    expect((await ratio(-400, 20, 'Ratio negative numerator')).result).toBe('failed_validation');
    expect((await ratio(400, 'x', 'Ratio malformed')).result).toBe('failed_validation');
    expect((await ratio(400, undefined, 'Ratio missing')).result).toBe('not_checked');
  });

  it('consistency rule reports contradictions and malformed input, and is skipped when its flag is not declared', async () => {
    const mk = async (form: object, title: string) => rule(NIRMALA, await draft(NIRMALA, nirmala, 'EOA', title, form), 'proposed_intake_consistency');
    expect((await mk({ approved_intake: 100, intake_increase: true, proposed_intake: 100 }, 'Cons equal')).result).toBe('failed_validation');
    expect((await mk({ approved_intake: 100, intake_increase: true, proposed_intake: 120 }, 'Cons ok')).result).toBe('passed');
    expect((await mk({ approved_intake: 100, intake_increase: true, proposed_intake: 'many' }, 'Cons malformed')).result).toBe('failed_validation');
    expect((await mk({ approved_intake: 100, intake_increase: false, proposed_intake: 50 }, 'Cons flag off')).result).toBe('not_checked');
  });

  it('every rule row names the observed input, requirement, rule version and source; synthetic rules are labelled', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Row shape', { approved_intake: 100, land_area_acres: 2 });
    const r = await rule(NIRMALA, id, 'land_area_min');
    expect(r).toMatchObject({ input_value: '2 acres', rule_ref: 'land_area_min v1', is_synthetic: true });
    expect(r.explanation).not.toMatch(/approved|rejected/i);
  });
});

describe('Feature 1: rule publication, history and bypass attempts', () => {
  const publish = (email: string, params: object, kind = 'min', code = 'land_area_min') =>
    t.as<{ r: { version: number } }>(email, `select to_jsonb(publish_compliance_rule($1, 'Declared land area', $2, array['EOA'], $3, 'SYNTHETIC DEMO RULE for tests', true, '', 'Test change of the demo threshold')) as r`,
      [code, kind, JSON.stringify(params)]);

  it('rejects negative, zero-ratio, non-finite and missing thresholds', async () => {
    await expectSqlError(publish(ADMIN, { field: 'land_area_acres', threshold: -1 }), /cannot be negative/);
    await expectSqlError(publish(ADMIN, { numerator: 'student_count', denominator: 'faculty_count', threshold: 0 }, 'ratio_max', 'student_faculty_ratio'), /greater than zero/);
    await expectSqlError(publish(ADMIN, { field: 'land_area_acres', threshold: 'NaN' }), /finite numeric threshold/);
    await expectSqlError(publish(ADMIN, { field: 'land_area_acres' }), /finite numeric threshold/);
  });

  it('only a national administrator with workflow_config can publish or retire', async () => {
    for (const who of [NIRMALA, SCRUTINY, ADMIN_WR]) {
      await expectSqlError(publish(who, { field: 'land_area_acres', threshold: 3 }), /national administrators|forbidden|Sign in/i);
    }
    await expectSqlError(t.as(SCRUTINY, `select retire_compliance_rule('land_area_min', 'Trying to retire without authority')`), /national administrators/);
  });

  it('a rule change changes later evaluations, keeps the old version on record, and a retired rule disappears from the matrix', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Rule change case', { approved_intake: 100, land_area_acres: 2.8 });
    expect((await rule(NIRMALA, id, 'land_area_min')).result).toBe('passed');
    await publish(ADMIN, { field: 'land_area_acres', threshold: 3, unit: 'acres' });
    const after = await rule(NIRMALA, id, 'land_area_min');
    expect(after).toMatchObject({ result: 'potential_issue', rule_ref: 'land_area_min v2' });
    expect((await t.owner(`select version, status from compliance_rules where code = 'land_area_min' order by version`)).length).toBe(2);
    await t.as(ADMIN, `select retire_compliance_rule('land_area_min', 'Retiring the demo rule for the test run')`);
    expect((await matrix(NIRMALA, id)).some((x) => x.check_code === 'rule:land_area_min')).toBe(false);
    expect((await t.owner(`select 1 from compliance_rules where code = 'land_area_min'`)).length).toBe(2);
    expect((await t.owner(`select 1 from audit_logs where action in ('compliance_rule_published','compliance_rule_retired')`)).length).toBe(2);
  });

  it('browser roles cannot write rules or fabricate pre-check results directly', async () => {
    await expectSqlError(t.as(ADMIN, `insert into compliance_rules (code, label, kind, applies_to, source_reference) values ('x_rule','x','min',array['EOA'],'direct insert')`), /permission denied/);
    await expectSqlError(t.as(ADMIN, `update compliance_rules set params = '{}'`), /permission denied/);
    await expectSqlError(t.as(NIRMALA, `insert into document_check_findings (run_id, check_code, check_name, outcome, severity, explanation) values (gen_random_uuid(), 'x','x','passed','info','x')`), /permission denied/);
    const v = (await t.owner<{ id: string }>(`select id from document_versions limit 1`))[0].id;
    const run = await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [(await t.owner<{ id: string }>(
      `select v.id from document_versions v join documents d on d.id = v.document_id where d.institution_id = $1 limit 1`, [nirmala]))[0].id ?? v]);
    await expectSqlError(t.as(NIRMALA, `select complete_document_check($1, 'forged', 'completed', 'succeeded', 'x', '[]', '{}', '{}', '[]')`, [run[0].r.id]), /document-check service/);
  });

  it('matrix is invisible across institutions and regions', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Isolation case', { approved_intake: 100 });
    await expectSqlError(matrix(COROMANDEL, id), /not found/i);
    await expectSqlError(matrix(SR, id), /not found/i);
    await expectSqlError(matrix(SAHYADRI, id), /not found/i);
    expect((await matrix(SCRUTINY, id)).length).toBeGreaterThan(0);
  });

  it('a failed pre-check (extraction failed) is never reported as passed', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Extraction failure', { approved_intake: 100 });
    const v = await upload(NIRMALA, nirmala, id, 'affidavit', 'a.pdf', null, sha('c'));
    const run = await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [v.id]);
    await t.service(`select complete_document_check($1, 'e', 'completed', 'failed', 'pdf-text', '[]', '{}', '{}', '[]')`, [run[0].r.id]);
    const rows = await matrix(NIRMALA, id);
    expect(rows.find((x) => x.check_code === `precheck:${v.id}`) ?? rows.find((x) => /extraction$/.test(x.check_code))).toMatchObject({ result: 'extraction_failed' });
    expect(rows.filter((x) => x.check_code.startsWith('precheck:') && x.result === 'passed').length).toBe(0);
  });
});

describe('Feature 2: concurrent review tasks', () => {
  const caseId = async () => (await t.owner<{ id: string }>(`select id from applications where title like 'Change of site%'`))[0].id;
  const tasks = async (id: string) => t.owner<{ id: string; review_code: string; status: string; row_version: number; assignee_id: string }>(
    `select id, review_code, status, row_version, assignee_id from review_tasks where application_id = $1 and status <> 'cancelled' order by review_code`, [id]);
  let extra: string;

  it('only the configured route creates review tasks; other cases are unchanged', async () => {
    expect((await t.owner(`select 1 from review_tasks`)).length).toBe(2);
    expect((await t.owner(`select 1 from review_tasks r join applications a on a.id = r.application_id where a.application_type_code <> 'CHANGE_SITE'`)).length).toBe(0);
    const [a] = await tasks(await caseId());
    expect(a).toBeDefined();
    const wv = await t.owner<{ ok: boolean }>(`select (r.stage_code = 'scrutiny') as ok from review_tasks r join applications a on a.id = r.application_id
      join workflow_stage_reviews s on s.version_id = a.workflow_version_id and s.stage_code = r.stage_code and s.code = r.review_code limit 1`);
    expect(wv[0].ok).toBe(true);
  });

  it('direct table writes and duplicate task rows are refused', async () => {
    const [a] = await tasks(await caseId());
    await expectSqlError(t.as(SCRUTINY, `update review_tasks set status = 'completed' where id = $1`, [a.id]), /permission denied/);
    await expectSqlError(t.as(SCRUTINY, `insert into review_tasks (application_id, stage_history_id, stage_code, review_code, name, required_capability, region_code) select application_id, stage_history_id, stage_code, review_code, name, required_capability, region_code from review_tasks limit 1`), /permission denied/);
    await expectSqlError(t.owner(`insert into review_tasks (application_id, stage_history_id, stage_code, review_code, name, required_capability, region_code)
      select application_id, stage_history_id, stage_code, review_code, name, required_capability, region_code from review_tasks where id = $1`, [a.id]), /duplicate key/);
    await expectSqlError(t.as(SCRUTINY, `delete from review_task_history`), /permission denied/);
  });

  it('an officer from another region and one without the responsibility are refused; the case stays blocked', async () => {
    const id = await caseId();
    const [land] = await tasks(id);
    await expectSqlError(t.as(SR, `select start_review_task($1, $2)`, [land.id, land.row_version]), /region WR/);
    await expectSqlError(t.as(EVC, `select complete_review_task($1, $2, 'completed', 'Attempt without responsibility.')`, [land.id, land.row_version]), /responsibility/);
    const r = await t.as<{ r: { ok: boolean; code: string } }>(SCRUTINY, `select perform_transition($1, 'scrutiny_to_decision', (select row_version from applications where id = $1)) as r`, [id]);
    expect(r[0].r).toMatchObject({ ok: false, code: 'prerequisite' });
  });

  it('administrator republishes the route while a case is in progress: the case keeps its version, tasks and gate', async () => {
    const id = await caseId();
    const def = (await t.owner<{ id: string; vid: string }>(`select d.id, v.id as vid from workflow_definitions d join workflow_definition_versions v on v.definition_id = d.id and v.status = 'active' where d.code = 'ROUTE_PARALLEL_SCRUTINY'`))[0];
    const stages = (await t.owner<Record<string, unknown>>(`select code, name, kind, sequence, sla_days, responsible_capability, description from workflow_stages where version_id = $1`, [def.vid]));
    const trans = await t.owner(`select code, name, from_stage, to_stage, allowed_role, required_capability, requires_reason, is_automatic, prerequisites, records_decision, sort_order from workflow_transitions where version_id = $1`, [def.vid]);
    // new version WITHOUT reviews
    await t.as(ADMIN, `select publish_workflow_version($1, $2, $3, 'Demo circular for audit test', 'Remove concurrent reviews in a new version')`, [def.id, JSON.stringify(stages), JSON.stringify(trans)]);
    expect((await t.owner<{ workflow_version_id: string }>(`select workflow_version_id from applications where id = $1`, [id]))[0].workflow_version_id).toBe(def.vid);
    expect((await tasks(id)).length).toBe(2);
    const blocked = await t.as<{ r: { code: string } }>(SCRUTINY, `select perform_transition($1, 'scrutiny_to_decision', (select row_version from applications where id = $1)) as r`, [id]);
    expect(blocked[0].r.code).toBe('prerequisite');
    // a new case on the new version has no review tasks
    const nid = await draft(SAHYADRI, sahyadri, 'CHANGE_SITE', 'Change of site after republish', { proposed_site_address: 'Plot 9, Demo Nagar' });
    for (const dt of ['land_lease_deed', 'building_plan_approval', 'fire_safety_certificate']) await upload(SAHYADRI, sahyadri, nid, dt, `${dt}.pdf`, null, sha(String(['land_lease_deed', 'building_plan_approval', 'fire_safety_certificate'].indexOf(dt) + 5)));
    await t.as(SAHYADRI, `select submit_application($1, (select row_version from applications where id = $1))`, [nid]);
    expect((await t.owner(`select 1 from review_tasks where application_id = $1`, [nid])).length).toBe(0);
    expect((await t.owner(`select 1 from workflow_stage_reviews where version_id = $1`, [def.vid])).length).toBe(2);
  });

  it('reassignment with a stale page, an unavailable reviewer and the recovery path', async () => {
    const id = await caseId();
    extra = await addUser(t, 'extra.scrutiny@aicasa-demo.test');
    await t.as(ADMIN, `select assign_role($1, 'officer', 'WR', array['scrutiny'], 'Audit test: second scrutiny officer', null)`, [extra]);
    const [land] = await tasks(id);
    // Anita opens the task, then loses her account (reviewer unavailable)
    await t.owner(`update profiles set is_active = false where id = $1`, [t.ids[SCRUTINY]]);
    await expectSqlError(t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]), /inactive|Sign in/i);
    await t.owner(`update profiles set is_active = true where id = $1`, [t.ids[SCRUTINY]]);
    // admin reassigns; the former assignee's stale page is refused twice over
    await t.as(ADMIN_WR, `select reassign_review_task($1, $2, 'Reviewer unavailable this week; moving the review.', $3)`, [land.id, extra, land.row_version]);
    await expectSqlError(t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]), /assigned to another officer/);
    // the new assignee with the old page version is refused as stale
    await expectSqlError(t.as('extra.scrutiny@aicasa-demo.test', `select start_review_task($1, $2)`, [land.id, land.row_version]), /changed since you opened it/);
    const [fresh] = await tasks(id);
    await expectSqlError(t.as(SCRUTINY, `select start_review_task($1, $2)`, [fresh.id, fresh.row_version]), /assigned to another officer/);
    await t.as('extra.scrutiny@aicasa-demo.test', `select start_review_task($1, $2)`, [fresh.id, fresh.row_version]);
    // reassigning a task in progress sends it back to pending
    const [started] = await tasks(id);
    expect(started.status).toBe('in_review');
    await t.as(ADMIN_WR, `select reassign_review_task($1, $2, 'Moving it back to the original reviewer.', $3)`, [started.id, t.ids[SCRUTINY], started.row_version]);
    expect((await tasks(id))[0]).toMatchObject({ status: 'pending' });
  });

  it('a returned review can be resumed and completed (no dead end), and every step is in the audit trail', async () => {
    const id = await caseId();
    let [land] = await tasks(id);
    await t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]);
    [land] = await tasks(id);
    await t.as(SCRUTINY, `select complete_review_task($1, $2, 'returned', 'Plan drawing is missing the north elevation.')`, [land.id, land.row_version]);
    [land] = await tasks(id);
    await t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]);
    [land] = await tasks(id);
    await t.as(SCRUTINY, `select complete_review_task($1, $2, 'completed', 'Revised plan received and checked.')`, [land.id, land.row_version]);
    expect((await tasks(id))[0].status).toBe('completed');
    const hist = await t.owner<{ action: string; actor_id: string | null }>(`select action, actor_id from review_task_history where task_id = $1 order by created_at`, [land.id]);
    expect(hist.map((h) => h.action)).toEqual(['created', 'reassigned', 'started', 'reassigned', 'started', 'returned', 'started', 'completed']);
    expect(hist.every((h) => h.actor_id !== null)).toBe(true);
  });
});

describe('Feature 3: EVC scheduling', () => {
  type Check = { people: { status: string; reasons: { code: string; status: string }[] }[] };
  let evcA: { id: string; row_version: number }; let evcB: { id: string; row_version: number };
  const day = (n: number, h: number) => { const d = new Date(Date.now() + n * 86400000); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
  const sched = (email: string, e: { id: string; row_version: number }, s: string, en: string, ov: string | null = null, version?: number, reason: string | null = null) =>
    t.as<{ r: { override: boolean; evc: { row_version: number } } }>(email, `select schedule_evc($1, $2, $3, '{}', true, null, $4, $6, $5) as r`, [e.id, s, en, version ?? e.row_version, ov, reason]);
  const fresh = async (id: string) => (await t.owner<{ id: string; row_version: number }>(`select id, row_version from evc_records where id = $1`, [id]))[0];

  beforeAll(async () => {
    // a second case that needs an EVC (declares an intake increase), so two WR cases are awaiting scheduling
    const id = await draft(NIRMALA, nirmala, 'EOA', 'EVC audit second case', { approved_intake: 100, intake_increase: true, proposed_intake: 140 });
    await upload(NIRMALA, nirmala, id, 'affidavit', 'aff.pdf', null, sha('7'));
    await upload(NIRMALA, nirmala, id, 'fire_safety_certificate', 'fire.pdf', null, sha('8'));
    await t.as(NIRMALA, `select submit_application($1, (select row_version from applications where id = $1))`, [id]);
    await t.as(SCRUTINY, `select perform_transition($1, 'scrutiny_to_evc', (select row_version from applications where id = $1)) as r`, [id]);
    const rows = await t.owner<{ id: string; row_version: number }>(`select e.id, e.row_version from evc_records e join applications a on a.id = e.application_id
      where e.status = 'awaiting_scheduling' and a.region_code = 'WR' order by a.reference`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    [evcA, evcB] = rows;
  });

  it('refuses scheduling by other regions, institutions and non-EVC staff', async () => {
    await expectSqlError(sched(SR, evcA, day(5, 4), day(5, 6)), /region WR/);
    await expectSqlError(sched(NIRMALA, evcA, day(5, 4), day(5, 6)), /EVC responsibility|Only officers/);
    await expectSqlError(sched(ADMIN, evcA, day(5, 4), day(5, 6)), /EVC responsibility|Only officers/);
    await expectSqlError(sched(SCRUTINY, evcA, day(5, 4), day(5, 6)), /EVC responsibility/);
  });

  it('failed attempts leave no partial records; unknown availability is reported, not hidden', async () => {
    const before = await t.owner(`select 1 from evc_history where evc_id = $1`, [evcA.id]);
    await expectSqlError(sched(EVC, evcA, day(-1, 4), day(-1, 6)), /future start/);
    expect((await t.owner(`select 1 from evc_history where evc_id = $1`, [evcA.id])).length).toBe(before.length);
    expect(await fresh(evcA.id)).toMatchObject({ row_version: evcA.row_version });
    const c = (await t.as<{ c: Check }>(EVC, `select evc_assignment_check($1, $2, $3, '{}') as c`, [evcA.id, day(5, 4), day(5, 6)]))[0].c;
    expect(c.people[0].reasons.find((r) => r.code === 'availability')!.status).toBe('info');
  });

  it('back-to-back slots are allowed; a real overlap needs an override reason and is recorded', async () => {
    const a = await sched(EVC, evcA, day(6, 4), day(6, 6));
    expect(a[0].r.override).toBe(false);
    await sched(EVC, evcB, day(6, 6), day(6, 8)); // starts exactly when A ends
    const b = await fresh(evcB.id);
    await expectSqlError(sched(EVC, b, day(6, 5), day(6, 7), null, b.row_version, 'Moving the slot by an hour for the panel.'), /overlapping EVC.*override reason/);
    const ok = await sched(EVC, b, day(6, 5), day(6, 7), 'Panel agreed to a short overlap for this audit run.', b.row_version, 'Moving the slot by an hour for the panel.');
    expect(ok[0].r.override).toBe(true);
    const hist = await t.owner<{ action: string }>(`select action from evc_history where evc_id = $1 order by created_at`, [evcB.id]);
    expect(hist.map((h) => h.action)).toContain('override');
    expect((await t.owner(`select 1 from audit_logs where action = 'evc_assignment_override' and entity_id = $1`, [evcB.id])).length).toBe(1);
  });

  it('a stale or duplicate submission is rejected', async () => {
    const a = await fresh(evcA.id);
    await expectSqlError(sched(EVC, a, day(7, 4), day(7, 6), null, a.row_version - 1), /changed/);
  });

  it('availability and conflict declarations are region-scoped and reflected in later checks', async () => {
    const [s, e] = [day(8, 4), day(8, 6)];
    const rec = (who: string, user: string) => t.as(who, `select record_evc_availability($1, $2::timestamptz, $3::timestamptz, 'unavailable', 'Audit window')`, [user, s, e]);
    await expectSqlError(rec(ADMIN_WR, t.ids[SR]), /assignment responsibility/);
    await expectSqlError(rec(SCRUTINY, t.ids[EVC]), /assignment responsibility/);
    await expectSqlError(rec(NIRMALA, t.ids[EVC]), /assignment responsibility/);
    await rec(ADMIN_WR, t.ids[EVC]);
    await rec(ADMIN, t.ids[SR]);
    const c = (await t.as<{ c: Check }>(EVC, `select evc_assignment_check($1, $2, $3, '{}') as c`, [evcA.id, s, e]))[0].c;
    expect(c.people[0].status).toBe('blocked');
    const inst = (await t.owner<{ institution_id: string }>(`select institution_id from applications a join evc_records e on e.application_id = a.id where e.id = $1`, [evcA.id]))[0].institution_id;
    await expectSqlError(t.as(ADMIN_WR, `select declare_evc_conflict($1, $2, 'Regional admin tries a cross-region declaration.')`, [t.ids[SR], inst]), /assignment responsibility/);
    await t.as(ADMIN_WR, `select declare_evc_conflict($1, $2, 'Former employee of this institution (audit test).')`, [t.ids[EVC], inst]);
    const c2 = (await t.as<{ c: Check }>(EVC, `select evc_assignment_check($1, $2, $3, '{}') as c`, [evcA.id, day(9, 4), day(9, 6)]))[0].c;
    expect(c2.people[0].reasons.find((r) => r.code === 'conflict_of_interest')!.status).toBe('blocked');
  });

  it('serialises bookings per panel member (static check of the locking code; not a race proof)', async () => {
    const def = (await t.owner<{ d: string }>(`select pg_get_functiondef('public.schedule_evc(uuid, timestamptz, timestamptz, uuid[], boolean, text, integer, text, text)'::regprocedure) as d`))[0].d;
    expect(def).toMatch(/pg_advisory_xact_lock/);
  });
});

describe('Feature 4: version-controlled correction', () => {
  let caseA: string; let memo: string; let v1: string;

  it('memo records the version on file and how the link was established', async () => {
    caseA = await scrutinyCase('Correction audit A');
    memo = await memoReturned(caseA, 'affidavit');
    v1 = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id where d.application_id = $1 and d.doc_type = 'affidavit'`, [caseA]))[0].id;
    expect((await t.owner(`select affected_document_version_id as v, affected_version_basis as b from deficiencies where id = $1`, [memo]))[0]).toEqual({ v: v1, b: 'captured_at_raise' });
  });

  it('a document type outside the checklist cannot be attached to a memo', async () => {
    const id = await scrutinyCase('Correction audit checklist');
    await expectSqlError(t.as(SCRUTINY, `select raise_deficiency($1, 'Wrong type memo', 'Reason long enough here.', 'src ref', 'Correct the thing please now.', 'land_lease_deed', now() + interval '3 days')`, [id]), /not on this application's checklist/);
  });

  it('same content re-uploaded under another filename is not a correction; unrelated and old versions are refused', async () => {
    const submit = (v: string) => t.as(NIRMALA, `select submit_deficiency_correction($1, 'Uploaded the corrected affidavit.', $2)`, [memo, v]);
    const same = await upload(NIRMALA, nirmala, caseA, 'affidavit', 'renamed_copy.pdf', 'Re-upload of the same file', sha('a'));
    await expectSqlError(submit(same.id), /identical content to version 1/);
    await expectSqlError(submit(v1), /new version/);
    const fire = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id where d.application_id = $1 and d.doc_type = 'fire_safety_certificate'`, [caseA]))[0].id;
    await expectSqlError(submit(fire), /version of the affidavit/);
    const other = await upload(COROMANDEL, (await t.owner<{ id: string }>(`select id from institutions where code='DEMO-SR-001'`))[0].id, (await t.owner<{ id: string }>(`select id from applications where title like 'Change of name to Coromandel%'`))[0].id, 'affidavit', 'other.pdf', 'x', sha('e')).catch(() => null);
    if (other) await expectSqlError(submit(other.id), /does not belong|version of the affidavit/);
    const good = await upload(NIRMALA, nirmala, caseA, 'affidavit', 'corrected.pdf', 'Corrected, legible and notarised', sha('d'));
    await submit(good.id);
    // uploaded but not reviewed: nothing is resolved and the case cannot route
    expect((await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [memo]))[0].status).toBe('correction_submitted');
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [caseA]))[0].status).toBe('correction_submitted');
    const r = await t.as<{ r: { ok: boolean; code: string } }>(SCRUTINY, `select perform_transition($1, 'scrutiny_to_decision', (select row_version from applications where id = $1)) as r`, [caseA]);
    expect(r[0].r.ok).toBe(false);
    // while the officer is reviewing, no further version can be uploaded
    await expectSqlError(upload(NIRMALA, nirmala, caseA, 'affidavit', 'late.pdf', 'Another upload', sha('f')), /drafts or to cases returned/);
    // and a second submission for the same memo is refused (sequential check, not a race proof)
    await expectSqlError(submit(good.id), /not awaiting a response/);
  });

  it('only an authorised officer review resolves the memo; incomplete answers keep it open', async () => {
    const review = (who: string, outcome = 'resolved') => t.as(who, `select review_deficiency_correction($1, $2, 'Reviewed against the corrected affidavit.')`, [memo, outcome]);
    await expectSqlError(review(NIRMALA), /Only an officer/);
    await expectSqlError(review(SR), /region WR/);
    await expectSqlError(review(EVC), /scrutiny/);
    await expectSqlError(review(COMPLIANCE), /scrutiny/);
    await review(SCRUTINY, 'needs_clarification');
    expect((await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [memo]))[0].status).toBe('needs_clarification');
    const audit = await t.owner<{ action: string }>(`select action from audit_logs where entity_id = $1 order by id`, [memo]);
    expect(audit.map((a) => a.action)).toEqual(['deficiency_raised', 'correction_submitted', 'correction_reviewed']);
  });

  it('direct writes to memos, submissions and versions are refused', async () => {
    await expectSqlError(t.as(NIRMALA, `update deficiencies set status = 'resolved' where id = $1`, [memo]), /permission denied/);
    await expectSqlError(t.as(SCRUTINY, `update deficiencies set affected_document_version_id = null where id = $1`, [memo]), /permission denied/);
    await expectSqlError(t.as(NIRMALA, `insert into deficiency_submissions (deficiency_id, attempt, response_text, submitted_by) values ($1, 9, 'forged', $2)`, [memo, t.ids[NIRMALA]]), /permission denied/);
    await expectSqlError(t.as(NIRMALA, `delete from document_versions where id = $1`, [v1]), /permission denied/);
    await expectSqlError(t.owner(`update document_versions set sha256 = $2 where id = $1`, [v1, sha('9')]), /immutable/);
    await expectSqlError(t.owner(`delete from document_versions where id = $1`, [v1]), /immutable/);
    await expectSqlError(t.owner(`update deficiency_submissions set response_text = 'edited'`), /append-only/);
  });

  it('an unproven link is reported as such and forces the latest version; a missing document gives no link', async () => {
    const id = await scrutinyCase('Correction audit B');
    const m = await memoReturned(id, 'affidavit');
    const vs = await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id where d.application_id = $1 and d.doc_type = 'affidavit'`, [id]);
    const v2 = await upload(NIRMALA, nirmala, id, 'affidavit', 'v2.pdf', 'Second version', sha('1'));
    const v3 = await upload(NIRMALA, nirmala, id, 'affidavit', 'v3.pdf', 'Third version', sha('2'));
    await t.owner(`update deficiencies set affected_document_version_id = $2, affected_version_basis = 'inferred_unverified' where id = $1`, [m, v2.id]);
    await expectSqlError(t.as(NIRMALA, `select submit_deficiency_correction($1, 'Attaching the second version.', $2)`, [m, v2.id]), /could not be established.*latest version/);
    await t.as(NIRMALA, `select submit_deficiency_correction($1, 'Attaching the latest version.', $2)`, [m, v3.id]);
    expect(vs.length).toBe(1);
    const noLink = await t.owner<{ affected_document_version_id: string | null; affected_version_basis: string | null }>(
      `select affected_document_version_id, affected_version_basis from deficiencies where id = $1`, [m]);
    expect(noLink[0].affected_version_basis).toBe('inferred_unverified');
  });

  it('comparison never claims a content diff when extraction failed for either version', async () => {
    const id = await draft(NIRMALA, nirmala, 'EOA', 'Correction audit C', { approved_intake: 100 });
    const a = (await upload(NIRMALA, nirmala, id, 'affidavit', 'a.pdf', null, sha('c'))).id;
    const b = await upload(NIRMALA, nirmala, id, 'affidavit', 'b.pdf', 'New one', sha('3'));
    for (const [vid, ex] of [[a, 'succeeded'], [b.id, 'failed']] as const) {
      const run = await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [vid]);
      await t.service(`select complete_document_check($1, 'e', 'completed', $2, 'pdf-text', '[]', '{}', '{}', '[]')`, [run[0].r.id, ex]);
    }
    const c = (await t.as<{ c: { content: { available: boolean; reason: string } } }>(SCRUTINY, `select compare_document_versions($1, $2) as c`, [a, b.id]))[0].c;
    expect(c.content.available).toBe(false);
    expect(c.content.reason).toMatch(/could not be read reliably/);
  });

  it('deadlines: authorised change is audited; others, stale, past and answered memos are refused; the default needs configuration', async () => {
    const id = await scrutinyCase('Correction audit D');
    const m = await memoReturned(id, 'affidavit');
    const ver = () => t.owner<{ row_version: number }>(`select row_version from deficiencies where id = $1`, [m]).then((r) => r[0].row_version);
    const change = (who: string, when: string, v: number, reason = 'Institution asked for more time; agreed.') =>
      t.as(who, `select change_deficiency_deadline($1, $2::timestamptz, $3, $4)`, [m, when, reason, v]);
    const later = new Date(Date.now() + 12 * 86400000).toISOString();
    await expectSqlError(change(NIRMALA, later, await ver()), /Only an officer/);
    await expectSqlError(change(SR, later, await ver()), /region WR/);
    await expectSqlError(change(SCRUTINY, new Date(Date.now() - 1000).toISOString(), await ver()), /in the future/);
    await expectSqlError(change(SCRUTINY, later, await ver(), 'short'), /at least 10/);
    await expectSqlError(change(SCRUTINY, later, (await ver()) - 1), /changed/);
    await change(SCRUTINY, later, await ver());
    expect((await t.owner(`select 1 from audit_logs where action = 'deficiency_deadline_changed' and entity_id = $1`, [m])).length).toBe(1);
    // expired deadline: the system records the lateness but does not block the response (characterisation test)
    await t.owner(`update deficiencies set due_at = now() - interval '1 day' where id = $1`, [m]);
    const good = await upload(NIRMALA, nirmala, id, 'affidavit', 'late_ok.pdf', 'Late but corrected', sha('4'));
    await t.as(NIRMALA, `select submit_deficiency_correction($1, 'Submitted after the deadline.', $2)`, [m, good.id]);
    await expectSqlError(change(SCRUTINY, later, await ver()), /still has to respond/);
  });
});

describe('Cross-cutting security checks', () => {
  it('every SECURITY DEFINER function in app/public has a pinned search_path and none is executable by anon', async () => {
    const unpinned = await t.owner<{ f: string }>(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','app') and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(unpinned).toEqual([]);
    const anon = await t.owner<{ f: string }>(`select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`);
    expect(anon).toEqual([]);
  });

  it('internal helpers of the new features are not callable by signed-in users', async () => {
    const callable = await t.owner<{ f: string }>(`select p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname in ('try_numeric','on_stage_entered','lock_review_task','review_event','evc_check','evc_person_checks','is_evc_officer_in','capture_affected_version','can_manage_officer')
        and has_function_privilege('authenticated', p.oid, 'execute')`);
    expect(callable).toEqual([]);
  });

  it('signed-in users have SELECT only on the new tables, and RLS is enabled on each', async () => {
    const rows = await t.owner<{ relname: string; rls: boolean; writes: string | null }>(`select c.relname, c.relrowsecurity as rls,
      (select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = c.relname
         and g.grantee in ('authenticated','anon') and g.privilege_type <> 'SELECT') as writes
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
        and c.relname in ('compliance_rules','workflow_stage_reviews','review_tasks','review_task_history','evc_availability','evc_conflict_declarations')`);
    expect(rows.length).toBe(6);
    for (const r of rows) { expect(r.rls, r.relname).toBe(true); expect(r.writes, r.relname).toBeNull(); }
  });
});
