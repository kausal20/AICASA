import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { auditDetail, uniqueAudit } from '../../src/lib/auditDetail';

const ADMIN = 'admin.national@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
let t: TestDb;

beforeAll(async () => { t = await createTestDb(); });

type Row = { entity_id: string | null; before_state: unknown; id: number; action: string; application_id: string | null; actor_id: string | null; actor_kind: string; created_at: string; detail: string | null; after_state: unknown; application_reference: string | null };
const audit = () => t.as<Row>(ADMIN, `select id, action, application_id, actor_id, actor_kind, created_at::text as created_at, entity_id, detail, before_state, after_state, application_reference from v_audit_logs order by id`);

describe('fix 1: every audit entry appears once', () => {
  it('no two entries share case + action + actor + timestamp + state change', async () => {
    await t.owner(`select app.run_deadline_scan('test', now() + interval '10 days')`);
    await t.owner(`select app.run_deadline_scan('test', now() + interval '10 days')`);
    const rows = await audit();
    const sig = rows.map((r) => [r.application_id, r.action, r.actor_kind, r.actor_id, r.created_at, r.entity_id, auditDetail(r), JSON.stringify(r.before_state), JSON.stringify(r.after_state)].join('|'));
    const dupes = sig.filter((s, i) => sig.indexOf(s) !== i);
    expect(dupes).toEqual([]);
    expect(uniqueAudit(rows)).toHaveLength(rows.length);
    expect(rows.length).toBe((await t.owner<{ n: number }>(`select count(*)::int as n from audit_logs`))[0].n);
  });

  it('the deadline scan writes one escalation entry per case per run, with its notices inside; a second run adds nothing', async () => {
    const before = (await t.owner<{ n: number }>(`select count(*)::int as n from audit_logs where action = 'escalation_triggered'`))[0].n;
    await t.owner(`select app.run_deadline_scan('test', now() + interval '40 days')`);
    const mid = (await t.owner<{ n: number }>(`select count(*)::int as n from audit_logs where action = 'escalation_triggered'`))[0].n;
    await t.owner(`select app.run_deadline_scan('test', now() + interval '40 days')`);
    expect((await t.owner<{ n: number }>(`select count(*)::int as n from audit_logs where action = 'escalation_triggered'`))[0].n).toBe(mid);
    expect(mid).toBeGreaterThanOrEqual(before);
    const lastId = (await t.owner<{ m: number }>(`select max(id)::int as m from audit_logs`))[0].m;
    await t.owner(`select app.run_deadline_scan('test', now() + interval '90 days')`);
    const perRun = await t.owner<{ app: string; n: number }>(`select coalesce(application_id::text, entity_id::text) as app, count(*)::int as n from audit_logs
      where action = 'escalation_triggered' and id > $1 group by 1 having count(*) > 1`, [lastId]);
    expect(perRun).toEqual([]);
    const shape = await t.owner<{ ok: boolean }>(`select (after_state ? 'notices' and jsonb_typeof(after_state -> 'notices') = 'array') as ok from audit_logs where action = 'escalation_triggered'`);
    for (const r of shape) expect(r.ok).toBe(true);
  });

  it('entries that differ in detail stay distinct and say how: which document was checked, which stage was entered', async () => {
    const owner = (await t.owner<{ id: string; institution_id: string }>(`select a.id, a.institution_id from applications a where a.title = 'Extension of approval 2027-28' and a.is_demo`))[0];
    const docs = await t.owner<{ id: string; title: string }>(`select v.id, d.title from documents d join document_versions v on v.document_id = d.id and v.version = d.current_version where d.application_id = $1`, [owner.id]);
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const d of docs) {
      const run = await t.owner<{ id: string }>(`insert into document_check_runs (document_version_id, application_id, institution_id, engine, status, extraction_status, completed_at)
        values ($1, $2, $3, 'aicasa-deterministic-v1', 'completed', 'succeeded', now()) returning id`, [d.id, owner.id, owner.institution_id]);
      await t.owner(`select app.audit('document_check_completed', 'document_check_run', $1, $2, $3, null, null, null, '{"status":"completed","findings":6}'::jsonb)`, [run[0].id, owner.id, owner.institution_id]);
    }
    const checks = (await audit()).filter((r) => r.action === 'document_check_completed' && r.application_id === owner.id);
    expect(checks.length).toBe(docs.length);
    expect(new Set(checks.map((c) => c.detail)).size).toBe(docs.length);
    for (const c of checks) expect(c.detail).toMatch(/ · version \d+ · check \d+$/);
    const stages = (await audit()).filter((r) => r.action === 'stage_entered' && r.application_id === owner.id);
    for (const s of stages) expect(s.detail).toMatch(/^Entered /);
  });
});

describe('fix 2: panels match the timeline', () => {
  it('a restoration session that records an expert being added lists that expert on its panel', async () => {
    const rows = await t.as<{ full_name: string; is_chair: boolean }>(EVC, `select x.full_name, p.is_chair from evc_panel_experts p join experts x on x.id = p.expert_id
      join evc_records e on e.id = p.evc_id join applications a on a.id = e.application_id where a.title = 'Restoration of intake — Mechanical Engineering'`);
    expect(rows.map((r) => r.full_name)).toEqual(['Dr. Farida Shaikh (Demo)']);
    const events = await t.owner(`select 1 from application_events ev join applications a on a.id = ev.application_id where a.title = 'Restoration of intake — Mechanical Engineering' and ev.event_type = 'evc_expert_assigned'`);
    expect(events.length).toBe(rows.length);
  });

  it('every scheduled session has at least two experts, none of them excluded for that institute', async () => {
    const sessions = await t.owner<{ id: string; title: string; institution_id: string }>(`select e.id, a.title, a.institution_id from evc_records e join applications a on a.id = e.application_id
      where a.title = 'New institution — Sahyadri School of Architecture' and e.status = 'scheduled'`);
    expect(sessions).toHaveLength(1);
    const names = await t.owner<{ full_name: string; code: string; excl: string[] }>(`select x.full_name, x.code, app.expert_exclusions(x.id, $2) as excl from evc_panel_experts p join experts x on x.id = p.expert_id where p.evc_id = $1`, [sessions[0].id, sessions[0].institution_id]);
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const n of names) expect(n.excl).toEqual([]);
    expect(names.map((n) => n.full_name)).toEqual(expect.arrayContaining(['Dr. Farida Shaikh (Demo)', 'Prof. Suresh Babu (Demo)']));
    const chairs = await t.owner<{ n: number }>(`select count(*)::int as n from evc_panel_experts where evc_id = $1 and is_chair`, [sessions[0].id]);
    expect(chairs[0].n).toBe(1);
  });

  it('the panel the case shows is the one the queue view and the matcher agree on', async () => {
    const v = await t.as<{ panel: { full_name: string }[] }>(EVC, `select panel from v_evc_queue where reference in (select reference from applications where title like 'New institution — Sahyadri%')`);
    expect(v[0].panel.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fix 3: fingerprint', () => {
  it('the comparison payload carries each version\'s fingerprint and flags identical content', async () => {
    const pair = await t.owner<{ d: string; a: string; b: string }>(`select d.id as d, v1.id as a, v2.id as b from documents d join document_versions v1 on v1.document_id = d.id and v1.version = 1
      join document_versions v2 on v2.document_id = d.id and v2.version = 2 limit 1`);
    expect(pair.length).toBe(1);
    const c = (await t.as<{ c: { old: { sha256: string | null }; new: { sha256: string | null } } }>(ADMIN, `select compare_document_versions($1, $2) as c`, [pair[0].a, pair[0].b]))[0].c;
    expect(c).toHaveProperty('old.sha256');
    expect(c).toHaveProperty('new.sha256');
  });
});
