import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectSqlError, type TestDb } from './harness';

const INST = 'inst.nirmala@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const DECISION = 'officer.wr.compliance@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';

let t: TestDb;
let nirmala: string;

async function byTitle(title: string) {
  const r = await t.owner<{ id: string; row_version: number; status: string; current_stage: string; reference: string }>(
    `select id, row_version, status, current_stage, reference from applications where title = $1`, [title]);
  return r[0];
}
async function uploadStub(instId: string, mime = 'application/pdf', size = 2048) {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`,
    [name, JSON.stringify({ size, mimetype: mime })]);
  return name;
}
async function transition(email: string, id: string, code: string, reason?: string, payload: object = {}) {
  const a = await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]);
  const r = await t.as<{ r: { ok: boolean; code?: string; message?: string } }>(email,
    `select perform_transition($1, $2, $3, $4, $5) as r`, [id, code, a[0].row_version, reason ?? null, JSON.stringify(payload)]);
  return r[0].r;
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('workflow configuration', () => {
  it('has the four configured routes with distinct stage paths', async () => {
    const rows = await t.owner<{ code: string; stages: string }>(`
      select d.code, string_agg(s.code, '>' order by s.sequence) as stages
      from workflow_definitions d join workflow_definition_versions v on v.definition_id = d.id and v.status = 'active'
      join workflow_stages s on s.version_id = v.id group by d.code order by d.code`);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.stages]))).toEqual({
      ROUTE_EVC_COMMITTEE: 'intake>evc>committee>decision>closed',
      ROUTE_EVC_ONLY: 'intake>evc>decision>closed',
      ROUTE_SCRUTINY_COND_EVC: 'intake>scrutiny>evc>decision>closed',
      ROUTE_SCRUTINY_ONLY: 'intake>scrutiny>decision>closed',
    });
  });

  it('publishing a new version leaves existing cases on their original version', async () => {
    const def = (await t.owner<{ id: string; vid: string }>(`
      select d.id, v.id as vid from workflow_definitions d join workflow_definition_versions v on v.definition_id = d.id
      where d.code = 'ROUTE_SCRUTINY_ONLY' and v.status = 'active'`))[0];
    const before = await t.owner<{ id: string }>(`select id from applications where workflow_version_id = $1`, [def.vid]);
    const stages = await t.owner(`select code, name, kind, sequence, sla_days, responsible_capability from workflow_stages where version_id = $1`, [def.vid]);
    const transitions = await t.owner(`select code, name, from_stage, to_stage, allowed_role, required_capability, requires_reason,
      is_automatic, prerequisites, records_decision, sort_order from workflow_transitions where version_id = $1`, [def.vid]);
    (stages.find((s) => (s as { code: string }).code === 'scrutiny') as { sla_days: number }).sla_days = 15;

    await expectSqlError(t.as(SCRUTINY, `select publish_workflow_version($1, $2, $3, 'x', 'y')`,
      [def.id, JSON.stringify(stages), JSON.stringify(transitions)]), /national administrators/);

    const r = await t.as<{ v: { version: number } }>(ADMIN,
      `select to_jsonb(publish_workflow_version($1, $2, $3, 'Demo circular ref 2026/11', 'Reduce scrutiny target to 15 days')) as v`,
      [def.id, JSON.stringify(stages), JSON.stringify(transitions)]);
    expect(r[0].v.version).toBe(2);
    const after = await t.owner<{ id: string }>(`select id from applications where workflow_version_id = $1`, [def.vid]);
    expect(after.length).toBe(before.length);
    const audit = await t.owner(`select 1 from audit_logs where action = 'workflow_version_published'`);
    expect(audit.length).toBe(1);
  });

  it('rejects a route with an unknown prerequisite', async () => {
    const def = (await t.owner<{ id: string }>(`select id from workflow_definitions where code = 'ROUTE_EVC_ONLY'`))[0];
    await expectSqlError(t.as(ADMIN, `select publish_workflow_version($1, $2, $3, 'Demo ref', 'Testing validation rules')`, [def.id,
      JSON.stringify([{ code: 'intake', name: 'Intake', kind: 'intake', sequence: 1 }, { code: 'closed', name: 'Closed', kind: 'terminal', sequence: 2 }]),
      JSON.stringify([{ code: 'go', name: 'Go', from_stage: 'intake', to_stage: 'closed', is_automatic: true, prerequisites: ['magic'] }])]),
      /Unknown prerequisite/);
  });
});

describe('application lifecycle', () => {
  let appId: string;

  it('institution creates a draft; submission blocked until required documents exist', async () => {
    const r = await t.as<{ a: { id: string; status: string; reference: string; row_version: number } }>(INST,
      `select to_jsonb(create_application_draft($1, 'EOA', 'Test extension application', '2027-28', '{"approved_intake": 60}')) as a`, [nirmala]);
    appId = r[0].a.id;
    expect(r[0].a.status).toBe('draft');
    expect(r[0].a.reference).toMatch(/^DEMO-WR-\d{4}-\d{5}$/);
    await expectSqlError(t.as(INST, `select submit_application($1, $2)`, [appId, r[0].a.row_version]), /Required documents missing/);
  });

  it('rejects wrong file types using storage metadata, not client claims', async () => {
    const path = await uploadStub(nirmala, 'application/x-msdownload');
    await expectSqlError(t.as(INST, `select register_document_version($1, $2, 'affidavit', null, $3, 'a.pdf')`, [nirmala, appId, path]),
      /not accepted/);
  });

  it('cannot route itself: institution has no officer transitions', async () => {
    const p1 = await uploadStub(nirmala);
    const p2 = await uploadStub(nirmala);
    await t.as(INST, `select register_document_version($1, $2, 'affidavit', null, $3, 'aff.pdf')`, [nirmala, appId, p1]);
    await t.as(INST, `select register_document_version($1, $2, 'fire_safety_certificate', null, $3, 'fire.pdf')`, [nirmala, appId, p2]);
    const a = await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [appId]);
    const s = await t.as<{ a: { status: string; current_stage: string } }>(INST, `select to_jsonb(submit_application($1, $2)) as a`, [appId, a[0].row_version]);
    // automatic intake → scrutiny once prerequisites hold
    expect(s[0].a.current_stage).toBe('scrutiny');
    expect(s[0].a.status).toBe('under_scrutiny');
    const r = await transition(INST, appId, 'scrutiny_to_decision');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('forbidden');
  });

  it('records rejected transitions in the audit log', async () => {
    const rows = await t.owner(`select reason from audit_logs where action = 'transition_rejected' and entity_id = $1`, [appId]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('rejects transitions not configured from the current stage', async () => {
    const r = await transition(SCRUTINY, appId, 'record_decision', 'Trying to skip the scrutiny stage entirely');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_transition');
  });

  it('enforces the route condition: without an intake increase the EVC path is unavailable', async () => {
    const r = await transition(SCRUTINY, appId, 'scrutiny_to_evc');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('prerequisite');
    const avail = await t.as<{ code: string; permitted: boolean; blocked_reason: string | null }>(SCRUTINY,
      `select * from available_transitions($1)`, [appId]);
    expect(avail.find((x) => x.code === 'scrutiny_to_decision')?.permitted).toBe(true);
    expect(avail.find((x) => x.code === 'scrutiny_to_evc')?.permitted).toBe(false);
  });

  it('runs the full deficiency → correction → re-review loop and keeps history', async () => {
    const due = new Date(Date.now() + 5 * 86400000).toISOString();
    const d = await t.as<{ d: { id: string } }>(SCRUTINY,
      `select to_jsonb(raise_deficiency($1, 'Affidavit not notarised', 'The affidavit carries no notary seal or registration number.',
       'Demo checklist EOA/affidavit', 'Upload a notarised affidavit with the notary registration number.', 'affidavit', $2)) as d`, [appId, due]);
    const defId = d[0].d.id;

    // cannot route while a deficiency is open
    const blocked = await transition(SCRUTINY, appId, 'scrutiny_to_decision');
    expect(blocked.code).toBe('prerequisite');

    // institution cannot respond until the case is returned
    await expectSqlError(t.as(INST, `select submit_deficiency_correction($1, 'Uploaded notarised copy today.')`, [defId]), /not been returned/);

    const a = await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [appId]);
    await expectSqlError(t.as(SCRUTINY, `select return_for_correction($1, $2, 'short')`, [appId, a[0].row_version]), /reason/);
    await t.as(SCRUTINY, `select return_for_correction($1, $2, 'Affidavit requires notarisation before review continues.')`, [appId, a[0].row_version]);

    const p = await uploadStub(nirmala);
    await expectSqlError(t.as(INST, `select register_document_version($1, $2, 'affidavit', null, $3, 'aff2.pdf')`, [nirmala, appId, p]),
      /why this document is being replaced/);
    const v = await t.as<{ v: { id: string; version: number } }>(INST,
      `select to_jsonb(register_document_version($1, $2, 'affidavit', null, $3, 'aff2.pdf', null, 'Notarised copy replaces unsigned draft')) as v`, [nirmala, appId, p]);
    expect(v[0].v.version).toBe(2);
    const versions = await t.owner(`select version from document_versions dv join documents d on d.id = dv.document_id
      where d.application_id = $1 and d.doc_type = 'affidavit' order by version`, [appId]);
    expect(versions.length).toBe(2);

    await t.as(INST, `select submit_deficiency_correction($1, 'Uploaded notarised affidavit with registration number.', $2)`, [defId, v[0].v.id]);
    let st = await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [defId]);
    expect(st[0].status).toBe('correction_submitted');
    const appRow = await t.owner<{ status: string }>(`select status from applications where id = $1`, [appId]);
    expect(appRow[0].status).toBe('correction_submitted');
    const task = await t.owner(`select 1 from tasks where deficiency_id = $1 and task_type = 'deficiency_review' and status = 'open'`, [defId]);
    expect(task.length).toBe(1);

    // still deficient → back to institution
    await t.as(SCRUTINY, `select review_deficiency_correction($1, 'still_deficient', 'Notary registration number is illegible on page 1.')`, [defId]);
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [appId]))[0].status).toBe('returned_for_correction');
    await t.as(INST, `select submit_deficiency_correction($1, 'Re-uploaded a clearer scan of the notarised affidavit.', $2)`, [defId, v[0].v.id]);
    await t.as(SCRUTINY, `select review_deficiency_correction($1, 'resolved', 'Notarisation verified on the replacement copy.')`, [defId]);
    st = await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [defId]);
    expect(st[0].status).toBe('resolved');
    expect((await t.owner<{ status: string }>(`select status from applications where id = $1`, [appId]))[0].status).toBe('under_scrutiny');

    const subs = await t.owner(`select attempt from deficiency_submissions where deficiency_id = $1`, [defId]);
    expect(subs.length).toBe(2);
    const timeline = await t.owner<{ event_type: string }>(`select event_type from application_events where application_id = $1 order by created_at`, [appId]);
    const types = timeline.map((x) => x.event_type);
    for (const e of ['created', 'submitted', 'deficiency_raised', 'returned', 'document_replaced', 'correction_submitted', 'correction_reviewed', 'corrections_resolved']) {
      expect(types).toContain(e);
    }
  });

  it('routes to decision and requires a competent officer to record the decision', async () => {
    expect((await transition(SCRUTINY, appId, 'scrutiny_to_decision')).ok).toBe(true);
    const noReason = await transition(DECISION, appId, 'record_decision', '', { decision: 'approved' });
    expect(noReason.code).toBe('reason_required');
    const noDecision = await transition(DECISION, appId, 'record_decision', 'All requirements met as per scrutiny record.');
    expect(noDecision.code).toBe('validation');
    const byScrutiny = await transition(SCRUTINY, appId, 'record_decision', 'All requirements met as per scrutiny record.', { decision: 'approved' });
    expect(byScrutiny.code).toBe('forbidden');
    const ok = await transition(DECISION, appId, 'record_decision', 'All requirements met as per scrutiny record.', { decision: 'approved' });
    expect(ok.ok).toBe(true);
    const a = await t.owner<{ status: string; closed_at: string | null }>(`select status, closed_at from applications where id = $1`, [appId]);
    expect(a[0].status).toBe('completed');
    expect(a[0].closed_at).not.toBeNull();
    expect((await t.owner(`select 1 from application_decisions where application_id = $1`, [appId])).length).toBe(1);
  });

  it('detects stale writes with optimistic concurrency', async () => {
    const n2 = await byTitle('Extension of approval with intake increase 2027-28');
    const r = await t.as<{ r: { ok: boolean; code: string } }>(SCRUTINY,
      `select perform_transition($1, 'scrutiny_to_evc', $2) as r`, [n2.id, n2.row_version - 1]);
    expect(r[0].r.code).toBe('stale');
  });

  it('serialises concurrent transitions: the second identical request is rejected as stale', async () => {
    const r = await t.as<{ a: { id: string; row_version: number } }>(INST,
      `select to_jsonb(create_application_draft($1, 'EOA', 'Concurrency test application', '2027-28', '{"approved_intake": 30}')) as a`, [nirmala]);
    const id = r[0].a.id;
    for (const dt of ['affidavit', 'fire_safety_certificate']) {
      const p = await uploadStub(nirmala);
      await t.as(INST, `select register_document_version($1, $2, $3, null, $4, 'x.pdf')`, [nirmala, id, dt, p]);
    }
    const a = await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]);
    await t.as(INST, `select submit_application($1, $2)`, [id, a[0].row_version]);
    const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [id]))[0].row_version;
    const first = await t.as<{ r: { ok: boolean } }>(SCRUTINY, `select perform_transition($1, 'scrutiny_to_decision', $2) as r`, [id, v]);
    const second = await t.as<{ r: { ok: boolean; code: string } }>(SCRUTINY, `select perform_transition($1, 'scrutiny_to_decision', $2) as r`, [id, v]);
    expect(first[0].r.ok).toBe(true);
    expect(second[0].r.ok).toBe(false);
    const hist = await t.owner(`select 1 from application_stage_history where application_id = $1 and stage_code = 'decision'`, [id]);
    expect(hist.length).toBe(1);
  });
});

describe('EVC', () => {
  it('queues EVC-required cases only after prerequisites and routes automatically after a satisfactory EVC', async () => {
    const n2 = await byTitle('Extension of approval with additional division 2027-28');
    expect(n2.current_stage).toBe('evc');
    const evc = (await t.owner<{ id: string; row_version: number; status: string }>(
      `select id, row_version, status from evc_records where application_id = $1`, [n2.id]))[0];
    expect(evc.status).toBe('awaiting_scheduling');

    await expectSqlError(t.as(SCRUTINY, `select schedule_evc($1, now() + interval '2 days', now() + interval '2 days 2 hours', '{}', true, null, $2)`,
      [evc.id, evc.row_version]), /EVC responsibility/);
    await expectSqlError(t.as(EVC, `select schedule_evc($1, now() - interval '2 days', now() - interval '1 day', '{}', true, null, $2)`,
      [evc.id, evc.row_version]), /future start/);
    const s = await t.as<{ r: { evc: { status: string; row_version: number }; conflicts: unknown[] } }>(EVC,
      `select schedule_evc($1, now() + interval '2 days', now() + interval '2 days 2 hours', '{}', true, 'Panel of two', $2) as r`,
      [evc.id, evc.row_version]);
    expect(s[0].r.evc.status).toBe('scheduled');

    // cannot complete before it starts
    await expectSqlError(t.as(EVC, `select complete_evc($1, 'satisfactory', 'A sufficiently long completion summary.', $2)`,
      [evc.id, s[0].r.evc.row_version]), /not started yet/);

    await t.owner(`update evc_records set scheduled_start = now() - interval '3 hours', scheduled_end = now() - interval '1 hour' where id = $1`, [evc.id]);
    await expectSqlError(t.as(EVC, `select complete_evc($1, 'satisfactory', 'too short', $2)`, [evc.id, s[0].r.evc.row_version]), /at least 20/);
    await t.as(EVC, `select complete_evc($1, 'satisfactory', 'Panel verified laboratories and classrooms online.', $2)`, [evc.id, s[0].r.evc.row_version]);
    const a = await t.owner<{ current_stage: string }>(`select current_stage from applications where id = $1`, [n2.id]);
    expect(a[0].current_stage).toBe('decision');
    const hist = await t.owner<{ action: string }>(`select action from evc_history where evc_id = $1 order by created_at`, [evc.id]);
    expect(hist.map((h) => h.action)).toEqual(['queued', 'confirmed', 'completed']);
  });

  it('reports overlapping panel schedules as conflicts', async () => {
    const s2 = await byTitle('New institution — Sahyadri School of Architecture');
    const existing = (await t.owner<{ scheduled_start: string; scheduled_end: string }>(
      `select scheduled_start, scheduled_end from evc_records where application_id = $1 and status = 'scheduled'`, [s2.id]))[0];
    const inst = 'inst.nirmala@aicasa-demo.test';
    const r = await t.as<{ a: { id: string; row_version: number } }>(inst,
      `select to_jsonb(create_application_draft($1, 'EOA', 'Conflict test application', '2027-28', '{"approved_intake": 30, "intake_increase": true}')) as a`, [nirmala]);
    for (const dt of ['affidavit', 'fire_safety_certificate']) {
      const p = await uploadStub(nirmala);
      await t.as(inst, `select register_document_version($1, $2, $3, null, $4, 'x.pdf')`, [nirmala, r[0].a.id, dt, p]);
    }
    const v = (await t.owner<{ row_version: number }>(`select row_version from applications where id = $1`, [r[0].a.id]))[0].row_version;
    await t.as(inst, `select submit_application($1, $2)`, [r[0].a.id, v]);
    expect((await transition(SCRUTINY, r[0].a.id, 'scrutiny_to_evc')).ok).toBe(true);
    const evc = (await t.owner<{ id: string; row_version: number }>(`select id, row_version from evc_records where application_id = $1`, [r[0].a.id]))[0];
    const res = await t.as<{ r: { conflicts: { reference: string }[] } }>(EVC,
      `select schedule_evc($1, $2, $3, '{}', false, null, $4) as r`, [evc.id, existing.scheduled_start, existing.scheduled_end, evc.row_version]);
    expect(res[0].r.conflicts.length).toBe(1);
  });

  it('cancellation requires a reason and re-queues a new cycle', async () => {
    const s2 = await byTitle('New institution — Sahyadri School of Architecture');
    const evc = (await t.owner<{ id: string; row_version: number }>(
      `select id, row_version from evc_records where application_id = $1 and status = 'scheduled'`, [s2.id]))[0];
    await expectSqlError(t.as(EVC, `select cancel_evc($1, 'no', $2)`, [evc.id, evc.row_version]), /reason/);
    const n = await t.as<{ e: { cycle: number; status: string } }>(EVC,
      `select to_jsonb(cancel_evc($1, 'Panel member unavailable due to an official assignment.', $2)) as e`, [evc.id, evc.row_version]);
    expect(n[0].e.cycle).toBe(2);
    expect(n[0].e.status).toBe('awaiting_scheduling');
  });
});
