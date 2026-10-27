/**
 * Guard Tablet Offline Data Store (IndexedDB)
 *
 * Provides resilient, localized storage for:
 * 1. Operational visitor cache (today's Manila issued/pending/inside passes)
 * 2. Offline manual registrations created by the Guard during connectivity outages
 * 3. Offline lifecycle event outbox (entry/exit/rejections with immutable UUID eventIds)
 * 4. Local retention and cryptographic device-bound metadata
 *
 * Security Invariants:
 * - NO server keys, NO service-role keys, NO server signing secrets stored client-side.
 * - Stored data is bounded strictly to operational needs and purged daily.
 */

import { getManilaDayValidityWindow } from '@/lib/scheduling';

const DB_NAME = 'egatepass_guard_offline';
const DB_VERSION = 1;

export interface UploadCheckpoint {
  intentId: string;
  bucketId: string;
  objectPath: string;
  contentType: string;
  maxBytes: number;
  expiresAt?: string;
  uploaded: boolean;
}

export interface CachedVisitorPass {
  id: string; // passId
  passId?: string;
  publicReference?: string;
  visitorId: string;
  visitorName: string;
  contactNumber: string;
  purpose: string;
  visitDate: string;
  status: 'issued' | 'pending' | 'inside';
  passReference: string;
  validFrom: string;
  validUntil: string;
  timeIn?: string | null;
  scannedAt?: string | null;
  gate?: string | null;
  photoEvidenceId?: string | null;
  idEvidenceId?: string | null;
  photoBlob?: Blob | null;
  idBlob?: Blob | null;
  cachedAt: string | number;
  version?: number;
}

export interface OfflineRegistrationRecord {
  offlineRegistrationId: string; // Immutable UUID
  visitor: {
    firstName: string;
    middleName?: string;
    lastName: string;
    contactNumber: string;
    purpose: string;
    visitDate: string;
  };
  action: 'approved' | 'rejected';
  occurredAt: string; // ISO string with client timestamp
  photoBlob?: Blob | null;
  idBlob?: Blob | null;
  rejectionReason: string | null;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'conflict';
  conflictReason?: string | null;
  syncedAt?: string | null;
  canonicalPassId?: string | null;
  photoUploadCheckpoint?: UploadCheckpoint | null;
  idUploadCheckpoint?: UploadCheckpoint | null;
}

export type SaveOfflineRegistrationInput = Omit<OfflineRegistrationRecord, 'syncStatus' | 'rejectionReason'> & {
  syncStatus?: OfflineRegistrationRecord['syncStatus'];
  rejectionReason?: string | null;
};

export interface OfflineEventRecord {
  eventId: string; // Immutable random UUID
  passId: string;
  visitorName: string;
  action: 'approve_entry' | 'reject_entry' | 'record_exit';
  expectedStatus: 'issued' | 'pending' | 'inside';
  expectedVersion?: number;
  occurredAt: string; // ISO string
  reason?: string | null;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'conflict';
  conflictReason?: string | null;
  syncedAt?: string | null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported on this device'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('cached_visitors')) {
        const store = db.createObjectStore('cached_visitors', { keyPath: 'id' });
        store.createIndex('by_name', 'visitorName', { unique: false });
        store.createIndex('by_contact', 'contactNumber', { unique: false });
        store.createIndex('by_status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('offline_registrations')) {
        const store = db.createObjectStore('offline_registrations', { keyPath: 'offlineRegistrationId' });
        store.createIndex('by_syncStatus', 'syncStatus', { unique: false });
      }

      if (!db.objectStoreNames.contains('offline_events')) {
        const store = db.createObjectStore('offline_events', { keyPath: 'eventId' });
        store.createIndex('by_syncStatus', 'syncStatus', { unique: false });
        store.createIndex('by_passId', 'passId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// =============================================================================
// METADATA & RETENTION PURGE
// =============================================================================

export async function setMeta(key: string, value: any): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value, updatedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta<T = any>(key: string): Promise<T | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Enforces local data retention policy (Phase 15):
 * 1. Stale operational visitor cache from prior days is purged.
 * 2. Synced offline registrations have their large evidence blobs freed.
 * 3. Synced events older than 24 hours are removed.
 */
/**
 * Strips sensitive biometric/ID Blobs from terminal offline registrations (synced or conflict)
 * and enforces the 7-day evidence retention ceiling (Root Cause 14).
 */
export async function stripTerminalOfflineEvidence(specificRegistrationId?: string): Promise<{ strippedBlobs: number; expiredPurged: number }> {
  const db = await openDatabase();
  let strippedBlobs = 0;
  let expiredPurged = 0;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const store = tx.objectStore('offline_registrations');
    const req = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineRegistrationRecord;
        if (specificRegistrationId && item.offlineRegistrationId !== specificRegistrationId) {
          cursor.continue();
          return;
        }
        const recordTime = new Date(item.occurredAt).getTime();

        // 1. Terminal states: synced or conflict
        if (item.syncStatus === 'synced' || item.syncStatus === 'conflict') {
          if (item.photoBlob || item.idBlob) {
            const updated = { ...item };
            delete updated.photoBlob;
            delete updated.idBlob;
            cursor.update(updated);
            strippedBlobs++;
          }
        }
        // 2. Absolute 7-day retention ceiling:
        else if (recordTime < sevenDaysAgo) {
          // If pending/syncing but exceeded 7 days, mark conflict and strip blobs
          const updated = {
            ...item,
            syncStatus: 'conflict' as const,
            conflictReason: 'expired_local_evidence_exceeded_policy',
          };
          delete updated.photoBlob;
          delete updated.idBlob;
          cursor.update(updated);
          expiredPurged++;
          strippedBlobs++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { strippedBlobs, expiredPurged };
}

/**
 * Enforces local data retention policy (Phase 15 & Root Cause 14):
 * 1. Stale operational visitor cache from prior days is purged.
 * 2. Terminal (synced & conflicted) offline registrations have sensitive evidence blobs stripped.
 * 3. Synced events older than 24 hours are removed.
 */
export async function purgeStaleLocalData(currentManilaDay: string): Promise<{ purgedVisitors: number; purgedEvents: number; strippedBlobs: number }> {
  const db = await openDatabase();
  let purgedVisitors = 0;
  let purgedEvents = 0;

  // 1. Purge cached visitors not matching today
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cached_visitors', 'readwrite');
    const store = tx.objectStore('cached_visitors');
    const req = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as CachedVisitorPass;
        if (item.visitDate !== currentManilaDay) {
          cursor.delete();
          purgedVisitors++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // 2. Free blobs from terminal offline registrations (synced AND conflict) + 7-day ceiling
  const { strippedBlobs } = await stripTerminalOfflineEvidence();

  // 3. Purge synced events older than 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('offline_events', 'readwrite');
    const store = tx.objectStore('offline_events');
    const req = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineEventRecord;
        if (item.syncStatus === 'synced' && item.syncedAt && new Date(item.syncedAt).getTime() < cutoff) {
          cursor.delete();
          purgedEvents++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  return { purgedVisitors, purgedEvents, strippedBlobs };
}

// =============================================================================
// CACHED OPERATIONAL VISITORS
// =============================================================================

export async function saveCachedVisitors(visitors: CachedVisitorPass[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_visitors', 'readwrite');
    const store = tx.objectStore('cached_visitors');
    for (const v of visitors) {
      store.put(v);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Atomically replaces the server snapshot visitors while strictly preserving
 * unsynchronized local visitors belonging to registrations still pending or syncing (Root Cause 3.1).
 * If any step fails, the transaction aborts and previous cached data remains untouched.
 */
export async function atomicReplaceCachedVisitors(visitors: CachedVisitorPass[]): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['cached_visitors', 'offline_registrations'], 'readwrite');
    const visitorStore = tx.objectStore('cached_visitors');
    const regStore = tx.objectStore('offline_registrations');

    const regReq = regStore.getAll();
    regReq.onsuccess = () => {
      const registrations = (regReq.result as OfflineRegistrationRecord[]) || [];
      // Identify active unsynchronized local registration IDs (pending or syncing approved visitors)
      const unsyncedRegIds = new Set(
        registrations
          .filter((r) => r.action === 'approved' && (r.syncStatus === 'pending' || r.syncStatus === 'syncing'))
          .map((r) => r.offlineRegistrationId)
      );

      // Read current cache so we can preserve active unsynced local visitors
      const currentReq = visitorStore.getAll();
      currentReq.onsuccess = () => {
        const currentCached = (currentReq.result as CachedVisitorPass[]) || [];
        const preservedLocalVisitors = currentCached.filter((v) => unsyncedRegIds.has(v.id));

        // Clear store and re-populate with preserved local visitors + new server snapshot
        visitorStore.clear();

        for (const localV of preservedLocalVisitors) {
          visitorStore.put(localV);
        }

        for (const serverV of visitors) {
          visitorStore.put(serverV);
        }
      };
      currentReq.onerror = () => tx.abort();
    };
    regReq.onerror = () => tx.abort();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function searchCachedVisitors(query: string): Promise<CachedVisitorPass[]> {
  const db = await openDatabase();
  const clean = query.trim().toLowerCase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_visitors', 'readonly');
    const store = tx.objectStore('cached_visitors');
    const req = store.getAll();

    req.onsuccess = () => {
      const all = (req.result as CachedVisitorPass[]) || [];
      if (!clean) {
        return resolve(all);
      }
      const cleanNoPrefix = clean.replace(/^ref:?\s*/i, '').replace(/-/g, '');
      const matches = all.filter((v) => {
        const nameMatch = (v.visitorName || '').toLowerCase().includes(clean);
        const contactMatch = (v.contactNumber || '').toLowerCase().includes(clean);
        const refStr = v.passReference || v.publicReference || '';
        const refMatch = refStr.toLowerCase().includes(clean);
        const idMatch = (v.id || '').toLowerCase().startsWith(clean);
        const publicRefMatch = v.publicReference ? v.publicReference.toLowerCase().includes(clean) : false;
        const refNoPrefix = refStr.replace(/^ref:?\s*/i, '').replace(/-/g, '').toLowerCase();
        return (
          nameMatch ||
          contactMatch ||
          refMatch ||
          idMatch ||
          publicRefMatch ||
          (cleanNoPrefix.length >= 3 && refNoPrefix.includes(cleanNoPrefix))
        );
      });
      resolve(matches);
    };

    req.onerror = () => reject(req.error);
  });
}

export async function updateCachedVisitorStatus(passId: string, status: 'issued' | 'pending' | 'inside'): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_visitors', 'readwrite');
    const store = tx.objectStore('cached_visitors');
    const req = store.get(passId);

    req.onsuccess = () => {
      if (req.result) {
        const updated = { ...req.result, status };
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =============================================================================
// OFFLINE REGISTRATIONS (GUARD CREATED)
// =============================================================================

export async function saveOfflineRegistration(record: SaveOfflineRegistrationInput): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const normalizedRecord: OfflineRegistrationRecord = {
      rejectionReason: null,
      syncStatus: 'pending',
      ...record,
    };
    tx.objectStore('offline_registrations').put(normalizedRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflineRegistrations(status?: OfflineRegistrationRecord['syncStatus']): Promise<OfflineRegistrationRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readonly');
    const store = tx.objectStore('offline_registrations');
    const req = store.getAll();

    req.onsuccess = () => {
      const all = (req.result as OfflineRegistrationRecord[]) || [];
      if (status) {
        resolve(all.filter((r) => r.syncStatus === status));
      } else {
        resolve(all);
      }
    };

    req.onerror = () => reject(req.error);
  });
}

export async function updateOfflineRegistrationStatus(
  offlineRegistrationId: string,
  syncStatus: OfflineRegistrationRecord['syncStatus'],
  extra?: { conflictReason?: string; syncedAt?: string; canonicalPassId?: string }
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const store = tx.objectStore('offline_registrations');
    const req = store.get(offlineRegistrationId);

    req.onsuccess = () => {
      if (req.result) {
        const updated = { ...req.result, syncStatus, ...extra };
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =============================================================================
// OFFLINE EVENT OUTBOX (APPROVE / REJECT / EXIT)
// =============================================================================

export async function queueOfflineEvent(event: OfflineEventRecord): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_events', 'readwrite');
    tx.objectStore('offline_events').put(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflineEvents(status?: OfflineEventRecord['syncStatus']): Promise<OfflineEventRecord[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_events', 'readonly');
    const store = tx.objectStore('offline_events');
    const req = store.getAll();

    req.onsuccess = () => {
      const all = (req.result as OfflineEventRecord[]) || [];
      if (status) {
        resolve(all.filter((e) => e.syncStatus === status));
      } else {
        resolve(all);
      }
    };

    req.onerror = () => reject(req.error);
  });
}

export async function updateOfflineEventStatus(
  eventId: string,
  syncStatus: OfflineEventRecord['syncStatus'],
  extra?: { conflictReason?: string; syncedAt?: string }
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_events', 'readwrite');
    const store = tx.objectStore('offline_events');
    const req = store.get(eventId);

    req.onsuccess = () => {
      if (req.result) {
        const updated = { ...req.result, syncStatus, ...extra };
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function resolvePendingEventsPassId(oldPassId: string, canonicalPassId: string): Promise<number> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_events', 'readwrite');
    const store = tx.objectStore('offline_events');
    const req = store.openCursor();
    let updatedCount = 0;

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineEventRecord;
        if (item.passId === oldPassId) {
          cursor.update({ ...item, passId: canonicalPassId });
          updatedCount++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve(updatedCount);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingSyncCount(): Promise<{ registrations: number; events: number; total: number }> {
  const [regs, evts] = await Promise.all([
    getOfflineRegistrations('pending'),
    getOfflineEvents('pending'),
  ]);
  return {
    registrations: regs.length,
    events: evts.length,
    total: regs.length + evts.length,
  };
}

/**
 * Atomically saves an offline registration and, if approved, inserts its projected
 * local cached visitor in ONE transaction across 'offline_registrations' and 'cached_visitors' (Root Causes 2.2 and 2.3).
 *
 * An approved visitor starts with status 'inside' and projected version 1.
 */
export async function saveOfflineRegistrationWithCache(
  record: SaveOfflineRegistrationInput
): Promise<CachedVisitorPass | null> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['offline_registrations', 'cached_visitors'], 'readwrite');
    const regStore = tx.objectStore('offline_registrations');
    const visitorStore = tx.objectStore('cached_visitors');

    const normalizedRecord: OfflineRegistrationRecord = {
      rejectionReason: null,
      syncStatus: 'pending',
      ...record,
    };
    regStore.put(normalizedRecord);

    let cached: CachedVisitorPass | null = null;
    if (record.action === 'approved') {
      const fullName = [record.visitor.firstName, record.visitor.middleName, record.visitor.lastName]
        .filter(Boolean)
        .join(' ');

      const { validFrom, validUntil } = getManilaDayValidityWindow(record.occurredAt);

      cached = {
        id: record.offlineRegistrationId,
        publicReference: record.offlineRegistrationId,
        visitorId: record.offlineRegistrationId,
        visitorName: fullName,
        contactNumber: record.visitor.contactNumber,
        purpose: record.visitor.purpose,
        visitDate: record.visitor.visitDate,
        status: 'inside',
        passReference: `EG-${record.offlineRegistrationId.slice(0, 8).toUpperCase()}`,
        validFrom,
        validUntil,
        timeIn: record.occurredAt,
        gate: 'Offline Gate',
        photoBlob: record.photoBlob,
        idBlob: record.idBlob,
        cachedAt: new Date().toISOString(),
        version: 1, // Canonical offline registration creates pass at version 1!
      };
      visitorStore.put(cached);
    }

    tx.oncomplete = () => resolve(cached);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/**
 * Atomically validates and transitions local visitor state while enqueuing an
 * offline outbox event in ONE transaction across 'cached_visitors' and 'offline_events' (Root Cause 2.1).
 *
 * Projected version behavior:
 * - Approve entry: expected = N, projected = N + 1, status = inside
 * - Record exit: requires projected inside; expected = N, locally evicted from actionable cache
 * - Reject: expected = N, locally evicted from actionable cache
 */
export async function queueOfflineVisitorAction(params: {
  passId: string;
  action: 'approve_entry' | 'reject_entry' | 'record_exit';
  reason?: string | null;
  occurredAt?: string;
  gate?: string | null;
  actorId?: string | null;
}): Promise<{ event: OfflineEventRecord; projectedVisitor: CachedVisitorPass | null }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['cached_visitors', 'offline_events'], 'readwrite');
    const visitorStore = tx.objectStore('cached_visitors');
    const eventsStore = tx.objectStore('offline_events');

    const getReq = visitorStore.get(params.passId);

    getReq.onsuccess = () => {
      const visitor = getReq.result as CachedVisitorPass | undefined;
      if (!visitor) {
        tx.abort();
        return reject(new Error(`Visitor pass '${params.passId}' not found in operational cache`));
      }

      // Legal state transition checks
      if (params.action === 'approve_entry') {
        if (visitor.status !== 'pending' && visitor.status !== 'issued') {
          tx.abort();
          return reject(new Error(`Cannot approve entry: visitor is currently '${visitor.status}'`));
        }
      } else if (params.action === 'record_exit') {
        if (visitor.status !== 'inside') {
          tx.abort();
          return reject(new Error(`Cannot record exit: visitor is not inside (status: '${visitor.status}')`));
        }
      } else if (params.action === 'reject_entry') {
        if (visitor.status !== 'pending' && visitor.status !== 'issued') {
          tx.abort();
          return reject(new Error(`Cannot reject entry: visitor is currently '${visitor.status}'`));
        }
      }

      const expectedStatus = visitor.status;
      const expectedVersion = visitor.version ?? 1;
      const occurredAt = params.occurredAt || new Date().toISOString();
      const eventId = crypto.randomUUID();

      const event: OfflineEventRecord = {
        eventId,
        passId: visitor.id,
        visitorName: visitor.visitorName,
        action: params.action,
        expectedStatus,
        expectedVersion,
        occurredAt,
        reason: params.reason ?? null,
        syncStatus: 'pending',
      };
      eventsStore.put(event);

      let projectedVisitor: CachedVisitorPass | null = null;
      if (params.action === 'approve_entry') {
        projectedVisitor = {
          ...visitor,
          status: 'inside',
          version: expectedVersion + 1,
          timeIn: occurredAt,
          gate: params.gate ?? visitor.gate ?? 'Offline Gate',
        };
        visitorStore.put(projectedVisitor);
      } else if (params.action === 'record_exit') {
        // Exited visitor is terminal: removed from actionable recovery cache so cannot be exited again
        visitorStore.delete(visitor.id);
        projectedVisitor = null;
      } else if (params.action === 'reject_entry') {
        // Rejected visitor is terminal: removed from actionable recovery cache
        visitorStore.delete(visitor.id);
        projectedVisitor = null;
      }

      tx.oncomplete = () => resolve({ event, projectedVisitor });
    };

    getReq.onerror = () => {
      tx.abort();
      reject(getReq.error);
    };

    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/**
 * Remaps an offline-created visitor pass in cached_visitors from local registration ID
 * to canonical pass ID returned by server synchronization (Root Cause 3.1).
 */
export async function remapCachedVisitorPassId(
  oldId: string,
  canonicalPassId: string,
  canonicalRef?: string
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_visitors', 'readwrite');
    const store = tx.objectStore('cached_visitors');
    const getReq = store.get(oldId);

    getReq.onsuccess = () => {
      const visitor = getReq.result as CachedVisitorPass | undefined;
      if (visitor) {
        store.delete(oldId);
        const updated: CachedVisitorPass = {
          ...visitor,
          id: canonicalPassId,
          passId: canonicalPassId,
          publicReference: canonicalRef || visitor.publicReference,
          passReference: canonicalRef
            ? `EG-${canonicalRef.slice(0, 8).toUpperCase()}`
            : `EG-${canonicalPassId.slice(0, 8).toUpperCase()}`,
        };
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface FinalizeOfflineRegistrationParams {
  offlineRegistrationId: string;
  canonicalPassId: string;
  canonicalReference?: string | null;
  publicReference?: string | null;
  syncedAt?: string;
}

/**
 * Atomically canonicalizes an offline-created registration in ONE IndexedDB transaction
 * across 'offline_registrations', 'cached_visitors', and 'offline_events' (Section 1).
 *
 * Invariant:
 * 1. Loads offline registration.
 * 2. If cached visitor exists under temporary registration ID:
 *    - deletes temporary key
 *    - inserts canonical key with preserved status/version/timeIn/validity
 *    - updates publicReference/passReference
 * 3. Remaps every still-unsynchronized lifecycle event whose passId equals temporary registration ID to canonical pass ID.
 * 4. Updates registration: syncStatus = 'synced', canonicalPassId, syncedAt, clears conflictReason, clears blobs & checkpoints.
 * 5. Commits ONLY in this same transaction. If aborted, NONE persist.
 */
export async function finalizeOfflineRegistrationSync(
  params: FinalizeOfflineRegistrationParams
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['offline_registrations', 'cached_visitors', 'offline_events'],
      'readwrite'
    );
    const regStore = tx.objectStore('offline_registrations');
    const visitorStore = tx.objectStore('cached_visitors');
    const eventsStore = tx.objectStore('offline_events');

    const regReq = regStore.get(params.offlineRegistrationId);

    regReq.onsuccess = () => {
      const reg = regReq.result as OfflineRegistrationRecord | undefined;
      if (!reg) {
        tx.abort();
        return reject(
          new Error(
            `Offline registration '${params.offlineRegistrationId}' not found for canonicalization`
          )
        );
      }

      // Step 2: Remap cached visitor if present
      const visitorReq = visitorStore.get(params.offlineRegistrationId);
      visitorReq.onsuccess = () => {
        const visitor = visitorReq.result as CachedVisitorPass | undefined;
        if (visitor) {
          visitorStore.delete(params.offlineRegistrationId);
          const canonicalRef =
            params.publicReference ||
            params.canonicalReference ||
            (params.canonicalPassId ? `EG-${params.canonicalPassId.slice(0, 8).toUpperCase()}` : visitor.publicReference);
          const updatedVisitor: CachedVisitorPass = {
            ...visitor,
            id: params.canonicalPassId,
            passId: params.canonicalPassId,
            publicReference: canonicalRef || undefined,
            passReference: canonicalRef
              ? (canonicalRef.startsWith('EG-') ? canonicalRef : `EG-${canonicalRef.slice(0, 8).toUpperCase()}`)
              : `EG-${params.canonicalPassId.slice(0, 8).toUpperCase()}`,
          };
          visitorStore.put(updatedVisitor);
        }

        // Step 3: Remap unsynchronized events whose passId equals temporary ID
        const evtReq = eventsStore.openCursor();
        evtReq.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const evt = cursor.value as OfflineEventRecord;
            if (evt.passId === params.offlineRegistrationId && evt.syncStatus !== 'synced') {
              cursor.update({
                ...evt,
                passId: params.canonicalPassId,
              });
            }
            cursor.continue();
          } else {
            // Step 4: Update the registration to synced and clean up evidence/checkpoints
            const syncedAt = params.syncedAt || new Date().toISOString();
            const updatedReg: OfflineRegistrationRecord = {
              ...reg,
              syncStatus: 'synced',
              canonicalPassId: params.canonicalPassId,
              syncedAt,
              conflictReason: null,
            };
            delete updatedReg.photoBlob;
            delete updatedReg.idBlob;
            delete updatedReg.photoUploadCheckpoint;
            delete updatedReg.idUploadCheckpoint;
            regStore.put(updatedReg);
          }
        };

        evtReq.onerror = () => {
          tx.abort();
          reject(evtReq.error);
        };
      };

      visitorReq.onerror = () => {
        tx.abort();
        reject(visitorReq.error);
      };
    };

    regReq.onerror = () => {
      tx.abort();
      reject(regReq.error);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/**
 * Recovers records left in transient 'syncing' state due to previous crash or ungraceful termination (Section 2).
 * Resets them to 'pending' so they become eligible for synchronization again.
 */
export async function recoverInterruptedSyncStates(): Promise<{
  recoveredRegistrations: number;
  recoveredEvents: number;
}> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['offline_registrations', 'offline_events'], 'readwrite');
    const regStore = tx.objectStore('offline_registrations');
    const evtStore = tx.objectStore('offline_events');
    let recoveredRegistrations = 0;
    let recoveredEvents = 0;

    const regReq = regStore.openCursor();
    regReq.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineRegistrationRecord;
        if (item.syncStatus === 'syncing') {
          cursor.update({ ...item, syncStatus: 'pending' });
          recoveredRegistrations++;
        }
        cursor.continue();
      }
    };

    const evtReq = evtStore.openCursor();
    evtReq.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineEventRecord;
        if (item.syncStatus === 'syncing') {
          cursor.update({ ...item, syncStatus: 'pending' });
          recoveredEvents++;
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve({ recoveredRegistrations, recoveredEvents });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/**
 * Updates or clears an upload checkpoint on an offline registration record (Section 5).
 */
export async function updateOfflineRegistrationCheckpoint(
  offlineRegistrationId: string,
  type: 'photo' | 'id',
  checkpoint: UploadCheckpoint | null
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const store = tx.objectStore('offline_registrations');
    const req = store.get(offlineRegistrationId);

    req.onsuccess = () => {
      if (req.result) {
        const updated = { ...req.result };
        if (type === 'photo') {
          if (checkpoint) {
            updated.photoUploadCheckpoint = checkpoint;
          } else {
            delete updated.photoUploadCheckpoint;
          }
        } else {
          if (checkpoint) {
            updated.idUploadCheckpoint = checkpoint;
          } else {
            delete updated.idUploadCheckpoint;
          }
        }
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

/**
 * Clears both photo and ID upload checkpoints on an offline registration record.
 */
export async function clearOfflineRegistrationCheckpoints(
  offlineRegistrationId: string
): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const store = tx.objectStore('offline_registrations');
    const req = store.get(offlineRegistrationId);

    req.onsuccess = () => {
      if (req.result) {
        const updated = { ...req.result };
        delete updated.photoUploadCheckpoint;
        delete updated.idUploadCheckpoint;
        store.put(updated);
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}
