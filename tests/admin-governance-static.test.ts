import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const adminDashboard = readFileSync('src/pages/AdminDashboard.tsx', 'utf8');
const adminRecords = readFileSync('src/pages/AdminRecords.tsx', 'utf8');
const adminUsers = readFileSync('src/pages/AdminUsers.tsx', 'utf8');
const devicesPage = readFileSync('src/pages/DevicesPage.tsx', 'utf8');
const adminSettings = readFileSync('src/pages/AdminSettings.tsx', 'utf8');
const adminEmergency = readFileSync('src/pages/AdminEmergency.tsx', 'utf8');
const adminAuditLogs = readFileSync('src/pages/AdminAuditLogs.tsx', 'utf8');
const adminPage = readFileSync('src/pages/AdminPage.tsx', 'utf8');

const createUserApi = readFileSync('server/routes/system/create-user.ts', 'utf8');
const updateUserApi = readFileSync('server/routes/system/update-user.ts', 'utf8');
const createDeviceApi = readFileSync('server/routes/device/create-device.ts', 'utf8');
const updateDeviceApi = readFileSync('server/routes/device/update-device.ts', 'utf8');
const updateDeviceAuthApi = readFileSync('server/routes/device/update-device-auth.ts', 'utf8');
const deleteDeviceApi = readFileSync('server/routes/device/delete-device.ts', 'utf8');
const updateSettingsApi = readFileSync('server/routes/system/update-settings.ts', 'utf8');
const purgeImagesApi = readFileSync('server/routes/system/purge-images.ts', 'utf8');
const adminSettingsApi = readFileSync('server/routes/admin/settings.ts', 'utf8');
const adminDashboardApi = readFileSync('server/routes/admin/dashboard.ts', 'utf8');
const adminUsersApi = readFileSync('server/routes/admin/users.ts', 'utf8');
const adminDevicesApi = readFileSync('server/routes/admin/devices.ts', 'utf8');
const adminRecordsApi = readFileSync('server/routes/admin/records.ts', 'utf8');
const adminActivityApi = readFileSync('server/routes/admin/activity.ts', 'utf8');
const adminEmergencyApi = readFileSync('server/routes/admin/emergency.ts', 'utf8');
const reconciliationApi = readFileSync('server/routes/system/reconciliation-items.ts', 'utf8');

const governanceMigration = readFileSync('supabase/migrations/20261020000700_admin_governance.sql', 'utf8');

describe('Admin and Operations Runtime Migration (M4/S6)', () => {
  it('removes all direct Firebase and Firestore imports from Admin UI pages', () => {
    const adminPages = [
      { name: 'AdminDashboard', code: adminDashboard },
      { name: 'AdminRecords', code: adminRecords },
      { name: 'AdminUsers', code: adminUsers },
      { name: 'DevicesPage', code: devicesPage },
      { name: 'AdminSettings', code: adminSettings },
      { name: 'AdminEmergency', code: adminEmergency },
      { name: 'AdminAuditLogs', code: adminAuditLogs },
      { name: 'AdminPage', code: adminPage },
    ];

    for (const page of adminPages) {
      expect(page.code).not.toContain("from '@/lib/firebase'");
      expect(page.code).not.toContain("from 'firebase/firestore'");
      expect(page.code).not.toContain("from 'firebase/auth'");
    }
  });

  it('enforces bearer authentication and role verification across all admin API endpoints', () => {
    const adminEndpoints = [
      createUserApi,
      updateUserApi,
      createDeviceApi,
      updateDeviceApi,
      updateDeviceAuthApi,
      deleteDeviceApi,
      updateSettingsApi,
      purgeImagesApi,
      adminSettingsApi,
      adminDashboardApi,
      adminUsersApi,
      adminDevicesApi,
      adminRecordsApi,
      adminActivityApi,
      adminEmergencyApi,
      reconciliationApi,
    ];

    for (const endpoint of adminEndpoints) {
      expect(endpoint).toContain('readBearerToken(request)');
      expect(endpoint).toContain('requireStaffActor');
    }
  });

  it('restricts privileged operations to Super Admin actors', () => {
    expect(purgeImagesApi).toContain("['superadmin']");
    expect(deleteDeviceApi).toContain("['superadmin']");
    expect(reconciliationApi).toContain("['superadmin']");
    expect(updateSettingsApi).toContain("actor.role !== 'superadmin'");
    expect(updateSettingsApi).toContain('Only Super Admins may change security-sensitive settings');
  });

  it('protects device and staff identities with controlled naming and service-only RPCs', () => {
    expect(createDeviceApi).toContain('controlledDeviceEmail');
    expect(updateDeviceAuthApi).toContain('controlledDeviceEmail');
    expect(governanceMigration).toContain('create or replace function api.create_staff_profile');
    expect(governanceMigration).toContain('create or replace function api.update_staff_profile');
    expect(governanceMigration).toContain('create or replace function api.create_device_profile');
    expect(governanceMigration).toContain('create or replace function api.update_device_profile');
    expect(governanceMigration).toContain('create or replace function api.retire_device');
    expect(governanceMigration).toContain('revoke all on function api.create_staff_profile');
    expect(governanceMigration).toContain('grant execute on function api.create_staff_profile');
  });

  it('provides bounded cursor pagination and excludes sensitive credentials from visitor exports', () => {
    expect(adminRecordsApi).toContain('pageSize');
    expect(adminRecordsApi).toContain('cursor');
    expect(adminRecords).toContain('collectCursorPages');
    expect(adminRecords).not.toContain('qrToken');
    expect(adminRecords).not.toContain('secret');
  });

  it('records administrative audit events for critical operational mutations', () => {
    expect(governanceMigration).toContain("'staff.create'");
    expect(governanceMigration).toContain("'staff.update'");
    expect(governanceMigration).toContain("'device.create'");
    expect(governanceMigration).toContain("'device.update'");
    expect(governanceMigration).toContain("'device.retire'");
    expect(updateDeviceAuthApi).toContain("action: 'device.password_update'");
    expect(updateSettingsApi).toContain("action: 'settings_updated'");
    expect(purgeImagesApi).toContain("action: 'image_purge'");
  });

  it('translates machine-readable cannot_remove_last_superadmin error to friendly user message in Staff Management UI', () => {
    // API contract preserves machine-readable error
    expect(updateUserApi).toContain("error.code === '23514'");
    expect(updateUserApi).toContain("error: 'cannot_remove_last_superadmin'");

    // UI translates code to user-friendly message
    expect(adminUsers).toContain("body?.error === 'cannot_remove_last_superadmin'");
    expect(adminUsers).toContain("'Cannot demote or deactivate the last remaining Super Admin.'");

    // Applied consistently to both deactivation and role change error handlers
    expect(adminUsers).toContain("toast.error(err instanceof Error ? err.message : 'Failed to deactivate user')");
    expect(adminUsers).toContain("toast.error(err instanceof Error ? err.message : 'Failed to change user role')");
  });
});
