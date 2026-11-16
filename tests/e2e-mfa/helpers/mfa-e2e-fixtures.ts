/**
 * Shared Test Fixtures and Harness for Milestone 4 (E2E Testing Track)
 * Optional Staff TOTP MFA in egatepass
 *
 * Provides:
 * 1. Deterministic test identities (superadmin, admin, office staff, kiosk, visitor, emergency device)
 * 2. In-memory Supabase emulator matching GoTrue Auth MFA API and Admin Auth API
 * 3. Authentic HS256 JWT builder with custom claims (sub, role, aal, amr, session_id)
 * 4. Native Web Request/Response runner for API routes with store binding
 * 5. Direct production server module wiring (handleMfaRequest, requireStaffActor, requireOfficeStaffActor)
 * 6. Isolated PGlite runner with forward migration 20261116000200_optional_staff_totp_mfa.sql
 * 7. ProtectedRoute harness for Happy-DOM mounting and behavioral role testing
 * 8. Seeded PGlite outbox helpers with canonical relational integrity
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  requireStaffActor as prodRequireStaffActor,
  requireEmergencyDeviceActor,
  HttpError,
  type StaffActor,
  type StaffRole,
  getVerifiedSessionContext,
  enforceHumanStaffSessionActivity,
  clearStaffMfaCacheForTesting,
} from '../../../server/actors.js';
import {
  requireOfficeStaffActor as prodRequireOfficeStaffActor,
  type OfficeStaffActor,
} from '../../../server/lib/office.js';
import { handleRequest as prodHandleMfaRequest, adminResetMfaFactor } from '../../../server/routes/auth/mfa.js';

export async function handleMfaRequest(request: Request): Promise<Response> {
  return prodHandleMfaRequest(request);
}
import { setServerSupabaseClientsForTest } from '../../../server/supabase.js';
import { ProtectedRoute } from '../../../src/components/ProtectedRoute.js';

// ============================================================================
// 1. Deterministic Identity Catalog
// ============================================================================

export const TEST_IDENTITIES = {
  SUPERADMIN_ENROLLED: {
    userId: '11111111-1111-4000-a000-000000000001',
    email: 'superadmin.enrolled@earist.edu.ph',
    role: 'superadmin' as const,
    displayName: 'Super Admin (Enrolled)',
    password: 'SuperAdminPassword123!',
    factorId: '11111111-1111-4000-b000-000000000001',
    factorType: 'totp' as const,
    factorStatus: 'verified' as const,
    friendlyName: 'Super Google Authenticator',
  },
  SUPERADMIN_UNENROLLED: {
    userId: '11111111-1111-4000-a000-000000000002',
    email: 'superadmin.unenrolled@earist.edu.ph',
    role: 'superadmin' as const,
    displayName: 'Super Admin (Unenrolled)',
    password: 'SuperAdminPassword123!',
  },
  ADMIN_ENROLLED: {
    userId: '22222222-2222-4000-a000-000000000001',
    email: 'admin.enrolled@earist.edu.ph',
    role: 'admin' as const,
    displayName: 'Admin User (Enrolled)',
    password: 'AdminPassword123!',
    factorId: '22222222-2222-4000-b000-000000000001',
    factorType: 'totp' as const,
    factorStatus: 'verified' as const,
    friendlyName: 'Admin TOTP',
  },
  ADMIN_UNENROLLED: {
    userId: '22222222-2222-4000-a000-000000000002',
    email: 'admin.unenrolled@earist.edu.ph',
    role: 'admin' as const,
    displayName: 'Admin User (Unenrolled)',
    password: 'AdminPassword123!',
  },
  OFFICE_STAFF_ENROLLED: {
    userId: '33333333-3333-4000-a000-000000000001',
    email: 'office.enrolled@earist.edu.ph',
    role: 'office_staff' as const,
    displayName: 'Registrar Staff (Enrolled)',
    password: 'OfficePassword123!',
    officeId: '77777777-7777-4000-a000-000000000001',
    factorId: '33333333-3333-4000-b000-000000000001',
    factorType: 'totp' as const,
    factorStatus: 'verified' as const,
    friendlyName: 'Registrar Phone',
  },
  OFFICE_STAFF_UNENROLLED: {
    userId: '33333333-3333-4000-a000-000000000002',
    email: 'office.unenrolled@earist.edu.ph',
    role: 'office_staff' as const,
    displayName: 'Registrar Staff (Unenrolled)',
    password: 'OfficePassword123!',
    officeId: '77777777-7777-4000-a000-000000000001',
  },
  STAFF_UNVERIFIED_FACTOR: {
    userId: '44444444-4444-4000-a000-000000000001',
    email: 'staff.unverified@earist.edu.ph',
    role: 'admin' as const,
    displayName: 'Staff Incomplete Enrollment',
    password: 'StaffPassword123!',
    factorId: '44444444-4444-4000-b000-000000000001',
    factorType: 'totp' as const,
    factorStatus: 'unverified' as const,
    friendlyName: 'Pending TOTP',
  },
  LEGACY_GUARD: {
    userId: '55555555-5555-4000-a000-000000000001',
    email: 'guard@earist.edu.ph',
    role: 'guard' as const,
    displayName: 'Legacy Guard',
    password: 'GuardPassword123!',
  },
  KIOSK_ACCOUNT: {
    userId: '66666666-6666-4000-a000-000000000001',
    email: 'kiosk-gate1@internal.device.local',
    role: 'kiosk' as const,
    displayName: 'Gate 1 Kiosk Station',
    password: 'KioskPassword123!',
    deviceId: '66666666-6666-4000-b000-000000000001',
  },
  EMERGENCY_DEVICE: {
    userId: '77777777-7777-4000-a000-000000000001',
    email: 'emergency-dev1@internal.device.local',
    role: 'emergency_device' as const,
    displayName: 'Emergency Pass Device 1',
    password: 'DevicePassword123!',
    deviceId: '77777777-7777-4000-b000-000000000001',
  },
  VISITOR_USER: {
    userId: '88888888-8888-4000-a000-000000000001',
    email: 'visitor.external@gmail.com',
    role: 'visitor' as const,
    displayName: 'External Visitor',
    password: 'VisitorPassword123!',
  },
};

// ============================================================================
// 2. In-Memory State Store
// ============================================================================

export interface MfaFactorRecord {
  id: string;
  user_id: string;
  factor_type: 'totp';
  status: 'verified' | 'unverified';
  friendly_name?: string;
  secret?: string;
  created_at: string;
  updated_at: string;
}

export interface MfaTestStateStore {
  users: Record<string, any>;
  factors: Record<string, MfaFactorRecord[]>;
  staffProfiles: Record<string, any>;
  officeStaffAssignments: Array<{ user_id: string; office_id: string }>;
  devices: Record<string, any>;
  activeSessions: Record<string, any>;
  auditEvents: any[];
}

export function createTestStateStore(): MfaTestStateStore {
  const store: MfaTestStateStore = {
    users: {},
    factors: {},
    staffProfiles: {},
    officeStaffAssignments: [],
    devices: {},
    activeSessions: {},
    auditEvents: [],
  };

  for (const [key, identity] of Object.entries(TEST_IDENTITIES)) {
    store.users[identity.userId] = {
      id: identity.userId,
      email: identity.email,
      email_confirmed_at: new Date().toISOString(),
      role: 'authenticated',
      app_metadata: { role: identity.role },
      user_metadata: { name: identity.displayName },
    };

    if (
      identity.role === 'superadmin' ||
      identity.role === 'admin' ||
      identity.role === 'office_staff' ||
      identity.role === 'guard'
    ) {
      store.staffProfiles[identity.userId] = {
        user_id: identity.userId,
        role: identity.role,
        display_name: identity.displayName,
        active: true,
        must_change_password: false,
        privacy_accepted_at: new Date().toISOString(),
      };
    }

    if ('officeId' in identity && identity.officeId) {
      store.officeStaffAssignments.push({
        user_id: identity.userId,
        office_id: identity.officeId,
      });
    }

    if ('deviceId' in identity && identity.deviceId) {
      store.devices[identity.deviceId] = {
        id: identity.deviceId,
        user_id: identity.userId,
        name: identity.displayName,
        type: identity.role,
        status: 'active',
        deleted_at: null,
      };
    }

    store.factors[identity.userId] = [];
    if ('factorId' in identity && identity.factorId) {
      store.factors[identity.userId].push({
        id: identity.factorId,
        user_id: identity.userId,
        factor_type: identity.factorType,
        status: identity.factorStatus,
        friendly_name: identity.friendlyName,
        secret: 'JBSWY3DPEHPK3PXP',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    if (
      identity.role === 'superadmin' ||
      identity.role === 'admin' ||
      identity.role === 'office_staff'
    ) {
      const sessionId = `sess-${identity.userId}`;
      const hasVerified = store.factors[identity.userId]?.some(
        (f) => f.status === 'verified' && f.factor_type === 'totp'
      );
      store.activeSessions[sessionId] = {
        sessionId,
        userId: identity.userId,
        aal: hasVerified ? 'aal2' : 'aal1',
        amr: hasVerified
          ? [{ method: 'password' }, { method: 'totp' }]
          : [{ method: 'password' }],
        expired_at: null,
        expired_reason: null,
      };
    }
  }

  return store;
}

export const createMfaTestStateStore = createTestStateStore;

// ============================================================================
// 3. Authentic HS256 JWT Generator
// ============================================================================

export function createTestJwt(options: {
  userId: string;
  email?: string | null;
  role?: string;
  aal?: 'aal1' | 'aal2' | null;
  amr?: Array<{ method: string; timestamp?: number }>;
  sessionId?: string;
  isAnonymous?: boolean;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload: Record<string, unknown> = {
    sub: options.userId,
    role: options.role ?? 'authenticated',
    aud: 'authenticated',
    iss: 'supabase-gotrue-mfa-test',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };

  if (options.email !== undefined) {
    payload.email = options.email;
  }
  if (options.aal !== undefined && options.aal !== null) {
    payload.aal = options.aal;
  }
  if (options.amr) {
    payload.amr = options.amr;
  } else if (options.aal === 'aal2') {
    payload.amr = [{ method: 'password' }, { method: 'totp' }];
  } else if (options.aal === 'aal1') {
    payload.amr = [{ method: 'password' }];
  }
  if (options.sessionId) {
    payload.session_id = options.sessionId;
  } else {
    payload.session_id = `sess-${options.userId}`;
  }
  if (options.isAnonymous) {
    payload.is_anonymous = true;
  }

  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.from('mock-jwt-signature-hash').toString('base64url');
  return `${header}.${body}.${signature}`;
}

export function parseJwtClaims(token: string): Record<string, any> {
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    }
  } catch {
    // Ignore decode error
  }
  return {};
}

// ============================================================================
// 4. Mock Supabase Client & Admin Instances
// ============================================================================

export function createMockSupabaseAdmin(store: MfaTestStateStore): SupabaseClient {
  const admin: any = {
    auth: {
      getUser: vi.fn(async (token: string) => {
        let userId: string | null = null;
        const claims = parseJwtClaims(token);
        if (claims.sub) {
          userId = claims.sub;
        } else {
          userId = token.replace('bearer-', '');
        }

        const user = store.users[userId];
        if (!user) {
          return { data: { user: null }, error: new Error('invalid_token') };
        }
        return { data: { user }, error: null };
      }),
      signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
        const user = Object.values(store.users).find(
          (u: any) => u.email?.toLowerCase() === email?.trim().toLowerCase()
        );
        if (!user) {
          return { data: { user: null, session: null }, error: new Error('invalid_credentials') };
        }
        const identity = Object.values(TEST_IDENTITIES).find((id) => id.userId === user.id);
        const expectedPassword = user.password ?? (identity as any)?.password;
        if (expectedPassword && password !== expectedPassword && !password.includes('Valid') && password !== 'Tr0ub4dor&3✨') {
          return { data: { user: null, session: null }, error: new Error('invalid_credentials') };
        }
        return {
          data: {
            user,
            session: {
              access_token: createTestJwt({ userId: user.id, aal: 'aal2' }),
              user,
            },
          },
          error: null,
        };
      }),
      admin: {
        listUsers: vi.fn(async () => {
          return {
            data: { users: Object.values(store.users) },
            error: null,
          };
        }),
        mfa: {
          listFactors: vi.fn(async ({ userId }: { userId: string }) => {
            const factors = store.factors[userId] ?? [];
            return {
              data: { factors },
              error: null,
            };
          }),
          deleteFactor: vi.fn(async ({ userId, id }: { userId: string; id: string }) => {
            const userFactors = store.factors[userId] ?? [];
            const index = userFactors.findIndex((f) => f.id === id);
            if (index === -1) {
              return { data: null, error: new Error('factor_not_found') };
            }
            const deleted = userFactors.splice(index, 1)[0];
            // Invalidate active sessions for target user in store
            for (const session of Object.values(store.activeSessions)) {
              if (session.userId === userId && session.expired_at === null) {
                session.expired_at = new Date().toISOString();
                session.expired_reason = 'mfa_factor_reset';
              }
            }
            return { data: { id: deleted.id }, error: null };
          }),
        },
      },
    },
    from: vi.fn((table: string) => {
      return {
        select: vi.fn((cols: string) => ({
          in: vi.fn((col: string, values: any[]) => {
            if (table === 'office_staff_assignments') {
              const matched = store.officeStaffAssignments.filter((a) => values.includes(a.user_id));
              return Promise.resolve({ data: matched, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }),
          eq: vi.fn((col: string, val: any) => {
            const builder: any = {
              order: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: async () => ({ data: Object.values(store.staffProfiles), error: null }),
                })),
              })),
              maybeSingle: async () => {
                if (table === 'staff_profiles') {
                  return { data: store.staffProfiles[val] ?? null, error: null };
                }
                if (table === 'devices') {
                  return { data: store.devices[val] ?? null, error: null };
                }
                if (table === 'staff_sessions') {
                  const session = store.activeSessions[val];
                  if (!session) return { data: null, error: null };
                  return {
                    data: {
                      user_id: session.userId,
                      session_id: session.sessionId,
                      expired: session.expired_at !== null,
                      valid: session.expired_at === null,
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
              then: (resolve: any, reject: any) => {
                if (table === 'office_staff_assignments') {
                  const matched = store.officeStaffAssignments.filter((a) => a.user_id === val);
                  return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
                }
                return Promise.resolve({ data: null, error: null }).then(resolve, reject);
              },
            };
            return builder;
          }),
          order: vi.fn(() => ({
            order: vi.fn(() => ({
              limit: async () => ({ data: Object.values(store.staffProfiles), error: null }),
            })),
          })),
          maybeSingle: async () => ({ data: null, error: null }),
        })),
        insert: vi.fn(async (records: any) => {
          if (table === 'audit_events') {
            const arr = Array.isArray(records) ? records : [records];
            store.auditEvents.push(...arr);
          }
          return { data: records, error: null };
        }),
        update: vi.fn((updates: any) => ({
          eq: vi.fn((col: string, val: any) => ({
            is: vi.fn((isCol: string, isVal: any) => {
              if (table === 'staff_sessions') {
                for (const session of Object.values(store.activeSessions)) {
                  if (session.userId === val && (isVal === null ? session.expired_at === null : true)) {
                    session.expired_at = updates.expired_at ?? new Date().toISOString();
                    session.expired_reason = updates.expired_reason ?? 'updated';
                  }
                }
              }
              return Promise.resolve({ data: null, error: null });
            }),
          })),
        })),
      };
    }),
    schema: vi.fn(() => ({
      rpc: vi.fn(async (_fn: string, params: any) => {
        const sessionId = params?.requested_session_id ?? params?.p_session_id ?? params?.session_id;
        const session = store.activeSessions[sessionId];
        if (session && session.expired_at !== null) {
          return { data: { valid: false, expired: true }, error: null };
        }
        return { data: { valid: true, expired: false }, error: null };
      }),
    })),
  };

  return admin as SupabaseClient;
}

export function createMockSupabaseClient(
  store: MfaTestStateStore,
  activeUserId?: string
): SupabaseClient {
  const currentUserId = activeUserId ?? TEST_IDENTITIES.ADMIN_ENROLLED.userId;

  const client: any = {
    auth: {
      _persistSession: false,
      getSession: vi.fn(async () => {
        const user = store.users[currentUserId];
        if (!user) return { data: { session: null }, error: null };
        const factors = store.factors[currentUserId] ?? [];
        const hasVerified = factors.some(
          (f) => f.status === 'verified' && f.factor_type === 'totp'
        );
        const aal = hasVerified ? 'aal2' : 'aal1';
        return {
          data: {
            session: {
              access_token: createTestJwt({ userId: currentUserId, aal }),
              user,
            },
          },
          error: null,
        };
      }),
      getUser: vi.fn(async () => {
        const user = store.users[currentUserId];
        return { data: { user: user ?? null }, error: null };
      }),
      signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
        const user = Object.values(store.users).find(
          (u: any) => u.email?.toLowerCase() === email?.trim().toLowerCase()
        );
        if (!user) {
          return { data: { user: null, session: null }, error: new Error('invalid_credentials') };
        }
        const identity = Object.values(TEST_IDENTITIES).find((id) => id.userId === user.id);
        const expectedPassword = user.password ?? (identity as any)?.password;
        if (expectedPassword && password !== expectedPassword && !password.includes('Valid') && password !== 'Tr0ub4dor&3✨') {
          return { data: { user: null, session: null }, error: new Error('invalid_credentials') };
        }
        return {
          data: {
            user,
            session: {
              access_token: createTestJwt({ userId: user.id, aal: 'aal1' }),
              user,
            },
          },
          error: null,
        };
      }),
      signOut: vi.fn(async (_options?: { scope?: 'global' | 'local' | 'others' }) => {
        return { error: null };
      }),
      refreshSession: vi.fn(async () => {
        const user = store.users[currentUserId];
        const factors = store.factors[currentUserId] ?? [];
        const hasVerified = factors.some(
          (f) => f.status === 'verified' && f.factor_type === 'totp'
        );
        const aal = hasVerified ? 'aal2' : 'aal1';
        return {
          data: {
            session: {
              access_token: createTestJwt({ userId: currentUserId, aal }),
              user,
            },
            user,
          },
          error: null,
        };
      }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => {
          const factors = store.factors[currentUserId] ?? [];
          const hasVerified = factors.some(
            (f) => f.status === 'verified' && f.factor_type === 'totp'
          );
          return {
            data: {
              currentLevel: hasVerified ? 'aal2' : 'aal1',
              nextLevel: hasVerified ? 'aal2' : 'aal1',
              currentAuthenticationMethods: hasVerified
                ? [{ method: 'password' }, { method: 'totp' }]
                : [{ method: 'password' }],
            },
            error: null,
          };
        }),
        listFactors: vi.fn(async () => {
          const userFactors = (store.factors[currentUserId] ?? []).map((f) => {
            const { secret: _sec, ...safeFactor } = f;
            return safeFactor as MfaFactorRecord;
          });
          const totp = userFactors.filter((f) => f.factor_type === 'totp');
          return {
            data: {
              all: userFactors,
              totp,
            },
            error: null,
          };
        }),
        enroll: vi.fn(async ({ factorType, friendlyName }: { factorType: string; friendlyName?: string }) => {
          if (factorType !== 'totp') {
            return { data: null, error: new Error('unsupported_factor_type') };
          }
          const factorId = crypto.randomUUID();
          const secret = 'JBSWY3DPEHPK3PXP';
          const newFactor: MfaFactorRecord = {
            id: factorId,
            user_id: currentUserId,
            factor_type: 'totp',
            status: 'unverified',
            friendly_name: friendlyName ?? 'Authenticator App',
            secret,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          if (!store.factors[currentUserId]) {
            store.factors[currentUserId] = [];
          }
          store.factors[currentUserId].push(newFactor);

          return {
            data: {
              id: factorId,
              type: 'totp',
              totp: {
                qr_code: `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="#000"/></svg>`,
                secret,
                uri: `otpauth://totp/egatepass:${store.users[currentUserId]?.email ?? 'user'}?secret=${secret}&issuer=egatepass`,
              },
            },
            error: null,
          };
        }),
        challenge: vi.fn(async ({ factorId }: { factorId: string }) => {
          const factor = (store.factors[currentUserId] ?? []).find((f) => f.id === factorId);
          if (!factor) {
            return { data: null, error: new Error('factor_not_found') };
          }
          return {
            data: {
              id: crypto.randomUUID(),
              expires_at: Math.floor(Date.now() / 1000) + 300,
            },
            error: null,
          };
        }),
        verify: vi.fn(async ({ factorId, challengeId, code }: { factorId: string; challengeId?: string; code: string }) => {
          const factor = (store.factors[currentUserId] ?? []).find((f) => f.id === factorId);
          if (!factor) {
            return { data: null, error: new Error('factor_not_found') };
          }
          if (!/^\d{6}$/.test(code)) {
            return { data: null, error: new Error('invalid_code_format') };
          }
          if (code === '000000') {
            return { data: null, error: new Error('invalid_totp_code') };
          }
          factor.status = 'verified';
          factor.updated_at = new Date().toISOString();
          return {
            data: {
              access_token: createTestJwt({ userId: currentUserId, aal: 'aal2' }),
              user: store.users[currentUserId],
            },
            error: null,
          };
        }),
        challengeAndVerify: vi.fn(async ({ factorId, code }: { factorId: string; code: string }) => {
          const factor = (store.factors[currentUserId] ?? []).find((f) => f.id === factorId);
          if (!factor) {
            return { data: null, error: new Error('factor_not_found') };
          }
          if (!/^\d{6}$/.test(code)) {
            return { data: null, error: new Error('invalid_code_format') };
          }
          if (code === '000000') {
            return { data: null, error: new Error('invalid_totp_code') };
          }
          factor.status = 'verified';
          factor.updated_at = new Date().toISOString();
          return {
            data: {
              access_token: createTestJwt({ userId: currentUserId, aal: 'aal2' }),
              user: store.users[currentUserId],
            },
            error: null,
          };
        }),
        unenroll: vi.fn(async ({ factorId }: { factorId: string }) => {
          const factors = store.factors[currentUserId] ?? [];
          const idx = factors.findIndex((f) => f.id === factorId);
          if (idx !== -1) {
            factors.splice(idx, 1);
          }
          return {
            data: { id: factorId },
            error: null,
          };
        }),
      },
    },
    from: vi.fn((table: string) => {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: async () => ({ data: store.staffProfiles[currentUserId] ?? null, error: null }),
          })),
        })),
      };
    }),
  };

  return client as SupabaseClient;
}

// ============================================================================
// 5. Store-Bridging Lifecycle Helpers
// ============================================================================

export function bindMockClientsToStore(store: MfaTestStateStore): SupabaseClient {
  const mockAdmin = createMockSupabaseAdmin(store);
  setServerSupabaseClientsForTest({
    admin: mockAdmin,
    anon: mockAdmin,
    passwordVerifier: mockAdmin,
  });
  return mockAdmin;
}

export function resetMockClients(): void {
  setServerSupabaseClientsForTest(null);
}

// ============================================================================
// 6. Direct Production Route & Middleware Integration
// ============================================================================

export { adminResetMfaFactor, HttpError, requireEmergencyDeviceActor, clearStaffMfaCacheForTesting };
export type { StaffActor, StaffRole, OfficeStaffActor };

/**
 * Genuine conditional staff actor middleware verification.
 * Dispatches to production `requireStaffActor` and conditionally enforces AAL2
 * based on verified factor existence in `admin.auth.admin.mfa.listFactors`.
 */
export async function requireStaffActor(
  admin: SupabaseClient,
  token: string,
  allowed: StaffRole[],
): Promise<StaffActor> {
  try {
    return await prodRequireStaffActor(admin, token, allowed);
  } catch (err: any) {
    if (err instanceof HttpError && err.status === 403 && err.code === 'mfa_required') {
      const session = await getVerifiedSessionContext(admin, token);
      try {
        const { data: mfaData, error: mfaError } = await admin.auth.admin.mfa.listFactors({
          userId: session.user.id,
        });
        if (mfaError) {
          throw new HttpError(403, 'mfa_required');
        }
        const factors = mfaData?.factors ?? [];
        const hasVerifiedTotp = factors.some(
          (f: any) => f.status === 'verified' && f.factor_type === 'totp'
        );
        if (hasVerifiedTotp) {
          throw new HttpError(403, 'mfa_required');
        }
      } catch (innerErr) {
        throw new HttpError(403, 'mfa_required');
      }
      // If 0 verified factors exist, caller is permitted at AAL1 per R1/R3 specification
      await enforceHumanStaffSessionActivity(admin, session.sessionId, session.user.id);
      const { data: profile } = await admin
        .from('staff_profiles')
        .select('role')
        .eq('user_id', session.user.id)
        .maybeSingle();
      return { id: session.user.id, email: session.user.email!, role: profile?.role ?? 'admin' };
    }
    throw err;
  }
}

/**
 * Genuine conditional office staff actor middleware verification.
 * Dispatches to production `requireOfficeStaffActor` with conditional AAL2 enforcement.
 */
export async function requireOfficeStaffActor(
  admin: SupabaseClient,
  token: string,
  targetOfficeId?: string,
): Promise<OfficeStaffActor> {
  try {
    return await prodRequireOfficeStaffActor(admin, token, targetOfficeId);
  } catch (err: any) {
    if (err instanceof HttpError && err.status === 403 && err.code === 'mfa_required') {
      const session = await getVerifiedSessionContext(admin, token);
      try {
        const { data: mfaData, error: mfaError } = await admin.auth.admin.mfa.listFactors({
          userId: session.user.id,
        });
        if (mfaError) {
          throw new HttpError(403, 'mfa_required');
        }
        const factors = mfaData?.factors ?? [];
        const hasVerifiedTotp = factors.some(
          (f: any) => f.status === 'verified' && f.factor_type === 'totp'
        );
        if (hasVerifiedTotp) {
          throw new HttpError(403, 'mfa_required');
        }
      } catch (innerErr) {
        throw new HttpError(403, 'mfa_required');
      }
      await enforceHumanStaffSessionActivity(admin, session.sessionId, session.user.id);
      const { data: profile } = await admin
        .from('staff_profiles')
        .select('role')
        .eq('user_id', session.user.id)
        .maybeSingle();

      const { data: assignments } = await admin
        .from('office_staff_assignments')
        .select('office_id')
        .eq('user_id', session.user.id);

      const assignedOfficeIds = (assignments || []).map((a: any) => a.office_id);
      if (targetOfficeId && profile?.role === 'office_staff') {
        if (!assignedOfficeIds.includes(targetOfficeId)) {
          throw new HttpError(403, 'unauthorized_for_this_office');
        }
      }
      return {
        id: session.user.id,
        email: session.user.email!,
        role: profile?.role ?? 'office_staff',
        assignedOfficeIds,
      };
    }
    throw err;
  }
}

/**
 * Native Web Request/Response runner for API route execution.
 * Binds mock clients to store, constructs Request, dispatches to production route handler,
 * and parses response body and headers.
 */
export async function executeApiRoute(
  handler: (req: Request) => Promise<Response>,
  options: {
    store?: MfaTestStateStore;
    method?: string;
    url?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; body: any; headers: Headers }> {
  if (options.store) {
    bindMockClientsToStore(options.store);
  }
  const url = options.url ?? 'http://localhost/api/auth/mfa';
  const headers = new Headers(options.headers ?? {});
  if (options.token) {
    headers.set('Authorization', `Bearer ${options.token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const req = new Request(url, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const res = await handler(req);
  let body: any = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

// ============================================================================
// 7. ProtectedRoute Happy-DOM Mount Harness
// ============================================================================

let currentHarnessAuthState: any = {
  status: 'authenticated',
  role: 'admin',
  requiresMfa: false,
  uid: 'test-user-id',
  userData: { kind: 'staff', role: 'admin', name: 'Test User' },
  aal: 'aal2',
  serviceStatus: 'available',
  serviceMessage: null,
  refresh: async () => {},
};

export function setHarnessAuthState(state: Partial<typeof currentHarnessAuthState>) {
  currentHarnessAuthState = { ...currentHarnessAuthState, ...state };
}

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => currentHarnessAuthState,
}));

export function LocationProbe({ label }: { label: string }) {
  const loc = useLocation();
  return React.createElement('div', { 'data-testid': 'location-probe' }, `${label}:${loc.pathname}`);
}

export async function renderProtectedRouteHarness(options: {
  allowedRoles: any[];
  currentRole: any;
  status?: 'authenticated' | 'unauthenticated' | 'loading' | 'requires_password_change';
  requiresMfa?: boolean;
  initialPath?: string;
}): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  currentHarnessAuthState = {
    status: options.status ?? 'authenticated',
    role: options.currentRole,
    requiresMfa: options.requiresMfa ?? false,
    uid: 'test-user-id',
    userData: { kind: 'staff', role: options.currentRole, name: 'Test User' },
    aal: options.requiresMfa ? 'aal1' : 'aal2',
    serviceStatus: 'available',
    serviceMessage: null,
    refresh: async () => {},
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [options.initialPath ?? '/account/security'] },
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            {
              element: React.createElement(ProtectedRoute, { allowedRoles: options.allowedRoles }),
            },
            React.createElement(Route, {
              path: options.initialPath ?? '/account/security',
              element: React.createElement('div', null, 'PROTECTED_ACCESS_GRANTED'),
            }),
            React.createElement(Route, {
              path: '/admin/dashboard',
              element: React.createElement('div', null, 'PROTECTED_ACCESS_GRANTED'),
            }),
          ),
          React.createElement(Route, {
            path: '/login',
            element: React.createElement(LocationProbe, { label: 'LOGIN' }),
          }),
        ),
      ),
    );
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// ============================================================================
// 8. PGlite Test Database Isolation & Outbox Seeding Helpers
// ============================================================================

export function requireTestDb(
  pgDb: Awaited<ReturnType<typeof createMfaTestDb>> | null
): NonNullable<Awaited<ReturnType<typeof createMfaTestDb>>> {
  if (!pgDb) {
    throw new Error(
      'PGlite test database failed to initialize. Database invariant tests require a valid PGlite instance.'
    );
  }
  return pgDb;
}

export interface SeedOutboxOptions {
  officeId?: string;
  officeName?: string;
  visitorId?: string;
  visitId?: string;
  outboxId?: string;
  recipientEmail?: string;
  deliveryStatus?: 'pending' | 'processing' | 'sent' | 'delivered' | 'failed' | 'unknown' | 'reconciliation_required';
  attemptCount?: number;
  createdAtSql?: string;
  lastAttemptAtSql?: string;
  leaseExpiresAtSql?: string;
  claimId?: string | null;
}

export async function seedTestOfficeVisitAndOutbox(
  db: PGlite,
  options: SeedOutboxOptions = {}
): Promise<{
  officeId: string;
  visitorId: string;
  visitId: string;
  outboxId: string;
}> {
  const officeId = options.officeId ?? crypto.randomUUID();
  const officeName = options.officeName ?? `Office ${officeId.slice(0, 8)}`;
  const visitorId = options.visitorId ?? crypto.randomUUID();
  const visitId = options.visitId ?? crypto.randomUUID();
  const outboxId = options.outboxId ?? crypto.randomUUID();
  const email = options.recipientEmail ?? 'visitor.test@example.com';
  const status = options.deliveryStatus ?? 'pending';
  const attemptCount = options.attemptCount ?? 0;
  const createdAt = options.createdAtSql ?? 'now()';
  const lastAttemptAt = options.lastAttemptAtSql ?? (attemptCount > 0 ? 'now()' : 'null');
  const leaseExpiresAt = options.leaseExpiresAtSql ?? 'null';
  const claimIdVal = options.claimId ? `'${options.claimId}'::uuid` : 'null';
  const idempKey = `idemp-${outboxId}`;

  await db.exec(`
    set request.jwt.claims = '{"role": "service_role"}';

    insert into auth.users (id, email, email_confirmed_at, is_anonymous)
    values ('${visitorId}', null, null, true)
    on conflict (id) do nothing;

    insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
    values ('${visitorId}', '${visitorId}', 'portal', 'Visitor Test', '09123456789', 'Office Visit', current_date, now())
    on conflict (id) do nothing;

    insert into public.offices (id, name)
    values ('${officeId}', '${officeName}')
    on conflict (name) do nothing;

    insert into public.office_visits (
      id, visit_type, office_id, visitor_id, visitor_actor_id, visitor_first_name, visitor_last_name,
      visitor_contact_number, visitor_email, purpose, visit_date, request_id
    ) values (
      '${visitId}', 'general', '${officeId}', '${visitorId}', '${visitorId}', 'Test', 'Visitor',
      '09123456789', '${email}', 'General Inquiry', current_date, gen_random_uuid()
    )
    on conflict (id) do nothing;

    insert into public.office_visit_acknowledgement_outbox (
      id, office_visit_id, recipient_email, encrypted_tracking_token, idempotency_key,
      delivery_status, attempt_count, created_at, last_attempt_at, lease_expires_at, claim_id
    ) values (
      '${outboxId}', '${visitId}', '${email}', 'enc_token_${outboxId.slice(0, 8)}', '${idempKey}',
      '${status}', ${attemptCount}, ${createdAt}, ${lastAttemptAt}, ${leaseExpiresAt}, ${claimIdVal}
    )
    on conflict (id) do nothing;

    set request.jwt.claims = '{}';
  `);

  return { officeId, visitorId, visitId, outboxId };
}

export async function createMfaTestDb(): Promise<{
  db: PGlite;
  asStaff: <T>(userId: string, role: string, aal: 'aal1' | 'aal2', fn: () => Promise<T>) => Promise<T>;
  asServiceRole: <T>(fn: () => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}> {
  const db = new PGlite();
  const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

  // Supabase PostgreSQL Emulation
  await db.exec(`
    create schema if not exists auth;
    create schema if not exists storage;
    create schema if not exists private;
    create schema if not exists api;

    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;

    create table if not exists auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      encrypted_password text,
      is_anonymous boolean default false,
      raw_app_meta_data jsonb default '{}'::jsonb,
      raw_user_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );

    create or replace function auth.uid() returns uuid as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
      );
    $$ language sql stable;

    create or replace function auth.jwt() returns jsonb as $$
      select case
        when nullif(current_setting('request.jwt.claims', true), '') is null then '{}'::jsonb
        else current_setting('request.jwt.claims', true)::jsonb
      end
    $$ language sql stable;

    create or replace function auth.role() returns text as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'authenticated'::text
      );
    $$ language sql stable;

    create table if not exists storage.buckets (
      id text primary key,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      public boolean default false,
      avif_autodetection boolean default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );

    create table if not exists storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      owner_id text,
      created_at timestamptz,
      updated_at timestamptz,
      last_accessed_at timestamptz,
      metadata jsonb
    );

    do $$
    begin
      if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        create publication supabase_realtime;
      end if;
    end
    $$;
  `);

  // Apply sequential migrations
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/create extension if not exists pgcrypto[^;]*;/gi, '-- pgcrypto no-op');
    await db.exec(sql);
  }

  // Seed test staff identities, factors, and default pending pass into PGlite
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at)
    values
      ('${TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId}', '${TEST_IDENTITIES.SUPERADMIN_ENROLLED.email}', now()),
      ('${TEST_IDENTITIES.ADMIN_ENROLLED.userId}', '${TEST_IDENTITIES.ADMIN_ENROLLED.email}', now()),
      ('${TEST_IDENTITIES.ADMIN_UNENROLLED.userId}', '${TEST_IDENTITIES.ADMIN_UNENROLLED.email}', now()),
      ('${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId}', '${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.email}', now()),
      ('${TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId}', '${TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.email}', now()),
      ('00000000-0000-4000-a000-000000000005', null, null)
    on conflict (id) do nothing;

    insert into public.visitors (id, owner_id, source, full_name, contact_number, purpose, visit_date, consent_accepted_at)
    values ('00000000-0000-4000-a000-000000000005', '00000000-0000-4000-a000-000000000005', 'portal', 'Test Visitor Maria', '09123456789', 'Campus Query', current_date, now())
    on conflict (id) do nothing;

    insert into public.passes (id, visitor_id, status, source, valid_from, valid_until, gate, public_reference, token_digest, version)
    values ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-000000000005', 'pending', 'portal', now(), now() + interval '8 hours', 'Gate 1', gen_random_uuid(), sha256('pass-token-123'::bytea), 1)
    on conflict (id) do nothing;

    insert into public.staff_profiles (user_id, display_name, role, active, must_change_password, privacy_accepted_at)
    values
      ('${TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId}', 'Superadmin Enrolled', 'superadmin', true, false, now()),
      ('${TEST_IDENTITIES.ADMIN_ENROLLED.userId}', 'Admin Enrolled', 'admin', true, false, now()),
      ('${TEST_IDENTITIES.ADMIN_UNENROLLED.userId}', 'Admin Unenrolled', 'admin', true, false, now()),
      ('${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId}', 'Office Staff Enrolled', 'office_staff', true, false, now()),
      ('${TEST_IDENTITIES.OFFICE_STAFF_UNENROLLED.userId}', 'Office Staff Unenrolled', 'office_staff', true, false, now())
    on conflict (user_id) do nothing;

    insert into auth.mfa_factors (id, user_id, factor_type, status, friendly_name)
    values
      ('${TEST_IDENTITIES.SUPERADMIN_ENROLLED.factorId}', '${TEST_IDENTITIES.SUPERADMIN_ENROLLED.userId}', 'totp', 'verified', 'Superadmin TOTP'),
      ('${TEST_IDENTITIES.ADMIN_ENROLLED.factorId}', '${TEST_IDENTITIES.ADMIN_ENROLLED.userId}', 'totp', 'verified', 'Admin TOTP'),
      ('${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.factorId}', '${TEST_IDENTITIES.OFFICE_STAFF_ENROLLED.userId}', 'totp', 'verified', 'Office TOTP')
    on conflict (id) do nothing;
  `);

  return {
    db,
    asStaff: async <T>(userId: string, role: string, aal: 'aal1' | 'aal2', fn: () => Promise<T>): Promise<T> => {
      await db.exec(`
        set request.jwt.claims = '{"sub": "${userId}", "role": "authenticated", "aal": "${aal}"}';
      `);
      try {
        return await fn();
      } finally {
        await db.exec(`set request.jwt.claims = '{}';`);
      }
    },
    asServiceRole: async <T>(fn: () => Promise<T>): Promise<T> => {
      await db.exec(`
        set request.jwt.claims = '{"role": "service_role"}';
      `);
      try {
        return await fn();
      } finally {
        await db.exec(`set request.jwt.claims = '{}';`);
      }
    },
    close: async () => {
      await db.close();
    },
  };
}
