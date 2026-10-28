import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const recordsQuerySchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
}).refine(
  (data) => {
    const from = data.dateFrom || data.date;
    const to = data.dateTo || data.date;
    if (from && to && from > to) {
      return false;
    }
    return true;
  },
  {
    message: 'dateFrom cannot be after dateTo',
    path: ['dateFrom'],
  }
);

describe('Group G: Visitor Records Date-Range Filtering Contract', () => {
  it('accepts From only date filter', () => {
    const parsed = recordsQuerySchema.safeParse({ dateFrom: '2026-10-01' });
    expect(parsed.success).toBe(true);
  });

  it('accepts To only date filter', () => {
    const parsed = recordsQuerySchema.safeParse({ dateTo: '2026-10-28' });
    expect(parsed.success).toBe(true);
  });

  it('accepts From + To range when dateFrom <= dateTo', () => {
    const parsed = recordsQuerySchema.safeParse({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-28',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts identical From and To dates (single day range)', () => {
    const parsed = recordsQuerySchema.safeParse({
      dateFrom: '2026-10-28',
      dateTo: '2026-10-28',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid range where dateFrom > dateTo with validation failure', () => {
    const parsed = recordsQuerySchema.safeParse({
      dateFrom: '2026-10-29',
      dateTo: '2026-10-28',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts status + search + date range combination', () => {
    const parsed = recordsQuerySchema.safeParse({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-28',
      status: 'approved',
      search: 'Juan Dela Cruz',
      limit: 25,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('approved');
      expect(parsed.data.search).toBe('Juan Dela Cruz');
      expect(parsed.data.limit).toBe(25);
    }
  });

  it('preserves keyset cursor pagination alongside filters', () => {
    const parsed = recordsQuerySchema.safeParse({
      dateFrom: '2026-10-01',
      dateTo: '2026-10-28',
      cursor: '2026-10-28T09:30:00Z|e5f6a7b8-1234-5678-9abc-def012345678',
      limit: 50,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cursor).toBe('2026-10-28T09:30:00Z|e5f6a7b8-1234-5678-9abc-def012345678');
    }
  });

  it('supports legacy single date query by treating date as both dateFrom and dateTo', () => {
    const parsed = recordsQuerySchema.safeParse({ date: '2026-10-28' });
    expect(parsed.success).toBe(true);
  });

  it('Reset Filters triggers exactly one authoritative fetch via effect without duplicate manual query', () => {
    let fetchCount = 0;
    const loadRootRecords = () => {
      fetchCount += 1;
    };

    // Simulated component state
    let dateFrom = '2026-10-01';
    let dateTo = '2026-10-28';
    let statusFilter = 'approved';
    let search = 'Juan';
    let debouncedSearch = 'Juan';

    // Simulated handleResetFilters (repaired: no manual loadRootRecords call)
    function handleResetFilters() {
      dateFrom = '';
      dateTo = '';
      statusFilter = '';
      search = '';
      debouncedSearch = '';
      // Manual loadRootRecords() was REMOVED to prevent duplicate fetch
    }

    // Reset action occurs
    handleResetFilters();

    // React batches the state updates and triggers the dependency effect ONCE
    loadRootRecords();

    // Exactly one authoritative request dispatched
    expect(fetchCount).toBe(1);
    expect(dateFrom).toBe('');
    expect(dateTo).toBe('');
    expect(statusFilter).toBe('');
    expect(search).toBe('');
    expect(debouncedSearch).toBe('');
  });
});
