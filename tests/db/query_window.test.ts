import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, expectSqlError, type TestDb } from './harness';

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const SR = 'officer.sr@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';

let t: TestDb;
let nirmala: string;
const sha = (c: string) => c.repeat(64);

type Def = { id: string; status: string; row_version: number; due_at: string; window_opens_at: string; window_closes_at: string; window_reopen_count: number };

async function uploadStub(instId: string) {
  const name = `${instId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`, [name, JSON.stringify({ size: 2048, mimetype: 'application/pdf' })]);
  return name;
}
async function upload(appId: string, docType: string, file: string, reason: string | null, hash: string) {
  return (await t.as<{ v: { id: string; version: number } }>(NIRMALA,
    `select to_jsonb(register_document_version($1, $2, $3, null, $4, $5, $6, $7)) as v`, [nirmala, appId, docType, await uploadStub(nirmala), file, hash, reason]))[0].v;
}
/** A submitted case with a raised query on the affidavit, returned to the institution. */
async function queryCase(title: string) {
  const id = (await t.as<{ a: { id: string } }>(NIRMALA, `select to_jsonb(create_application_draft($1, 'EOA', $2, '2027-28', '{"approved_intake": 100}')) as a`, [nirmala, title]))[0].a.id;
  await upload(id, 'affidavit', 'aff.pdf', null, sha('a'));
  await upload(id, 'fire_safety_certificate', 'fire.pdf', null, sha('b'));
  await t.as(NIRMALA, `select submit_application($1, (select row_version from applications where id = $1))`, [id]);
  const d = await t.as<{ d: Def }>(SCRUTINY, `select to_jsonb(raise_deficiency($1, 'Affidavit unreadable', 'The scan of the affidavit is not legible.', 'Demo checklist EOA/affidavit', 'Upload a legible scan.', 'affidavit', null)) as d`, [id]);
  await t.as(SCRUTINY, `select return_for_correction($1, (select row_version from applications where id = $1), 'Query raised on the affidavit; response window is open.')`, [id]);
  return { id, def: d[0].d };
}
const def = async (id: string) => (await t.owner<Def>(`select id, status, row_version, due_at, window_opens_at, window_closes_at, window_reopen_count from deficiencies where id = $1`, [id]))[0];
/** Moves the window into the past as if it had run out (the audit log keeps its real times). */
async function expire(id: string) {
  await t.owner(`update deficiencies set window_opens_at = now() - interval '49 hours', window_closes_at = now() - interval '1 hour', due_at = now() - interval '1 hour' where id = $1`, [id]);
}

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('response window', () => {
  it('a raised query opens a window that closes exactly 48 hours later, and the deadline follows it', async () => {
    const { def: d } = await queryCase('Window exact');
    const r = await t.owner<{ exact: boolean; hours: number; due_same: boolean }>(
      `select (window_closes_at - window_opens_at) = interval '48 hours' as exact, (extract(epoch from (window_closes_at - window_opens_at)) / 3600)::float as hours,
              due_at = window_closes_at as due_same from deficiencies where id = $1`, [d.id]);
    expect(r[0]).toMatchObject({ exact: true, hours: 48, due_same: true });
    expect(Math.abs(new Date(d.window_opens_at).getTime() - Date.now())).toBeLessThan(60_000);
    const ev = await t.owner<{ metadata: { due_source: string } }>(`select metadata from application_events where event_type = 'deficiency_raised' and metadata ->> 'deficiency_id' = $1`, [d.id]);
    expect(ev[0].metadata.due_source).toBe('query_window');
  });

  it('the window length is configuration; an officer-chosen date no longer overrides it', async () => {
    await t.owner(`update system_settings set value = '{"hours": 24, "max_reopens": 1, "source_reference": "test"}' where key = 'deficiency.query_window'`);
    try {
      const { def: d } = await queryCase('Window configured 24h');
      expect((await t.owner<{ h: number }>(`select (extract(epoch from (window_closes_at - window_opens_at)) / 3600)::float as h from deficiencies where id = $1`, [d.id]))[0].h).toBe(24);
    } finally {
      await t.owner(`update system_settings set value = '{"hours": 48, "max_reopens": 1, "source_reference": "test"}' where key = 'deficiency.query_window'`);
    }
  });

  it('while the window is open the institution can upload and respond', async () => {
    const { id, def: d } = await queryCase('Window open');
    const v = await upload(id, 'affidavit', 'clear.pdf', 'Legible scan', sha('c'));
    await t.as(NIRMALA, `select submit_deficiency_correction($1, 'Uploaded a legible scan of the affidavit.', $2)`, [d.id, v.id]);
    expect((await def(d.id)).status).toBe('correction_submitted');
  });

  it('after the window closes, uploads for that query and clarifications are rejected (server side)', async () => {
    const { id, def: d } = await queryCase('Window closed');
    const v = await upload(id, 'affidavit', 'before_close.pdf', 'Prepared before the close', sha('d'));
    await expire(d.id);
    await expectSqlError(upload(id, 'affidavit', 'late.pdf', 'Late upload', sha('e')), /response window .* has closed/);
    await expectSqlError(t.as(NIRMALA, `select submit_deficiency_correction($1, 'Trying to respond after the window closed.', $2)`, [d.id, v.id]), /response window for this query closed/);
    // other documents of the case are not affected
    const other = await upload(id, 'fire_safety_certificate', 'fire_v2.pdf', 'Renewed fire certificate', sha('f'));
    expect(other.version).toBe(2);
    expect((await def(d.id)).status).toBe('open');
  });

  it('the window closes at the stored instant: one second before it is open, at the instant it is closed', async () => {
    const { id, def: d } = await queryCase('Window boundary');
    await t.owner(`update deficiencies set window_closes_at = now() + interval '2 seconds', due_at = now() + interval '2 seconds' where id = $1`, [d.id]);
    await upload(id, 'affidavit', 'just_in_time.pdf', 'Inside the window', sha('1'));
    await t.owner(`update deficiencies set window_closes_at = now(), due_at = now() where id = $1`, [d.id]);
    await expectSqlError(upload(id, 'affidavit', 'at_close.pdf', 'At the close', sha('2')), /has closed/);
  });
});

describe('reopening', () => {
  it('an officer can reopen an expired window once: fresh 48 hours, recorded in the audit log and timeline', async () => {
    const { id, def: d } = await queryCase('Reopen once');
    await expire(d.id);
    let cur = await def(d.id);
    await expectSqlError(t.as(NIRMALA, `select reopen_deficiency_window($1, 'The institution cannot reopen its own window.', $2)`, [d.id, cur.row_version]), /Only an officer/);
    await expectSqlError(t.as(SR, `select reopen_deficiency_window($1, 'Wrong region reopening the window.', $2)`, [d.id, cur.row_version]), /region WR|not found/i);
    await expectSqlError(t.as(EVC, `select reopen_deficiency_window($1, 'Wrong responsibility reopening it.', $2)`, [d.id, cur.row_version]), /scrutiny/);
    await expectSqlError(t.as(SCRUTINY, `select reopen_deficiency_window($1, 'short', $2)`, [d.id, cur.row_version]), /at least 10/);
    await expectSqlError(t.as(SCRUTINY, `select reopen_deficiency_window($1, 'Stale page reopening the window.', $2)`, [d.id, cur.row_version - 1]), /changed/);

    const before = Date.now();
    await t.as(SCRUTINY, `select reopen_deficiency_window($1, 'Institution had a system outage; granting a fresh window.', $2)`, [d.id, cur.row_version]);
    cur = await def(d.id);
    expect(cur.window_reopen_count).toBe(1);
    expect((await t.owner<{ exact: boolean }>(`select (window_closes_at - window_opens_at) = interval '48 hours' as exact from deficiencies where id = $1`, [d.id]))[0].exact).toBe(true);
    expect(new Date(cur.window_closes_at).getTime() - before).toBeGreaterThan(47.9 * 3600_000);
    expect(new Date(cur.due_at).getTime()).toBe(new Date(cur.window_closes_at).getTime());
    const audit = await t.owner<{ reason: string; after_state: { reopen_count: number } }>(`select reason, after_state from audit_logs where action = 'deficiency_window_reopened' and entity_id = $1`, [d.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'Institution had a system outage; granting a fresh window.', after_state: { reopen_count: 1 } });
    expect((await t.owner(`select 1 from application_events where application_id = $1 and event_type = 'deficiency_window_reopened'`, [id])).length).toBe(1);
    // the institution can upload again
    expect((await upload(id, 'affidavit', 'after_reopen.pdf', 'After reopening', sha('3'))).version).toBe(2);
  });

  it('a second reopening is refused (once only); an open window cannot be reopened', async () => {
    const { def: d } = await queryCase('Reopen twice');
    let cur = await def(d.id);
    await expectSqlError(t.as(SCRUTINY, `select reopen_deficiency_window($1, 'The window is still running, nothing to reopen.', $2)`, [d.id, cur.row_version]), /still open/);
    await expire(d.id);
    cur = await def(d.id);
    await t.as(SCRUTINY, `select reopen_deficiency_window($1, 'First and only reopening for this query.', $2)`, [d.id, cur.row_version]);
    await expire(d.id);
    cur = await def(d.id);
    await expectSqlError(t.as(SCRUTINY, `select reopen_deficiency_window($1, 'Trying a second reopening of the window.', $2)`, [d.id, cur.row_version]), /already been reopened 1 time/);
    expect((await def(d.id)).window_reopen_count).toBe(1);
  });

  it('an answered query cannot be reopened; a further-clarification review opens a fresh window of the same length', async () => {
    const { id, def: d } = await queryCase('Reopen after answer');
    const v = await upload(id, 'affidavit', 'answer.pdf', 'Answering the query', sha('4'));
    await t.as(NIRMALA, `select submit_deficiency_correction($1, 'Uploaded a legible scan of the affidavit.', $2)`, [d.id, v.id]);
    let cur = await def(d.id);
    await expectSqlError(t.as(SCRUTINY, `select reopen_deficiency_window($1, 'Nothing is awaited from the institution now.', $2)`, [d.id, cur.row_version]), /still has to respond/);
    await t.owner(`update deficiencies set window_opens_at = now() - interval '47 hours', window_closes_at = now() + interval '1 hour', due_at = now() + interval '1 hour' where id = $1`, [d.id]);
    await t.as(SCRUTINY, `select review_deficiency_correction($1, 'needs_clarification', 'The notary registration number is still unreadable.')`, [d.id]);
    cur = await def(d.id);
    expect(cur.window_reopen_count).toBe(0);
    expect((await t.owner<{ h: number }>(`select (extract(epoch from (window_closes_at - window_opens_at)) / 3600)::float as h from deficiencies where id = $1`, [d.id]))[0].h).toBe(48);
    expect(new Date(cur.window_closes_at).getTime() - Date.now()).toBeGreaterThan(47.9 * 3600_000);
  });
});

describe('escalation', () => {
  it('the DEFICIENCY_WINDOW_EXPIRED rule exists and the deadline scan escalates a closed window once', async () => {
    const rule = await t.owner<{ code: string; entity_type: string; offset_hours: number; rule_kind: string }>(`select code, entity_type, offset_hours, rule_kind from escalation_rules where code = 'DEFICIENCY_WINDOW_EXPIRED' and is_active`);
    expect(rule).toEqual([{ code: 'DEFICIENCY_WINDOW_EXPIRED', entity_type: 'deficiency_window', offset_hours: 0, rule_kind: 'escalation' }]);
    const { def: d } = await queryCase('Escalation');
    const first = await t.owner<{ r: { status: string } }>(`select app.run_deadline_scan('test') as r`);
    expect(first[0].r.status).toBe('succeeded');
    expect((await t.owner(`select 1 from escalation_events e join escalation_rules r on r.id = e.rule_id where r.code = 'DEFICIENCY_WINDOW_EXPIRED' and e.entity_id = $1`, [d.id])).length).toBe(0);
    await expire(d.id);
    await t.owner(`select app.run_deadline_scan('test')`);
    const events = await t.owner<{ summary: string; status: string }>(`select e.summary, e.status from escalation_events e join escalation_rules r on r.id = e.rule_id where r.code = 'DEFICIENCY_WINDOW_EXPIRED' and e.entity_id = $1`, [d.id]);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toMatch(/query window: Affidavit unreadable/);
    await t.owner(`select app.run_deadline_scan('test')`);
    expect((await t.owner(`select 1 from escalation_events e join escalation_rules r on r.id = e.rule_id where r.code = 'DEFICIENCY_WINDOW_EXPIRED' and e.entity_id = $1`, [d.id])).length).toBe(1);
    expect((await t.owner(`select 1 from audit_logs where action = 'escalation_triggered' and after_state ->> 'rule' = 'DEFICIENCY_WINDOW_EXPIRED'`)).length).toBeGreaterThan(0);
    expect((await t.owner(`select 1 from notifications where kind = 'escalation' and title like '%query window%'`)).length).toBeGreaterThan(0);
  });

  it('queries without a window (rule-raised or older ones) do not trigger the window escalation', async () => {
    const id = (await t.owner<{ id: string }>(`select id from applications where title = 'Extension of approval — computing capacity review (demo)'`))[0].id;
    await t.owner(`select app.run_deadline_scan('test', now() + interval '30 days')`);
    expect((await t.owner(`select 1 from escalation_events e join escalation_rules r on r.id = e.rule_id where r.code = 'DEFICIENCY_WINDOW_EXPIRED' and e.application_id = $1`, [id])).length).toBe(0);
  });
});

describe('stored extracted text and version comparison', () => {
  async function run(versionId: string, status: string, text: string | null) {
    const r = await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [versionId]);
    await t.service(`select complete_document_check($1, 'e', 'completed', $2, 'pdf-text', '[]', '{}', '{}', '[]', null, $3)`, [r[0].r.id, status, text]);
  }
  it('returns both texts only when both versions were read and their text was stored; otherwise says why not', async () => {
    const { id } = await queryCase('Compare texts');
    const v1 = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id where d.application_id = $1 and d.doc_type = 'affidavit'`, [id]))[0].id;
    const v2 = (await upload(id, 'affidavit', 'v2.pdf', 'Second version', sha('7'))).id;
    const cmp = async () => (await t.as<{ c: { content: { text_available: boolean; text_reason: string | null; old_text: string | null; new_text: string | null } } }>(SCRUTINY, `select compare_document_versions($1, $2) as c`, [v1, v2]))[0].c.content;
    expect((await cmp()).text_available).toBe(false);
    await run(v1, 'succeeded', 'Valid till 31/03/2026');
    expect((await cmp()).text_reason).toMatch(/no completed pre-check/);
    await run(v2, 'failed', null);
    expect((await cmp()).text_reason).toMatch(/could not be read reliably/);
    await run(v2, 'succeeded', null);
    expect((await cmp()).text_reason).toMatch(/text of version 2 was not stored|version 2 .*not stored/);
    await run(v2, 'succeeded', 'Valid till 31/03/2029');
    const ok = await cmp();
    expect(ok).toMatchObject({ text_available: true, text_reason: null, old_text: 'Valid till 31/03/2026', new_text: 'Valid till 31/03/2029' });
  });
  it('only the document-check service can store results', async () => {
    const { id } = await queryCase('Compare forged');
    const v = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id where d.application_id = $1 and d.doc_type = 'affidavit'`, [id]))[0].id;
    const r = await t.as<{ r: { id: string } }>(NIRMALA, `select to_jsonb(start_document_check($1)) as r`, [v]);
    await expectSqlError(t.as(NIRMALA, `select complete_document_check($1, 'forged', 'completed', 'succeeded', 'x', '[]', '{}', '{}', '[]', null, 'forged text')`, [r[0].r.id]), /document-check service/);
  });
});

describe('administration', () => {
  it('changing the deadline of a windowed query moves the window close with it (audited)', async () => {
    const { def: d } = await queryCase('Deadline sync');
    const later = new Date(Date.now() + 5 * 86400000).toISOString();
    await t.as(SCRUTINY, `select change_deficiency_deadline($1, $2::timestamptz, 'Institution asked for more time; agreed.', $3)`, [d.id, later, d.row_version]);
    const cur = await def(d.id);
    expect(new Date(cur.window_closes_at).toISOString()).toBe(later);
    expect(new Date(cur.due_at).toISOString()).toBe(later);
  });
  it('only a national administrator with escalation responsibility edits the window escalation rule', async () => {
    await expectSqlError(t.as(SCRUTINY, `select update_escalation_rule('DEFICIENCY_WINDOW_EXPIRED', 0, 'assigned_officer', null, 'in_app', 2, 24, true, 'Demo ref', 'Trying to change it without authority')`), /national|forbidden|escalation/i);
    const r = await t.as<{ n: { version: number } }>(ADMIN, `select to_jsonb(update_escalation_rule('DEFICIENCY_WINDOW_EXPIRED', 0, 'regional_admin', null, 'in_app', 2, 24, true, 'Project requirement: 48-hour query window', 'Notify the regional administrator too')) as n`);
    expect(r[0].n.version).toBe(2);
  });
});
