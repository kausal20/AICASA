// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ApplicationRow, AuditRow, ReviewTask, WorkflowStage, WorkflowTransition } from '@/types/domain';

vi.mock('@/features/auth/AuthProvider', () => ({
  useAuth: () => ({ session: { user: { id: 'u-1' } }, workspace: 'officer', can: () => false }),
}));
vi.mock('@/services/applications', () => ({ getDirectory: async () => [{ id: 'o-1', full_name: 'Anita Deshpande (Demo)', designation: null, roles: ['officer'] }] }));

const reviewTasks: ReviewTask[] = [
  { id: 't1', application_id: 'a1', stage_history_id: 'h1', stage_code: 'scrutiny', review_code: 'land_building', name: 'Land and building documents review',
    required_capability: 'scrutiny', region_code: 'WR', assignee_id: 'o-1', status: 'in_review', outcome_note: null, due_at: null, row_version: 1,
    created_at: '2026-10-25T00:00:00Z', started_at: null, completed_at: null, completed_by: null, review_task_history: [] },
  { id: 't2', application_id: 'a1', stage_history_id: 'h1', stage_code: 'scrutiny', review_code: 'safety_compliance', name: 'Safety and compliance record review',
    required_capability: 'compliance', region_code: 'WR', assignee_id: 'o-1', status: 'pending', outcome_note: null, due_at: null, row_version: 1,
    created_at: '2026-10-25T00:00:00Z', started_at: null, completed_at: null, completed_by: null, review_task_history: [] },
];
vi.mock('@/services/operations', () => ({
  listReviewTasks: async () => reviewTasks, startReviewTask: vi.fn(), completeReviewTask: vi.fn(), reassignReviewTask: vi.fn(),
}));

const auditRows: AuditRow[] = [
  { id: 1, actor_id: 'a', actor_kind: 'user', action: 'assignment_changed', entity_type: 'application', entity_id: 'x', application_id: 'app-1', institution_id: null,
    region_code: 'WR', reason: 'Workload balancing between regional officers.', before_state: null, after_state: { officer_id: 'o-1' }, metadata: {},
    created_at: '2026-10-25T05:00:00Z', actor_name: 'Rahul Kulkarni (Demo)', application_reference: 'DEMO-WR-2026-01011' },
  { id: 2, actor_id: 'a', actor_kind: 'user', action: 'role_granted', entity_type: 'user', entity_id: 'y', application_id: null, institution_id: null,
    region_code: 'WR', reason: 'Order 14/2026 appointing the committee.', before_state: null,
    after_state: { role: 'officer', region: 'WR', capabilities: ['scrutiny', 'decision', 'compliance'] }, metadata: {},
    created_at: '2026-10-25T04:00:00Z', actor_name: 'Neha Sharma (Demo)', application_reference: null },
];
vi.mock('@/services/admin', async (orig) => ({
  ...(await orig<typeof import('@/services/admin')>()),
  listAudit: async () => ({ rows: auditRows, total: auditRows.length }),
}));

import { RESPONSIBILITY_LABELS, auditActionLabel, auditResponsibilities, REGIONAL_OFFICER_LABEL, responsibilityLabel } from '@/lib/responsibilities';
import { RouteTables } from '@/features/admin/WorkflowsPage';
import { ReviewTasksPanel } from '@/features/applications/ReviewTasksPanel';
import { CaseFacts } from '@/features/applications/ApplicationDetailPage';
import { AuditPage } from '@/features/admin/AuditPage';

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

describe('label helpers', () => {
  it('maps scrutiny and decision to the pitch names and leaves every other responsibility plain', () => {
    expect(responsibilityLabel('scrutiny')).toBe('Scrutiny Committee');
    expect(responsibilityLabel('decision')).toBe('Central AICTE Desk');
    expect(REGIONAL_OFFICER_LABEL).toBe('Regional Officer');
    expect(responsibilityLabel('compliance')).toBe('Compliance');
    expect(responsibilityLabel('evc')).toBe('Evc');
    expect(responsibilityLabel(null)).toBe('—');
  });

  it('only labels are mapped: the stored capability keys are the unchanged internal ones', () => {
    expect(Object.keys(RESPONSIBILITY_LABELS).sort()).toEqual(['decision', 'scrutiny']);
    expect(auditActionLabel('assignment_changed')).toBe('Regional Officer assignment changed');
    expect(auditActionLabel('role_granted')).toBe('Role granted');
  });

  it('finds the responsibilities recorded in an audit entry and labels them', () => {
    expect(auditResponsibilities(auditRows[1])).toEqual(['Scrutiny Committee', 'Central AICTE Desk', 'Compliance']);
    expect(auditResponsibilities(auditRows[0])).toEqual([]);
  });
});

describe('route configuration view', () => {
  const stages: WorkflowStage[] = [
    { id: 's1', version_id: 'v', code: 'scrutiny', name: 'Scrutiny', kind: 'scrutiny', sequence: 2, sla_days: 21, responsible_capability: 'scrutiny', description: '',
      reviews: [
        { code: 'land_building', name: 'Land and building documents review', required_capability: 'scrutiny', description: '', sort_order: 1 },
        { code: 'safety_compliance', name: 'Safety and compliance record review', required_capability: 'compliance', description: '', sort_order: 2 },
      ] },
    { id: 's2', version_id: 'v', code: 'decision', name: 'Decision', kind: 'decision', sequence: 3, sla_days: 10, responsible_capability: 'decision', description: '' },
  ];
  const transitions: WorkflowTransition[] = [
    { id: 'x1', version_id: 'v', code: 'scrutiny_to_decision', name: 'Forward for decision', from_stage: 'scrutiny', to_stage: 'decision', allowed_role: 'officer',
      required_capability: 'scrutiny', requires_reason: false, is_automatic: false, prerequisites: [], records_decision: false, sort_order: 1 },
    { id: 'x2', version_id: 'v', code: 'record_decision', name: 'Record decision', from_stage: 'decision', to_stage: 'closed', allowed_role: 'officer',
      required_capability: 'decision', requires_reason: true, is_automatic: false, prerequisites: [], records_decision: true, sort_order: 1 },
  ];

  it('shows Scrutiny Committee and Central AICTE Desk for the stage responsibilities, the concurrent reviews and the transition actors', () => {
    cleanup();
    wrap(<RouteTables stages={stages} transitions={transitions} />);
    const stageTable = screen.getAllByRole('table')[0];
    const rows = within(stageTable).getAllByRole('row');
    expect(within(rows[1]).getAllByText(/Scrutiny Committee/).length).toBeGreaterThanOrEqual(2); // stage responsibility + the land/building review
    expect(within(rows[1]).getByText(/Compliance/)).toBeTruthy();                                  // not renamed
    expect(within(rows[2]).getByText('Central AICTE Desk')).toBeTruthy();
    const transitionTable = screen.getAllByRole('table')[1];
    expect(within(transitionTable).getByText(/Officer · Scrutiny Committee/)).toBeTruthy();
    expect(within(transitionTable).getByText(/Officer · Central AICTE Desk/)).toBeTruthy();
    // the internal keys are still what the route stores and shows as the stage code
    expect(within(stageTable).getByText('scrutiny')).toBeTruthy();
    expect(screen.queryByText('Scrutiny responsibility')).toBeNull();
  });
});

describe('application workspace', () => {
  it('the Concurrent reviews section names the responsibility with the pitch label', async () => {
    cleanup();
    wrap(<ReviewTasksPanel applicationId="a1" />);
    expect(await screen.findByText('Concurrent reviews')).toBeTruthy();
    expect(await screen.findByText(/Scrutiny Committee · Anita Deshpande \(Demo\)/)).toBeTruthy();
    expect(screen.getByText(/Compliance · Anita Deshpande \(Demo\)/)).toBeTruthy();
    expect(screen.queryByText(/Scrutiny responsibility/)).toBeNull();
  });

  it('the case-level assignment is labelled Regional Officer, not Assigned officer', () => {
    cleanup();
    const a = { assigned_officer_name: 'Anita Deshpande (Demo)', region_code: 'WR', institution_code: 'DEMO-WR-002', route_name: 'Scrutiny with concurrent reviews',
      route_version: 1, submitted_at: '2026-10-24T00:00:00Z', age_days: 1, stage_age_days: 1, stage_name: 'Scrutiny' } as unknown as ApplicationRow;
    render(<CaseFacts a={a} />);
    expect(screen.getByText('Regional Officer')).toBeTruthy();
    expect(screen.getByText('Anita Deshpande (Demo)')).toBeTruthy();
    expect(screen.queryByText('Assigned officer')).toBeNull();
  });
});

describe('audit log', () => {
  it('labels the Regional Officer assignment change and the responsibilities recorded in an entry', async () => {
    cleanup();
    wrap(<AuditPage />);
    expect((await screen.findAllByText('Regional Officer assignment changed')).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('Responsibilities: Scrutiny Committee, Central AICTE Desk, Compliance')).toBeTruthy();
    // the audit evidence itself is unchanged: the raw state still carries the internal keys
    expect(auditRows[1].after_state).toMatchObject({ capabilities: ['scrutiny', 'decision', 'compliance'] });
  });
});
