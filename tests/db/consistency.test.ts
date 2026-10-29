import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const NIRMALA = 'inst.nirmala@aicasa-demo.test';
const SCRUTINY = 'officer.wr.scrutiny@aicasa-demo.test';
const EVC = 'officer.wr.evc@aicasa-demo.test';
const ADMIN = 'admin.national@aicasa-demo.test';
const N2 = 'Extension of approval with intake increase 2027-28';
const CADRE = 'Extension of approval — faculty cadre review (demo)';

let t: TestDb;
let nirmala: string;
const caseId = async (title: string) => (await t.owner<{ id: string }>(`select id from applications where title = $1 and is_demo`, [title]))[0].id;
type Q = { id: string; title: string; status: string; sent_at: string | null; doc_type: string | null; application_id: string };

beforeAll(async () => {
  t = await createTestDb();
  nirmala = (await t.owner<{ id: string }>(`select id from institutions where code = 'DEMO-WR-001'`))[0].id;
});

describe('fix 1: the institution correction loop', () => {
  it('the live Nirmala rule queries are sent to the institution, each with a notification linking to its card', async () => {
    const qs = await t.owner<Q & { reference: string; app_status: string }>(`select d.id, d.title, d.status, d.sent_at, d.doc_type, d.application_id, a.reference, a.status as app_status
      from deficiencies d join applications a on a.id = d.application_id where a.title in ($1, $2) and d.auto_generated and d.status = 'open'`, [N2, CADRE]);
    expect(qs.map((q) => q.title).sort()).toEqual([
      'Matrix rule not met: Declared land area', 'Matrix rule not met: Faculty cadre ratio', 'Matrix rule not met: Student-to-faculty ratio (declared figures)']);
    for (const q of qs) {
      expect(q.app_status).toBe('returned_for_correction');
      expect(q.sent_at).not.toBeNull();
      const n = await t.as<{ title: string; link: string }>(NIRMALA, `select title, link from notifications where entity_type = 'deficiency' and entity_id = $1`, [q.id]);
      expect(n).toHaveLength(1);
      expect(n[0].title).toBe(`Query to answer: ${q.reference}`);
      expect(n[0].link).toBe(`/app/applications/${q.application_id}?tab=deficiencies&query=${q.id}`);
    }
    // the sidebar / dashboard source agrees with the list of answerable queries
    const answerable = (await t.as(NIRMALA, `select 1 from deficiencies d join applications a on a.id = d.application_id
      where a.institution_id = $1 and a.status = 'returned_for_correction' and d.sent_at is not null and d.status in ('open','still_deficient','needs_clarification')`, [nirmala])).length;
    const badge = (await t.as<{ n: number }>(NIRMALA, `select coalesce(sum(queries_awaiting_institution), 0)::int as n from v_applications where institution_id = $1`, [nirmala]))[0].n;
    expect(badge).toBe(answerable);
    expect(badge).toBeGreaterThanOrEqual(3);
  });

  it('a query raised on a case that is already returned is sent at once; one still with AICTE is not', async () => {
    const cadre = await caseId(CADRE);
    const d = (await t.as<{ d: Q }>(SCRUTINY, `select to_jsonb(raise_deficiency($1, 'Principal appointment letter', 'The appointment letter of the Principal is not on file.', 'Checklist EOA', 'Upload the appointment letter of the Principal.', null, now() + interval '5 days')) as d`, [cadre]))[0].d;
    const row = (await t.owner<Q>(`select sent_at from deficiencies where id = $1`, [d.id]))[0];
    expect(row.sent_at).not.toBeNull();
    const unsent = await t.owner<Q>(`select d.sent_at from deficiencies d join applications a on a.id = d.application_id where a.status <> 'returned_for_correction' and d.status = 'open'`);
    for (const u of unsent) expect(u.sent_at).toBeNull();
  });

  it('answering with a reply and a corrected document creates a new version, notifies the officer, and the officer can resolve or follow up', async () => {
    const n2 = await caseId(N2);
    const q = (await t.owner<Q>(`select id from deficiencies where application_id = $1 and title = 'Matrix rule not met: Declared land area'`, [n2]))[0];
    const path = `${nirmala}/${crypto.randomUUID()}.pdf`;
    await t.owner(`insert into storage.objects (bucket_id, name, metadata) values ('institution-documents', $1, $2)`, [path, JSON.stringify({ size: 4096, mimetype: 'application/pdf' })]);
    const v = (await t.as<{ v: { id: string; version: number } }>(NIRMALA,
      `select to_jsonb(register_document_version($1, $2, 'supporting_evidence', 'Supporting evidence', $3, 'land_record.pdf', $4, null)) as v`, [nirmala, n2, path, 'e'.repeat(64)]))[0].v;
    await t.as(NIRMALA, `select submit_deficiency_correction($1, '', $2)`, [q.id, v.id]);
    const after = (await t.owner<{ status: string }>(`select status from deficiencies where id = $1`, [q.id]))[0];
    expect(after.status).toBe('correction_submitted');
    const sub = (await t.owner<{ response_text: string }>(`select response_text from deficiency_submissions where deficiency_id = $1`, [q.id]))[0];
    expect(sub.response_text).toMatch(/Corrected document uploaded/);
    const officer = (await t.owner<{ assigned_officer_id: string }>(`select assigned_officer_id from applications where id = $1`, [n2]))[0].assigned_officer_id;
    const note = await t.owner<{ title: string }>(`select title from notifications where recipient_id = $1 and entity_id = $2 and kind = 'correction_received'`, [officer, q.id]);
    expect(note).toHaveLength(1);
    const task = await t.owner<{ assignee_id: string }>(`select assignee_id from tasks where deficiency_id = $1 and task_type = 'deficiency_review'`, [q.id]);
    expect(task[0].assignee_id).toBe(officer);
    // the case still has other queries to answer, and says so
    const app = (await t.owner<{ status: string; next_action: string }>(`select status, next_action from applications where id = $1`, [n2]))[0];
    expect(app.status).toBe('returned_for_correction');
    expect(app.next_action).toMatch(/awaiting officer re-review/);
    // nothing at all cannot be submitted
    const other = (await t.owner<Q>(`select id from deficiencies where application_id = $1 and title like 'Matrix rule not met: Student%'`, [n2]))[0];
    await expect(t.as(NIRMALA, `select submit_deficiency_correction($1, '', null)`, [other.id])).rejects.toThrow(/reply or upload/);
  });
});

describe('fix 2: one date-only deadline policy', () => {
  it('due today is never overdue; due yesterday is', async () => {
    const id = await caseId('Extension of approval — computing capacity review (demo)');
    await t.owner(`update applications set stage_due_at = app.end_of_day(app.today_ist()) - interval '20 hours' where id = $1`, [id]);
    let r = (await t.owner<{ is_overdue: boolean; is_due_today: boolean }>(`select is_overdue, is_due_today from v_applications where id = $1`, [id]))[0];
    expect(r).toEqual({ is_overdue: false, is_due_today: true });
    await t.owner(`update applications set stage_due_at = app.end_of_day(app.today_ist() - 1) where id = $1`, [id]);
    r = (await t.owner<{ is_overdue: boolean; is_due_today: boolean }>(`select is_overdue, is_due_today from v_applications where id = $1`, [id]))[0];
    expect(r).toEqual({ is_overdue: true, is_due_today: false });
  });

  it('obligations and document validity count days between IST calendar dates', async () => {
    const o = await t.owner<{ due: string; days: number }>(`select app.ist_date(due_at)::text as due, days_to_due as days from v_obligations limit 3`);
    const today = (await t.owner<{ d: string }>(`select app.today_ist()::text as d`))[0].d;
    for (const x of o) expect(x.days).toBe(Math.round((Date.parse(x.due) - Date.parse(today)) / 86_400_000));
    const v = await t.owner<{ e: string; days: number }>(`select expiry_date::text as e, days_to_expiry as days from v_document_validity`);
    for (const x of v) expect(x.days).toBe(Math.round((Date.parse(x.e) - Date.parse(today)) / 86_400_000));
  });

  it('"With institution" never includes drafts', async () => {
    const drafts = (await t.owner<{ n: number }>(`select count(*)::int as n from applications where status = 'draft'`))[0].n;
    expect(drafts).toBeGreaterThan(0);
    const s = (await t.as<{ s: { totals: { awaiting_institution: number } } }>(ADMIN, `select analytics_summary(null) as s`))[0].s;
    const returned = (await t.as(ADMIN, `select 1 from v_applications where status = 'returned_for_correction'`)).length;
    expect(s.totals.awaiting_institution).toBe(returned);
  });
});

describe('fix 3: escalations', () => {
  it('one escalation per case + rule; repeat notices are its timeline and follow the rule cadence; re-running adds nothing', async () => {
    await t.owner(`select app.run_deadline_scan('test', now() + interval '10 days')`);
    const before = (await t.owner<{ n: number }>(`select count(*)::int as n from escalation_events`))[0].n;
    await t.owner(`select app.run_deadline_scan('test', now() + interval '10 days')`);
    expect((await t.owner<{ n: number }>(`select count(*)::int as n from escalation_events`))[0].n).toBe(before);
    const rows = await t.as<{ rule_id: string; entity_id: string; due_at: string; notice_count: number; notices: { notice: number; scheduled_at: string }[]; rule_offset_hours: number; rule_repeat_interval_hours: number | null; entity_type: string }>(ADMIN,
      `select rule_id, entity_id, due_at, notice_count, notices, rule_offset_hours, rule_repeat_interval_hours, entity_type from v_escalations`);
    expect(rows.length).toBeGreaterThan(0);
    const keys = rows.map((r) => `${r.rule_id}:${r.entity_id}:${r.due_at}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of rows.filter((x) => x.entity_type !== 'deficiency_window')) {
      const eod = (await t.owner<{ e: string }>(`select app.end_of_day(app.ist_date($1::timestamptz)) as e`, [r.due_at]))[0].e;
      r.notices.forEach((n, i) => {
        expect(n.notice).toBe(i + 1);
        expect(Date.parse(n.scheduled_at)).toBe(Date.parse(eod) + (r.rule_offset_hours + (r.rule_repeat_interval_hours ?? 0) * i) * 3_600_000);
      });
      expect(r.notice_count).toBe(r.notices.length);
    }
  });

  it('a case due today is not escalated as overdue', async () => {
    const id = await caseId('Extension of approval — computing capacity review (demo)');
    await t.owner(`update applications set stage_due_at = app.end_of_day(app.today_ist()) - interval '20 hours' where id = $1`, [id]);
    await t.owner(`select app.run_deadline_scan('test')`);
    const e = await t.owner(`select 1 from escalation_events e join escalation_rules r on r.id = e.rule_id where r.code = 'STAGE_OVERDUE_ESCALATION' and e.entity_id = $1 and e.withdrawn_reason is null and e.due_at = (select stage_due_at from applications where id = $1)`, [id]);
    expect(e).toHaveLength(0);
  });

  it('acknowledging an escalation acknowledges all of its notices; several can be acknowledged at once', async () => {
    const open = await t.as<{ id: string }>(ADMIN, `select id from v_escalations where status = 'open'`);
    expect(open.length).toBeGreaterThan(1);
    const n = (await t.as<{ n: number }>(ADMIN, `select acknowledge_escalations($1, 'Seen in the weekly review') as n`, [open.map((o) => o.id)]))[0].n;
    expect(n).toBe(open.length);
    expect((await t.owner(`select 1 from escalation_events where status = 'open' and withdrawn_reason is null`))).toHaveLength(0);
  });

  it('automatic events are attributed to System, never to the user whose action triggered them', async () => {
    const auto = await t.owner<{ actor_kind: string; actor_id: string | null }>(`select actor_kind, actor_id from audit_logs where action in ('deficiency_auto_raised', 'escalation_triggered')`);
    expect(auto.length).toBeGreaterThan(0);
    for (const a of auto) expect(a).toEqual({ actor_kind: 'system', actor_id: null });
    const autoStage = await t.owner<{ actor_kind: string }>(`select l.actor_kind from audit_logs l join workflow_transitions w on w.code = l.metadata ->> 'via' and w.is_automatic where l.action = 'stage_entered'`);
    for (const a of autoStage) expect(a.actor_kind).toBe('system');
  });
});

describe('fix 4 and 9: eligibility, panels and one session time', () => {
  it('reassignment on a WR scrutiny stage offers only officers who hold Scrutiny in WR', async () => {
    const id = await caseId('Extension of approval — computing capacity review (demo)');
    const rows = await t.as<{ full_name: string }>(ADMIN, `select full_name from eligible_case_officers($1)`, [id]);
    expect(rows.map((r) => r.full_name)).toEqual(['Anita Deshpande (Demo)']);
  });

  it('the EVC "next action" follows the stored session time, and a panel records its chair', async () => {
    const e = (await t.owner<{ id: string; application_id: string; scheduled_start: string }>(`select e.id, e.application_id, e.scheduled_start from evc_records e
      join applications a on a.id = e.application_id where e.status = 'scheduled' and a.region_code = 'WR' limit 1`))[0];
    await t.owner(`update evc_records set scheduled_start = scheduled_start + interval '1 day', scheduled_end = scheduled_end + interval '1 day' where id = $1`, [e.id]);
    const next = (await t.owner<{ next_action: string; s: string }>(`select a.next_action, to_char(e.scheduled_start at time zone 'Asia/Kolkata', 'DD Mon YYYY') as s
      from applications a join evc_records e on e.application_id = a.id where e.id = $1`, [e.id]))[0];
    expect(next.next_action).toContain(next.s);
    // the seeded session already has a panel; naming another member chair moves the chair mark
    const members = await t.owner<{ expert_id: string }>(`select expert_id from evc_panel_experts where evc_id = $1 order by assigned_at, expert_id`, [e.id]);
    expect(members.length).toBeGreaterThan(0);
    const pick = members[members.length - 1].expert_id;
    await t.as(EVC, `select set_evc_panel_chair($1, $2)`, [e.id, pick]);
    const panel = (await t.as<{ panel: { expert_id: string; is_chair: boolean }[] }>(EVC, `select panel from v_evc_queue where id = $1`, [e.id]))[0].panel;
    expect(panel.filter((p) => p.is_chair).map((p) => p.expert_id)).toEqual([pick]);
    expect(panel[0].is_chair).toBe(true); // chair listed first
  });
});

describe('fix 2e: notifications show live dates', () => {
  it('copied due dates are removed from notification text and the live due date comes from the record', async () => {
    const o = (await t.owner<{ id: string; recipient: string }>(`select o.id, n.recipient_id as recipient from compliance_obligations o join notifications n on n.entity_id = o.id limit 1`))[0];
    const n = (await t.owner<{ body: string; subject_due_at: string; due: string }>(`select n.body, n.subject_due_at, o.due_at as due from v_notifications n join compliance_obligations o on o.id = n.entity_id where n.entity_id = $1 limit 1`, [o.id]))[0];
    expect(n.body).not.toMatch(/\d{2} [A-Z][a-z]{2} \d{4}/);
    expect(Date.parse(n.subject_due_at)).toBe(Date.parse(n.due));
  });
});
