import { describe, expect, it } from 'vitest';
import { calendarDaysUntil, codeLabel, dueState, fmtDate, fmtDateTime, plainText, plural, relativeDay, relativeDue, verb } from '../../src/lib/format';
import { queryState, windowKind, WINDOWS_EXPLAINED } from '../../src/lib/queries';
import { officerCaseState } from '../../src/lib/caseState';
import { onePerCase, type WorkItem } from '../../src/lib/workQueue';
import { formatRemaining } from '../../src/lib/queryWindow';
import { summaryLine } from '../../src/features/documents/PrecheckPanel';
import { cadenceText } from '../../src/features/escalations/EscalationsPage';
import type { ApplicationRow, AvailableTransition, Deficiency, FindingOutcome } from '../../src/types/domain';

// 27 Oct 2026, 1:20 PM IST
const NOW = new Date('2026-10-27T07:50:00Z');

describe('one date format and one day-difference rule', () => {
  it('formats every date and time the same way', () => {
    expect(fmtDateTime('2026-10-27T07:50:00Z')).toBe('27 Oct 2026, 1:20 PM IST');
    expect(fmtDateTime('2026-10-26 08:30:00+00')).toBe('26 Oct 2026, 2:00 PM IST');
    expect(fmtDate('2026-11-01')).toBe('1 Nov 2026');
    expect(fmtDate('2026-11-01T18:29:59Z')).toBe('1 Nov 2026');
  });

  it('counts IST calendar days, so the same date gives the same number on every page', () => {
    expect(calendarDaysUntil('2026-10-13', NOW)).toBe(-14);
    expect(calendarDaysUntil('2026-12-07', NOW)).toBe(41);
    expect(calendarDaysUntil('2026-11-01', NOW)).toBe(5);
    expect(calendarDaysUntil('2026-10-27T18:29:59Z', NOW)).toBe(0); // 23:59:59 IST today
    expect(calendarDaysUntil('2026-10-27T18:30:00Z', NOW)).toBe(1); // 00:00 IST tomorrow
    // Compliance (deadline), Obligations (deadline) and Document validity (event) agree on the number
    expect(relativeDue('2026-10-13', NOW)).toBe('14 days overdue');
    expect(relativeDay('2026-10-13', NOW)).toBe('14 days ago');
    expect(relativeDue('2026-12-07', NOW)).toBe('41 days left');
    expect(relativeDay('2026-12-07', NOW)).toBe('in 41 days');
    expect(relativeDue('2026-11-01', NOW)).toBe('5 days left');
  });

  it('due today is never overdue; overdue means the due date has ended', () => {
    expect(dueState('2026-10-27T02:48:36Z', NOW)).toBe('today'); // due 8:18 AM IST today, now 1:20 PM
    expect(relativeDue('2026-10-27T02:48:36Z', NOW)).toBe('Due today');
    expect(dueState('2026-10-26T18:29:59Z', NOW)).toBe('overdue');
    expect(relativeDue('2026-10-26', NOW)).toBe('1 day overdue');
  });
});

describe('pluralisation and plain language', () => {
  it('pluralises every count-driven phrase', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(2, 'day')).toBe('2 days');
    expect(`${plural(1, 'item')} ${verb(1, 'needs', 'need')} your judgement`).toBe('1 item needs your judgement');
    expect(`${plural(3, 'item')} ${verb(3, 'needs', 'need')} your judgement`).toBe('3 items need your judgement');
    expect(plural(1, 'query', 'queries')).toBe('1 query');
    expect(relativeDay('2026-10-26', NOW)).toBe('1 day ago');
  });

  it('turns codes, ISO timestamps and day-first dates into words', () => {
    expect(plainText('Target 1:20 (ug_engg)')).toBe('Target 1:20 (UG Engineering)');
    expect(plainText('ceil(student_count ÷ 4)')).toBe('ceil(students ÷ 4)');
    expect(plainText('Run at 2026-10-26 08:30:00+00')).toBe('Run at 26 Oct 2026, 2:00 PM IST');
    expect(plainText('Date of issue: 05/01/2026')).toBe('Date of issue: 5 Jan 2026');
    expect(plainText('file_type rejected')).toBe('File type rejected');
    expect(codeLabel('STAGE_OVERDUE_ESCALATION')).toBe('Stage overdue');
    expect(codeLabel('EVC_OVERDUE_ESCALATION')).toBe('EVC overdue');
    expect(codeLabel('land_lease_deed')).toBe('Land lease deed');
    expect(plainText('Matrix rule not met')).not.toMatch(/\b[a-z]+_[a-z_]+\b|[A-Z]+_[A-Z_]+/);
  });
});

const def = (over: Partial<Deficiency>): Deficiency => ({
  id: 'd1', application_id: 'a1', stage_code: 'scrutiny', title: 't', reason: 'r', requirement_source: 's', requested_correction: 'c', doc_type: null,
  responsible_party: 'institution', due_at: '2026-11-01T18:29:59Z', status: 'open', raised_by: null, raised_at: '2026-10-25T00:00:00Z', resolved_at: null,
  row_version: 1, window_opens_at: null, window_closes_at: null, window_reopen_count: 0, auto_generated: true, rule_id: null, rule_code: null, rule_version: null,
  affected_document_version_id: null, affected_version_basis: null, sent_at: null, sent_by: null, ...over,
} as Deficiency);

describe('a query under "Needs your response" can always be answered', () => {
  it('only queries sent on a returned case need a response; unsent ones are with AICTE', () => {
    expect(queryState(def({ sent_at: '2026-10-25T00:00:00Z', applications: { status: 'returned_for_correction' } as never }))).toBe('needs_response');
    expect(queryState(def({ sent_at: null, applications: { status: 'under_scrutiny' } as never }))).toBe('with_aicte');
    expect(queryState(def({ status: 'correction_submitted' }))).toBe('with_officer');
    expect(queryState(def({ status: 'resolved' }))).toBe('closed');
  });

  it('tells the two response windows apart and explains both in one sentence', () => {
    expect(windowKind(def({ window_closes_at: '2026-10-29T00:00:00Z' }))).toBe('query_window');
    expect(windowKind(def({}))).toBe('correction_period');
    expect(WINDOWS_EXPLAINED).toBe('Officer queries: respond within 48 hours. Deficiency corrections: due date shown on each item (typically 7 days).');
    expect(formatRemaining((37 * 60 + 12) * 60_000)).toBe('37h 12m left');
    expect(formatRemaining(48 * 3_600_000)).toBe('48h 00m left');
    expect(formatRemaining((5 * 24 + 3) * 3_600_000 + 60_000)).toBe('5d 03h left');
  });
});

describe('the officer case view never contradicts itself', () => {
  const row = { status: 'under_scrutiny', stage_kind: 'scrutiny' } as ApplicationRow;
  const blocked = [{ code: 'scrutiny_to_decision', name: 'Forward for decision', permitted: false, blocked_reason: 'All deficiencies must be resolved before this action.' }] as AvailableTransition[];
  it('with a raise-query action available, it never says there is nothing to do', () => {
    const s = officerCaseState(row, blocked, [def({})], true);
    expect(s.hasAction).toBe(true);
    expect(s.canRaiseQuery).toBe(true);
    expect(s.returnCount).toBe(1);
    expect(s.headline).not.toMatch(/Nothing for you to do/);
  });
  it('an officer without the stage responsibility gets no actions at all', () => {
    const s = officerCaseState(row, blocked, [def({ status: 'correction_submitted' })], false);
    expect(s).toMatchObject({ hasAction: false, canRaiseQuery: false, returnCount: 0, reviewCount: 0, routing: [] });
  });
});

describe('lists and summaries', () => {
  it('a case appears once in an action queue, with its most urgent item', () => {
    const items: WorkItem[] = [
      { id: 'app-1', caseId: '1', title: 'Case 1', detail: '', to: '', date: '2026-10-20', kind: 'Application' },
      { id: 'task-a', caseId: '1', title: 'Task on case 1', detail: '', to: '', date: '2026-10-22', kind: 'Task' },
      { id: 'task-b', caseId: '1', title: 'Another task on case 1', detail: '', to: '', date: '2026-10-25', kind: 'Task' },
      { id: 'obl-1', caseId: null, title: 'Obligation', detail: '', to: '', date: '2026-10-21', kind: 'Compliance obligation' },
    ];
    expect(onePerCase(items).map((i) => i.id)).toEqual(['app-1', 'obl-1']);
  });
  it('pre-check results open with a one-line summary', () => {
    const findings: { outcome: FindingOutcome }[] = [...Array(8)].map(() => ({ outcome: 'passed' as FindingOutcome }));
    findings.push({ outcome: 'potential_issue' }, { outcome: 'missing_information' });
    expect(summaryLine(findings))
      .toBe('8 checks passed · 2 to review');
  });
  it('the escalation cadence text is built from the rule the scanner uses', () => {
    expect(cadenceText({ rule_offset_hours: 24, rule_repeat_interval_hours: 72, rule_max_repeats: 3, entity_type: 'evc_schedule' }))
      .toBe('First notice 24 hours after the end of the due date (11:59 PM IST), then every 72 hours, up to 3 notices.');
  });
});
