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

const DB_NAME = 'egatepass_guard_offline';
const DB_VERSION = 1;

export interface CachedVisitorPass {
  id: string; // passId
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
  cachedAt: string;
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
  photoBlob: Blob;
  idBlob: Blob | null;
  rejectionReason: string | null;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'conflict';
  conflictReason?: string | null;
  syncedAt?: string | null;
  canonicalPassId?: string | null;
}

export interface OfflineEventRecord {
  eventId: string; // Immutable random UUID
  passId: string;
  visitorName: string;
  action: 'approve_entry' | 'reject_entry' | 'record_exit';
  expectedStatus: 'issued' | 'pending' | 'inside';
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
export async function purgeStaleLocalData(currentManilaDay: string): Promise<{ purgedVisitors: number; purgedEvents: number }> {
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

  // 2. Free blobs from synced offline registrations
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    const store = tx.objectStore('offline_registrations');
    const req = store.openCursor();

    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const item = cursor.value as OfflineRegistrationRecord;
        if (item.syncStatus === 'synced') {
          // Keep metadata for audit trail but drop evidence blob objects to protect disk
          if (item.photoBlob || item.idBlob) {
            cursor.update({ ...item, photoBlob: null as any, idBlob: null });
          }
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

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

  return { purgedVisitors, purgedEvents };
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
      const matches = all.filter(
        (v) =>
          v.visitorName.toLowerCase().includes(clean) ||
          v.contactNumber.toLowerCase().includes(clean) ||
          v.passReference.toLowerCase().includes(clean) ||
          v.id.toLowerCase().startsWith(clean)
      );
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

export async function saveOfflineRegistration(record: OfflineRegistrationRecord): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('offline_registrations', 'readwrite');
    tx.objectStore('offline_registrations').put(record);
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
