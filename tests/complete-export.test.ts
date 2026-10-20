import { describe, expect, it, vi } from 'vitest';
import { collectCursorPages } from '../src/lib/completeExport';

describe('complete export cursor pagination', () => {
  it('collects every page until a short final page', async () => {
    const records = Array.from({ length: 11 }, (_, index) => index + 1);
    const fetchPage = vi.fn(async (cursor: number | null, pageSize: number) => {
      const start = cursor ?? 0;
      const items = records.slice(start, start + pageSize);
      return { items, nextCursor: items.length ? start + items.length : null };
    });

    const result = await collectCursorPages(fetchPage, { pageSize: 4, maxRows: 50 });
    expect(result).toEqual({ items: records, truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops at the configured safety limit and reports truncation', async () => {
    const fetchPage = vi.fn(async (cursor: number | null, pageSize: number) => {
      const start = cursor ?? 0;
      const items = Array.from({ length: pageSize }, (_, index) => start + index);
      return { items, nextCursor: start + items.length };
    });

    const result = await collectCursorPages(fetchPage, { pageSize: 3, maxRows: 7 });
    expect(result.items).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
