import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectSqlError, type TestDb } from './harness';

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SAHYADRI = 'inst.sahyadri@aicasa-demo.test';
const COROMANDEL = 'inst.coromandel@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const COMPLIANCE = 'officer.wr.compliance@aicasa-demo.test';
const SR = 'officer.sr@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';
const ADMIN_WR = 'admin.wr@aicasa-demo.test';
const RESULTS = ['passed', 'potential_issue', 'failed_validation', 'extraction_failed', 'not_checked', 'manual_review'];

let t: TestDb;
let nirmala: string;

type MatrixRow = { section: string; check_code: string; result: string; input_value: string; is_synthetic: boolean; rule_ref: string };
type Task = { id: string; review_code: string; status: string; row_version: number; assignee_id: string | null };

async function byTitle(title: string) {
  return (await t.owner<{ id: string; row_version: number; status: string; current_stage: string; institution_id: string }>(
    `select id, row_version, status, current_stage, institution_id from applications where title = $1`, [title]))[0];
}
async function uploadStub(instId: string, mime = 'application/pdf') {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`,
    [name, JSON.stringify({ size: 2048, mimetype: mime })]);
  return name;
}
async function upload(email: string, instId: string, appId: string, docType: string, file: string, reason: string | null = null, sha: string | null = null) {
  const p = await uploadStub(instId);
  const r = await t.as<{ v: { id: string; version: number } }>(email,
    `select to_jsonb(register_document_version($1, $2, $3, null, $4, $5, $6, $7)) as v`, [instId, appId, docType, p, file, sha, reason]);
  return r[0].v;
}
async function transition(email: string, id: string, code: string, reason?: string) {
  const a = await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]);
  return (await t.as<{ r: { ok: boolean; code?: string; message?: string } }>(email,
    `select perform_transition($1, $2, $3, $4) as r`, [id, code, a[0].row_version, reason ?? null]))[0].r;
}
async function matrix(email: string, id: string) {
  return t.as<MatrixRow>(email, `select * from deficiency_matrix($1)`, [id]);
}
async function tasks(id: string) {
  return t.owner<Task>(`select id, review_code, status, row_version, assignee_id from review_tasks where application_id = $1 order by created_at, review_code`, [id]);
}
async function precheck(email: string, versionId: string, extraction: string, findings: object[]) {
  const run = await t.as<{ r: { id: string } }>(email, `select to_jsonb(start_document_check($1)) as r`, [versionId]);
  await t.service(`select complete_document_check($1, 'test-engine', 'completed', $2, 'pdf-text', '[]', '{}', '{}', $3)`,
    [run[0].r.id, extraction, JSON.stringify(findings)]);
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('Deficiency Matrix', () => {
  let draft: string;

  it('evaluates configured rules and missing items without inventing results', async () => {
    const r = await t.as<{ a: { id: string } }>(NIRMALA, `select to_jsonb(create_application_draft($1, 'EOA', 'Matrix test application', '2027-28', $2)) as a`,
      [nirmala, JSON.stringify({ approved_intake: 120, intake_increase: true, proposed_intake: 100, land_area_acres: 2, student_count: 900, faculty_count: 40 })]);
    draft = r[0].a.id;
    const rows = await matrix(NIRMALA, draft);
    const by = (code: string) => rows.find((x) => x.check_code === code)!;
    expect(rows.every((x) => RESULTS.includes(x.result))).toBe(true);
    expect(by('field:approved_intake').result).toBe('passed');
    expect(by('document:affidavit').result).toBe('failed_validation');
    expect(by('document:fire_safety_certificate').result).toBe('failed_validation');
    expect(by('document:faculty_list').result).toBe('not_checked');
    expect(by('rule:land_area_min')).toMatchObject({ result: 'potential_issue', is_synthetic: true, input_value: '2 acres' });
    expect(by('rule:built_up_min').result).toBe('not_checked');
    expect(by('rule:student_faculty_ratio')).toMatchObject({ result: 'potential_issue', input_value: '1:22.5' });
    expect(by('rule:student_computer_ratio').result).toBe('not_checked');
    expect(by('rule:proposed_intake_consistency')).toMatchObject({ result: 'failed_validation', is_synthetic: false });
    // evaluation never changes the case
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [draft]))[0].status).toBe('draft');
  });

  it('reports an unsupported rule kind as manual review instead of guessing', async () => {
    await t.owner(`insert into compliance_rules (code, label, kind, applies_to, params, source_reference, is_synthetic)
                   values ('library_volumes', 'Library volumes', 'library_count', array['EOA'], '{"field":"x"}', 'Test rule, not configured by publish', true)`);
    const row = (await matrix(NIRMALA, draft)).find((x) => x.check_code === 'rule:library_volumes')!;
    expect(row.result).toBe('manual_review');
    await t.owner(`delete from compliance_rules where code = 'library_volumes'`);
  });

  it('is readable only within the case scope', async () => {
    await expectSqlError(matrix(COROMANDEL, draft), /not found/i);
    expect((await matrix(SCRUTINY, draft)).length).toBeGreaterThan(0);
  });

  it('reports duplicate files, unread documents and failed extraction', async () => {
    const sha = 'a'.repeat(64);
    await upload(NIRMALA, nirmala, draft, 'affidavit', 'aff.pdf', null, sha);
    const fire = await upload(NIRMALA, nirmala, draft, 'fire_safety_certificate', 'fire.pdf', null, sha);
    let rows = await matrix(NIRMALA, draft);
    expect(rows.filter((x) => x.section === 'duplicates' && x.result === 'potential_issue').length).toBe(2);
    expect(rows.filter((x) => x.section === 'precheck' && x.result === 'not_checked').length).toBe(2);
    await precheck(NIRMALA, fire.id, 'failed', [{ check_code: 'readability', check_name: 'Readable content', outcome: 'extraction_failed',
      severity: 'medium', explanation: 'No text layer.' }]);
    rows = await matrix(NIRMALA, draft);
    expect(rows.some((x) => x.section === 'precheck' && x.result === 'extraction_failed')).toBe(true);
  });

  it('publishes rules only with authority, a known kind, real form fields and a source', async () => {
    const args = (kind: string, field: string) => [kind, ['EOA'], JSON.stringify({ field, threshold: 3, unit: 'acres' })];
    const sql = `select to_jsonb(publish_compliance_rule('land_area_min', 'Declared land area', $1, $2, $3, 'SYNTHETIC DEMO RULE for testing', true, '', 'Raise demo threshold for the test')) as r`;
    await expectSqlError(t.as(SCRUTINY, sql, args('min', 'land_area_acres')), /national administrators/);
    await expectSqlError(t.as(ADMIN, sql, args('magic', 'land_area_acres')), /Unsupported rule kind/);
    await expectSqlError(t.as(ADMIN, sql, args('min', 'not_a_field')), /not on the EOA form/);
    const r = await t.as<{ r: { version: number } }>(ADMIN, sql, args('min', 'land_area_acres'));
    expect(r[0].r.version).toBe(2);
    const active = await t.owner(`select version from compliance_rules where code = 'land_area_min' and status = 'active'`);
    expect(active).toEqual([{ version: 2 }]);
    expect((await t.owner(`select 1 from audit_logs where action = 'compliance_rule_published'`)).length).toBe(1);
  });
});

describe('Concurrent review tasks', () => {
  let caseId: string;
  const task = async (code: string) => (await tasks(caseId)).filter((x) => x.review_code === code && x.status !== 'cancelled').at(-1)!;

  it('creates one task per configured review, each with an officer holding that responsibility', async () => {
    caseId = (await byTitle('Change of site — Sahyadri College to the Survey 310 campus')).id;
    const rows = await tasks(caseId);
    expect(rows.map((x) => [x.review_code, x.status])).toEqual([['land_building', 'pending'], ['safety_compliance', 'pending']]);
    expect(rows.find((x) => x.review_code === 'land_building')!.assignee_id).toBe(t.ids[SCRUTINY]);
    expect(rows.find((x) => x.review_code === 'safety_compliance')!.assignee_id).toBe(t.ids[COMPLIANCE]);
  });

  it('blocks routing until every configured review is complete', async () => {
    const r = await transition(SCRUTINY, caseId, 'scrutiny_to_decision');
    expect(r.code).toBe('prerequisite');
    expect(r.message).toMatch(/Configured reviews not yet completed/);
    const avail = await t.as<{ code: string; permitted: boolean }>(SCRUTINY, `select * from available_transitions($1)`, [caseId]);
    expect(avail.find((x) => x.code === 'scrutiny_to_decision')!.permitted).toBe(false);
  });

  it('refuses review actions from roles or regions without the responsibility', async () => {
    const land = await task('land_building');
    const start = `select start_review_task($1, $2)`;
    await expectSqlError(t.as(EVC, start, [land.id, land.row_version]), /"scrutiny" responsibility/);
    await expectSqlError(t.as(COMPLIANCE, start, [land.id, land.row_version]), /"scrutiny" responsibility/);
    await expectSqlError(t.as(SR, start, [land.id, land.row_version]), /region WR/);
    const safety = await task('safety_compliance');
    await expectSqlError(t.as(SCRUTINY, start, [safety.id, safety.row_version]), /"compliance" responsibility/);
    await expectSqlError(t.as(SAHYADRI, start, [land.id, land.row_version]), /responsibility/);
    expect(await t.as(SAHYADRI, `select * from review_tasks where application_id = $1`, [caseId])).toEqual([]);
  });

  it('prevents stale writes and duplicate completion', async () => {
    const land = await task('land_building');
    await t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]);
    await expectSqlError(t.as(SCRUTINY, `select start_review_task($1, $2)`, [land.id, land.row_version]), /changed since you opened it/);
    const started = await task('land_building');
    expect(started.status).toBe('in_review');
    const done = `select complete_review_task($1, $2, 'completed', 'Lease deed and building plan checked against the new site.')`;
    await expectSqlError(t.as(SCRUTINY, done, [land.id, land.row_version]), /changed since you opened it/);
    await expectSqlError(t.as(COMPLIANCE, done, [land.id, started.row_version]), /responsibility/);
    await expectSqlError(t.as(SCRUTINY, `select complete_review_task($1, $2, 'completed', 'short')`, [land.id, started.row_version]), /at least 10/);
    await t.as(SCRUTINY, done, [land.id, started.row_version]);
    const completed = await task('land_building');
    await expectSqlError(t.as(SCRUTINY, done, [land.id, completed.row_version]), /Only a review in progress/);
    expect(completed.status).toBe('completed');
  });

  it('a returned review keeps the case blocked; reassignment needs the assignment responsibility', async () => {
    let safety = await task('safety_compliance');
    await t.as(COMPLIANCE, `select start_review_task($1, $2)`, [safety.id, safety.row_version]);
    safety = await task('safety_compliance');
    await t.as(COMPLIANCE, `select complete_review_task($1, $2, 'returned', 'Fire certificate covers only the old campus buildings.')`, [safety.id, safety.row_version]);
    const blocked = await transition(SCRUTINY, caseId, 'scrutiny_to_decision');
    expect(blocked.message).toMatch(/Safety and compliance record review \(returned\)/);

    safety = await task('safety_compliance');
    const reassign = `select reassign_review_task($1, $2, 'Rebalancing compliance reviews this week.', $3)`;
    await expectSqlError(t.as(SCRUTINY, reassign, [safety.id, t.ids[COMPLIANCE], safety.row_version]), /assignment responsibility/);
    await expectSqlError(t.as(ADMIN_WR, reassign, [safety.id, t.ids[EVC], safety.row_version]), /does not hold the "compliance"/);
    await t.as(ADMIN_WR, reassign, [safety.id, t.ids[COMPLIANCE], safety.row_version]);

    safety = await task('safety_compliance');
    await t.as(COMPLIANCE, `select start_review_task($1, $2)`, [safety.id, safety.row_version]);
    safety = await task('safety_compliance');
    await t.as(COMPLIANCE, `select complete_review_task($1, $2, 'completed', 'Renewed certificate for the new buildings verified.')`, [safety.id, safety.row_version]);
    expect((await transition(SCRUTINY, caseId, 'scrutiny_to_decision')).ok).toBe(true);
  });

  it('keeps an append-only, audited task history and opens fresh reviews when the case returns to the stage', async () => {
    const hist = await t.owner<{ action: string }>(`select h.action from review_task_history h join review_tasks r on r.id = h.task_id
      where r.application_id = $1 and r.review_code = 'safety_compliance' order by h.created_at`, [caseId]);
    expect(hist.map((h) => h.action)).toEqual(['created', 'started', 'returned', 'reassigned', 'started', 'completed']);
    await expectSqlError(t.owner(`update review_task_history set reason = 'x'`), /append-only/);
    const audit = await t.owner<{ action: string }>(`select distinct action from audit_logs where entity_type = 'review_task'`);
    expect(audit.map((a) => a.action).sort()).toEqual(['review_task_completed', 'review_task_created', 'review_task_reassigned', 'review_task_returned', 'review_task_started']);

    expect((await transition(COMPLIANCE, caseId, 'refer_back_to_scrutiny', 'Site plan needs a second look after the visit.')).ok).toBe(true);
    const rows = await tasks(caseId);
    expect(rows.filter((x) => x.status === 'pending').length).toBe(2);
    expect(rows.filter((x) => x.status === 'completed').length).toBe(2);
  });
});

describe('EVC assignment checks', () => {
  let evcId: string;
  const slot = () => [new Date(Date.now() + 3 * 86400000).toISOString(), new Date(Date.now() + 3 * 86400000 + 2 * 3600000).toISOString()];
  type Check = { blocked: boolean; needs_override: boolean; policy: object | null; readiness: { code: string; status: string }[];
    people: { user_id: string; status: string; overridable: boolean; reasons: { code: string; status: string }[] }[] };
  const check = async (email = EVC) => {
    const [s, e] = slot();
    return (await t.as<{ c: Check }>(email, `select evc_assignment_check($1, $2, $3, '{}') as c`, [evcId, s, e]))[0].c;
  };
  const evcRow = async () => (await t.owner<{ row_version: number; status: string }>(`select row_version, status from evc_records where id = $1`, [evcId]))[0];

  it('explains eligibility and states what cannot be checked', async () => {
    const app = await byTitle('Extension of approval with additional division 2027-28');
    evcId = (await t.owner<{ id: string }>(`select id from evc_records where application_id = $1 and status = 'awaiting_scheduling'`, [app.id]))[0].id;
    const c = await check();
    expect(c.people[0]).toMatchObject({ user_id: t.ids[EVC], status: 'eligible' });
    expect(c.people[0].reasons.find((r) => r.code === 'availability')!.status).toBe('info');
    expect(c.readiness.find((r) => r.code === 'external_sources')!.status).toBe('info');
    expect(c.policy).not.toBeNull();
    await expectSqlError(t.as(NIRMALA, `select evc_assignment_check($1, now() + interval '3 days', now() + interval '3 days 2 hours', '{}')`, [evcId]), /authorised staff/);
  });

  it('only EVC officers or assignment holders record availability', async () => {
    const [s, e] = slot();
    await expectSqlError(t.as(SCRUTINY, `select record_evc_availability($1, $2, $3, 'unavailable', null)`, [t.ids[EVC], s, e]), /assignment responsibility/);
    await expectSqlError(t.as(NIRMALA, `select record_evc_availability($1, $2, $3, 'unavailable', null)`, [t.ids[EVC], s, e]), /assignment responsibility/);
  });

  it('blocks recorded unavailability unless an override reason is recorded', async () => {
    const [s, e] = slot();
    await t.as(EVC, `select record_evc_availability($1, $2::timestamptz - interval '1 hour', $3::timestamptz + interval '1 hour', 'unavailable', 'Training')`, [t.ids[EVC], s, e]);
    const c = await check();
    expect(c.people[0]).toMatchObject({ status: 'blocked', overridable: true });
    const sql = `select schedule_evc($1, $2, $3, '{}', true, null, $4, null, $5) as r`;
    await expectSqlError(t.as(EVC, sql, [evcId, s, e, (await evcRow()).row_version, null]), /Recorded as unavailable.*override reason/);
    const r = await t.as<{ r: { override: boolean } }>(EVC, sql, [evcId, s, e, (await evcRow()).row_version, 'Training session moved; officer confirmed by phone.']);
    expect(r[0].r.override).toBe(true);
    const hist = await t.owner<{ action: string }>(`select action from evc_history where evc_id = $1 order by created_at`, [evcId]);
    expect(hist.map((h) => h.action)).toEqual(['queued', 'override', 'confirmed']);
  });

  it('a declared conflict of interest blocks assignment and cannot be overridden', async () => {
    const app = await byTitle('Extension of approval with additional division 2027-28');
    await t.as(EVC, `select declare_evc_conflict($1, $2, 'Former faculty member of this institution until 2025.')`, [t.ids[EVC], app.institution_id]);
    const c = await check();
    expect(c.people[0]).toMatchObject({ status: 'blocked', overridable: false });
    const [s, e] = slot();
    await expectSqlError(t.as(EVC, `select schedule_evc($1, $2, $3, '{}', true, null, $4, 'Moving the slot by one hour for the panel.', 'Override attempt for the test.')`,
      [evcId, s, e, (await evcRow()).row_version]), /Assignment blocked: .*Declared conflict/);
    const decl = (await t.owner<{ id: string }>(`select id from evc_conflict_declarations where user_id = $1`, [t.ids[EVC]]))[0];
    await expectSqlError(t.as(EVC, `select withdraw_evc_conflict($1, 'Declared in error by the officer.')`, [decl.id]), /Only another officer/);
  });

  it('without a configured policy, a declared conflict needs manual review instead of a block', async () => {
    await t.owner(`delete from system_settings where key = 'evc.assignment_policy'`);
    const c = await check();
    expect(c.policy).toBeNull();
    expect(c.readiness.find((r) => r.code === 'policy')!.status).toBe('info');
    expect(c.people[0].reasons.find((r) => r.code === 'conflict_of_interest')!.status).toBe('manual_review');
  });
});

describe('Version-controlled correction', () => {
  let n2: string; let defId: string; let v1: string; let v2: string;

  it('records the affected version and requires a newer version of that document', async () => {
    n2 = (await byTitle('Extension of approval with intake increase 2027-28')).id;
    const d = (await t.owner<{ id: string; affected_document_version_id: string | null }>(
      `select id, affected_document_version_id from deficiencies where application_id = $1`, [n2]))[0];
    defId = d.id;
    v1 = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents doc on doc.id = v.document_id
      where doc.application_id = $1 and doc.doc_type = 'fire_safety_certificate' and v.version = 1`, [n2]))[0].id;
    expect(d.affected_document_version_id).toBe(v1);

    const submit = `select submit_deficiency_correction($1, 'Uploaded the certificate that states its validity.', $2)`;
    await expectSqlError(t.as(NIRMALA, submit, [defId, null]), /upload a new version/);
    await expectSqlError(t.as(NIRMALA, submit, [defId, v1]), /Attach a new version/);
    const aff = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents doc on doc.id = v.document_id
      where doc.application_id = $1 and doc.doc_type = 'affidavit'`, [n2]))[0].id;
    await expectSqlError(t.as(NIRMALA, submit, [defId, aff]), /version of the fire safety certificate/);

    v2 = (await upload(NIRMALA, nirmala, n2, 'fire_safety_certificate', 'fire_with_validity.pdf', 'Certificate stating validity period')).id;
    await t.as(NIRMALA, submit, [defId, v2]);
    const versions = await t.owner<{ version: number; storage_path: string }>(`select version, storage_path from document_versions
      where document_id = (select document_id from document_versions where id = $1) order by version`, [v2]);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(new Set(versions.map((v) => v.storage_path)).size).toBe(2);
    const audit = await t.owner<{ after_state: { document_version_id: string } }>(
      `select after_state from audit_logs where action = 'correction_submitted' and entity_id = $1`, [defId]);
    expect(audit[0].after_state.document_version_id).toBe(v2);
  });

  it('compares versions without claiming changes it could not read', async () => {
    const cmp = `select compare_document_versions($1, $2) as c`;
    let c = (await t.as<{ c: { content: { available: boolean; reason: string }; metadata_changes: { field: string }[] } }>(SCRUTINY, cmp, [v1, v2]))[0].c;
    expect(c.content.available).toBe(false);
    expect(c.content.reason).toMatch(/no completed pre-check/);
    expect(c.metadata_changes.map((m) => m.field)).toContain('File name');
    await expectSqlError(t.as(COROMANDEL, cmp, [v1, v2]), /not found/i);

    const field = (value: string) => [{ check_code: 'field:expiry_date', check_name: 'Expiry date', outcome: 'passed', severity: 'info', explanation: 'Found.', evidence: value }];
    // runs are started by the owning institution; the case is returned, so it may still run checks
    await precheck(NIRMALA, v1, 'succeeded', field('2025-03-31'));
    await precheck(NIRMALA, v2, 'succeeded', field('2029-03-31'));
    c = (await t.as<{ c: { content: { available: boolean; fields: { check_code: string; old: string; new: string; changed: boolean }[] } } }>(SCRUTINY, cmp, [v1, v2]))[0].c as never;
    const content = (c as unknown as { content: { available: boolean; fields: { check_code: string; old: string; new: string; changed: boolean }[] } }).content;
    expect(content.available).toBe(true);
    expect(content.fields[0]).toMatchObject({ check_code: 'field:expiry_date', old: '2025-03-31', new: '2029-03-31', changed: true });
  });

  it('only an authorised review resolves the memo; an incomplete response keeps it open', async () => {
    await expectSqlError(t.as(NIRMALA, `select review_deficiency_correction($1, 'resolved', 'Institution marking its own correction.')`, [defId]), /Only an officer/);
    await t.as(SCRUTINY, `select review_deficiency_correction($1, 'needs_clarification', 'Certificate does not name the hostel block.')`, [defId]);
    const d = await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [defId]);
    expect(d[0].status).toBe('needs_clarification');
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [n2]))[0].status).toBe('returned_for_correction');
  });

  it('uses the configured correction period when no date is given, and refuses when none is configured', async () => {
    const d1 = (await byTitle('Extension of approval — University Department of Technology')).id;
    const raise = `select to_jsonb(raise_deficiency($1, 'Affidavit year missing', 'The affidavit does not state the academic year.', 'Demo checklist EOA/affidavit', 'Upload an affidavit that states the academic year.', 'affidavit', null)) as d`;
    const r = await t.as<{ d: { due_at: string } }>(SCRUTINY, raise, [d1]);
    const days = (new Date(r[0].d.due_at).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(8.1);
    const ev = await t.owner<{ metadata: { due_source: string } }>(`select metadata from application_events where application_id = $1 and event_type = 'deficiency_raised'`, [d1]);
    expect(ev[0].metadata.due_source).toBe('configured_default');
    await t.owner(`delete from system_settings where key = 'deficiency.correction_period'`);
    await expectSqlError(t.as(SCRUTINY, raise, [d1]), /no default correction period/);
  });
});
