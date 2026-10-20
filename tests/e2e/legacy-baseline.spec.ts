import { expect, test, type Page } from '@playwright/test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const projectId = 'e-gatepass-c1870';
const password = `${randomBytes(24).toString('base64url')}!Aa1`;
const evidenceDir = path.resolve('docs/evidence/s0-baseline/authenticated');

const actors = [
  { key: 'superadmin', email: 's0-superadmin@example.test', role: 'superadmin', route: '/admin', collection: 'users' },
  { key: 'admin', email: 's0-admin@example.test', role: 'admin', route: '/admin', collection: 'users' },
  { key: 'guard', email: 's0-guard@example.test', role: 'guard', route: '/guard', collection: 'users' },
  { key: 'kiosk', email: 's0-kiosk@example.test', role: 'kiosk', route: '/kiosk', collection: 'devices' },
  { key: 'entry', email: 's0-entry@example.test', role: 'entry', route: '/scan/entry', collection: 'devices' },
  { key: 'exit', email: 's0-exit@example.test', role: 'exit', route: '/scan/exit', collection: 'devices' },
] as const;

const actorHeading: Record<(typeof actors)[number]['key'], string> = {
  superadmin: 'Dashboard',
  admin: 'Dashboard',
  guard: 'Guard Queue',
  kiosk: 'Walk-in Registration Kiosk',
  entry: 'Synthetic Main Gate',
  exit: 'Synthetic Main Gate',
};

const adminHeadings: Record<string, string> = {
  visitors: 'Visitor Records',
  devices: 'Devices',
  users: 'User Management',
  emergency: 'Emergency Evacuation List',
  audit: 'Audit and Activity',
  settings: 'System Settings',
};

async function login(page: Page, actor: (typeof actors)[number]) {
  await page.goto('/login');
  await page.getByLabel('Email or Device Username').fill(actor.email);
  await page.locator('#login-password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(new RegExp(`${actor.route.replaceAll('/', '\\/')}$`));
  await expect(page.getByRole('heading', { name: actorHeading[actor.key], exact: true })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('Legacy baseline E2E must run only inside Firebase Auth and Firestore emulators.');
  }

  const app = getApps()[0] ?? initializeApp({ projectId });
  const auth = getAuth(app);
  const db = getFirestore(app);
  await mkdir(evidenceDir, { recursive: true });

  for (const actor of actors) {
    const user = await auth.createUser({
      email: actor.email,
      emailVerified: true,
      password,
      displayName: `S0 ${actor.key}`,
    });

    if (actor.collection === 'users') {
      await db.collection('users').doc(user.uid).set({
        name: `S0 ${actor.key}`,
        email: actor.email,
        role: actor.role,
        active: true,
        mustChangePassword: false,
        privacyAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      await db.collection('devices').doc(user.uid).set({
        name: `S0 ${actor.key} device`,
        email: actor.email,
        type: actor.role,
        gate: 'Synthetic Main Gate',
        status: 'active',
        createdBy: 's0-e2e',
        createdAt: FieldValue.serverTimestamp(),
        lastSeen: null,
      });
    }
  }

  await db.collection('settings').doc('app').set({
    workingHours: { start: '08:00', end: '17:00', timezone: 'Asia/Manila' },
    rejectionReasons: ['Invalid identification'],
    visitPurposes: [{ label: 'Synthetic test visit', requiresDetails: false, detailPrompt: '' }],
    retentionDays: 7,
    peakMode: false,
  });
});

test('public landing exposes no staff or device navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Get Your Gate Pass', exact: true }).first()).toBeVisible();
  for (const forbidden of ['Staff Sign In', 'Device Login', 'Kiosk', 'Entry Scanner', 'Exit Scanner']) {
    await expect(page.getByRole('link', { name: forbidden, exact: true })).toHaveCount(0);
  }
});

for (const actor of actors) {
  test(`${actor.key} authenticates to the original role route`, async ({ page }) => {
    await login(page, actor);
    await page.screenshot({ path: path.join(evidenceDir, `${actor.key}.png`), fullPage: true });
  });
}

test('entry device cannot open the Admin console', async ({ page }) => {
  const actor = actors.find((candidate) => candidate.key === 'entry')!;
  await login(page, actor);
  await page.goto('/admin');
  await expect(page).not.toHaveURL(/\/admin(?:\/|$)/);
  await expect(page).toHaveURL(/\/scan\/entry$/);
});

test('Admin tabs render from the isolated baseline data', async ({ page }) => {
  const actor = actors.find((candidate) => candidate.key === 'admin')!;
  await login(page, actor);
  for (const route of ['visitors', 'devices', 'users', 'emergency', 'audit', 'settings']) {
    await page.goto(`/admin/${route}`);
    await expect(page).toHaveURL(new RegExp(`/admin/${route}$`));
    await expect(page.getByRole('heading', { name: adminHeadings[route], exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidenceDir, `admin-${route}.png`), fullPage: true });
  }
});
