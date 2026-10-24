import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from '../src/lib/retentionPolicy';
import {
  isClosedPassStatus,
  isProtectedAuditAction,
  PROTECTED_AUDIT_ACTIONS,
} from '../server/routes/admin/retention-maintenance.js';

describe('retention policy compatibility', () => {
  it('uses safe defaults for old empty settings', () => {
    expect(normalizeRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it('uses legacy retentionDays only for image retention', () => {
    expect(normalizeRetentionPolicy({ retentionDays: 21 })).toEqual({
      ...DEFAULT_RETENTION_POLICY,
      imageRetentionDays: 21,
    });
  });

  it.each(['issued', 'pending', 'inside'])('protects active pass state %s', (status) => {
    expect(isClosedPassStatus(status)).toBe(false);
  });

  it.each(['exited', 'rejected', 'expired'])('allows closed pass state %s', (status) => {
    expect(isClosedPassStatus(status)).toBe(true);
  });

  // Current canonical runtime governance actions (11 actions)
  const canonicalGovernanceActions = [
    'superadmin.bootstrap',
    'staff.create',
    'staff.update',
    'device.create',
    'device.update',
    'device.retire',
    'device.password_update',
    'settings_updated',
    'maintenance.retention_run',
    'security_hold_created',
    'incident_hold.released',
  ];

  it.each(canonicalGovernanceActions)(
    'protects current canonical governance audit action: %s',
    (action) => {
      expect(isProtectedAuditAction(action)).toBe(true);
    }
  );

  // Backward-compatible legacy aliases (12 actions)
  const legacyGovernanceAliases = [
    'initial_superadmin_bootstrapped',
    'superadmin_created',
    'admin_created',
    'admin_deleted',
    'device_registered',
    'device_deleted',
    'device_credentials_updated',
    'user_role_and_status_changed',
    'user_role_changed',
    'user_reactivated',
    'user_deactivated',
    'security_hold_released',
  ];

  it.each(legacyGovernanceAliases)(
    'preserves protection for legacy backward-compatible audit alias: %s',
    (alias) => {
      expect(isProtectedAuditAction(alias)).toBe(true);
    }
  );

  it.each([
    'visitor_images_purged',
    'pass.issue',
    'resend.delivery_event',
    'privacy.acknowledged',
    'staff.password_change_completed',
    'staff.password_reset',
    'evidence.review_held',
    'image_purge',
  ])('does not classify unrelated action %s as permanently protected', (action) => {
    expect(isProtectedAuditAction(action)).toBe(false);
  });

  it('enforces semantic emitter contract between runtime sources and PROTECTED_AUDIT_ACTIONS', () => {
    // 1. Bootstrap function emits superadmin.bootstrap
    const bootstrapSql = readFileSync(
      'supabase/migrations/20261024142836_bootstrap_super_admin_hardening.sql',
      'utf8'
    );
    expect(bootstrapSql).toContain("'superadmin.bootstrap'");
    expect(isProtectedAuditAction('superadmin.bootstrap')).toBe(true);

    // 2. Staff RPCs emit staff.create and staff.update
    const adminGovSql = readFileSync(
      'supabase/migrations/20261020000700_admin_governance.sql',
      'utf8'
    );
    expect(adminGovSql).toContain("'staff.create'");
    expect(adminGovSql).toContain("'staff.update'");
    expect(isProtectedAuditAction('staff.create')).toBe(true);
    expect(isProtectedAuditAction('staff.update')).toBe(true);

    // 3. Device RPCs emit device.create, device.update, device.retire
    expect(adminGovSql).toContain("'device.create'");
    expect(adminGovSql).toContain("'device.update'");
    expect(adminGovSql).toContain("'device.retire'");
    expect(isProtectedAuditAction('device.create')).toBe(true);
    expect(isProtectedAuditAction('device.update')).toBe(true);
    expect(isProtectedAuditAction('device.retire')).toBe(true);

    // 4. Device credential update handler emits device.password_update
    const updateDeviceAuthTs = readFileSync(
      'server/routes/device/update-device-auth.ts',
      'utf8'
    );
    expect(updateDeviceAuthTs).toContain("action: 'device.password_update'");
    expect(isProtectedAuditAction('device.password_update')).toBe(true);

    // 5. Settings update emits settings_updated
    const updateSettingsTs = readFileSync(
      'server/routes/system/update-settings.ts',
      'utf8'
    );
    expect(updateSettingsTs).toContain("action: 'settings_updated'");
    expect(isProtectedAuditAction('settings_updated')).toBe(true);

    // 6. Incident hold release emits incident_hold.released
    const incidentReleaseSql = readFileSync(
      'supabase/migrations/20261020001300_cross_layer_root_cause_hardening.sql',
      'utf8'
    );
    expect(incidentReleaseSql).toContain("'incident_hold.released'");
    expect(isProtectedAuditAction('incident_hold.released')).toBe(true);

    // 7. Incident hold create emits security_hold_created
    const incidentCreateSql = readFileSync(
      'supabase/migrations/20261020001400_closure_and_hardening.sql',
      'utf8'
    );
    expect(incidentCreateSql).toContain("'security_hold_created'");
    expect(isProtectedAuditAction('security_hold_created')).toBe(true);

    // 8. Maintenance run emits maintenance.retention_run
    const retentionMaintenanceTs = readFileSync(
      'server/routes/admin/retention-maintenance.ts',
      'utf8'
    );
    expect(retentionMaintenanceTs).toContain("action: 'maintenance.retention_run'");
    expect(isProtectedAuditAction('maintenance.retention_run')).toBe(true);
  });
});
