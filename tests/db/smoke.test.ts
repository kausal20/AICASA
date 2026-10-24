import { describe, expect, it } from 'vitest';
import { createTestDb } from './harness';

describe('migrations and seed', () => {
  it('apply cleanly and produce the demo scenario', async () => {
    const t = await createTestDb();
    const rows = await t.owner<{ reference: string; status: string; current_stage: string }>(
      `select reference, status, current_stage from applications order by reference`,
    );
    expect(rows.length).toBe(11);
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses).toContain('draft');
    expect(statuses).toContain('returned_for_correction');
    expect(statuses).toContain('correction_submitted');
    expect(statuses).toContain('completed');
    expect(statuses).toContain('evc_scheduled');
    expect(statuses).toContain('committee_review');
    const scan = await t.owner<{ status: string; stats: Record<string, number> }>(
      `select status, stats from scheduled_job_runs order by started_at desc limit 1`,
    );
    expect(scan[0].status).toBe('succeeded');
    expect(scan[0].stats.escalations).toBeGreaterThan(0);
  });
});
