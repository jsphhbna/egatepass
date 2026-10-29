import { describe, it, expect, beforeEach } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveCachedVisitors,
  searchCachedVisitors,
  saveOfflineRegistration,
  getOfflineRegistrations,
  queueOfflineEvent,
  getOfflineEvents,
  purgeStaleLocalData,
  type CachedVisitorPass,
  type OfflineRegistrationRecord,
  type OfflineEventRecord,
} from '@/lib/offline/guardIndexedDb';

describe('Phase 4, 5, 6, 7, 8: Guard Visitor Recovery & Offline Operations', () => {
  beforeEach(async () => {
    setupMockIndexedDb();
  });

  const actorId = 'test-guard-actor-id';

  const mockActiveVisitors: CachedVisitorPass[] = [
    {
      actorId,
      id: 'pass-001',
      visitorId: 'vis-001',
      visitorName: 'Juan Dela Cruz',
      contactNumber: '09171234567',
      purpose: 'Registrar Document Request',
      visitDate: '2026-10-27',
      status: 'issued',
      passReference: 'Ref: EG-1A2B3C4D',
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      photoEvidenceId: 'evi-photo-001',
      idEvidenceId: 'evi-id-001',
      cachedAt: new Date().toISOString(),
    },
    {
      actorId,
      id: 'pass-002',
      visitorId: 'vis-002',
      visitorName: 'Maria Santos',
      contactNumber: '09189876543',
      purpose: 'Dean Consultation',
      visitDate: '2026-10-27',
      status: 'pending',
      passReference: 'Ref: EG-5E6F7A8B',
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      photoEvidenceId: 'evi-photo-002',
      idEvidenceId: null,
      cachedAt: new Date().toISOString(),
    },
    {
      actorId,
      id: 'pass-003',
      visitorId: 'vis-003',
      visitorName: 'Pedro Penduko',
      contactNumber: '09201112233',
      purpose: 'Library Access',
      visitDate: '2026-10-27',
      status: 'inside',
      passReference: 'Ref: EG-9C0D1E2F',
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      timeIn: '2026-10-27T09:30:00+08:00',
      photoEvidenceId: 'evi-photo-003',
      idEvidenceId: 'evi-id-003',
      cachedAt: new Date().toISOString(),
    },
  ];

  it('4.1. caches operational visitors in IndexedDB and retrieves them', async () => {
    await saveCachedVisitors(actorId, mockActiveVisitors);

    const all = await searchCachedVisitors(actorId, '');
    expect(all.length).toBe(3);
  });

  it('4.2. recovery search filters by visitor name', async () => {
    await saveCachedVisitors(actorId, mockActiveVisitors);

    const results = await searchCachedVisitors(actorId, 'Dela Cruz');
    expect(results.length).toBe(1);
    expect(results[0]?.visitorName).toBe('Juan Dela Cruz');
  });

  it('4.3. recovery search filters by contact number', async () => {
    await saveCachedVisitors(actorId, mockActiveVisitors);

    const results = await searchCachedVisitors(actorId, '09189876543');
    expect(results.length).toBe(1);
    expect(results[0]?.visitorName).toBe('Maria Santos');
  });

  it('4.4. recovery search filters by pass reference', async () => {
    await saveCachedVisitors(actorId, mockActiveVisitors);

    const results = await searchCachedVisitors(actorId, 'EG-9C0D1E2F');
    expect(results.length).toBe(1);
    expect(results[0]?.visitorName).toBe('Pedro Penduko');
  });

  it('4.5. offline gate actions write to outbox with immutable eventId', async () => {
    const offlineEvent: OfflineEventRecord = {
      actorId,
      eventId: 'evt-unique-uuid-1234',
      passId: 'pass-001',
      action: 'approve_entry',
      expectedStatus: 'issued',
      occurredAt: new Date().toISOString(),
      syncStatus: 'pending',
    };

    await queueOfflineEvent(actorId, offlineEvent);

    const pending = await getOfflineEvents(actorId, 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0]?.eventId).toBe('evt-unique-uuid-1234');
    expect(pending[0]?.action).toBe('approve_entry');
  });

  it('4.6. offline registration stores visitor details, photo, and generates immutable ID', async () => {
    const dummyBlob = new Blob(['dummy photo content'], { type: 'image/webp' });

    const offlineReg: OfflineRegistrationRecord = {
      actorId,
      offlineRegistrationId: 'offline-reg-uuid-5678',
      visitor: {
        firstName: 'Jose',
        lastName: 'Rizal',
        contactNumber: '09191234567',
        purpose: 'Historical Archives',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: dummyBlob,
      idBlob: null,
      rejectionReason: null,
      syncStatus: 'pending',
    };

    await saveOfflineRegistration(actorId, offlineReg);

    const regs = await getOfflineRegistrations(actorId, 'pending');
    expect(regs.length).toBe(1);
    expect(regs[0]?.offlineRegistrationId).toBe('offline-reg-uuid-5678');
    expect(regs[0]?.visitor.firstName).toBe('Jose');
    expect(regs[0]?.action).toBe('approved');
  });

  it('4.7. data retention: purgeStaleLocalData cleans visitors from yesterday but keeps today', async () => {
    const oldVisitor: CachedVisitorPass = {
      ...mockActiveVisitors[0]!,
      actorId,
      id: 'pass-old',
      visitDate: '2026-10-26', // Yesterday
    };
    const todayVisitor: CachedVisitorPass = {
      ...mockActiveVisitors[1]!,
      actorId,
      id: 'pass-today',
      visitDate: '2026-10-27', // Today
    };

    await saveCachedVisitors(actorId, [oldVisitor, todayVisitor]);

    // Purge with today = '2026-10-27'
    const purgeResult = await purgeStaleLocalData('2026-10-27');
    expect(purgeResult.purgedVisitors).toBeGreaterThanOrEqual(1);

    const remaining = await searchCachedVisitors(actorId, '');
    expect(remaining.some((v) => v.id === 'pass-old')).toBe(false);
    expect(remaining.some((v) => v.id === 'pass-today')).toBe(true);
  });
});
