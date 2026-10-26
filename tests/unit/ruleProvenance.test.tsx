// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComplianceRule } from '@/types/domain';

const base = { version: 1, status: 'active', applies_to: ['EOA'], explanation: '', retired_at: null, retired_reason: null, created_at: '2026-10-25T00:00:00Z' };
const rules = [
  { ...base, id: 'r1', code: 'student_faculty_ratio', label: 'Student-to-faculty ratio (declared figures)', kind: 'ratio_max', is_synthetic: false,
    params: { numerator: 'student_count', denominator: 'faculty_count', threshold_by_level: { ug_engg: 20, pg_engg: 15, diploma: 25 } },
    source_reference: 'AICTE Approval Process Handbook 2024–27 — Annexure 5, sections 5.1–5.3 (faculty/student ratios)' },
  { ...base, id: 'r2', code: 'faculty_cadre_ratio', label: 'Faculty cadre ratio', kind: 'cadre_ratio', is_synthetic: false,
    params: { base_field: 'approved_intake', divisor: 20, ratios: [1, 2, 6] },
    source_reference: 'AICTE Approval Process Handbook 2024–27 — Annexure 5.2, UG Engineering cadre ratio 1:2:6 plus Principal.' },
  { ...base, id: 'r3', code: 'land_area_min', label: 'Declared land area', kind: 'min', is_synthetic: true,
    params: { field: 'land_area_acres', threshold: 2.5, unit: 'acres' }, source_reference: 'Demonstration configuration' },
] as unknown as ComplianceRule[];

vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ isNational: false, can: () => false }) }));
vi.mock('@/services/admin', async (orig) => ({ ...(await orig<typeof import('@/services/admin')>()), listComplianceRules: async () => rules }));
vi.mock('@/services/applications', () => ({ getApplicationTypes: async () => [] }));

import { ComplianceRulesPanel } from '@/features/admin/ComplianceRulesPanel';

describe('rule provenance on the rules page', () => {
  it('labels handbook-sourced rules with the handbook, drops the per-row synthetic badges and shows one demonstration footnote', async () => {
    cleanup();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ComplianceRulesPanel /></QueryClientProvider>);
    const ratio = (await screen.findByText('Student-to-faculty ratio (declared figures)')).closest('tr')!;
    expect(within(ratio).getByText(/AICTE Approval Process Handbook 2024–27/)).toBeTruthy();
    const cadre = screen.getByText('Faculty cadre ratio').closest('tr')!;
    expect(within(cadre).getByText(/AICTE Approval Process Handbook 2024–27/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SYNTHETIC DEMO RULE|DEMO VALUE|Synthetic rule/);
    expect(screen.getAllByText('Demonstration values — verify against the current APH before real use.')).toHaveLength(1);
  });
});
