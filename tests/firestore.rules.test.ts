import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Timestamp } from 'firebase/firestore';
import { getFirestore as getAdminFirestore, Timestamp as AdminTimestamp } from 'firebase-admin/firestore';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import { vi } from 'vitest';
import { v2 as cloudinary } from 'cloudinary';
import type { Handler } from '@netlify/functions';
import { adminAuth } from '../netlify/functions/firebase-admin';
import { handler as updateUserHandler } from '../netlify/functions/update-user';
import { handler as createUserHandler } from '../netlify/functions/create-user';
import { handler as createDeviceHandler } from '../netlify/functions/create-device';
import { handler as updateDeviceHandler } from '../netlify/functions/update-device';
import { handler as updateDeviceAuthHandler } from '../netlify/functions/update-device-auth';
import { handler as deleteDeviceHandler } from '../netlify/functions/delete-device';
import { handler as createPassHandler } from '../netlify/functions/create-pass';
import { handler as scanPassHandler } from '../netlify/functions/scan-pass';
import { handler as decideVisitHandler } from '../netlify/functions/decide-visit';
import { handler as updateSettingsHandler } from '../netlify/functions/update-settings';
import { handler as reconciliationItemsHandler } from '../netlify/functions/reconciliation-items';
import { handler as imageHandler } from '../netlify/functions/image';
import { handler as purgeImagesHandler } from '../netlify/functions/purge-images';
import { handler as cloudinarySignHandler } from '../netlify/functions/cloudinary-sign';
import { handler as cleanupUploadHandler } from '../netlify/functions/cleanup-upload';
import { handler as migrateImageDeliveryHandler } from '../netlify/functions/migrate-image-delivery';
import { authorizeReferencedImage, classifyImageIdentifier, ImageAccessError } from '../netlify/functions/utils/image-security';
import {
  calculateImageExpiry,
  closedPassImageExpiryUpdate,
  isVisitDateWithinPolicy,
  passProtectsImages,
} from '../netlify/functions/utils/image-lifecycle';
import { enforceRateLimit, RateLimitError } from '../netlify/functions/utils/rate-limit';
import { cleanupAuditLogs, cleanupExpiredRateLimits, cleanupHistoricalVisits } from '../netlify/functions/utils/retention-maintenance';

let testEnv: RulesTestEnvironment;
let adminIdToken = '';
let superAdminIdToken = '';
let entryDeviceIdToken = '';
let exitDeviceIdToken = '';
let kioskDeviceIdToken = '';
let anonymousIdToken = '';
let anonymousUid = '';
let guardIdToken = '';

const TEST_PROJECT_ID = process.env.GCLOUD_PROJECT || 'e-gatepass-test';
const TEST_PASSWORD = 'TestPassword123!';

async function signInTestUser(email: string): Promise<string> {
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );
  const body = await response.json() as { idToken?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken) {
    throw new Error(`Could not sign in emulator test user: ${body.error?.message || response.status}`);
  }
  return body.idToken;
}

async function signInAnonymousTestUser(): Promise<{ idToken: string; uid: string }> {
  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  const body = await response.json() as { idToken?: string; localId?: string; error?: { message?: string } };
  if (!response.ok || !body.idToken || !body.localId) {
    throw new Error(`Could not create anonymous emulator user: ${body.error?.message || response.status}`);
  }
  return { idToken: body.idToken, uid: body.localId };
}

async function invokeUpdateUser(
  idToken: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  const event = {
    httpMethod: 'POST',
    headers: { authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  } as Parameters<typeof updateUserHandler>[0];
  const context = {} as Parameters<typeof updateUserHandler>[1];
  const response = await updateUserHandler(event, context);
  if (!response) throw new Error('Update user handler returned no response');
  return response;
}

async function invokeHandler(
  handler: Handler,
  idToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: string }> {
  const event = {
    httpMethod: method,
    headers: { authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  } as Parameters<Handler>[0];
  const response = await handler(event, {} as Parameters<Handler>[1]);
  if (!response) throw new Error('Handler returned no response');
  return response;
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: TEST_PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8'),
    },
  });

  await Promise.all([
    adminAuth.createUser({
      uid: 'admin_uid',
      email: 'admin-test@example.com',
      password: TEST_PASSWORD,
      emailVerified: true,
    }),
    adminAuth.createUser({
      uid: 'superadmin_uid',
      email: 'superadmin-test@example.com',
      password: TEST_PASSWORD,
      emailVerified: true,
    }),
    adminAuth.createUser({ uid: 'entry_device', email: 'entry-device@example.com', password: TEST_PASSWORD, emailVerified: true }),
    adminAuth.createUser({ uid: 'exit_device', email: 'exit-device@example.com', password: TEST_PASSWORD, emailVerified: true }),
    adminAuth.createUser({ uid: 'kiosk_device', email: 'kiosk-device@example.com', password: TEST_PASSWORD, emailVerified: true }),
    adminAuth.createUser({ uid: 'guard_uid', email: 'guard-test@example.com', password: TEST_PASSWORD, emailVerified: true }),
  ]);
  [adminIdToken, superAdminIdToken, entryDeviceIdToken, exitDeviceIdToken, kioskDeviceIdToken, guardIdToken] = await Promise.all([
    signInTestUser('admin-test@example.com'),
    signInTestUser('superadmin-test@example.com'),
    signInTestUser('entry-device@example.com'),
    signInTestUser('exit-device@example.com'),
    signInTestUser('kiosk-device@example.com'),
    signInTestUser('guard-test@example.com'),
  ]);
  const anonymous = await signInAnonymousTestUser();
  anonymousIdToken = anonymous.idToken;
  anonymousUid = anonymous.uid;
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await adminAuth.deleteUsers(['admin_uid', 'superadmin_uid', 'entry_device', 'exit_device', 'kiosk_device', 'guard_uid', anonymousUid]);
  await testEnv.cleanup();
});

// ============================================================
// HELPERS
// ============================================================

/** Timestamp in the past (1 hour ago) */
function pastTimestamp() {
  return Timestamp.fromMillis(Date.now() - 3600 * 1000);
}

/** Timestamp in the future (1 hour from now) */
function futureTimestamp() {
  return Timestamp.fromMillis(Date.now() + 3600 * 1000);
}

/** Timestamp far in the future (24 hours from now) */
function farFutureTimestamp() {
  return Timestamp.fromMillis(Date.now() + 24 * 3600 * 1000);
}

const REQUIRED_VISITOR_FIELDS = {
  firstName: 'Test',
  middleName: '',
  lastName: 'Visitor',
  fullName: 'Test Visitor',
  contactNumber: '1234567890',
  purpose: 'Meeting',
  visitDate: '2026-10-01',
  idImagePublicId: null,
  photoPublicId: 'photo_id',
  consentAcceptedAt: Timestamp.now(),
  createdAt: Timestamp.now(),
  createdByUid: 'anon_uid',
  imagesPurgedAt: null,
};

function makeValidPortalPass(uid: string) {
  return {
    visitorId: 'my_visitor',
    visitorName: 'Test Visitor',
    purpose: 'Meeting',
    photoPublicId: 'photo_id',
    idImagePublicId: null,
    source: 'portal',
    status: 'issued',
    validFrom: futureTimestamp(),
    validUntil: farFutureTimestamp(),
    issuedAt: Timestamp.now(),
    scannedAt: null,
    timeIn: null,
    timeOut: null,
    entryDeviceId: null,
    exitDeviceId: null,
    decidedByUid: null,
    rejectionReason: null,
    gate: null,
    createdByUid: uid,
  };
}

function makeValidKioskPass(uid: string) {
  return {
    ...makeValidPortalPass(uid),
    source: 'kiosk',
  };
}

describe('E-GatePass Firestore Rules', () => {

  const getAdminContext = () =>
    testEnv.authenticatedContext('admin_uid', { email_verified: true });

  const getSuperAdminContext = (uid = 'superadmin_uid') =>
    testEnv.authenticatedContext(uid, { email_verified: true });

  const getGuardContext = (uid = 'guard_uid', isVerified = true) =>
    testEnv.authenticatedContext(uid, { email_verified: isVerified });

  const getDeviceContext = (uid = 'device_uid') =>
    testEnv.authenticatedContext(uid, { email_verified: true });

  const getAnonContext = (uid = 'anon_uid') =>
    testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous', identities: {} } });

  // Seed base data
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();

      await db.collection('users').doc('admin_uid').set({ role: 'admin', active: true });
      await db.collection('users').doc('admin_two_uid').set({ role: 'admin', active: true });
      await db.collection('users').doc('superadmin_uid').set({ role: 'superadmin', active: true });
      await db.collection('users').doc('second_superadmin_uid').set({ role: 'superadmin', active: true });
      await db.collection('users').doc('guard_uid').set({ role: 'guard', active: true });
      await db.collection('users').doc('inactive_guard').set({ role: 'guard', active: false });

      await db.collection('devices').doc('entry_device').set({ type: 'entry', status: 'active', gate: 'Main Gate' });
      await db.collection('devices').doc('exit_device').set({ type: 'exit', status: 'active', gate: 'Main Gate' });
      await db.collection('devices').doc('kiosk_device').set({ type: 'kiosk', status: 'active' });
      await db.collection('devices').doc('revoked_device').set({ type: 'entry', status: 'revoked' });

      await db.collection('visitors').doc('other_visitor').set({ createdByUid: 'other_uid' });
    });
  });

  // ============================================================
  // 1. Authorization Tests (existing)
  // ============================================================
  describe('Authorization Tests', () => {
    it('Unverified Guard reads protected data -> DENY', async () => {
      const db = getGuardContext('guard_uid', false).firestore();
      await assertFails(db.collection('visitors').get());
    });

    it('Inactive Guard reads protected data -> DENY', async () => {
      const db = getGuardContext('inactive_guard', true).firestore();
      await assertFails(db.collection('visitors').get());
    });

    it('Verified active Guard reads permitted data -> ALLOW', async () => {
      const db = getGuardContext('guard_uid', true).firestore();
      await assertSucceeds(db.collection('visitors').get());
    });

    it('Revoked Entry device reads/updates -> DENY', async () => {
      const db = getDeviceContext('revoked_device').firestore();
      await assertFails(db.collection('gatePasses').get());
    });
  });

  describe('Super Admin authorization model', () => {
    const userProfile = (role: 'guard' | 'admin' | 'superadmin') => ({
      name: 'New Staff User',
      email: `new-${role}@example.com`,
      role,
      active: true,
      privacyAcceptedAt: null,
      mustChangePassword: role === 'guard',
      createdAt: Timestamp.now(),
    });

    it('Super Admin inherits normal Admin read access -> ALLOW', async () => {
      const db = getSuperAdminContext().firestore();
      await assertSucceeds(db.collection('users').get());
      await assertSucceeds(db.collection('devices').get());
      await assertSucceeds(db.collection('visitors').get());
    });

    it('Admin cannot create a Guard profile directly -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('users').doc('new_guard').set(userProfile('guard')));
    });

    it('Admin creates Admin or Super Admin profile -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('users').doc('new_admin').set(userProfile('admin')));
      await assertFails(db.collection('users').doc('new_superadmin').set(userProfile('superadmin')));
    });

    it('Super Admin cannot create any staff profile directly -> DENY', async () => {
      const db = getSuperAdminContext().firestore();
      await assertFails(db.collection('users').doc('new_guard').set(userProfile('guard')));
      await assertFails(db.collection('users').doc('new_admin').set(userProfile('admin')));
      await assertFails(db.collection('users').doc('new_superadmin').set(userProfile('superadmin')));
    });

    it('Admin and Super Admin cannot mutate device records directly -> DENY', async () => {
      await assertFails(getAdminContext().firestore().collection('devices').doc('entry_device').update({ status: 'revoked' }));
      await assertFails(getSuperAdminContext().firestore().collection('devices').doc('new_device').set({
        name: 'New Device',
        type: 'entry',
        gate: 'Main Gate',
        email: 'new-device@example.com',
        status: 'active',
      }));
    });

    it('Admin cannot promote themselves or another Admin through Firestore -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('users').doc('admin_uid').update({ role: 'superadmin' }));
      await assertFails(db.collection('users').doc('admin_two_uid').update({ role: 'superadmin' }));
    });

    it('Admin cannot modify or deactivate a Super Admin through Firestore -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('users').doc('superadmin_uid').update({ active: false }));
      await assertFails(db.collection('users').doc('superadmin_uid').update({ role: 'admin' }));
    });

    it('Super Admin role and status writes are backend-only -> DENY', async () => {
      const db = getSuperAdminContext().firestore();
      await assertFails(db.collection('users').doc('admin_two_uid').update({ role: 'superadmin' }));
      await assertFails(db.collection('users').doc('second_superadmin_uid').update({ active: false }));
    });

    it('Guard cannot manage users, devices, or settings -> DENY', async () => {
      const db = getGuardContext().firestore();
      await assertFails(db.collection('users').doc('new_guard').set(userProfile('guard')));
      await assertFails(db.collection('devices').doc('entry_device').update({ status: 'revoked' }));
      await assertFails(db.collection('settings').doc('app').set({ peakMode: true }));
    });

    it('Admin settings mutations are backend-only -> DENY', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('settings').doc('app').set({
          peakMode: false,
          retentionDays: 30,
          rejectionReasons: [],
          visitPurposes: [],
        });
      });
      const db = getAdminContext().firestore();
      await assertFails(db.collection('settings').doc('app').update({ peakMode: true }));
      await assertFails(db.collection('settings').doc('app').update({ retentionDays: 1 }));
    });

    it('Super Admin settings mutations are backend-only -> DENY', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('settings').doc('app').set({ retentionDays: 30 });
      });
      const db = getSuperAdminContext().firestore();
      await assertFails(db.collection('settings').doc('app').update({ retentionDays: 60 }));
    });
  });

  describe('Administrative audit and reconciliation boundaries', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('auditLogs').doc('administrative_event').set({
            action: 'device_revoked',
            actorUid: 'admin_uid',
            actorRole: 'admin',
            targetType: 'device',
            targetId: 'entry_device',
            result: 'success',
            timestamp: Timestamp.now(),
          }),
          db.collection('visitLogs').doc('visitor_event').set({
            passToken: 'pass_for_matrix',
            visitorId: 'visitor_for_matrix',
            event: 'scan_entry',
            reason: null,
            deviceId: 'entry_device',
            gate: 'Main Gate',
            guardUid: null,
            timestamp: Timestamp.now(),
          }),
          db.collection('reconciliationTasks').doc('unresolved_item').set({
            operation: 'update_device_credentials',
            targetType: 'device',
            targetId: 'entry_device',
            targetUid: 'entry_device',
            actorUid: 'superadmin_uid',
            reason: 'Password changed and token revocation requires confirmation',
            requiredActions: ['Confirm the new password remains effective', 'Revoke refresh tokens'],
            status: 'pending',
            createdAt: Timestamp.now(),
          }),
        ]);
      });
    });

    it('Guard reads visitor activity but not administrative audit or reconciliation', async () => {
      const db = getGuardContext().firestore();
      await assertSucceeds(db.collection('visitLogs').get());
      await assertFails(db.collection('auditLogs').get());
      await assertFails(db.collection('reconciliationTasks').get());
    });

    it('Admin reads visitor and administrative activity but not reconciliation', async () => {
      const db = getAdminContext().firestore();
      await assertSucceeds(db.collection('visitLogs').get());
      await assertSucceeds(db.collection('auditLogs').get());
      await assertFails(db.collection('reconciliationTasks').get());

      const response = await invokeHandler(reconciliationItemsHandler, adminIdToken, 'GET');
      if (response.statusCode !== 403) throw new Error(`Expected 403, received ${response.statusCode}`);
    });

    it('Super Admin reads both logs and a sanitized bounded reconciliation list', async () => {
      const db = getSuperAdminContext().firestore();
      await assertSucceeds(db.collection('visitLogs').get());
      await assertSucceeds(db.collection('auditLogs').get());
      await assertFails(db.collection('reconciliationTasks').get());

      const response = await invokeHandler(reconciliationItemsHandler, superAdminIdToken, 'GET');
      if (response.statusCode !== 200) throw new Error(response.body);
      const body = JSON.parse(response.body) as {
        items: Array<Record<string, unknown>>;
        count: number;
        limit: number;
        readOnly: boolean;
      };
      if (body.count !== 1 || body.limit !== 50 || body.readOnly !== true) {
        throw new Error('Reconciliation response was not bounded and read-only');
      }
      if ('actorUid' in body.items[0] || 'reference' in body.items[0]) {
        throw new Error('Reconciliation response leaked server-only fields');
      }
    });

    it('All browser audit and reconciliation mutations are denied', async () => {
      const adminDb = getAdminContext().firestore();
      const superDb = getSuperAdminContext().firestore();
      await assertFails(adminDb.collection('auditLogs').doc('forged').set({ action: 'forged' }));
      await assertFails(superDb.collection('auditLogs').doc('administrative_event').update({ result: 'failure' }));
      await assertFails(superDb.collection('reconciliationTasks').doc('unresolved_item').update({ status: 'resolved' }));
      await assertFails(superDb.collection('reconciliationTasks').doc('forged').set({ status: 'pending' }));
    });
  });

  describe('Protected settings endpoint', () => {
    const operationalSettings = {
      peakMode: true,
      rejectionReasons: ['Invalid identification'],
      visitPurposes: [{ label: 'Business meeting', requiresDetails: false, detailPrompt: '' }],
    };

    it('Admin updates operational settings with a structured backend audit', async () => {
      const response = await invokeHandler(updateSettingsHandler, adminIdToken, 'POST', operationalSettings);
      if (response.statusCode !== 200) throw new Error(response.body);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [settings, audit] = await Promise.all([
          db.collection('settings').doc('app').get(),
          db.collection('auditLogs').where('action', '==', 'settings_updated').get(),
        ]);
        const event = audit.docs[0]?.data();
        if (settings.data()?.peakMode !== true || audit.size !== 1) throw new Error('Settings update did not commit atomically');
        if (
          event?.actorUid !== 'admin_uid' ||
          event?.actorRole !== 'admin' ||
          event?.targetType !== 'settings' ||
          event?.targetId !== 'app' ||
          event?.result !== 'success'
        ) throw new Error('Settings audit schema is incomplete');
      });
    });

    it('Admin cannot change retention while Super Admin can', async () => {
      const forbidden = await invokeHandler(updateSettingsHandler, adminIdToken, 'POST', {
        ...operationalSettings,
        imageRetentionDays: 7,
      });
      if (forbidden.statusCode !== 403) throw new Error(`Expected 403, received ${forbidden.statusCode}`);

      const allowed = await invokeHandler(updateSettingsHandler, superAdminIdToken, 'POST', {
        ...operationalSettings,
        visitorRetentionDays: 60,
        imageRetentionDays: 14,
        auditRetentionDays: 730,
        reconciliationRetentionDays: 120,
        automaticCleanupEnabled: true,
      });
      if (allowed.statusCode !== 200) throw new Error(allowed.body);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const settings = await context.firestore().collection('settings').doc('app').get();
        const data = settings.data();
        if (data?.visitorRetentionDays !== 60 || data.imageRetentionDays !== 14 || data.auditRetentionDays !== 730 || data.reconciliationRetentionDays !== 120 || data.automaticCleanupEnabled !== true) {
          throw new Error('Retention policy was not updated');
        }
      });
    });

    it('Admin cannot change working hours while Super Admin can with an audited old/new value', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('settings').doc('app').set({
          ...operationalSettings,
          workingHours: { start: '08:00', end: '17:00', timezone: 'Asia/Manila' },
        });
      });
      const nextHours = { start: '09:15', end: '16:30', timezone: 'Asia/Manila' };
      const forbidden = await invokeHandler(updateSettingsHandler, adminIdToken, 'POST', {
        ...operationalSettings,
        workingHours: nextHours,
      });
      if (forbidden.statusCode !== 403) throw new Error(`Expected 403, received ${forbidden.statusCode}`);

      const allowed = await invokeHandler(updateSettingsHandler, superAdminIdToken, 'POST', {
        ...operationalSettings,
        workingHours: nextHours,
      });
      if (allowed.statusCode !== 200) throw new Error(allowed.body);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [settings, audits] = await Promise.all([
          db.collection('settings').doc('app').get(),
          db.collection('auditLogs').where('action', '==', 'settings_updated').get(),
        ]);
        if (settings.data()?.workingHours?.start !== '09:15') throw new Error('Working hours were not updated');
        const metadata = audits.docs[0]?.data().metadata;
        if (metadata?.previousWorkingHours?.start !== '08:00' || metadata?.newWorkingHours?.end !== '16:30') {
          throw new Error('Working-hours audit did not preserve safe old/new values');
        }
      });
    });

    it('Rejects malformed or inverted working hours', async () => {
      const malformed = await invokeHandler(updateSettingsHandler, superAdminIdToken, 'POST', {
        ...operationalSettings,
        workingHours: { start: '9:00', end: '17:00', timezone: 'Asia/Manila' },
      });
      const inverted = await invokeHandler(updateSettingsHandler, superAdminIdToken, 'POST', {
        ...operationalSettings,
        workingHours: { start: '18:00', end: '08:00', timezone: 'Asia/Manila' },
      });
      if (malformed.statusCode !== 400 || inverted.statusCode !== 400) {
        throw new Error(`Expected validation failures, received ${malformed.statusCode}/${inverted.statusCode}`);
      }
    });
  });

  describe('Image ownership and destructive-operation boundaries', () => {
    const currentPhotoId = 'e-gatepass/photos/aaaaaaaaaaaaaaaa';
    const currentIdImageId = 'e-gatepass/ids/bbbbbbbbbbbbbbbb';
    const legacyPhotoId = 'legacy-visitors/photo_123';

    beforeEach(async () => {
      process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
      process.env.CLOUDINARY_API_KEY = 'test-key';
      process.env.CLOUDINARY_API_SECRET = 'test-secret';
      cloudinary.config({ cloud_name: 'test-cloud', api_key: 'test-key', api_secret: 'test-secret', secure: true });
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('visitors').doc('pending_image_visitor').set({
            ...REQUIRED_VISITOR_FIELDS,
            photoPublicId: currentPhotoId,
            idImagePublicId: currentIdImageId,
            photoDeliveryType: 'authenticated',
            idImageDeliveryType: 'authenticated',
          }),
          db.collection('gatePasses').doc('pending_image_pass').set({
            ...makeValidPortalPass(anonymousUid),
            visitorId: 'pending_image_visitor',
            photoPublicId: currentPhotoId,
            idImagePublicId: currentIdImageId,
            photoDeliveryType: 'authenticated',
            idImageDeliveryType: 'authenticated',
            status: 'pending',
          }),
          db.collection('visitors').doc('legacy_image_visitor').set({
            ...REQUIRED_VISITOR_FIELDS,
            photoPublicId: legacyPhotoId,
            idImagePublicId: null,
          }),
          db.collection('gatePasses').doc('legacy_image_pass').set({
            ...makeValidPortalPass(anonymousUid),
            visitorId: 'legacy_image_visitor',
            photoPublicId: legacyPhotoId,
            idImagePublicId: null,
            status: 'exited',
          }),
        ]);
      });
    });

    it('classifies current, legacy-candidate, and malformed identifiers', () => {
      if (classifyImageIdentifier(currentPhotoId) !== 'current') throw new Error('Current identifier was not recognized');
      if (classifyImageIdentifier(legacyPhotoId) !== 'legacy_candidate') throw new Error('Legacy identifier was not preserved');
      if (classifyImageIdentifier('../external/asset') !== 'malformed') throw new Error('Malformed identifier was accepted');
    });

    it('allows Admin and Super Admin referenced current and legacy images', async () => {
      const db = getAdminFirestore();
      await authorizeReferencedImage(db, { uid: 'admin_uid', email: '', role: 'admin' }, currentPhotoId);
      await authorizeReferencedImage(db, { uid: 'superadmin_uid', email: '', role: 'superadmin' }, legacyPhotoId);
    });

    it('allows Guard images only for pending approval passes', async () => {
      const db = getAdminFirestore();
      await authorizeReferencedImage(db, { uid: 'guard_uid', email: '', role: 'guard' }, currentIdImageId);
      try {
        await authorizeReferencedImage(db, { uid: 'guard_uid', email: '', role: 'guard' }, legacyPhotoId);
        throw new Error('Guard received historical image access');
      } catch (error) {
        if (!(error instanceof ImageAccessError) || error.statusCode !== 404) throw error;
      }
    });

    it('rejects malformed and arbitrary unreferenced image identifiers', async () => {
      const db = getAdminFirestore();
      for (const [publicId, expectedStatus] of [
        ['https://example.com/image.jpg', 400],
        ['e-gatepass/photos/cccccccccccccccc', 404],
      ] as const) {
        try {
          await authorizeReferencedImage(db, { uid: 'admin_uid', email: '', role: 'admin' }, publicId);
          throw new Error('Unauthorized image identifier was accepted');
        } catch (error) {
          if (!(error instanceof ImageAccessError) || error.statusCode !== expectedStatus) throw error;
        }
      }
    });

    it('denies anonymous image access and serves an authorized Guard image through the proxy', async () => {
      const anonymous = await invokeHandler(imageHandler, anonymousIdToken, 'GET', {});
      if (anonymous.statusCode !== 403) throw new Error(`Expected anonymous denial, received ${anonymous.statusCode}`);

      const originalFetch = globalThis.fetch;
      let fetchedImageUrl = '';
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('cloudinary.com')) {
          fetchedImageUrl = String(input);
          return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/webp' } });
        }
        return originalFetch(input, init);
      });
      try {
        const event = {
          httpMethod: 'GET',
          headers: { authorization: `Bearer ${guardIdToken}` },
          queryStringParameters: { publicId: currentPhotoId },
        } as Parameters<typeof imageHandler>[0];
        const response = await imageHandler(event, {} as Parameters<typeof imageHandler>[1]);
        if (!response || response.statusCode !== 200 || response.headers?.['Content-Type'] !== 'image/webp') {
          throw new Error(`Authorized image proxy failed: ${response?.statusCode}`);
        }
        if (!fetchedImageUrl.includes('/image/authenticated/')) {
          throw new Error(`Authorized proxy did not use authenticated delivery: ${fetchedImageUrl}`);
        }
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('returns the distinct expired-image response without removing visitor or pass details', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('visitors').doc('legacy_image_visitor').update({ imagesPurgedAt: Timestamp.now() });
      });
      const event = {
        httpMethod: 'GET',
        headers: { authorization: `Bearer ${adminIdToken}` },
        queryStringParameters: { publicId: legacyPhotoId },
      } as Parameters<typeof imageHandler>[0];
      const response = await imageHandler(event, {} as Parameters<typeof imageHandler>[1]);
      if (!response || response.statusCode !== 410 || !response.body.includes('Image expired')) {
        throw new Error(`Expected expired image response, received ${response?.statusCode}`);
      }
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const [visitor, pass] = await Promise.all([
          context.firestore().collection('visitors').doc('legacy_image_visitor').get(),
          context.firestore().collection('gatePasses').doc('legacy_image_pass').get(),
        ]);
        if (!visitor.exists || !pass.exists) throw new Error('Image expiry removed visitor or pass details');
      });
    });

    it('issues owner-bound upload sessions only to valid upload actors', async () => {
      const denied = await invokeHandler(cloudinarySignHandler, adminIdToken, 'POST', { folder: 'e-gatepass/photos' });
      if (denied.statusCode !== 403) throw new Error(`Expected staff upload denial, received ${denied.statusCode}`);
      const allowed = await invokeHandler(cloudinarySignHandler, anonymousIdToken, 'POST', { folder: 'e-gatepass/photos' });
      if (allowed.statusCode !== 200) throw new Error(allowed.body);
      const body = JSON.parse(allowed.body) as { uploadId: string; expectedPublicId: string; context?: string; deliveryType?: string };
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const session = await context.firestore().collection('imageUploads').doc(body.uploadId).get();
        if (
          session.data()?.ownerUid !== anonymousUid ||
          session.data()?.publicId !== body.expectedPublicId ||
          session.data()?.deliveryType !== 'authenticated' ||
          session.data()?.status !== 'pending' ||
          typeof body.context !== 'string' ||
          body.deliveryType !== 'authenticated'
        ) throw new Error('Upload ownership session was not created correctly');
      });
    });

    it('rate limits repeated upload signing after validation and returns 429 with retry guidance', async () => {
      const malformed = await invokeHandler(cloudinarySignHandler, anonymousIdToken, 'POST', { folder: 'not-allowed' });
      if (malformed.statusCode !== 400) throw new Error('Malformed signing request was not rejected normally');
      for (let index = 0; index < 8; index++) {
        const response = await invokeHandler(cloudinarySignHandler, anonymousIdToken, 'POST', { folder: 'e-gatepass/photos' });
        if (response.statusCode !== 200) throw new Error(`Normal signing request ${index + 1} failed: ${response.body}`);
      }
      const limited = await invokeHandler(cloudinarySignHandler, anonymousIdToken, 'POST', { folder: 'e-gatepass/photos' });
      if (limited.statusCode !== 429 || !limited.headers?.['Retry-After']) {
        throw new Error(`Signing abuse was not rate limited: ${limited.statusCode}`);
      }
    });

    it('cleans only the same owner pending upload and refuses a claimed upload', async () => {
      const pendingId = 'cccccccccccccccccccccccccccccccc';
      const claimedId = 'dddddddddddddddddddddddddddddddd';
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('imageUploads').doc(pendingId).set({ ownerUid: anonymousUid, publicId: `e-gatepass/photos/${pendingId}`, deliveryType: 'authenticated', status: 'pending' }),
          db.collection('imageUploads').doc(claimedId).set({ ownerUid: anonymousUid, publicId: `e-gatepass/photos/${claimedId}`, status: 'claimed' }),
        ]);
      });
      const destroy = vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as never);
      try {
        const cleaned = await invokeHandler(cleanupUploadHandler, anonymousIdToken, 'POST', { publicIds: [`e-gatepass/photos/${pendingId}`] });
        const refused = await invokeHandler(cleanupUploadHandler, anonymousIdToken, 'POST', { publicIds: [`e-gatepass/photos/${claimedId}`] });
        if (cleaned.statusCode !== 200 || refused.statusCode !== 409) throw new Error(`${cleaned.body}\n${refused.body}`);
        if (destroy.mock.calls.length !== 1) throw new Error('Cleanup deleted an ineligible asset');
        if (destroy.mock.calls[0]?.[1]?.type !== 'authenticated') throw new Error('Cleanup used the wrong delivery type');
      } finally {
        destroy.mockRestore();
      }
    });

    it('denies Admin purge and lets Super Admin purge a referenced legacy image with an audit', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await db.collection('settings').doc('app').set({ retentionDays: 1 });
        await db.collection('visitors').doc('legacy_image_visitor').update({ createdAt: Timestamp.fromMillis(Date.now() - 3 * 86400000) });
      });
      const denied = await invokeHandler(purgeImagesHandler, adminIdToken, 'POST', {});
      if (denied.statusCode !== 403) throw new Error(`Expected Admin purge denial, received ${denied.statusCode}`);

      const destroy = vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as never);
      try {
        const allowed = await invokeHandler(purgeImagesHandler, superAdminIdToken, 'POST', {});
        if (allowed.statusCode !== 200) throw new Error(allowed.body);
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          const [visitor, audit] = await Promise.all([
            db.collection('visitors').doc('legacy_image_visitor').get(),
            db.collection('auditLogs').where('action', '==', 'visitor_images_purged').get(),
          ]);
          if (!visitor.data()?.imagesPurgedAt || audit.empty) throw new Error('Purge state or audit was not finalized');
        });
      } finally {
        destroy.mockRestore();
      }
    });

    it('prevents direct client forging of visitor and upload-session image ownership', async () => {
      const adminDb = getAdminContext().firestore();
      const superDb = getSuperAdminContext().firestore();
      await assertFails(adminDb.collection('visitors').doc('pending_image_visitor').update({ photoPublicId: 'external/forged' }));
      await assertFails(superDb.collection('imageUploads').doc('forged').set({ ownerUid: 'superadmin_uid', status: 'pending' }));
    });
  });

  describe('Protected user role and activation endpoint', () => {
    it('Admin may deactivate a Guard and receives a backend-authored audit event', async () => {
      const response = await invokeUpdateUser(adminIdToken, { targetUid: 'guard_uid', active: false });
      if (response.statusCode !== 200) throw new Error(response.body);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const guard = await db.collection('users').doc('guard_uid').get();
        if (guard.data()?.active !== false) throw new Error('Guard was not deactivated');
        const audit = await db.collection('auditLogs').where('targetUid', '==', 'guard_uid').get();
        if (audit.size !== 1 || audit.docs[0].data().actorRole !== 'admin') {
          throw new Error('Structured administrative audit event was not created');
        }
      });
    });

    it('Admin cannot promote themselves', async () => {
      const response = await invokeUpdateUser(adminIdToken, { targetUid: 'admin_uid', role: 'superadmin' });
      if (response.statusCode !== 403) throw new Error(`Expected 403, received ${response.statusCode}`);
    });

    it('Admin cannot promote another Admin to Super Admin', async () => {
      const response = await invokeUpdateUser(adminIdToken, { targetUid: 'admin_two_uid', role: 'superadmin' });
      if (response.statusCode !== 403) throw new Error(`Expected 403, received ${response.statusCode}`);
    });

    it('Admin cannot modify a Super Admin', async () => {
      const response = await invokeUpdateUser(adminIdToken, { targetUid: 'superadmin_uid', active: false });
      if (response.statusCode !== 403) throw new Error(`Expected 403, received ${response.statusCode}`);
    });

    it('Super Admin may promote an active Admin to Super Admin', async () => {
      const response = await invokeUpdateUser(superAdminIdToken, { targetUid: 'admin_two_uid', role: 'superadmin' });
      if (response.statusCode !== 200) throw new Error(response.body);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const promoted = await context.firestore().collection('users').doc('admin_two_uid').get();
        if (promoted.data()?.role !== 'superadmin') throw new Error('Admin was not promoted');
      });
    });

    it('Final active Super Admin cannot be demoted or deactivated', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('users').doc('second_superadmin_uid').update({ active: false });
      });
      const demote = await invokeUpdateUser(superAdminIdToken, { targetUid: 'superadmin_uid', role: 'admin' });
      const deactivate = await invokeUpdateUser(superAdminIdToken, { targetUid: 'superadmin_uid', active: false });
      if (demote.statusCode !== 409 || deactivate.statusCode !== 409) {
        throw new Error(`Expected final-Super-Admin protections, received ${demote.statusCode}/${deactivate.statusCode}`);
      }
    });

    it('Super Admin may demote themselves when another active Super Admin remains', async () => {
      const response = await invokeUpdateUser(superAdminIdToken, { targetUid: 'superadmin_uid', role: 'admin' });
      if (response.statusCode !== 200) throw new Error(response.body);
    });
  });

  describe('Server-managed account and device lifecycle', () => {
    it('Admin creates only Guards while Super Admin may create Admins, with profile and audit records', async () => {
      const guardEmail = `guard-created-${Date.now()}@example.com`;
      const guardResponse = await invokeHandler(createUserHandler, adminIdToken, 'POST', {
        name: 'Created Guard',
        email: guardEmail,
        password: TEST_PASSWORD,
        role: 'guard',
      });
      if (guardResponse.statusCode !== 201) throw new Error(guardResponse.body);
      const guardUid = (JSON.parse(guardResponse.body) as { uid: string }).uid;

      const forbidden = await invokeHandler(createUserHandler, adminIdToken, 'POST', {
        name: 'Forbidden Admin',
        email: `forbidden-admin-${Date.now()}@example.com`,
        password: TEST_PASSWORD,
        role: 'admin',
      });
      if (forbidden.statusCode !== 403) throw new Error(`Expected 403, received ${forbidden.statusCode}`);

      const adminEmail = `admin-created-${Date.now()}@example.com`;
      const adminResponse = await invokeHandler(createUserHandler, superAdminIdToken, 'POST', {
        name: 'Created Admin',
        email: adminEmail,
        password: TEST_PASSWORD,
        role: 'admin',
      });
      if (adminResponse.statusCode !== 201) throw new Error(adminResponse.body);
      const createdAdminUid = (JSON.parse(adminResponse.body) as { uid: string }).uid;

      try {
        await testEnv.withSecurityRulesDisabled(async (context) => {
          const db = context.firestore();
          const [guard, createdAdmin, guardAudit, adminAudit] = await Promise.all([
            db.collection('users').doc(guardUid).get(),
            db.collection('users').doc(createdAdminUid).get(),
            db.collection('auditLogs').where('targetUid', '==', guardUid).get(),
            db.collection('auditLogs').where('targetUid', '==', createdAdminUid).get(),
          ]);
          if (guard.data()?.role !== 'guard' || guard.data()?.mustChangePassword !== true) {
            throw new Error('Guard profile was not created with the expected controls');
          }
          if (createdAdmin.data()?.role !== 'admin' || createdAdmin.data()?.mustChangePassword !== false) {
            throw new Error('Admin profile was not created with the expected controls');
          }
          if (guardAudit.size !== 1 || adminAudit.size !== 1) throw new Error('Creation audit records are missing');
        });
      } finally {
        await adminAuth.deleteUsers([guardUid, createdAdminUid]);
      }
    });

    it('Device registration, status, credentials, and deletion are server-managed and audited', async () => {
      const originalEmail = `device-created-${Date.now()}@example.com`;
      const createResponse = await invokeHandler(createDeviceHandler, adminIdToken, 'POST', {
        name: 'Created Entry Scanner',
        type: 'entry',
        gate: 'Main Gate',
        email: originalEmail,
        password: TEST_PASSWORD,
      });
      if (createResponse.statusCode !== 201) throw new Error(createResponse.body);
      const deviceUid = (JSON.parse(createResponse.body) as { uid: string }).uid;

      const revokeResponse = await invokeHandler(updateDeviceHandler, adminIdToken, 'POST', {
        targetUid: deviceUid,
        status: 'revoked',
      });
      if (revokeResponse.statusCode !== 200) throw new Error(revokeResponse.body);

      const deniedCredentialResponse = await invokeHandler(updateDeviceAuthHandler, adminIdToken, 'POST', {
        targetUid: deviceUid,
        password: 'ReplacementPassword123!',
      });
      if (deniedCredentialResponse.statusCode !== 403) {
        throw new Error(`Expected credential update denial, received ${deniedCredentialResponse.statusCode}`);
      }

      const updatedEmail = `device-updated-${Date.now()}@example.com`;
      const credentialResponse = await invokeHandler(updateDeviceAuthHandler, superAdminIdToken, 'POST', {
        targetUid: deviceUid,
        email: updatedEmail,
        password: 'ReplacementPassword123!',
      });
      if (credentialResponse.statusCode !== 200) throw new Error(credentialResponse.body);

      const authRecord = await adminAuth.getUser(deviceUid);
      if (authRecord.email !== updatedEmail) throw new Error('Auth email was not updated');

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [device, audits] = await Promise.all([
          db.collection('devices').doc(deviceUid).get(),
          db.collection('auditLogs').where('targetUid', '==', deviceUid).get(),
        ]);
        if (device.data()?.status !== 'revoked' || device.data()?.email !== updatedEmail) {
          throw new Error('Device metadata did not match the server-managed state');
        }
        const actions = audits.docs.map((doc) => doc.data().action);
        for (const action of ['device_registered', 'device_revoked', 'device_credentials_updated']) {
          if (!actions.includes(action)) throw new Error(`Missing ${action} audit event`);
        }
      });

      const deleteResponse = await invokeHandler(deleteDeviceHandler, superAdminIdToken, 'DELETE', {
        targetUid: deviceUid,
      });
      if (deleteResponse.statusCode !== 200) throw new Error(deleteResponse.body);
      try {
        await adminAuth.getUser(deviceUid);
        throw new Error('Deleted device Auth account still exists');
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'auth/user-not-found') {
          throw error;
        }
      }
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const deletedDevice = await context.firestore().collection('devices').doc(deviceUid).get();
        if (deletedDevice.exists) throw new Error('Deleted device document still exists');
      });
    });
  });

  describe('Atomic pass creation and scanner transitions', () => {
    const futureVisitDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })
      .format(new Date(Date.now() + 86_400_000));
    const imageSuffix = (value: string, kind: 'photo' | 'id') =>
      Buffer.from(`${kind}-${value}`).toString('base64url').padEnd(16, 'x').slice(0, 128);
    const passRequest = (visitorId: string, passId: string) => ({
      visitorId,
      passId,
      firstName: 'Test',
      middleName: '',
      lastName: 'Visitor',
      contactNumber: '09171234567',
      purpose: 'Campus meeting',
      visitDate: futureVisitDate(),
      photoPublicId: `e-gatepass/photos/${imageSuffix(passId, 'photo')}`,
      idImagePublicId: `e-gatepass/ids/${imageSuffix(passId, 'id')}`,
    });
    const seedUploadSessions = async (ownerUid: string, request: ReturnType<typeof passRequest>) => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([request.photoPublicId, request.idImagePublicId].map((publicId) => {
          const uploadId = publicId.split('/').pop()!;
          return db.collection('imageUploads').doc(uploadId).set({
            ownerUid,
            actorType: ownerUid === 'kiosk_device' ? 'kiosk' : 'visitor',
            folder: publicId.substring(0, publicId.lastIndexOf('/')),
            publicId,
            deliveryType: 'authenticated',
            status: 'pending',
            createdAt: Timestamp.now(),
            expiresAt: futureTimestamp(),
          });
        }));
      });
    };

    it('uses the same configured Asia/Manila working hours for Portal and Kiosk passes', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('settings').doc('app').set({
          peakMode: false,
          workingHours: { start: '09:15', end: '16:30', timezone: 'Asia/Manila' },
        });
      });
      const portalRequest = passRequest('hours_portal_visitor', 'hours_portal_pass');
      const kioskRequest = passRequest('hours_kiosk_visitor', 'hours_kiosk_pass');
      await seedUploadSessions(anonymousUid, portalRequest);
      await seedUploadSessions('kiosk_device', kioskRequest);
      const portal = await invokeHandler(createPassHandler, anonymousIdToken, 'POST', portalRequest);
      const kiosk = await invokeHandler(createPassHandler, kioskDeviceIdToken, 'POST', kioskRequest);
      if (portal.statusCode !== 201 || kiosk.statusCode !== 201) throw new Error(`${portal.body}\n${kiosk.body}`);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [portalPass, kioskPass] = await Promise.all([
          db.collection('gatePasses').doc('hours_portal_pass').get(),
          db.collection('gatePasses').doc('hours_kiosk_pass').get(),
        ]);
        const expectedStart = new Date(`${portalRequest.visitDate}T09:15:00+08:00`).getTime();
        const expectedEnd = new Date(`${portalRequest.visitDate}T16:30:00+08:00`).getTime();
        for (const pass of [portalPass, kioskPass]) {
          if (pass.data()?.validFrom?.toMillis() !== expectedStart || pass.data()?.validUntil?.toMillis() !== expectedEnd) {
            throw new Error('Pass did not use the authoritative working-hours window');
          }
        }
      });
    });

    it('falls back to 08:00-17:00 when legacy settings omit working hours', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('settings').doc('app').set({ peakMode: false });
      });
      const request = passRequest('fallback_visitor', 'fallback_pass');
      await seedUploadSessions(anonymousUid, request);
      const response = await invokeHandler(createPassHandler, anonymousIdToken, 'POST', request);
      if (response.statusCode !== 201) throw new Error(response.body);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const pass = await context.firestore().collection('gatePasses').doc('fallback_pass').get();
        if (
          pass.data()?.validFrom?.toMillis() !== new Date(`${request.visitDate}T08:00:00+08:00`).getTime() ||
          pass.data()?.validUntil?.toMillis() !== new Date(`${request.visitDate}T17:00:00+08:00`).getTime()
        ) throw new Error('Legacy settings fallback was not applied');
      });
    });

    it('creates Portal visitor and pass atomically and makes retries idempotent', async () => {
      const request = passRequest('portal_visitor', 'portal_pass');
      await seedUploadSessions(anonymousUid, request);
      const created = await invokeHandler(createPassHandler, anonymousIdToken, 'POST', request);
      if (created.statusCode !== 201) throw new Error(created.body);
      const retried = await invokeHandler(createPassHandler, anonymousIdToken, 'POST', request);
      if (retried.statusCode !== 200 || !(JSON.parse(retried.body) as { idempotent?: boolean }).idempotent) {
        throw new Error(`Expected idempotent retry, received ${retried.statusCode}: ${retried.body}`);
      }

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [visitor, pass] = await Promise.all([
          db.collection('visitors').doc('portal_visitor').get(),
          db.collection('gatePasses').doc('portal_pass').get(),
        ]);
        if (!visitor.exists || !pass.exists) throw new Error('Atomic visitor/pass records are missing');
        if (visitor.data()?.createdByUid !== anonymousUid || pass.data()?.source !== 'portal') {
          throw new Error('Portal ownership or source was not derived from the anonymous identity');
        }
        if (visitor.data()?.photoDeliveryType !== 'authenticated' || pass.data()?.idImageDeliveryType !== 'authenticated') {
          throw new Error('Secure image delivery metadata was not preserved on the visitor and pass');
        }
        if (visitor.data()?.imagesExpireAt?.toMillis() < pass.data()?.validUntil?.toMillis()) {
          throw new Error('Pass validity outlived its identity-image retention');
        }
        if (pass.data()?.visitorId !== visitor.id || pass.data()?.status !== 'issued') {
          throw new Error('Portal pass lifecycle fields are invalid');
        }
      });
    });

    it('rate limits repeated anonymous pass creation without weakening normal requests', async () => {
      for (let index = 0; index < 4; index++) {
        const request = passRequest(`limited_visitor_${index}`, `limited_pass_${index}`);
        await seedUploadSessions(anonymousUid, request);
        const response = await invokeHandler(createPassHandler, anonymousIdToken, 'POST', request);
        if (index < 3 && response.statusCode !== 201) throw new Error(`Normal pass request ${index + 1} failed: ${response.body}`);
        if (index === 3 && response.statusCode !== 429) throw new Error(`Pass abuse was not rate limited: ${response.statusCode}`);
      }
    });

    it('allows an active Kiosk but rejects a staff account from pass creation', async () => {
      const kioskRequest = passRequest('kiosk_created_visitor', 'kiosk_created_pass');
      await seedUploadSessions('kiosk_device', kioskRequest);
      const kiosk = await invokeHandler(
        createPassHandler,
        kioskDeviceIdToken,
        'POST',
        kioskRequest,
      );
      if (kiosk.statusCode !== 201) throw new Error(kiosk.body);
      const staff = await invokeHandler(
        createPassHandler,
        adminIdToken,
        'POST',
        passRequest('staff_visitor', 'staff_pass'),
      );
      if (staff.statusCode !== 403) throw new Error(`Expected 403, received ${staff.statusCode}`);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const pass = await context.firestore().collection('gatePasses').doc('kiosk_created_pass').get();
        if (pass.data()?.source !== 'kiosk' || pass.data()?.createdByUid !== 'kiosk_device') {
          throw new Error('Kiosk source or ownership was not enforced');
        }
        const forbiddenVisitor = await context.firestore().collection('visitors').doc('staff_visitor').get();
        const forbiddenPass = await context.firestore().collection('gatePasses').doc('staff_pass').get();
        if (forbiddenVisitor.exists || forbiddenPass.exists) throw new Error('Rejected staff request wrote partial data');
      });
    });

    it('rejects invalid tokens without creating reconciliation noise', async () => {
      const response = await invokeHandler(
        createPassHandler,
        'invalid-token',
        'POST',
        passRequest('invalid_token_visitor', 'invalid_token_pass'),
      );
      if (response.statusCode !== 401) throw new Error(`Expected 401, received ${response.statusCode}`);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const tasks = await context.firestore().collection('reconciliationTasks').get();
        if (!tasks.empty) throw new Error('Invalid authentication created a reconciliation task');
      });
    });

    it('commits Entry and Exit transitions with their logs and enforces device mode', async () => {
      const baseExpiry = Timestamp.fromMillis(Date.now() + 86_400_000);
      const extendedExpiry = Timestamp.fromMillis(Date.now() + 10 * 86_400_000);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('gatePasses').doc('entry_atomic_pass').set({
            visitorId: 'entry_atomic_visitor',
            status: 'issued',
            validFrom: pastTimestamp(),
            validUntil: futureTimestamp(),
          }),
          db.collection('gatePasses').doc('exit_atomic_pass').set({
            visitorId: 'exit_atomic_visitor',
            status: 'inside',
          }),
          db.collection('visitors').doc('exit_atomic_visitor').set({
            baseImagesExpireAt: baseExpiry,
            imagesExpireAt: extendedExpiry,
          }),
        ]);
      });

      const wrongMode = await invokeHandler(scanPassHandler, entryDeviceIdToken, 'POST', {
        passId: 'exit_atomic_pass',
        mode: 'exit',
      });
      if (wrongMode.statusCode !== 403) throw new Error(`Expected device-mode denial, received ${wrongMode.statusCode}`);

      const entry = await invokeHandler(scanPassHandler, entryDeviceIdToken, 'POST', {
        passId: 'entry_atomic_pass',
        mode: 'entry',
      });
      if (entry.statusCode !== 200) throw new Error(entry.body);
      const exit = await invokeHandler(scanPassHandler, exitDeviceIdToken, 'POST', {
        passId: 'exit_atomic_pass',
        mode: 'exit',
      });
      if (exit.statusCode !== 200) throw new Error(exit.body);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [entryPass, exitPass, exitVisitor, entryLogs, exitLogs] = await Promise.all([
          db.collection('gatePasses').doc('entry_atomic_pass').get(),
          db.collection('gatePasses').doc('exit_atomic_pass').get(),
          db.collection('visitors').doc('exit_atomic_visitor').get(),
          db.collection('visitLogs').where('passToken', '==', 'entry_atomic_pass').get(),
          db.collection('visitLogs').where('passToken', '==', 'exit_atomic_pass').get(),
        ]);
        if (entryPass.data()?.status !== 'pending' || entryPass.data()?.entryDeviceId !== 'entry_device') {
          throw new Error('Entry transition did not commit');
        }
        if (exitPass.data()?.status !== 'exited' || exitPass.data()?.exitDeviceId !== 'exit_device') {
          throw new Error('Exit transition did not commit');
        }
        if (entryLogs.size !== 1 || entryLogs.docs[0].data().event !== 'scan_entry') {
          throw new Error('Entry transition log did not commit exactly once');
        }
        if (exitLogs.size !== 1 || exitLogs.docs[0].data().event !== 'scan_exit') {
          throw new Error('Exit transition log did not commit exactly once');
        }
        if (exitVisitor.data()?.imagesExpireAt?.toMillis() !== baseExpiry.toMillis()) {
          throw new Error('Exit did not return an extended image expiry to its creation-time policy deadline');
        }
      });
    });

    it('records invalid scans server-side without mutating another pass', async () => {
      const response = await invokeHandler(scanPassHandler, entryDeviceIdToken, 'POST', {
        passId: 'unknown_qr_payload',
        mode: 'entry',
      });
      if (response.statusCode !== 404) throw new Error(`Expected 404, received ${response.statusCode}`);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const logs = await context.firestore().collection('visitLogs').where('passToken', '==', 'unknown_qr_payload').get();
        if (logs.size !== 1 || logs.docs[0].data().event !== 'invalid_scan' || logs.docs[0].data().deviceId !== 'entry_device') {
          throw new Error('Invalid scan was not logged by the authenticated scanner');
        }
      });
    });

    it('keeps the existing Guard decision transaction behavior intact', async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('gatePasses').doc('guard_pending_pass').set({
          visitorId: 'guard_pending_visitor',
          status: 'pending',
          gate: 'Main Gate',
        });
      });
      const response = await invokeHandler(decideVisitHandler, guardIdToken, 'POST', {
        passId: 'guard_pending_pass',
        decision: 'approved',
        reason: null,
      });
      if (response.statusCode !== 200) throw new Error(response.body);

      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        const [pass, logs] = await Promise.all([
          db.collection('gatePasses').doc('guard_pending_pass').get(),
          db.collection('visitLogs').where('passToken', '==', 'guard_pending_pass').get(),
        ]);
        if (pass.data()?.status !== 'inside' || pass.data()?.decidedByUid !== 'guard_uid') {
          throw new Error('Guard approval transition did not commit');
        }
        if (logs.size !== 1 || logs.docs[0].data().event !== 'approved' || logs.docs[0].data().guardUid !== 'guard_uid') {
          throw new Error('Guard approval log did not commit atomically');
        }
      });
    });

    it('returns rejected-pass images to their original retention deadline', async () => {
      const baseExpiry = Timestamp.fromMillis(Date.now() + 86_400_000);
      const extendedExpiry = Timestamp.fromMillis(Date.now() + 10 * 86_400_000);
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('gatePasses').doc('guard_rejected_pass').set({
            visitorId: 'guard_rejected_visitor',
            status: 'pending',
            gate: 'Main Gate',
          }),
          db.collection('visitors').doc('guard_rejected_visitor').set({
            baseImagesExpireAt: baseExpiry,
            imagesExpireAt: extendedExpiry,
          }),
        ]);
      });
      const response = await invokeHandler(decideVisitHandler, guardIdToken, 'POST', {
        passId: 'guard_rejected_pass',
        decision: 'rejected',
        reason: 'Not expected today',
      });
      if (response.statusCode !== 200) throw new Error(response.body);
      const visitor = await getAdminFirestore().collection('visitors').doc('guard_rejected_visitor').get();
      if (visitor.data()?.imagesExpireAt?.toMillis() !== baseExpiry.toMillis()) {
        throw new Error('Rejected pass retained the future-pass image extension');
      }
    });
  });

  // ============================================================
  // 2. Visitors Collection
  // ============================================================
  describe('Visitors Collection', () => {
    it('anonymous visitor cannot create a visitor record directly -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('visitors').doc('my_visitor').set(REQUIRED_VISITOR_FIELDS));
    });

    it('anonymous visitor creates visitor with extra unauthorized field -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('visitors').doc('v2').set({
        ...REQUIRED_VISITOR_FIELDS,
        hackedField: true,
      }));
    });

    it('anonymous visitor creates visitor for different UID -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('visitors').add({
        ...REQUIRED_VISITOR_FIELDS,
        createdByUid: 'other_uid',
      }));
    });

    it('visitor missing required field (fullName) -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      const { fullName: _, ...incomplete } = REQUIRED_VISITOR_FIELDS;
      await assertFails(db.collection('visitors').doc('v3').set(incomplete));
    });

    it('visitor with empty firstName -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('visitors').doc('v4').set({
        ...REQUIRED_VISITOR_FIELDS,
        firstName: '',
      }));
    });
  });

  // ============================================================
  // 3. GatePass Creation - Source/Actor enforcement
  // ============================================================
  describe('GatePasses Creation - Source/Actor Enforcement', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        // Seed visitor owned by anon_uid
        await context.firestore().collection('visitors').doc('my_visitor').set({
          createdByUid: 'anon_uid',
        });
        // Seed visitor owned by kiosk_device
        await context.firestore().collection('visitors').doc('kiosk_visitor').set({
          createdByUid: 'kiosk_device',
        });
      });
    });

    it('anonymous visitor cannot create a portal pass directly -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('anon_uid')));
    });

    it.each(['password', 'google.com', 'phone', 'custom'])('unroled %s account with own visitor cannot create portal pass -> DENY', async (provider) => {
      const db = testEnv.authenticatedContext('anon_uid', {
        email_verified: true,
        isAnonymous: true, // A custom flag must not substitute for the Firebase provider.
        firebase: { sign_in_provider: provider as any, identities: {} },
      }).firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('anon_uid')));
    });

    it('account without an anonymous provider claim cannot create portal pass -> DENY', async () => {
      const db = testEnv.authenticatedContext('anon_uid', { isAnonymous: true }).firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('anon_uid')));
    });

    it('anonymous visitor creates kiosk pass -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidKioskPass('anon_uid')));
    });

    it('kiosk device cannot create a kiosk pass directly -> DENY', async () => {
      const db = getDeviceContext('kiosk_device').firestore();
      const pass = makeValidKioskPass('kiosk_device');
      pass.visitorId = 'kiosk_visitor'; // owned by kiosk_device
      await assertFails(db.collection('gatePasses').add(pass));
    });

    it('kiosk device creates portal pass -> DENY', async () => {
      const db = getDeviceContext('kiosk_device').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('kiosk_device')));
    });

    it('entry device creates any visitor pass -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('entry_device')));
      await assertFails(db.collection('gatePasses').add(makeValidKioskPass('entry_device')));
    });

    it('exit device creates any visitor pass -> DENY', async () => {
      const db = getDeviceContext('exit_device').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('exit_device')));
    });

    it('guard creates any visitor pass -> DENY', async () => {
      const db = getGuardContext('guard_uid').firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('guard_uid')));
    });

    it('admin creates visitor pass through client rules -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('gatePasses').add(makeValidPortalPass('admin_uid')));
    });
  });

  // ============================================================
  // 4. GatePass Creation - Schema validation
  // ============================================================
  describe('GatePasses Creation - Schema Validation', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection('visitors').doc('my_visitor').set({
          createdByUid: 'anon_uid',
        });
      });
    });

    it('missing required field (purpose) -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      const { purpose: _, ...incomplete } = makeValidPortalPass('anon_uid');
      await assertFails(db.collection('gatePasses').add(incomplete));
    });

    it('wrong field type (visitorName is number) -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        visitorName: 12345,
      }));
    });

    it('empty visitorName -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        visitorName: '',
      }));
    });

    it('validUntil <= validFrom -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      const now = futureTimestamp();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        validFrom: now,
        validUntil: now, // equal, not greater
      }));
    });

    it('validUntil < validFrom -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        validFrom: farFutureTimestamp(),
        validUntil: futureTimestamp(), // before validFrom
      }));
    });

    it('arbitrary extra field -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        hackedField: true,
      }));
    });

    it('status not "issued" -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        status: 'inside',
      }));
    });

    it('referencing another uid\'s visitor -> DENY', async () => {
      const db = getAnonContext('anon_uid').firestore();
      await assertFails(db.collection('gatePasses').add({
        ...makeValidPortalPass('anon_uid'),
        visitorId: 'other_visitor',
      }));
    });
  });

  describe('VisitLogs Creation', () => {
    const events = ['scan_entry', 'scan_exit', 'invalid_scan', 'approved', 'rejected'];
    function logFor(uid: string, event: string) {
      const guardEvent = ['approved', 'rejected'].includes(event);
      return {
        passToken: event === 'invalid_scan' ? 'unknown/QR content' : 'valid_pass',
        visitorId: event === 'invalid_scan' ? null : 'my_visitor',
        event,
        reason: ['invalid_scan', 'rejected'].includes(event) ? 'Scan or approval rejected' : null,
        deviceId: guardEvent ? null : uid,
        gate: 'Main Gate',
        guardUid: guardEvent ? uid : null,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      };
    }

    const actors = [
      { uid: 'entry_device', allowed: [] },
      { uid: 'exit_device', allowed: [] },
      { uid: 'guard_uid', allowed: [] },
      { uid: 'kiosk_device', allowed: [] },
      { uid: 'revoked_device', allowed: [] },
      { uid: 'inactive_guard', allowed: [] },
      { uid: 'admin_uid', allowed: [] },
      { uid: 'unroled_account', allowed: [] },
    ];
    for (const { uid, allowed } of actors) {
      it.each(events)(`${uid} event %s obeys role/device permissions`, async (event) => {
        const db = testEnv.authenticatedContext(uid, { email_verified: true }).firestore();
        const write = db.collection('visitLogs').add(logFor(uid, event));
        await (allowed.includes(event) ? assertSucceeds(write) : assertFails(write));
      });
    }

    it.each(['approved', 'rejected'])('Guard %s client audit write with nullable legacy pass gate -> DENY', async (event) => {
      await assertFails(getGuardContext().firestore().collection('visitLogs').add({
        ...logFor('guard_uid', event), gate: null,
      }));
    });

    it.each(['entry_device', 'exit_device'])('%s invalid scan client log write -> DENY', async (uid) => {
      await assertFails(getDeviceContext(uid).firestore().collection('visitLogs').add({
        ...logFor(uid, 'invalid_scan'), passToken: '',
      }));
    });

    it.each(Object.keys(logFor('entry_device', 'scan_entry')))('missing required field %s -> DENY', async (field) => {
      const data: Record<string, unknown> = logFor('entry_device', 'scan_entry');
      delete data[field];
      await assertFails(getDeviceContext('entry_device').firestore().collection('visitLogs').add(data));
    });

    it.each([
      { extra: true }, { passToken: 123 }, { passToken: '' }, { visitorId: 123 },
      { visitorId: null }, { visitorId: '' }, { event: 'invented' }, { event: 123 },
      { reason: 'unexpected reason' }, { deviceId: 123 }, { deviceId: null },
      { deviceId: 'exit_device' }, { guardUid: 'guard_uid' }, { guardUid: 123 },
      { gate: 123 }, { gate: null }, { timestamp: 'today' }, { timestamp: null },
    ])('malformed or forged Entry log %j -> DENY', async (patch) => {
      await assertFails(getDeviceContext('entry_device').firestore().collection('visitLogs').add({
        ...logFor('entry_device', 'scan_entry'), ...patch,
      }));
    });

    it.each([
      { guardUid: 'other_guard' }, { guardUid: null }, { guardUid: 123 },
      { deviceId: 'entry_device' }, { deviceId: 123 }, { gate: 123 },
    ])('malformed or forged Guard log %j -> DENY', async (patch) => {
      await assertFails(getGuardContext().firestore().collection('visitLogs').add({
        ...logFor('guard_uid', 'approved'), ...patch,
      }));
    });

    for (const event of ['invalid_scan', 'rejected']) {
      it.each([null, '', 123])(`${event} invalid reason %s -> DENY`, async (reason) => {
        const uid = event === 'rejected' ? 'guard_uid' : 'entry_device';
        await assertFails(testEnv.authenticatedContext(uid, { email_verified: true }).firestore().collection('visitLogs').add({
          ...logFor(uid, event), reason,
        }));
      });
    }

    it('invalid scan with non-null visitor -> DENY', async () => {
      await assertFails(getDeviceContext('entry_device').firestore().collection('visitLogs').add({
        ...logFor('entry_device', 'invalid_scan'), visitorId: 'my_visitor',
      }));
    });

    it('unverified Guard, anonymous visitor, and unauthenticated caller -> DENY', async () => {
      for (const context of [getGuardContext('guard_uid', false), getAnonContext(), testEnv.unauthenticatedContext()]) {
        await assertFails(context.firestore().collection('visitLogs').add(logFor('guard_uid', 'approved')));
      }
    });

    it('guards cannot create, update, or delete decision logs from the client', async () => {
      const ref = getGuardContext().firestore().collection('visitLogs').doc('log');
      await assertFails(ref.set(logFor('guard_uid', 'approved')));
      await assertFails(ref.update({ reason: 'changed' }));
      await assertFails(ref.delete());
    });
  });

  // ============================================================
  // 5. Scanner Updates and Protected Guard Decisions
  // ============================================================
  describe('GatePasses - Scanner Updates and Protected Guard Decisions', () => {
    beforeEach(async () => {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        // issued pass with expired validity (validUntil in the past)
        await db.collection('gatePasses').doc('expired_pass').set({
          status: 'issued',
          source: 'kiosk',
          validUntil: pastTimestamp(),
        });
        // issued pass still valid
        await db.collection('gatePasses').doc('valid_pass').set({
          status: 'issued',
          source: 'kiosk',
          validUntil: farFutureTimestamp(),
        });
        await db.collection('gatePasses').doc('pending_pass').set({ status: 'pending', source: 'kiosk' });
        await db.collection('gatePasses').doc('inside_pass').set({ status: 'inside', source: 'kiosk' });
        await db.collection('gatePasses').doc('exited_pass').set({ status: 'exited', source: 'kiosk' });
      });
    });

    // -- Entry device --
    it('Entry device direct issued -> pending transition -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'pending',
        scannedAt: Timestamp.now(),
        entryDeviceId: 'entry_device',
        gate: 'Main Gate',
      }));
    });

    it('Entry device writes another UID into entryDeviceId -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'pending',
        scannedAt: Timestamp.now(),
        entryDeviceId: 'some_other_device',
        gate: 'Main Gate',
      }));
    });

    it.each(['Other Gate', 'main gate', 'Main Gate ', '', null, 123])('Entry device issued -> pending with forged/invalid gate %s -> DENY', async (gate) => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'pending', scannedAt: Timestamp.now(), entryDeviceId: 'entry_device', gate,
      }));
    });

    it('Entry device direct expiry transition -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('expired_pass').update({
        status: 'expired',
      }));
    });

    it('Entry device marks unexpired issued pass as expired -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'expired',
      }));
    });

    it('Entry device tries issued -> exited -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'exited',
        scannedAt: Timestamp.now(),
        entryDeviceId: 'entry_device',
        gate: 'Main Gate',
      }));
    });

    it('Entry device modifies unrelated field -> DENY', async () => {
      const db = getDeviceContext('entry_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'pending',
        scannedAt: Timestamp.now(),
        entryDeviceId: 'entry_device',
        gate: 'Main Gate',
        visitorName: 'Hacked',
      }));
    });

    // -- Exit device --
    it('Exit device direct inside -> exited transition -> DENY', async () => {
      const db = getDeviceContext('exit_device').firestore();
      await assertFails(db.collection('gatePasses').doc('inside_pass').update({
        status: 'exited',
        timeOut: Timestamp.now(),
        exitDeviceId: 'exit_device',
      }));
    });

    it('Exit device writes another UID into exitDeviceId -> DENY', async () => {
      const db = getDeviceContext('exit_device').firestore();
      await assertFails(db.collection('gatePasses').doc('inside_pass').update({
        status: 'exited',
        timeOut: Timestamp.now(),
        exitDeviceId: 'some_other_device',
      }));
    });

    it('Exit device modifies unrelated field -> DENY', async () => {
      const db = getDeviceContext('exit_device').firestore();
      await assertFails(db.collection('gatePasses').doc('inside_pass').update({
        status: 'exited',
        timeOut: Timestamp.now(),
        exitDeviceId: 'exit_device',
        visitorName: 'Hacked',
      }));
    });

    // -- Guard decisions must go through the protected backend transaction --
    it('Guard client pending -> inside -> DENY', async () => {
      const db = getGuardContext('guard_uid').firestore();
      await assertFails(db.collection('gatePasses').doc('pending_pass').update({
        status: 'inside',
        timeIn: Timestamp.now(),
        decidedByUid: 'guard_uid',
      }));
    });

    it('Guard client pending -> rejected with reason -> DENY', async () => {
      const db = getGuardContext('guard_uid').firestore();
      await assertFails(db.collection('gatePasses').doc('pending_pass').update({
        status: 'rejected',
        rejectionReason: 'Fake ID',
        decidedByUid: 'guard_uid',
      }));
    });

    it('Guard rejects with empty rejectionReason -> DENY', async () => {
      const db = getGuardContext('guard_uid').firestore();
      await assertFails(db.collection('gatePasses').doc('pending_pass').update({
        status: 'rejected',
        rejectionReason: '',
        decidedByUid: 'guard_uid',
      }));
    });

    it('Guard sets decidedByUid to another user -> DENY', async () => {
      const db = getGuardContext('guard_uid').firestore();
      await assertFails(db.collection('gatePasses').doc('pending_pass').update({
        status: 'inside',
        timeIn: Timestamp.now(),
        decidedByUid: 'other_uid',
      }));
    });

    it('Admin client cannot bypass the protected decision endpoint -> DENY', async () => {
      const db = getAdminContext().firestore();
      await assertFails(db.collection('gatePasses').doc('pending_pass').update({
        status: 'inside',
        timeIn: Timestamp.now(),
        decidedByUid: 'admin_uid',
      }));
    });

    it('Kiosk device cannot arbitrarily update existing gate passes -> DENY', async () => {
      const db = getDeviceContext('kiosk_device').firestore();
      await assertFails(db.collection('gatePasses').doc('valid_pass').update({
        status: 'inside',
      }));
    });
  });

  describe('High-finding remediation integration', () => {
    it('keeps rate-limit and maintenance cursor state server-only', async () => {
      const db = getSuperAdminContext().firestore();
      await assertFails(db.collection('rateLimits').get());
      await assertFails(db.collection('rateLimits').doc('forged').set({ count: 0 }));
      await assertFails(db.collection('maintenanceState').get());
      await assertFails(db.collection('maintenanceState').doc('forged').set({ cursor: null }));
    });

    it('aligns image expiry with pass validity and closes back to the original policy deadline', () => {
      const now = Date.now();
      const short = calculateImageExpiry(now, 7, now + 86_400_000);
      const future = calculateImageExpiry(now, 7, now + 20 * 86_400_000);
      if (short.imagesExpireAt.toMillis() !== short.baseImagesExpireAt.toMillis()) {
        throw new Error('Short pass unexpectedly extended image retention');
      }
      if (future.imagesExpireAt.toMillis() !== now + 21 * 86_400_000) {
        throw new Error('Future pass was not protected through its safety margin');
      }
      const closedUpdate = closedPassImageExpiryUpdate({
        baseImagesExpireAt: future.baseImagesExpireAt,
        imagesExpireAt: future.imagesExpireAt,
      });
      if (closedUpdate?.imagesExpireAt.toMillis() !== future.baseImagesExpireAt.toMillis()) {
        throw new Error('Closed pass did not return to its creation-time retention policy');
      }
      if (!passProtectsImages('issued', Timestamp.fromMillis(now + 1_000), now)) throw new Error('Future issued pass was not protected');
      if (!passProtectsImages('pending', null, now) || !passProtectsImages('inside', null, now)) throw new Error('Active pass was not protected');
      for (const status of ['rejected', 'exited', 'expired']) {
        if (passProtectsImages(status, Timestamp.fromMillis(now + 1_000), now)) throw new Error(`Closed ${status} pass remained protected`);
      }
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(now));
      const tooFar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(now + 31 * 86_400_000));
      if (!isVisitDateWithinPolicy(today, now) || isVisitDateWithinPolicy(tooFar, now)) {
        throw new Error('Visit scheduling boundary was not enforced');
      }
    });

    it('enforces UID burst limits without incorrectly merging separate users or storing raw IPs', async () => {
      process.env.CRON_SECRET = 'test-only-rate-limit-hmac-key';
      const db = getAdminFirestore();
      const nowMillis = 1_800_000_000_000;
      for (let index = 0; index < 3; index++) {
        await enforceRateLimit(db, {
          operation: 'create_pass', actorType: 'visitor', uid: 'visitor-a',
          clientAddress: '203.0.113.10', nowMillis,
        });
      }
      try {
        await enforceRateLimit(db, {
          operation: 'create_pass', actorType: 'visitor', uid: 'visitor-a',
          clientAddress: '203.0.113.10', nowMillis,
        });
        throw new Error('Burst abuse was not rate limited');
      } catch (error) {
        if (!(error instanceof RateLimitError) || error.statusCode !== 429) throw error;
      }
      await enforceRateLimit(db, {
        operation: 'create_pass', actorType: 'visitor', uid: 'visitor-b',
        clientAddress: '203.0.113.10', nowMillis,
      });
      const stored = await db.collection('rateLimits').get();
      if (stored.empty || stored.docs.some((item) => JSON.stringify(item.data()).includes('203.0.113.10'))) {
        throw new Error('Rate-limit state is empty or contains a raw client address');
      }
    });

    it('deletes only a bounded page of expired rate-limit records and is safe to repeat', async () => {
      const db = getAdminFirestore();
      const expiredAt = AdminTimestamp.fromMillis(Date.now() - 1_000);
      const activeAt = AdminTimestamp.fromMillis(Date.now() + 86_400_000);
      const firstBatch = db.batch();
      for (let index = 0; index < 55; index++) {
        firstBatch.set(db.collection('rateLimits').doc(`expired_rate_limit_${String(index).padStart(2, '0')}`), {
          count: 1,
          expiresAt: AdminTimestamp.fromMillis(expiredAt.toMillis() - index),
        });
      }
      firstBatch.set(db.collection('rateLimits').doc('active_rate_limit'), { count: 1, expiresAt: activeAt });
      firstBatch.set(db.collection('visitors').doc('rate_limit_cleanup_unrelated'), { keep: true });
      await firstBatch.commit();

      const first = await cleanupExpiredRateLimits(db, 25);
      const second = await cleanupExpiredRateLimits(db, 25);
      const third = await cleanupExpiredRateLimits(db, 25);
      const fourth = await cleanupExpiredRateLimits(db, 25);
      if (
        first.scanned !== 25 || first.deleted !== 25 || !first.hasMore ||
        second.scanned !== 25 || second.deleted !== 25 || !second.hasMore ||
        third.scanned !== 5 || third.deleted !== 5 || third.hasMore ||
        fourth.scanned !== 0 || fourth.deleted !== 0 || fourth.failed !== 0
      ) {
        throw new Error(`Expired rate-limit cleanup was not bounded and idempotent: ${JSON.stringify({ first, second, third, fourth })}`);
      }
      const [active, unrelated, remainingExpired] = await Promise.all([
        db.collection('rateLimits').doc('active_rate_limit').get(),
        db.collection('visitors').doc('rate_limit_cleanup_unrelated').get(),
        db.collection('rateLimits').where('expiresAt', '<=', AdminTimestamp.now()).get(),
      ]);
      if (!active.exists || !unrelated.exists || !remainingExpired.empty) {
        throw new Error('Rate-limit cleanup affected active or unrelated records');
      }
    });

    it('advances past blocked historical records and eventually deletes later eligible records', async () => {
      const db = getAdminFirestore();
      const old = Date.now() - 60 * 86_400_000;
      for (let index = 0; index < 3; index++) {
        const visitorId = `cursor_visitor_${index}`;
        const passId = `cursor_pass_${index}`;
        await db.collection('visitors').doc(visitorId).set({
          imagesPurgedAt: index < 2 ? null : AdminTimestamp.now(),
        });
        await db.collection('gatePasses').doc(passId).set({
          visitorId,
          status: 'exited',
          issuedAt: AdminTimestamp.fromMillis(old + index * 1_000),
        });
      }
      const first = await cleanupHistoricalVisits(db, 30, 2);
      const second = await cleanupHistoricalVisits(db, 30, 2);
      if (first.scanned !== 2 || first.skipped !== 2 || !first.hasMore || second.deleted !== 1) {
        throw new Error(`Cleanup cursor did not make progress: ${JSON.stringify({ first, second })}`);
      }
      const [pass, visitor] = await Promise.all([
        db.collection('gatePasses').doc('cursor_pass_2').get(),
        db.collection('visitors').doc('cursor_visitor_2').get(),
      ]);
      if (pass.exists || visitor.exists) throw new Error('Later eligible records were not deleted parent-last');
      await cleanupHistoricalVisits(db, 30, 2);
    });

    it('advances past protected audit history instead of starving ordinary old events', async () => {
      const db = getAdminFirestore();
      const old = AdminTimestamp.fromMillis(Date.now() - 400 * 86_400_000);
      await db.collection('auditLogs').doc('protected_oldest').set({ action: 'initial_superadmin_bootstrapped', timestamp: old });
      await db.collection('auditLogs').doc('ordinary_later').set({ action: 'visitor_images_purged', timestamp: AdminTimestamp.fromMillis(old.toMillis() + 1_000) });
      const first = await cleanupAuditLogs(db, 365, 1);
      const second = await cleanupAuditLogs(db, 365, 1);
      if (first.skipped !== 1 || second.deleted !== 1) throw new Error('Protected audit event starved ordinary cleanup');
      if (!(await db.collection('auditLogs').doc('protected_oldest').get()).exists) throw new Error('Protected audit event was deleted');
    });

    it('migrates legacy delivery only for confirmed Super Admin batches and updates every reference', async () => {
      process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
      process.env.CLOUDINARY_API_KEY = 'test-key';
      process.env.CLOUDINARY_API_SECRET = 'test-secret';
      const publicId = 'e-gatepass/photos/migrationasset0001';
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('visitors').doc('migration_visitor').set({
            imagesPurgedAt: null,
            createdAt: Timestamp.fromMillis(Date.now() - 1_000),
            photoPublicId: publicId,
            photoDeliveryType: 'upload',
            idImagePublicId: null,
          }),
          db.collection('gatePasses').doc('migration_pass').set({
            visitorId: 'migration_visitor',
            photoPublicId: publicId,
            photoDeliveryType: 'upload',
            idImagePublicId: null,
            status: 'exited',
          }),
        ]);
      });
      const denied = await invokeHandler(migrateImageDeliveryHandler, adminIdToken, 'POST', { dryRun: true });
      const unconfirmed = await invokeHandler(migrateImageDeliveryHandler, superAdminIdToken, 'POST', { dryRun: false });
      if (denied.statusCode !== 403 || unconfirmed.statusCode !== 400) throw new Error('Migration authorization or confirmation failed');

      const rename = vi.spyOn(cloudinary.uploader, 'rename').mockResolvedValue({ type: 'authenticated' } as never);
      try {
        const dryRun = await invokeHandler(migrateImageDeliveryHandler, superAdminIdToken, 'POST', { dryRun: true });
        if (dryRun.statusCode !== 200 || rename.mock.calls.length !== 0) throw new Error('Dry-run mutated Cloudinary');
        const migrated = await invokeHandler(migrateImageDeliveryHandler, superAdminIdToken, 'POST', {
          dryRun: false,
          confirmation: 'MIGRATE LEGACY VISITOR IMAGES',
        });
        if (migrated.statusCode !== 200 || rename.mock.calls[0]?.[2]?.to_type !== 'authenticated') {
          throw new Error(`Migration failed: ${migrated.body}`);
        }
        const [visitor, pass] = await Promise.all([
          getAdminFirestore().collection('visitors').doc('migration_visitor').get(),
          getAdminFirestore().collection('gatePasses').doc('migration_pass').get(),
        ]);
        if (visitor.data()?.photoDeliveryType !== 'authenticated' || pass.data()?.photoDeliveryType !== 'authenticated') {
          throw new Error('Migrated delivery metadata did not update every reference');
        }
      } finally {
        rename.mockRestore();
      }
    });

    it('purges authenticated assets with their delivery type and reconciles partial deletion', async () => {
      process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
      process.env.CLOUDINARY_API_KEY = 'test-key';
      process.env.CLOUDINARY_API_SECRET = 'test-secret';
      const photo = 'e-gatepass/photos/securepurgephoto1';
      const idImage = 'e-gatepass/ids/securepurgeid0001';
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await db.collection('settings').doc('app').set({ imageRetentionDays: 1 });
        await db.collection('visitors').doc('secure_purge_visitor').set({
          imagesPurgedAt: null,
          createdAt: Timestamp.fromMillis(Date.now() - 5 * 86_400_000),
          imagesExpireAt: Timestamp.fromMillis(Date.now() - 1_000),
          photoPublicId: photo,
          idImagePublicId: idImage,
          photoDeliveryType: 'authenticated',
          idImageDeliveryType: 'authenticated',
        });
        await db.collection('gatePasses').doc('secure_purge_pass').set({
          visitorId: 'secure_purge_visitor',
          status: 'exited',
          validUntil: Timestamp.fromMillis(Date.now() - 86_400_000),
        });
      });
      const destroy = vi.spyOn(cloudinary.uploader, 'destroy')
        .mockResolvedValueOnce({ result: 'ok' } as never)
        .mockRejectedValueOnce(new Error('simulated second delete failure'));
      try {
        const response = await invokeHandler(purgeImagesHandler, superAdminIdToken, 'POST', {});
        if (response.statusCode !== 200 || destroy.mock.calls.some((call) => call[1]?.type !== 'authenticated')) {
          throw new Error(`Authenticated purge failed: ${response.body}`);
        }
        const [visitor, tasks] = await Promise.all([
          getAdminFirestore().collection('visitors').doc('secure_purge_visitor').get(),
          getAdminFirestore().collection('reconciliationTasks').where('targetUid', '==', 'secure_purge_visitor').get(),
        ]);
        if (visitor.data()?.imagesPurgedAt != null || tasks.empty) {
          throw new Error('Partial image deletion was finalized or hidden from reconciliation');
        }
      } finally {
        destroy.mockRestore();
      }
    });

    it('does not purge a due image while a future-valid issued pass still needs it', async () => {
      process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
      process.env.CLOUDINARY_API_KEY = 'test-key';
      process.env.CLOUDINARY_API_SECRET = 'test-secret';
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        await Promise.all([
          db.collection('settings').doc('app').set({ imageRetentionDays: 1 }),
          db.collection('visitors').doc('future_image_protection_visitor').set({
            imagesPurgedAt: null,
            createdAt: Timestamp.fromMillis(Date.now() - 5 * 86_400_000),
            imagesExpireAt: Timestamp.fromMillis(Date.now() - 1_000),
            photoPublicId: 'e-gatepass/photos/futureprotection001',
            photoDeliveryType: 'authenticated',
          }),
          db.collection('gatePasses').doc('future_image_protection_pass').set({
            visitorId: 'future_image_protection_visitor',
            status: 'issued',
            validUntil: Timestamp.fromMillis(Date.now() + 2 * 86_400_000),
          }),
        ]);
      });
      const destroy = vi.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' } as never);
      try {
        const response = await invokeHandler(purgeImagesHandler, superAdminIdToken, 'POST', {});
        if (response.statusCode !== 200 || destroy.mock.calls.length !== 0) {
          throw new Error(`Future-valid pass image was not protected: ${response.body}`);
        }
        const visitor = await getAdminFirestore().collection('visitors').doc('future_image_protection_visitor').get();
        if (visitor.data()?.imagesPurgedAt != null) throw new Error('Protected image was marked as purged');
      } finally {
        destroy.mockRestore();
      }
    });
  });
});
