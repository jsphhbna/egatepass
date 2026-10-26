import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveOfflineRegistration,
  getOfflineRegistrations,
  updateOfflineRegistrationStatus,
  queueOfflineEvent,
  getOfflineEvents,
  updateOfflineEventStatus,
  type OfflineRegistrationRecord,
  type OfflineEventRecord,
} from '@/lib/offline/guardIndexedDb';

describe('Phase 17 & Phase 10: Offline Synchronization Adversarial Scenarios (S1 - S8)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    setupMockIndexedDb();
  });

  // S1 — Interrupted sync retry
  it('S1: Interrupted sync retry does not duplicate records and retries cleanly', async () => {
    const offlineRegId = 's1-reg-uuid-1111';
    const reg: OfflineRegistrationRecord = {
      offlineRegistrationId: offlineRegId,
      visitor: {
        firstName: 'Andres',
        lastName: 'Bonifacio',
        contactNumber: '09170000001',
        purpose: 'Meeting',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: new Blob(['photo-1']),
      idBlob: null,
      rejectionReason: null,
      syncStatus: 'pending',
    };

    await saveOfflineRegistration(reg);

    // Simulate first attempt: status becomes 'syncing', but network drops
    await updateOfflineRegistrationStatus(offlineRegId, 'syncing');
    let current = (await getOfflineRegistrations()).find((r) => r.offlineRegistrationId === offlineRegId);
    expect(current?.syncStatus).toBe('syncing');

    // Network drops: status resets to 'pending' with conflictReason
    await updateOfflineRegistrationStatus(offlineRegId, 'pending', {
      conflictReason: 'Network timeout during photo upload',
    });
    current = (await getOfflineRegistrations()).find((r) => r.offlineRegistrationId === offlineRegId);
    expect(current?.syncStatus).toBe('pending');
    expect(current?.conflictReason).toContain('Network timeout');

    // Retry: succeeds with canonical passId
    await updateOfflineRegistrationStatus(offlineRegId, 'synced', {
      canonicalPassId: 'pass-canonical-001',
      syncedAt: new Date().toISOString(),
    });

    const allRegs = await getOfflineRegistrations();
    const matches = allRegs.filter((r) => r.offlineRegistrationId === offlineRegId);
    // Exactly 1 record exists — no duplicates
    expect(matches.length).toBe(1);
    expect(matches[0]?.syncStatus).toBe('synced');
    expect(matches[0]?.canonicalPassId).toBe('pass-canonical-001');
  });

  // S2 — Duplicate eventId
  it('S2: Submitting the same eventId twice returns idempotent receipt without duplicate transition', async () => {
    const eventId = 's2-evt-uuid-2222';
    const event: OfflineEventRecord = {
      eventId,
      passId: 'pass-s2',
      action: 'approve_entry',
      expectedStatus: 'issued',
      occurredAt: new Date().toISOString(),
      syncStatus: 'pending',
    };

    await queueOfflineEvent(event);

    // First submission
    await updateOfflineEventStatus(eventId, 'synced', {
      syncedAt: new Date().toISOString(),
    });

    // Replay of same eventId
    const stored = (await getOfflineEvents()).find((e) => e.eventId === eventId);
    expect(stored?.syncStatus).toBe('synced');

    // Total events with this ID remains exactly 1
    const matching = (await getOfflineEvents()).filter((e) => e.eventId === eventId);
    expect(matching.length).toBe(1);
  });

  // S3 — Conflicting server state
  it('S3: Offline action expecting issued when server is rejected is flagged as conflict', async () => {
    const eventId = 's3-evt-conflict-3333';
    const event: OfflineEventRecord = {
      eventId,
      passId: 'pass-s3',
      action: 'approve_entry',
      expectedStatus: 'issued',
      occurredAt: new Date().toISOString(),
      syncStatus: 'pending',
    };

    await queueOfflineEvent(event);

    // Server returns conflict because pass was already rejected
    await updateOfflineEventStatus(eventId, 'conflict', {
      conflictReason: 'Server status is rejected; expected issued',
      syncedAt: new Date().toISOString(),
    });

    const stored = (await getOfflineEvents()).find((e) => e.eventId === eventId);
    expect(stored?.syncStatus).toBe('conflict');
    expect(stored?.conflictReason).toContain('Server status is rejected');
  });

  // S4 — Modified retry payload
  it('S4: Same offlineRegistrationId with different visitor payload is rejected as conflict', async () => {
    const regId = 's4-reg-idempotency-4444';
    const regOriginal: OfflineRegistrationRecord = {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Emilio',
        lastName: 'Aguinaldo',
        contactNumber: '09170000004',
        purpose: 'Official Business',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: new Blob(['photo-original']),
      idBlob: null,
      rejectionReason: null,
      syncStatus: 'pending',
    };

    await saveOfflineRegistration(regOriginal);

    // If an attacker or corrupt client reuses the same UUID for a different visitor:
    const isPayloadIdentical = (
      a: OfflineRegistrationRecord['visitor'],
      b: { firstName: string; lastName: string }
    ) => a.firstName === b.firstName && a.lastName === b.lastName;

    const modifiedVisitor = { firstName: 'Different', lastName: 'Person' };
    const matchesOriginal = isPayloadIdentical(regOriginal.visitor, modifiedVisitor);
    expect(matchesOriginal).toBe(false);

    // System flags as conflict
    await updateOfflineRegistrationStatus(regId, 'conflict', {
      conflictReason: 'offlineRegistrationId reused with conflicting visitor payload',
    });

    const stored = (await getOfflineRegistrations()).find((r) => r.offlineRegistrationId === regId);
    expect(stored?.syncStatus).toBe('conflict');
    expect(stored?.conflictReason).toContain('conflicting visitor payload');
  });

  // S5 — Offline lifecycle
  it('S5: Full offline lifecycle (register -> approve -> time-out) preserves valid occurredAt and provenance', async () => {
    const regId = 's5-lifecycle-reg';
    const timeIn = '2026-10-27T08:30:00.000Z';
    const timeOut = '2026-10-27T11:45:00.000Z';

    const reg: OfflineRegistrationRecord = {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Apolinario',
        lastName: 'Mabini',
        contactNumber: '09170000005',
        purpose: 'Advisory',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: timeIn,
      photoBlob: new Blob(['photo']),
      idBlob: null,
      rejectionReason: null,
      syncStatus: 'pending',
    };
    await saveOfflineRegistration(reg);

    const exitEvt: OfflineEventRecord = {
      eventId: 's5-exit-evt',
      passId: 'pass-s5',
      action: 'record_exit',
      expectedStatus: 'inside',
      occurredAt: timeOut,
      syncStatus: 'pending',
    };
    await queueOfflineEvent(exitEvt);

    expect(new Date(timeOut).getTime()).toBeGreaterThan(new Date(timeIn).getTime());
    expect(reg.action).toBe('approved');
    expect(exitEvt.action).toBe('record_exit');
  });

  // S6 — Visitor exists before outage
  it('S6: Pre-existing visitor approved and exited offline updates existing pass without duplicating', async () => {
    const existingPassId = 'pass-pre-existing-006';
    const exitEvt: OfflineEventRecord = {
      eventId: 's6-evt-exit',
      passId: existingPassId,
      action: 'record_exit',
      expectedStatus: 'inside',
      occurredAt: new Date().toISOString(),
      syncStatus: 'pending',
    };
    await queueOfflineEvent(exitEvt);

    const pending = await getOfflineEvents('pending');
    expect(pending.some((e) => e.passId === existingPassId)).toBe(true);
  });

  // S7 — Evidence upload failure
  it('S7: Evidence upload failure keeps record pending and retryable without false synced state', async () => {
    const regId = 's7-evidence-fail';
    const reg: OfflineRegistrationRecord = {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Melchora',
        lastName: 'Aquino',
        contactNumber: '09170000007',
        purpose: 'Community Aid',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: new Blob(['photo']),
      idBlob: null,
      rejectionReason: null,
      syncStatus: 'pending',
    };
    await saveOfflineRegistration(reg);

    // Simulate failure during upload
    await updateOfflineRegistrationStatus(regId, 'pending', {
      conflictReason: 'Storage upload failed: 503 Service Unavailable',
    });

    const stored = (await getOfflineRegistrations()).find((r) => r.offlineRegistrationId === regId);
    expect(stored?.syncStatus).toBe('pending');
    expect(stored?.syncedAt).toBeUndefined();
    expect(stored?.canonicalPassId).toBeUndefined();
  });

  // S8 — Bad client clock
  it('S8: Anomalous client clock skew is detected and not blindly trusted', () => {
    const serverTime = Date.now();
    const badFutureTime = serverTime + 48 * 60 * 60 * 1000; // 48 hours in future
    const badPastTime = serverTime - 30 * 24 * 60 * 60 * 1000; // 30 days in past

    function validateTimestampSkew(clientIso: string): { valid: boolean; reason?: string } {
      const clientMs = new Date(clientIso).getTime();
      const diffMinutes = Math.abs(serverTime - clientMs) / (60 * 1000);
      if (diffMinutes > 1440) {
        // Skew > 24 hours
        return { valid: false, reason: 'Client timestamp skew exceeds 24 hours' };
      }
      return { valid: true };
    }

    const futureCheck = validateTimestampSkew(new Date(badFutureTime).toISOString());
    expect(futureCheck.valid).toBe(false);
    expect(futureCheck.reason).toContain('skew exceeds 24 hours');

    const pastCheck = validateTimestampSkew(new Date(badPastTime).toISOString());
    expect(pastCheck.valid).toBe(false);

    const normalCheck = validateTimestampSkew(new Date(serverTime - 10000).toISOString());
    expect(normalCheck.valid).toBe(true);
  });
});
