import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, createTestDb, expectSqlError, type TestDb } from './harness';

let t: TestDb;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  for (const code of ['DEMO-WR-001', 'DEMO-WR-002', 'DEMO-WR-003', 'DEMO-SR-001']) {
    ids[code] = (await t.owner<{ id: string }>(`select id from institutions where code = $1`, [code]))[0].id;
  }
});

describe('institution isolation', () => {
  it('an institution sees only its own applications', async () => {
    const rows = await t.as<{ institution_id: string }>('inst.nirmala@aicasa-demo.test', `select institution_id from applications`);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.institution_id))).toEqual(new Set([ids['DEMO-WR-001']]));
  });

  it('cannot read another institution\'s deficiencies, documents or obligations', async () => {
    const e = 'inst.coromandel@aicasa-demo.test';
    const defs = await t.as<{ application_id: string }>(e, `select application_id from deficiencies`);
    expect(defs.length).toBe(0);
    const docs = await t.as<{ institution_id: string }>(e, `select institution_id from documents`);
    expect(docs.every((d) => d.institution_id === ids['DEMO-SR-001'])).toBe(true);
    const obl = await t.as<{ institution_id: string }>(e, `select institution_id from compliance_obligations`);
    expect(obl.every((d) => d.institution_id === ids['DEMO-SR-001'])).toBe(true);
  });

  it('a university sees an affiliated college only through the explicit grant, read-only', async () => {
    const rows = await t.as<{ institution_id: string }>('univ.deccan@aicasa-demo.test', `select distinct institution_id from applications`);
    const visible = new Set(rows.map((r) => r.institution_id));
    expect(visible.has(ids['DEMO-WR-003'])).toBe(true);
    expect(visible.has(ids['DEMO-WR-002'])).toBe(true);   // granted
    expect(visible.has(ids['DEMO-WR-001'])).toBe(false);  // not granted
    const s1 = (await t.owner<{ id: string }>(`select id from applications where institution_id = $1 and status = 'correction_submitted'`, [ids['DEMO-WR-002']]))[0];
    const d = (await t.owner<{ id: string }>(`select id from deficiencies where application_id = $1`, [s1.id]))[0];
    await expectSqlError(t.as('univ.deccan@aicasa-demo.test', `select submit_deficiency_correction($1, 'Trying to respond for the college.')`, [d.id]),
      /Only the institution concerned/);
  });

  it('turning the university-access flag off removes the granted visibility', async () => {
    await t.owner(`update system_settings set value = '{"enabled": false}' where key = 'feature.university_access'`);
    const rows = await t.as<{ institution_id: string }>('univ.deccan@aicasa-demo.test', `select distinct institution_id from applications`);
    expect(rows.map((r) => r.institution_id)).toEqual([ids['DEMO-WR-003']]);
    await t.owner(`update system_settings set value = '{"enabled": true}' where key = 'feature.university_access'`);
  });

  it('cannot create an application for another institution', async () => {
    await expectSqlError(t.as('inst.nirmala@aicasa-demo.test',
      `select create_application_draft($1, 'EOA', 'Not my institution application', '2027-28', '{}')`, [ids['DEMO-WR-002']]),
      /not an authorised representative/);
  });
});

describe('officer and admin scope', () => {
  it('a Western Region officer cannot see Southern Region cases', async () => {
    const rows = await t.as<{ region_code: string }>('officer.wr.scrutiny@aicasa-demo.test', `select region_code from applications`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.region_code === 'WR')).toBe(true);
  });

  it('a regional admin\'s aggregates match only their region; national admin sees all', async () => {
    const wr = await t.as<{ s: { totals: { all: number } } }>('admin.wr@aicasa-demo.test', `select analytics_summary() as s`);
    const nat = await t.as<{ s: { totals: { all: number } } }>('admin.national@aicasa-demo.test', `select analytics_summary() as s`);
    const wrCount = (await t.owner<{ n: number }>(`select count(*)::int as n from applications where region_code = 'WR'`))[0].n;
    const all = (await t.owner<{ n: number }>(`select count(*)::int as n from applications`))[0].n;
    expect(wr[0].s.totals.all).toBe(wrCount);
    expect(nat[0].s.totals.all).toBe(all);
  });

  it('an officer cannot act on a case outside their region', async () => {
    const c2 = (await t.owner<{ id: string; row_version: number }>(`select id, row_version from applications where region_code = 'SR' and current_stage = 'scrutiny'`))[0];
    const r = await t.as<{ r: { ok: boolean; code: string } }>('officer.wr.scrutiny@aicasa-demo.test',
      `select perform_transition($1, 'scrutiny_to_decision', $2) as r`, [c2.id, c2.row_version]);
    expect(r[0].r.ok).toBe(false);
    expect(r[0].r.code).toBe('not_found');
    await expectSqlError(t.as('officer.wr.scrutiny@aicasa-demo.test',
      `select raise_deficiency($1, 'Out of scope deficiency', 'This officer is not responsible for this region.', 'x src', 'Correct it please now', null, now() + interval '3 days')`,
      [c2.id]), /responsibility for region SR/);
  });

  it('administrators cannot perform officer workflow decisions', async () => {
    const n = (await t.owner<{ id: string; row_version: number }>(`select id, row_version from applications where status = 'under_scrutiny' and region_code = 'WR' limit 1`))[0];
    const r = await t.as<{ r: { ok: boolean; code: string } }>('admin.national@aicasa-demo.test',
      `select perform_transition($1, 'scrutiny_to_decision', $2) as r`, [n.id, n.row_version]);
    expect(r[0].r.ok).toBe(false);
    expect(r[0].r.code).toBe('forbidden');
  });
});

describe('privilege boundaries', () => {
  it('browser roles cannot write tables directly', async () => {
    const e = 'inst.nirmala@aicasa-demo.test';
    await expectSqlError(t.as(e, `update applications set status = 'completed'`), /permission denied/);
    await expectSqlError(t.as(e, `insert into user_role_assignments (user_id, role) values ($1, 'admin')`, [t.ids[e]]), /permission denied/);
    await expectSqlError(t.as(e, `update profiles set is_active = true`), /permission denied/);
    await expectSqlError(t.as(e, `delete from audit_logs`), /permission denied/);
  });

  it('a user cannot promote themselves, and only admins with user_admin can grant roles', async () => {
    await expectSqlError(t.as('officer.wr.scrutiny@aicasa-demo.test',
      `select assign_role($1, 'admin', null, '{}', 'I would like more access please')`, [t.ids['officer.wr.scrutiny@aicasa-demo.test']]),
      /Only administrators/);
    await expectSqlError(t.as('admin.wr@aicasa-demo.test',
      `select assign_role($1, 'officer', 'WR', '{scrutiny}', 'Self-grant attempt for testing')`, [t.ids['admin.wr@aicasa-demo.test']]),
      /own roles/);
  });

  it('a regional admin can grant officer access only within their region', async () => {
    const newUser = await addUser(t, 'new.officer@aicasa-demo.test');
    await expectSqlError(t.as('admin.wr@aicasa-demo.test',
      `select assign_role($1, 'officer', 'SR', '{scrutiny}', 'Granting scrutiny access in SR')`, [newUser]), /within your own region/);
    await expectSqlError(t.as('admin.wr@aicasa-demo.test',
      `select assign_role($1, 'admin', 'WR', '{}', 'Granting admin access in WR')`, [newUser]), /national administrator/);
    const ok = await t.as<{ a: { role: string } }>('admin.wr@aicasa-demo.test',
      `select to_jsonb(assign_role($1, 'officer', 'WR', '{scrutiny}', 'New scrutiny officer joining WR team')) as a`, [newUser]);
    expect(ok[0].a.role).toBe('officer');
    expect((await t.owner(`select 1 from audit_logs where action = 'role_granted' and entity_id = $1`, [newUser])).length).toBe(1);
  });

  it('a new user without a role assignment sees nothing', async () => {
    await addUser(t, 'nobody@aicasa-demo.test');
    expect((await t.as('nobody@aicasa-demo.test', `select * from applications`)).length).toBe(0);
    expect((await t.as('nobody@aicasa-demo.test', `select * from institutions`)).length).toBe(0);
    const ctx = await t.as<{ c: { roles: unknown[] } }>('nobody@aicasa-demo.test', `select get_my_context() as c`);
    expect(ctx[0].c.roles).toEqual([]);
  });

  it('a deactivated account loses access immediately', async () => {
    await t.owner(`update profiles set is_active = false where email = 'inst.sahyadri@aicasa-demo.test'`);
    expect((await t.as('inst.sahyadri@aicasa-demo.test', `select * from applications`)).length).toBe(0);
    await t.owner(`update profiles set is_active = true where email = 'inst.sahyadri@aicasa-demo.test'`);
  });

  it('audit records are append-only even for the owner', async () => {
    await expectSqlError(t.owner(`update audit_logs set action = 'tampered'`), /append-only/);
    await expectSqlError(t.owner(`delete from application_events`), /append-only/);
  });

  it('internal engine functions are not callable from the browser', async () => {
    const a = (await t.owner<{ id: string }>(`select id from applications limit 1`))[0];
    await expectSqlError(t.as('inst.nirmala@aicasa-demo.test', `select app.enter_stage($1, 'closed', 'hack')`, [a.id]), /permission denied/);
    await expectSqlError(t.as('admin.national@aicasa-demo.test', `select app.run_deadline_scan('manual')`), /permission denied/);
    await expectSqlError(t.as('admin.national@aicasa-demo.test', `select seed_demo_cases('{}')`), /permission denied/);
  });

  it('check results can only be written by the service role', async () => {
    const v = (await t.owner<{ id: string }>(`select v.id from document_versions v join documents d on d.id = v.document_id
      where d.institution_id = $1 limit 1`, [ids['DEMO-WR-001']]))[0];
    const run = await t.as<{ r: { id: string } }>('inst.nirmala@aicasa-demo.test', `select to_jsonb(start_document_check($1)) as r`, [v.id]);
    await expectSqlError(t.as('inst.nirmala@aicasa-demo.test',
      `select complete_document_check($1, 'fake', 'completed', 'succeeded', null, '[]', '{}', '{}', '[]')`, [run[0].r.id]),
      /document-check service/);
    await expectSqlError(t.as('inst.coromandel@aicasa-demo.test', `select start_document_check($1)`, [v.id]), /Only the institution/);
    const ok = await t.service<{ r: { status: string } }>(
      `select to_jsonb(complete_document_check($1, 'deterministic-v1', 'completed', 'succeeded', 'pdf-text', '[]', '{}', '{}',
        '[{"check_code":"file_type","check_name":"File type","outcome":"passed","severity":"info","explanation":"PDF accepted"}]')) as r`,
      [run[0].r.id]);
    expect(ok[0].r.status).toBe('completed');
  });
});

describe('storage policies', () => {
  it('uploads only into the caller\'s own institution folder', async () => {
    const own = `${ids['DEMO-WR-001']}/${crypto.randomUUID()}.pdf`;
    const other = `${ids['DEMO-WR-002']}/${crypto.randomUUID()}.pdf`;
    await t.as('inst.nirmala@aicasa-demo.test',
      `insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, '{}')`, [own]);
    await expectSqlError(t.as('inst.nirmala@aicasa-demo.test',
      `insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, '{}')`, [other]),
      /row-level security/);
    await expectSqlError(t.as('inst.nirmala@aicasa-demo.test',
      `insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, '{}')`, [`${ids['DEMO-WR-001']}/../x.pdf`]),
      /row-level security/);
  });

  it('reads are limited to institutions the caller may see', async () => {
    const rows = await t.as<{ name: string }>('inst.coromandel@aicasa-demo.test', `select name from storage.objects where bucket_id = 'institution-documents'`);
    expect(rows.every((r) => r.name.startsWith(ids['DEMO-SR-001']))).toBe(true);
    const officer = await t.as<{ name: string }>('officer.sr@aicasa-demo.test', `select name from storage.objects where bucket_id = 'institution-documents'`);
    expect(officer.every((r) => r.name.startsWith(ids['DEMO-SR-001']))).toBe(true);
  });

  it('EVC inspection reports are internal: the institution cannot read them, the panel and regional staff can', async () => {
    const inst = await t.as<{ name: string }>('inst.coromandel@aicasa-demo.test', `select name from storage.objects where bucket_id = 'evc-reports'`);
    expect(inst).toHaveLength(0);
    const officer = await t.as<{ name: string }>('officer.sr@aicasa-demo.test', `select name from storage.objects where bucket_id = 'evc-reports'`);
    expect(officer.length).toBeGreaterThan(0);
    const otherRegion = await t.as<{ name: string }>('officer.wr.scrutiny@aicasa-demo.test', `select name from storage.objects where bucket_id = 'evc-reports'`);
    expect(otherRegion).toHaveLength(0);
  });
});
