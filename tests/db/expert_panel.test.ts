import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, createTestDb, expectSqlError, type TestDb } from './harness';
import { matchExperts, type MatchExpert, type MatchInstitution } from '../../src/lib/expertMatch';

const EVC = 'officer.wr.evc@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const SR = 'officer.sr@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';
const SAHYADRI = 'inst.sahyadri@aicasa-demo.test';

let t: TestDb;

type Evc = { id: string; row_version: number; status: string; application_id: string };
async function evcOf(title: string): Promise<Evc> {
  return (await t.owner<Evc>(
    `select e.id, e.row_version, e.status, e.application_id from evc_records e join applications a on a.id = e.application_id
     where a.title = $1 order by e.cycle desc limit 1`, [title]))[0];
}
const expertId = async (code: string) => (await t.owner<{ id: string }>(`select id from experts where code = $1`, [code]))[0].id;
async function stub(evcId: string) {
  const path = `${evcId}/${crypto.randomUUID()}.pdf`;
  await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('evc-reports', $1, $2)`, [path, JSON.stringify({ size: 52_000, mimetype: 'application/pdf' })]);
  return path;
}
type Report = { id: string; uploaded_at: string; latitude: string; longitude: string; geo_source: string; geo_accuracy_m: string | null };
async function upload(who: string, evcId: string, lat: number | null, lng: number | null, source = 'browser', accuracy: number | null = 12) {
  return (await t.as<{ r: Report }>(who,
    `select to_jsonb(register_evc_report($1, $2, 'inspection_report.pdf', null, $3, $4, $5, $6, null)) as r`,
    [evcId, await stub(evcId), lat, lng, source, accuracy]))[0].r;
}

const SAHYADRI_TITLE_S2 = 'New institution — Sahyadri School of Architecture'; // scheduled, starts in 5 days
const SAHYADRI_TITLE_S3 = 'Restoration of intake — Mechanical Engineering';      // scheduled, started yesterday, outcome pending

beforeAll(async () => { t = await createTestDb(); });

describe('expert registry and seed', () => {
  it('seeds 8 demo experts across at least 3 regions and 4 specializations', async () => {
    const r = await t.owner<{ n: number; regions: number; specs: number }>(
      `select count(*)::int as n, count(distinct region_code)::int as regions, (select count(distinct s)::int from experts, unnest(specializations) s) as specs from experts where is_demo`);
    expect(r[0].n).toBe(8);
    expect(r[0].regions).toBeGreaterThanOrEqual(3);
    expect(r[0].specs).toBeGreaterThanOrEqual(4);
  });

  it('officers can read the registry, institution users cannot', async () => {
    expect((await t.as(EVC, `select id from experts`)).length).toBe(8);
    expect((await t.as(SAHYADRI, `select id from experts`)).length).toBe(0);
  });

  it('an administrator can add an expert; validation and scope are enforced and the change is audited', async () => {
    const e = (await t.as<{ e: { id: string; full_name: string } }>(ADMIN,
      `select to_jsonb(upsert_expert(null, 'Dr. Test Expert (Demo)', '{ECE, ECE, CSE}', 'Indore', 'Madhya Pradesh', null, 'Test Institute', 'CR', null, true)) as e`))[0].e;
    const row = (await t.owner<{ specializations: string[] }>(`select specializations from experts where id = $1`, [e.id]))[0];
    expect([...row.specializations].sort()).toEqual(['CSE', 'ECE']);
    expect((await t.owner(`select 1 from audit_logs where action = 'expert_created' and entity_id = $1`, [e.id])).length).toBe(1);
    await expectSqlError(t.as(ADMIN, `select upsert_expert(null, 'No Fields (Demo)', '{}', 'Indore', 'Madhya Pradesh', null, null, 'CR', null, true)`), /at least one specialization/);
    await expectSqlError(t.as(SAHYADRI, `select upsert_expert(null, 'Nope (Demo)', '{CSE}', 'Indore', 'Madhya Pradesh', null, null, 'CR', null, true)`), /Managing experts/);
    await expectSqlError(t.as(EVC, `select upsert_expert(null, 'Out Of Region (Demo)', '{CSE}', 'Indore', 'Madhya Pradesh', null, null, 'SR', null, true)`), /outside your region/);
    await t.owner(`delete from experts where id = $1`, [e.id]);
  });

  it('records and withdraws expert availability windows', async () => {
    const id = await expertId('DEMO-EXP-004');
    // a WR officer cannot manage an SR expert
    await expectSqlError(t.as(EVC, `select record_expert_availability($1, 'unavailable', now() + interval '3 days', now() + interval '5 days', 'x')`, [id]), /outside your region/);
    const w = (await t.as<{ w: { id: string } }>(ADMIN,
      `select to_jsonb(record_expert_availability($1, 'unavailable', now() + interval '3 days', now() + interval '5 days', 'Conference')) as w`, [id]))[0].w;
    await expectSqlError(t.as(ADMIN, `select record_expert_availability($1, 'available', now() - interval '3 days', now() - interval '1 day', null)`, [id]), /end in the future/);
    await t.as(ADMIN, `select withdraw_expert_availability($1, 'Conference cancelled')`, [w.id]);
    expect((await t.owner<{ withdrawn_at: string | null }>(`select withdrawn_at from expert_availability where id = $1`, [w.id]))[0].withdrawn_at).not.toBeNull();
  });
});

describe('recommending a panel', () => {
  let s2: Evc;
  beforeAll(async () => {
    s2 = await evcOf(SAHYADRI_TITLE_S2);
    // the seeded demo gives this session a panel (Farida Shaikh, Suresh Babu); these tests start from an empty one
    expect((await t.owner(`select 1 from evc_panel_experts where evc_id = $1`, [s2.id])).length).toBe(2);
    await t.owner(`delete from evc_panel_experts where evc_id = $1`, [s2.id]);
  });

  async function inputs(who = EVC) {
    return (await t.as<{ r: { institution: MatchInstitution; programme_text: string; experts: MatchExpert[]; evc: { scheduled_start: string; scheduled_end: string } } }>(who,
      `select expert_match_inputs($1) as r`, [s2.id]))[0].r;
  }

  it('shows one exclusion of each type for Sahyadri, with the reason strings, and ranks the rest', async () => {
    const r = await inputs();
    expect(r.institution.district).toBe('Nashik');
    const m = matchExperts(r.institution, r.experts, { programmeText: r.programme_text, sessionStart: r.evc.scheduled_start, sessionEnd: r.evc.scheduled_end });
    const reason = (name: string) => m.excluded.find((x) => x.expert.full_name.includes(name))?.labels;
    expect(reason('Anil Wagh')).toEqual(['Excluded — same district as institute']);        // no declaration involved
    expect(reason('Kavita Joshi')).toEqual(['Excluded — affiliated with this institute']); // no declaration involved
    expect(reason('Rohan Deshmukh')).toEqual(['Excluded — declared conflict']);
    expect(m.excluded).toHaveLength(4);
    expect(m.recommended.map((x) => x.expert.full_name.replace(' (Demo)', ''))).toEqual([
      'Dr. Farida Shaikh', 'Prof. Suresh Babu', 'Dr. Lakshmi Narayanan', 'Prof. Sudipta Banerjee',
    ]);
    expect(m.recommended[0].matchedTags).toEqual(['CSE', 'Mechanical']);
  });

  it('a different institute gets a different panel: Nirmala (Pune) excludes by its own district and affiliation facts', async () => {
    const n2 = await evcOf('Extension of approval with additional division 2027-28');
    const r = (await t.as<{ r: { institution: MatchInstitution; programme_text: string; experts: MatchExpert[] } }>(EVC, `select expert_match_inputs($1) as r`, [n2.id]))[0].r;
    const m = matchExperts(r.institution, r.experts, { programmeText: r.programme_text });
    expect(m.excluded).toHaveLength(1);
    expect(m.excluded[0].reasons).toContain('no_specialization_match');
    expect(m.recommended.length).toBe(7);
  });

  it('only AICTE staff can ask for recommendations', async () => {
    await expectSqlError(t.as(SAHYADRI, `select expert_match_inputs($1)`, [s2.id]), /Only AICTE staff/);
  });

  it('the server refuses to assign an excluded expert, with the same reasons, whatever the browser sends', async () => {
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, await expertId('DEMO-EXP-001'), s2.row_version]), /Excluded — same district as institute/);
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, await expertId('DEMO-EXP-002'), s2.row_version]), /Excluded — affiliated with this institute/);
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, await expertId('DEMO-EXP-003'), s2.row_version]), /Excluded — declared conflict/);
    expect((await t.owner(`select 1 from evc_panel_experts where evc_id = $1`, [s2.id])).length).toBe(0);
  });

  it('an eligible expert can be assigned and removed; panel changes need the EVC responsibility and are logged', async () => {
    const farida = await expertId('DEMO-EXP-007');
    await expectSqlError(t.as(SCRUTINY, `select assign_evc_expert($1, $2, $3)`, [s2.id, farida, s2.row_version]), /EVC responsibility/);
    const histBefore = (await t.owner(`select 1 from evc_history where evc_id = $1 and action = 'expert_assigned'`, [s2.id])).length;
    const eventsBefore = (await t.owner(`select 1 from application_events where application_id = $1 and event_type = 'evc_expert_assigned'`, [s2.application_id])).length;
    await t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, farida, s2.row_version]);
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, farida, s2.row_version]), /already on the panel/);
    expect((await t.owner(`select 1 from evc_history where evc_id = $1 and action = 'expert_assigned'`, [s2.id])).length).toBe(histBefore + 1);
    expect((await t.owner(`select 1 from application_events where application_id = $1 and event_type = 'evc_expert_assigned'`, [s2.application_id])).length).toBe(eventsBefore + 1);
    await t.as(EVC, `select remove_evc_expert($1, $2, 'Replaced by a closer expert')`, [s2.id, farida]);
    expect((await t.owner(`select 1 from evc_panel_experts where evc_id = $1`, [s2.id])).length).toBe(0);
  });

  it('a declared conflict recorded for an expert feeds the exclusion immediately, and withdrawing it lifts the exclusion', async () => {
    const lakshmi = await expertId('DEMO-EXP-004');
    const sahyadri = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-002'`))[0].id;
    const d = (await t.as<{ d: { id: string } }>(ADMIN, `select to_jsonb(declare_expert_conflict($1, $2, 'Former employer of the expert, left in 2023.')) as d`, [lakshmi, sahyadri]))[0].d;
    await expectSqlError(t.as(ADMIN, `select declare_expert_conflict($1, $2, 'Duplicate declaration of the same conflict.')`, [lakshmi, sahyadri]), /already on record/);
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, lakshmi, s2.row_version]), /Excluded — declared conflict/);
    const m = matchExperts((await inputs()).institution, (await inputs()).experts);
    expect(m.excluded.find((x) => x.expert.id === lakshmi)?.labels).toEqual(['Excluded — declared conflict']);
    await t.as(ADMIN, `select withdraw_evc_conflict($1, 'The employment ended well beyond the review window.')`, [d.id]);
    await t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, lakshmi, s2.row_version]);
    await t.as(EVC, `select remove_evc_expert($1, $2, 'Not needed for this visit')`, [s2.id, lakshmi]);
  });

  it('a conflict an officer declared with the existing self-declaration feature excludes the expert linked to that officer', async () => {
    const officerProfile = t.ids[SR];
    const e = (await t.as<{ e: { id: string } }>(ADMIN,
      `select to_jsonb(upsert_expert(null, 'Karthik Raman as expert (Demo)', '{Civil}', 'Chennai', 'Tamil Nadu', null, 'AICTE Southern Region (Demo)', 'SR', $1, true)) as e`, [officerProfile]))[0].e;
    const sahyadri = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-002'`))[0].id;
    await t.as(SR, `select declare_evc_conflict($1, $2, 'Studied together with the institute director.')`, [officerProfile, sahyadri]);
    await expectSqlError(t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, e.id, s2.row_version]), /Excluded — declared conflict/);
    const r = await inputs();
    expect(matchExperts(r.institution, r.experts).excluded.find((x) => x.expert.id === e.id)?.labels).toEqual(['Excluded — declared conflict']);
  });
});

describe('geo-tagged, time-stamped inspection reports', () => {
  it('the seeded completed session has an uploaded, geo-tagged report', async () => {
    const c1 = await evcOf('New institution — Coromandel School of Business Analytics');
    expect(c1.status).toBe('completed');
    const r = await t.owner<{ latitude: string; longitude: string; geo_source: string; uploaded_at: string }>(`select * from evc_reports where evc_id = $1`, [c1.id]);
    expect(r).toHaveLength(1);
    expect(Number(r[0].latitude)).toBeCloseTo(13.0827, 4);
    expect(Number(r[0].longitude)).toBeCloseTo(80.2707, 4);
    expect(r[0].uploaded_at).toBeTruthy();
  });

  it('a session cannot be completed without a report', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    expect(s3.status).toBe('scheduled');
    const msg = await expectSqlError(t.as(EVC, `select complete_evc($1, 'satisfactory', 'Panel verified the laboratories during the visit.', $2)`, [s3.id, s3.row_version]), /inspection report/);
    expect(msg).toMatch(/geo-tag/);
    expect((await t.owner<{ status: string }>(`select status::text from evc_records where id = $1`, [s3.id]))[0].status).toBe('scheduled');
  });

  it('an upload records the server timestamp and the geo-tag, and both reach the timeline and the audit log', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    const before = Date.now();
    const rep = await upload(EVC, s3.id, 19.99753, 73.78981, 'browser', 12.4);
    const row = (await t.owner<{ latitude: string; longitude: string; geo_source: string; geo_accuracy_m: string; secs: number; uploaded_by: string }>(
      `select latitude, longitude, geo_source, geo_accuracy_m, abs(extract(epoch from (now() - uploaded_at)))::float as secs, uploaded_by from evc_reports where id = $1`, [rep.id]))[0];
    expect(Number(row.latitude)).toBeCloseTo(19.99753, 5);
    expect(Number(row.longitude)).toBeCloseTo(73.78981, 5);
    expect(row.geo_source).toBe('browser');
    expect(Number(row.geo_accuracy_m)).toBeCloseTo(12.4, 1);
    expect(row.secs).toBeLessThan(60);                                   // stamped by the server clock
    expect(row.uploaded_by).toBe(t.ids[EVC]);
    expect(Math.abs(new Date(rep.uploaded_at).getTime() - before)).toBeLessThan(120_000);

    const ev = await t.owner<{ summary: string; visibility: string; metadata: { latitude: number; longitude: number; uploaded_at: string } }>(
      `select summary, visibility, metadata from application_events where application_id = $1 and event_type = 'evc_report_uploaded'`, [s3.application_id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].summary).toMatch(/19\.997530, 73\.789810/);
    expect(ev[0].metadata.uploaded_at).toBeTruthy();
    expect(ev[0].visibility).toBe('internal');
    expect((await t.owner(`select 1 from audit_logs where action = 'evc_report_uploaded' and entity_id = $1`, [rep.id])).length).toBe(1);
    expect((await t.owner<{ action: string }>(`select action from evc_history where evc_id = $1 and action = 'report_uploaded'`, [s3.id])).length).toBe(1);
  });

  it('reports are internal: institution users see neither the report nor its timeline entry', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    expect((await t.as(SAHYADRI, `select id from evc_reports where evc_id = $1`, [s3.id])).length).toBe(0);
    expect((await t.as(SAHYADRI, `select id from application_events where application_id = $1 and event_type = 'evc_report_uploaded'`, [s3.application_id])).length).toBe(0);
    expect((await t.as(EVC, `select id from evc_reports where evc_id = $1`, [s3.id])).length).toBe(1);
  });

  it('the report is stored immutably', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    await expectSqlError(t.owner(`update evc_reports set latitude = 0 where evc_id = $1`, [s3.id]), /append-only/);
    await expectSqlError(t.owner(`delete from evc_reports where evc_id = $1`, [s3.id]), /append-only/);
  });

  it('a geo-tag is mandatory and must be a real coordinate', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    await expectSqlError(upload(EVC, s3.id, null, 73.8), /geo-tag is required/);
    await expectSqlError(upload(EVC, s3.id, 19.9, null), /geo-tag is required/);
    await expectSqlError(upload(EVC, s3.id, 91, 73.8), /geo-tag is required/);
    await expectSqlError(upload(EVC, s3.id, 19.9, -181), /geo-tag is required/);
    await expectSqlError(upload(EVC, s3.id, 19.9, 73.8, 'guess'), /browser or was entered manually/);
  });

  it('only a panel member can upload, only to a started, confirmed session, only a PDF that really is in storage', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    const s2 = await evcOf(SAHYADRI_TITLE_S2);
    await expectSqlError(upload(SCRUTINY, s3.id, 19.9, 73.8), /member of this EVC panel/);
    await expectSqlError(upload(SAHYADRI, s3.id, 19.9, 73.8), /member of this EVC panel/);
    await expectSqlError(upload(EVC, s2.id, 19.9, 73.8), /has not started yet/);
    await expectSqlError(t.as(EVC, `select register_evc_report($1, $2, 'ghost.pdf', null, 19.9, 73.8, 'manual')`, [s3.id, `${s3.id}/${crypto.randomUUID()}.pdf`]), /not found in private storage/);
    await expectSqlError(t.as(EVC, `select register_evc_report($1, 'elsewhere/x.pdf', 'x.pdf', null, 19.9, 73.8, 'manual')`, [s3.id]), /expected EVC folder format/);
    const png = `${s3.id}/${crypto.randomUUID()}.pdf`;
    await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('evc-reports', $1, $2)`, [png, JSON.stringify({ size: 1000, mimetype: 'image/png' })]);
    await expectSqlError(t.as(EVC, `select register_evc_report($1, $2, 'x.pdf', null, 19.9, 73.8, 'manual')`, [s3.id, png]), /must be a PDF/);
  });

  it('storage policy: only a panel member can put a file into the session folder', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    const path = `${s3.id}/${crypto.randomUUID()}.pdf`;
    await t.as(EVC, `insert into storage.objects (bucket_id, name, metadata) values ('evc-reports', $1, '{"size": 10, "mimetype": "application/pdf"}')`, [path]);
    await expectSqlError(t.as(SCRUTINY, `insert into storage.objects (bucket_id, name, metadata) values ('evc-reports', $1, '{"size": 10, "mimetype": "application/pdf"}')`,
      [`${s3.id}/${crypto.randomUUID()}.pdf`]), /row-level security/);
  });

  it('with a report on file the session can be completed; afterwards no more reports are accepted', async () => {
    const s3 = await evcOf(SAHYADRI_TITLE_S3);
    await t.as(EVC, `select complete_evc($1, 'satisfactory', 'Panel verified the laboratories during the visit.', $2)`, [s3.id, s3.row_version]);
    expect((await t.owner<{ status: string }>(`select status::text from evc_records where id = $1`, [s3.id]))[0].status).toBe('completed');
    await expectSqlError(upload(EVC, s3.id, 19.9, 73.8), /confirmed \(scheduled\)/);
  });

  it('an assigned expert who has an account can upload the report for their session, an unassigned one cannot', async () => {
    const s2 = await evcOf(SAHYADRI_TITLE_S2);
    const user = await addUser(t, 'expert.account@aicasa-demo.test');
    const e = (await t.as<{ e: { id: string } }>(ADMIN,
      `select to_jsonb(upsert_expert(null, 'Account Expert (Demo)', '{Civil}', 'Mysuru', 'Karnataka', null, 'Test Institute', 'SR', $1, true)) as e`, [user]))[0].e;
    await t.owner(`update evc_records set scheduled_start = now() - interval '3 hours', scheduled_end = now() - interval '1 hour' where id = $1`, [s2.id]);
    await expectSqlError(upload('expert.account@aicasa-demo.test', s2.id, 12.3, 76.6, 'manual', null), /member of this EVC panel/);
    const fresh = await evcOf(SAHYADRI_TITLE_S2);
    await t.as(EVC, `select assign_evc_expert($1, $2, $3)`, [s2.id, e.id, fresh.row_version]);
    const rep = await upload('expert.account@aicasa-demo.test', s2.id, 12.3, 76.6, 'manual', null);
    expect(rep.geo_source).toBe('manual');
    expect((await t.owner<{ uploaded_by: string }>(`select uploaded_by from evc_reports where id = $1`, [rep.id]))[0].uploaded_by).toBe(user);
  });
});
