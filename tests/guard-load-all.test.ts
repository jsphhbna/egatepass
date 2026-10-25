import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('PATCH 9: Guard Load All Pagination & Safety Ceiling', () => {
  const guardPagePath = join(__dirname, '../src/pages/GuardPage.tsx');
  const guardPageContent = readFileSync(guardPagePath, 'utf-8');

  it('9A. Does NOT increase RPC 200-row cap in database migration', () => {
    const migrationPath = join(
      __dirname,
      '../supabase/migrations/20261026040000_pass_expiration_and_operational_truth_closure.sql'
    );
    const migrationContent = readFileSync(migrationPath, 'utf-8');
    expect(migrationContent).toContain('v_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 200);');
  });

  it('9B. Replaces one-shot load-all with pagination loop (offset, pageSize=200, deduplication)', () => {
    expect(guardPageContent).toContain('const pageSize = 200;');
    expect(guardPageContent).toContain('const SAFETY_CEILING = 5000;');
    expect(guardPageContent).toContain('while (more)');
    expect(guardPageContent).toContain('fetchGuardDashboard({ limit: pageSize, offset });');
    expect(guardPageContent).toContain('offset += batch.queue.length;');
    expect(guardPageContent).toContain('!seenIds.has(item.id)');
  });

  it('9C. Enforces 5,000 pending records safety ceiling with exact message', () => {
    expect(guardPageContent).toContain('if (accumulated.length >= SAFETY_CEILING && more)');
    expect(guardPageContent).toContain('reachedCeiling = true;');
    expect(guardPageContent).toContain(
      "'Loaded the first 5,000 pending passes. Narrow the search or continue using paginated queue controls.'"
    );
    expect(guardPageContent).toContain('`Loaded all ${accumulated.length} pending passes.`');
  });

  it('9D. Simulates pagination loop: 450 passes across 3 pages load completely and deduplicate', async () => {
    // Simulate pagination algorithm exactly as implemented in GuardPage
    const mockBatches = [
      {
        queue: Array.from({ length: 200 }, (_, i) => ({ id: `pass-${i}`, name: `Visitor ${i}` })),
        pendingTotal: 450,
        hasMore: true,
      },
      {
        queue: Array.from({ length: 200 }, (_, i) => ({ id: `pass-${200 + i}`, name: `Visitor ${200 + i}` })),
        pendingTotal: 450,
        hasMore: true,
      },
      {
        queue: Array.from({ length: 50 }, (_, i) => ({ id: `pass-${400 + i}`, name: `Visitor ${400 + i}` })),
        pendingTotal: 450,
        hasMore: false,
      },
    ];

    let batchIndex = 0;
    const fetchBatchMock = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
      const b = mockBatches[batchIndex++];
      return b;
    });

    const pageSize = 200;
    const SAFETY_CEILING = 5000;
    let offset = 0;
    let more = true;
    let reachedCeiling = false;
    const accumulated: any[] = [];
    const seenIds = new Set<string>();

    while (more) {
      const batch = await fetchBatchMock({ limit: pageSize, offset });
      for (const item of batch.queue) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          accumulated.push(item);
        }
      }
      offset += batch.queue.length;
      more = batch.hasMore && batch.queue.length > 0;

      if (accumulated.length >= SAFETY_CEILING && more) {
        reachedCeiling = true;
        break;
      }
    }

    expect(fetchBatchMock).toHaveBeenCalledTimes(3);
    expect(accumulated.length).toBe(450);
    expect(reachedCeiling).toBe(false);
  });

  it('9E. Simulates safety ceiling: stops at 5,000 when queue exceeds ceiling', async () => {
    let callCount = 0;
    const fetchBatchMock = vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
      callCount++;
      return {
        queue: Array.from({ length: 200 }, (_, i) => ({ id: `pass-${offset + i}` })),
        pendingTotal: 6000,
        hasMore: true,
      };
    });

    const pageSize = 200;
    const SAFETY_CEILING = 5000;
    let offset = 0;
    let more = true;
    let reachedCeiling = false;
    const accumulated: any[] = [];
    const seenIds = new Set<string>();

    while (more) {
      const batch = await fetchBatchMock({ limit: pageSize, offset });
      for (const item of batch.queue) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          accumulated.push(item);
        }
      }
      offset += batch.queue.length;
      more = batch.hasMore && batch.queue.length > 0;

      if (accumulated.length >= SAFETY_CEILING && more) {
        reachedCeiling = true;
        break;
      }
    }

    expect(accumulated.length).toBe(5000);
    expect(reachedCeiling).toBe(true);
    expect(callCount).toBe(25); // 25 * 200 = 5000
  });
});
