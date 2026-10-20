import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from '../src/lib/retentionPolicy';
import { isClosedPassStatus, isProtectedAuditAction } from '../netlify/functions/utils/retention-maintenance';

describe('retention policy compatibility', () => {
  it('uses safe defaults for old empty settings', () => {
    expect(normalizeRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it('uses legacy retentionDays only for image retention', () => {
    expect(normalizeRetentionPolicy({ retentionDays: 21 })).toEqual({ ...DEFAULT_RETENTION_POLICY, imageRetentionDays: 21 });
  });

  it.each(['issued', 'pending', 'inside'])('protects active pass state %s', (status) => {
    expect(isClosedPassStatus(status)).toBe(false);
  });

  it.each(['exited', 'rejected', 'expired'])('allows closed pass state %s', (status) => {
    expect(isClosedPassStatus(status)).toBe(true);
  });

  it.each(['initial_superadmin_bootstrapped', 'user_role_changed', 'admin_created', 'device_deleted', 'settings_updated'])('protects security audit action %s', (action) => {
    expect(isProtectedAuditAction(action)).toBe(true);
  });

  it('allows ordinary historical audit actions to expire', () => {
    expect(isProtectedAuditAction('visitor_images_purged')).toBe(false);
  });
});
