import { describe, it, expect, vi } from 'vitest';
import activityHandler from '../server/routes/admin/activity.js';

describe('Admin Activity Date Range Validation (Requirement 16 & 30)', () => {
  it('rejects invalid dateFrom format with 400 invalid_date_from', async () => {
    const req = new Request('http://localhost/api/admin/activity?dateFrom=2026-13-45', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    });

    const res = await activityHandler.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_date_from');
  });

  it('rejects invalid dateTo format with 400 invalid_date_to', async () => {
    const req = new Request('http://localhost/api/admin/activity?dateTo=not-a-date', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    });

    const res = await activityHandler.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_date_to');
  });

  it('rejects inverted date range (dateFrom > dateTo) with 400 invalid_date_range', async () => {
    const req = new Request('http://localhost/api/admin/activity?dateFrom=2026-10-30&dateTo=2026-10-01', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer test-token',
      },
    });

    const res = await activityHandler.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_date_range');
    expect(body.message).toContain('dateFrom cannot be later than dateTo');
  });
});
