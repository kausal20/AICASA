// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { auditDetail, uniqueAudit } from '../../src/lib/auditDetail';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
vi.mock('@/services/documents', () => ({
  computeVersionFingerprint: vi.fn(async (id: string) => ({ computed: id === 'v1' ? H1 : H2, recorded: id === 'v1' ? H1 : null })),
}));
vi.mock('@/services/operations', () => ({
  compareVersions: vi.fn(async () => ({
    document: { id: 'd', title: 'Fire safety certificate', doc_type: 'fire_safety_certificate' },
    old: { id: 'v1', version: 1, file_name: 'fire_certificate_2023.pdf', mime_type: 'application/pdf', size_bytes: 2048, sha256: H1, uploaded_at: '2026-10-05T02:48:00Z', replaced_reason: null },
    new: { id: 'v2', version: 2, file_name: 'fire_certificate_2026_renewed.pdf', mime_type: 'application/pdf', size_bytes: 2100, sha256: null, uploaded_at: '2026-10-05T02:49:00Z', replaced_reason: 'Renewed' },
    identical_file: false, metadata_changes: [],
    content: { available: true, reason: null, fields: [], text_available: true, text_reason: null, old_text: 'a\nb\nc', new_text: 'a\nx\nc' },
  })),
}));

import { VersionCompare } from '@/features/documents/VersionCompare';

describe('audit entries', () => {
  const row = (over: object) => ({ id: 1, action: 'escalation_triggered', application_id: 'app-1', actor_id: null, actor_kind: 'system', created_at: '2026-10-27T09:00:00Z',
    entity_id: 'e1', detail: null, before_state: null, after_state: null, ...over }) as never;

  it('identical events collapse to one; events that differ in their state change stay', () => {
    const same = [row({ id: 1 }), row({ id: 2 })];
    expect(uniqueAudit(same)).toHaveLength(1);
    const differ = [row({ id: 1, after_state: { notices: [{ rule: 'STAGE_OVERDUE_ESCALATION', notice: 1 }] } }), row({ id: 2, after_state: { notices: [{ rule: 'EVC_OVERDUE_ESCALATION', notice: 2 }] } })];
    expect(uniqueAudit(differ)).toHaveLength(2);
    expect(uniqueAudit([row({ id: 1 }), row({ id: 1 })])).toHaveLength(1);
  });

  it('says which document, stage or notices an entry is about', () => {
    expect(auditDetail({ action: 'document_check_completed', after_state: null, detail: 'Fire safety certificate · version 2' })).toBe('Fire safety certificate · version 2');
    expect(auditDetail({ action: 'escalation_triggered', detail: null, after_state: { notices: [
      { rule: 'STAGE_OVERDUE_ESCALATION', notice: 1 }, { rule: 'STAGE_OVERDUE_ESCALATION', notice: 2 }, { rule: 'EVC_OVERDUE_ESCALATION', notice: 3 }] } }))
      .toBe('Stage overdue · notices 1, 2; EVC overdue · notice 3');
  });
});

describe('version compare', () => {
  it('shows a SHA-256 fingerprint for each version, and the two differ', async () => {
    cleanup();
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><VersionCompare oldVersionId="v1" newVersionId="v2" /></QueryClientProvider>);
    const hashes = await screen.findAllByTestId('sha256');
    await vi.waitFor(() => expect(screen.getAllByTestId('sha256')).toHaveLength(2));
    const texts = screen.getAllByTestId('sha256').map((e) => e.textContent);
    expect(texts).toEqual([H1, H2]);
    expect(texts[0]).not.toBe(texts[1]);
    expect(hashes.length).toBeGreaterThan(0);
    expect(screen.getByText(/matches the fingerprint recorded at upload/)).toBeTruthy();
  });
});
