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

const createUserApi = readFileSync('api/create-user.ts', 'utf8');
const updateUserApi = readFileSync('api/update-user.ts', 'utf8');
const createDeviceApi = readFileSync('api/create-device.ts', 'utf8');
const updateDeviceApi = readFileSync('api/update-device.ts', 'utf8');
const updateDeviceAuthApi = readFileSync('api/update-device-auth.ts', 'utf8');
const deleteDeviceApi = readFileSync('api/delete-device.ts', 'utf8');
const updateSettingsApi = readFileSync('api/update-settings.ts', 'utf8');
const purgeImagesApi = readFileSync('api/purge-images.ts', 'utf8');
const adminSettingsApi = readFileSync('api/admin/settings.ts', 'utf8');
const adminDashboardApi = readFileSync('api/admin/dashboard.ts', 'utf8');
const adminUsersApi = readFileSync('api/admin/users.ts', 'utf8');
const adminDevicesApi = readFileSync('api/admin/devices.ts', 'utf8');
const adminRecordsApi = readFileSync('api/admin/records.ts', 'utf8');
const adminActivityApi = readFileSync('api/admin/activity.ts', 'utf8');
const adminEmergencyApi = readFileSync('api/admin/emergency.ts', 'utf8');
const reconciliationApi = readFileSync('api/reconciliation-items.ts', 'utf8');

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
});
