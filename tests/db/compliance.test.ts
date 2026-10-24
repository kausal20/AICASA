import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectSqlError, type TestDb } from './harness';

const INST = 'inst.nirmala@aicasa-demo.test';
const OFFICER = 'officer.wr.compliance@aicasa-demo.test';
let t: TestDb;
let nirmala: string;

async function uploadDoc(email: string, instId: string) {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, '{"size": 1000, "mimetype": "application/pdf"}')`, [name]);
  const v = await t.as<{ v: { id: string } }>(email, `select to_jsonb(register_document_version($1, null, 'evidence', 'Evidence', $2, 'e.pdf')) as v`, [instId, name]);
  return v[0].v.id;
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('compliance obligations', () => {
  it('links obligations to the right institution and only compliance staff can create them', async () => {
    await expectSqlError(t.as('officer.wr.scrutiny@aicasa-demo.test',
      `select create_obligation($1, null, 'undertaking', 'Undertaking title', 'Some conditions here', 'Source ref', 'Evidence text', null, current_date + 10)`,
      [nirmala]), /compliance responsibility/);
    await expectSqlError(t.as('officer.sr@aicasa-demo.test',
      `select create_obligation($1, null, 'undertaking', 'Undertaking title', 'Some conditions here', 'Source ref', 'Evidence text', null, current_date + 10)`,
      [nirmala]), /compliance responsibility/);
    const o = await t.as<{ o: { institution_id: string; region_code: string; status: string } }>(OFFICER,
      `select to_jsonb(create_obligation($1, null, 'undertaking', 'Install ramps in academic block', 'Undertaking on accessibility of the academic block.',
       'Demo undertaking ref', 'Photographs and completion certificate', null, current_date + 40)) as o`, [nirmala]);
    expect(o[0].o.institution_id).toBe(nirmala);
    expect(o[0].o.region_code).toBe('WR');
    expect(o[0].o.status).toBe('awaiting_submission');
  });

  it('submitting evidence creates a verification task and never verifies by itself', async () => {
    const o = (await t.owner<{ id: string; row_version: number }>(`select id, row_version from compliance_obligations where title = 'Install ramps in academic block'`))[0];
    const v = await uploadDoc(INST, nirmala);
    await t.as(INST, `select submit_compliance_evidence($1, $2, 'Ramps installed', null, $3)`, [o.id, v, o.row_version]);
    const after = (await t.owner<{ status: string }>(`select status from compliance_obligations where id = $1`, [o.id]))[0];
    expect(after.status).toBe('submitted');
    expect((await t.owner(`select 1 from tasks where obligation_id = $1 and task_type = 'compliance_verification' and status = 'open'`, [o.id])).length).toBe(1);
    await expectSqlError(t.as(INST, `select verify_compliance($1, 'verified', 'Self-verification attempt by institution', 2)`, [o.id]), /Only officers/);
  });

  it('verification requires a reason and records officer and time', async () => {
    const o = (await t.owner<{ id: string; row_version: number }>(`select id, row_version from compliance_obligations where title = 'Install ramps in academic block'`))[0];
    await expectSqlError(t.as(OFFICER, `select verify_compliance($1, 'verified', 'ok', $2)`, [o.id, o.row_version]), /basis/);
    await t.as(OFFICER, `select verify_compliance($1, 'correction_required', 'Photographs do not show the ramp gradient marking.', $2)`, [o.id, o.row_version]);
    const row = (await t.owner<{ status: string }>(`select status from compliance_obligations where id = $1`, [o.id]))[0];
    expect(row.status).toBe('correction_required');
    const ver = await t.owner<{ verified_by: string; verified_at: string }>(`select verified_by, verified_at from compliance_verifications where obligation_id = $1`, [o.id]);
    expect(ver[0].verified_by).toBe(t.ids[OFFICER]);
  });

  it('calculates due-soon and overdue from dates, not stored flags', async () => {
    const rows = await t.as<{ title: string; effective_status: string }>(INST, `select title, effective_status from v_obligations`);
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.effective_status]));
    expect(byTitle['Display revised name on all statutory disclosures']).toBe('overdue');
    const sr = await t.as<{ title: string; effective_status: string }>('inst.coromandel@aicasa-demo.test', `select title, effective_status from v_obligations`);
    expect(sr.find((r) => r.title === 'Appoint full-time director before commencement')?.effective_status).toBe('due_soon');
  });

  it('a verified recurring obligation creates exactly one next occurrence', async () => {
    const rows = await t.owner<{ status: string; parent_obligation_id: string | null }>(
      `select status, parent_obligation_id from compliance_obligations where title = 'Annual faculty and student strength return' order by due_at`);
    expect(rows.map((r) => r.status)).toEqual(['verified', 'awaiting_submission']);
    expect(rows[1].parent_obligation_id).not.toBeNull();
  });
});

describe('document validity and renewal', () => {
  it('reminder lead time creates a renewal obligation; renewal verification supersedes the old record', async () => {
    const renewal = (await t.owner<{ id: string; row_version: number; validity_id: string }>(
      `select id, row_version, validity_id from compliance_obligations where title = 'Renew: Campus land lease deed'`))[0];
    expect(renewal).toBeTruthy();
    const v = await uploadDoc(INST, nirmala);
    await expectSqlError(t.as(INST, `select submit_compliance_evidence($1, $2, 'renewed', current_date + 10, $3)`,
      [renewal.id, v, renewal.row_version]), /must be after/);
    await t.as(INST, `select submit_compliance_evidence($1, $2, 'Renewed lease registered', current_date + 3650, $3)`, [renewal.id, v, renewal.row_version]);
    const pending = (await t.owner<{ renewal_state: string }>(`select renewal_state from document_validities where id = $1`, [renewal.validity_id]))[0];
    expect(pending.renewal_state).toBe('renewal_submitted');
    const o = (await t.owner<{ row_version: number }>(`select row_version from compliance_obligations where id = $1`, [renewal.id]))[0];
    await t.as(OFFICER, `select verify_compliance($1, 'verified', 'Registered lease deed checked against registration number.', $2)`, [renewal.id, o.row_version]);
    const old = (await t.owner<{ renewal_state: string; superseded_by: string }>(`select renewal_state, superseded_by from document_validities where id = $1`, [renewal.validity_id]))[0];
    expect(old.renewal_state).toBe('renewed');
    const next = (await t.owner<{ expiry_date: string }>(`select expiry_date::text from document_validities where id = $1`, [old.superseded_by]))[0];
    expect(next.expiry_date).toBeTruthy();
  });

  it('expired documents are shown as expired, not as legally invalid', async () => {
    const rows = await t.as<{ validity_state: string; title: string }>('inst.sahyadri@aicasa-demo.test', `select validity_state, title from v_document_validity`);
    expect(rows.find((r) => r.title === 'Hostel block fire safety certificate')?.validity_state).toBe('expired');
  });
});

describe('deadline scanner', () => {
  it('repeated runs do not duplicate escalations or notifications', async () => {
    await t.owner(`select app.run_deadline_scan('test')`);
    const before = await t.owner<{ e: number; n: number }>(`select (select count(*)::int from escalation_events) e, (select count(*)::int from notifications) n`);
    await t.owner(`select app.run_deadline_scan('test')`);
    await t.owner(`select app.run_deadline_scan('test')`);
    const after = await t.owner<{ e: number; n: number }>(`select (select count(*)::int from escalation_events) e, (select count(*)::int from notifications) n`);
    expect(after[0].e).toBe(before[0].e);
    expect(after[0].n).toBe(before[0].n);
  });

  it('uses the configured lead time: changing the rule changes when reminders fire', async () => {
    // an obligation due in 20 days is outside a 14-day reminder window
    const o = await t.as<{ o: { id: string } }>(OFFICER,
      `select to_jsonb(create_obligation($1, null, 'periodic_report', 'Lead time probe report', 'Probe for reminder lead time behaviour.', 'Demo ref', 'Any evidence', null, current_date + 20)) as o`,
      [nirmala]);
    await t.owner(`select app.run_deadline_scan('test')`);
    const none = await t.owner(`select 1 from notifications where entity_id = $1 and kind = 'reminder'`, [o[0].o.id]);
    expect(none.length).toBe(0);
    await t.as('admin.national@aicasa-demo.test',
      `select update_escalation_rule('OBLIGATION_DUE_REMINDER', -720, 'institution', null, 'in_app', 2, 168, true, null, 'Widen reminder window to 30 days')`);
    await t.owner(`select app.run_deadline_scan('test')`);
    const some = await t.owner(`select 1 from notifications where entity_id = $1 and kind = 'reminder'`, [o[0].o.id]);
    expect(some.length).toBeGreaterThan(0);
    const versions = await t.owner<{ version: number; is_active: boolean }>(`select version, is_active from escalation_rules where code = 'OBLIGATION_DUE_REMINDER' order by version`);
    expect(versions).toEqual([{ version: 1, is_active: false }, { version: 2, is_active: true }]);
  });

  it('records each run with its outcome and escalates through the audit trail', async () => {
    const runs = await t.owner<{ status: string }>(`select status from scheduled_job_runs`);
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    expect((await t.owner(`select 1 from audit_logs where action = 'escalation_triggered'`)).length).toBeGreaterThan(0);
  });

  it('logs skipped email delivery honestly when no provider is configured', async () => {
    const rows = await t.owner<{ status: string }>(`select distinct status from notification_delivery_attempts`);
    expect(rows.map((r) => r.status)).toEqual(['skipped_unconfigured']);
  });

  it('only administrators with escalation responsibility can trigger a manual scan', async () => {
    await expectSqlError(t.as(OFFICER, `select run_deadline_scan_now()`), /Only administrators/);
    const r = await t.as<{ r: { status: string } }>('admin.wr@aicasa-demo.test', `select run_deadline_scan_now() as r`);
    expect(r[0].r.status).toBe('succeeded');
  });
});
