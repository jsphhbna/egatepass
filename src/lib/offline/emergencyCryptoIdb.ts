import {
  PHYSICAL_ID_ATTESTATION_TEXT,
  type EmergencyLeaseStatus,
  type SignedEmergencyManifest,
} from './emergencyManifestVerifier';

const DB_NAME = 'egatepass-emergency-vault-v1';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';
const STORE_MANIFESTS = 'manifests';
const STORE_RECORDS = 'records';
const STORE_META = 'meta';

export type OfflineSyncState = 'pending_sync' | 'synced' | 'conflict' | 'rejected';

export interface EncryptedBlobRecord {
  id: string;
  deviceUserId: string;
  ivB64: string;
  ciphertextB64: string;
  updatedAt: string;
}

export interface EmergencyOfflineRecord {
  recordId: string;
  requestId: string;
  deviceUserId: string;
  claimedGate: string;
  visitorFullName: string;
  declaredAddress: string;
  purpose: string;
  destinationOfficeId: string | null;
  destinationOfficeNameSnapshot: string;
  officeResolutionStatus: 'resolved_snapshot' | 'unresolved_stale_snapshot';
  officeRequiresApprovalSnapshot: boolean;
  idPhysicallyInspected: true;
  idInspectionAttestationText: typeof PHYSICAL_ID_ATTESTATION_TEXT;
  localRecordedAt: string;
  localSequence: number;
  snapshotVersion: string;
  manifestId: string | null;
  leaseStatusAtRecord: EmergencyLeaseStatus;
  emergencyExceptionApplied: boolean;
  emergencyExceptionReason: string | null;
  classification: 'OFFLINE MODE RECORDED';
  syncStatus: OfflineSyncState;
  serverOutcome?: string | null;
  serverMessage?: string | null;
}

export interface EnqueueEmergencyRecordInput {
  deviceUserId: string;
  claimedGate: string;
  visitorFullName: string;
  declaredAddress: string;
  purpose: string;
  destinationOfficeId: string | null;
  destinationOfficeNameSnapshot: string;
  officeResolutionStatus: 'resolved_snapshot' | 'unresolved_stale_snapshot';
  officeRequiresApprovalSnapshot: boolean;
  idPhysicallyInspected: boolean;
  snapshotVersion: string;
  manifestId: string | null;
  leaseStatusAtRecord: EmergencyLeaseStatus;
  emergencyExceptionApplied: boolean;
  emergencyExceptionReason?: string | null;
  allowEmergencyExceptionPolicy: boolean;
}

export interface EmergencyVaultStorageAdapter {
  getKey(keyId: string): Promise<CryptoKey | null>;
  putKey(keyId: string, key: CryptoKey): Promise<void>;
  getManifestBlob(deviceUserId: string): Promise<EncryptedBlobRecord | null>;
  putManifestBlob(blob: EncryptedBlobRecord): Promise<void>;
  getRecordBlobs(deviceUserId: string): Promise<EncryptedBlobRecord[]>;
  putRecordBlob(blob: EncryptedBlobRecord): Promise<void>;
  getLastSequence(deviceUserId: string): Promise<number>;
  setLastSequence(deviceUserId: string, seq: number): Promise<void>;
  allocateSequenceAndPutRecord?(
    deviceUserId: string,
    buildBlob: (seq: number) => Promise<EncryptedBlobRecord>,
  ): Promise<{ seq: number; blob: EncryptedBlobRecord }>;
  clearDeviceVault(deviceUserId: string): Promise<void>;
}

let testAdapterOverride: EmergencyVaultStorageAdapter | null = null;

export function setEmergencyVaultStorageForTest(adapter: EmergencyVaultStorageAdapter | null): void {
  testAdapterOverride = adapter;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function openIndexedDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('indexeddb_unavailable');
  }

  return await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MANIFESTS)) {
        db.createObjectStore(STORE_MANIFESTS, { keyPath: 'deviceUserId' });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const recStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        recStore.createIndex('deviceUserId', 'deviceUserId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_open_failed'));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb_request_failed'));
  });
}

function createIndexedDbAdapter(): EmergencyVaultStorageAdapter {
  return {
    async getKey(keyId: string) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_KEYS, 'readonly');
      const row = await idbReq<{ id: string; key: CryptoKey } | undefined>(tx.objectStore(STORE_KEYS).get(keyId));
      db.close();
      return row?.key ?? null;
    },
    async putKey(keyId: string, key: CryptoKey) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_KEYS, 'readwrite');
      await idbReq(tx.objectStore(STORE_KEYS).put({ id: keyId, key }));
      db.close();
    },
    async getManifestBlob(deviceUserId: string) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_MANIFESTS, 'readonly');
      const row = await idbReq<EncryptedBlobRecord | undefined>(tx.objectStore(STORE_MANIFESTS).get(deviceUserId));
      db.close();
      return row ?? null;
    },
    async putManifestBlob(blob: EncryptedBlobRecord) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_MANIFESTS, 'readwrite');
      await idbReq(tx.objectStore(STORE_MANIFESTS).put(blob));
      db.close();
    },
    async getRecordBlobs(deviceUserId: string) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_RECORDS, 'readonly');
      const store = tx.objectStore(STORE_RECORDS);
      const index = store.index('deviceUserId');
      const rows = await idbReq<EncryptedBlobRecord[]>(index.getAll(deviceUserId));
      db.close();
      return rows ?? [];
    },
    async putRecordBlob(blob: EncryptedBlobRecord) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_RECORDS, 'readwrite');
      await idbReq(tx.objectStore(STORE_RECORDS).put(blob));
      db.close();
    },
    async getLastSequence(deviceUserId: string) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_META, 'readonly');
      const row = await idbReq<{ id: string; value: number } | undefined>(
        tx.objectStore(STORE_META).get(`seq:${deviceUserId}`),
      );
      db.close();
      return typeof row?.value === 'number' ? row.value : 0;
    },
    async setLastSequence(deviceUserId: string, seq: number) {
      const db = await openIndexedDb();
      const tx = db.transaction(STORE_META, 'readwrite');
      await idbReq(tx.objectStore(STORE_META).put({ id: `seq:${deviceUserId}`, value: seq }));
      db.close();
    },
    async allocateSequenceAndPutRecord(deviceUserId: string, buildBlob: (seq: number) => Promise<EncryptedBlobRecord>) {
      const db = await openIndexedDb();
      try {
        const tx = db.transaction([STORE_META, STORE_RECORDS], 'readwrite');
        const metaStore = tx.objectStore(STORE_META);
        const recordStore = tx.objectStore(STORE_RECORDS);

        const row = await idbReq<{ id: string; value: number } | undefined>(
          metaStore.get(`seq:${deviceUserId}`),
        );
        const prevSeq = typeof row?.value === 'number' ? row.value : 0;
        const nextSeq = prevSeq + 1;
        await idbReq(metaStore.put({ id: `seq:${deviceUserId}`, value: nextSeq }));
        const blob = await buildBlob(nextSeq);
        await idbReq(recordStore.put(blob));
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
        return { seq: nextSeq, blob };
      } finally {
        db.close();
      }
    },
    async clearDeviceVault(deviceUserId: string) {
      const db = await openIndexedDb();
      const tx = db.transaction([STORE_MANIFESTS, STORE_RECORDS, STORE_META, STORE_KEYS], 'readwrite');
      tx.objectStore(STORE_MANIFESTS).delete(deviceUserId);
      tx.objectStore(STORE_META).delete(`seq:${deviceUserId}`);
      tx.objectStore(STORE_KEYS).delete(`aes-gcm-v1:${deviceUserId}`);
      const recStore = tx.objectStore(STORE_RECORDS);
      const index = recStore.index('deviceUserId');
      const existing = await idbReq<EncryptedBlobRecord[]>(index.getAll(deviceUserId));
      for (const row of existing ?? []) {
        recStore.delete(row.id);
      }
      db.close();
    },
  };
}

function getStorage(): EmergencyVaultStorageAdapter {
  return testAdapterOverride ?? createIndexedDbAdapter();
}

async function getOrCreateAesKey(deviceUserId: string): Promise<CryptoKey> {
  const storage = getStorage();
  const keyId = `aes-gcm-v1:${deviceUserId}`;
  const existing = await storage.getKey(keyId);
  if (existing) return existing;

  const generated = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await storage.putKey(keyId, generated);
  return generated;
}

async function encryptJsonPayload(
  deviceUserId: string,
  recordId: string,
  payload: unknown,
): Promise<EncryptedBlobRecord> {
  const key = await getOrCreateAesKey(deviceUserId);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(new TextEncoder().encode(`${deviceUserId}:${recordId}`)),
    },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    id: recordId,
    deviceUserId,
    ivB64: bytesToBase64(iv),
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString(),
  };
}

async function decryptJsonPayload<T>(deviceUserId: string, blob: EncryptedBlobRecord): Promise<T> {
  const key = await getOrCreateAesKey(deviceUserId);
  const iv = base64ToBytes(blob.ivB64);
  const ciphertext = base64ToBytes(blob.ciphertextB64);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(new TextEncoder().encode(`${deviceUserId}:${blob.id}`)),
    },
    key,
    toArrayBuffer(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function saveEncryptedManifest(
  deviceUserId: string,
  manifest: SignedEmergencyManifest,
): Promise<void> {
  const blob = await encryptJsonPayload(deviceUserId, 'manifest', manifest);
  await getStorage().putManifestBlob(blob);
}

export async function loadEncryptedManifest(deviceUserId: string): Promise<SignedEmergencyManifest | null> {
  const blob = await getStorage().getManifestBlob(deviceUserId);
  if (!blob) return null;
  return await decryptJsonPayload<SignedEmergencyManifest>(deviceUserId, blob);
}

export async function enqueueEmergencyRecord(input: EnqueueEmergencyRecordInput): Promise<EmergencyOfflineRecord> {
  if (input.idPhysicallyInspected !== true) {
    throw new Error('Physical identification inspection attestation is mandatory.');
  }

  const trimmedName = input.visitorFullName.trim();
  const trimmedAddress = input.declaredAddress.trim();
  const trimmedPurpose = input.purpose.trim();
  const trimmedOfficeName = input.destinationOfficeNameSnapshot.trim();
  if (trimmedName.length < 2) throw new Error('Visitor full name is required.');
  if (trimmedAddress.length < 5) throw new Error('Declared address is required.');
  if (trimmedPurpose.length < 2) throw new Error('Purpose of visit is required.');
  if (trimmedOfficeName.length < 2) throw new Error('Destination office is required.');

  const applyException = Boolean(input.allowEmergencyExceptionPolicy && input.emergencyExceptionApplied);
  const exceptionReason = applyException ? (input.emergencyExceptionReason ?? '').trim() : null;
  if (input.emergencyExceptionApplied && !input.allowEmergencyExceptionPolicy) {
    throw new Error('Emergency exceptions are disabled by Superadmin policy.');
  }
  if (applyException && (!exceptionReason || exceptionReason.length < 5)) {
    throw new Error('An emergency exception reason (minimum 5 characters) is required when applying an exception.');
  }

  const storage = getStorage();

  const recordTemplate: Omit<EmergencyOfflineRecord, 'localSequence'> = {
    recordId: globalThis.crypto.randomUUID(),
    requestId: globalThis.crypto.randomUUID(),
    deviceUserId: input.deviceUserId,
    claimedGate: input.claimedGate,
    visitorFullName: trimmedName,
    declaredAddress: trimmedAddress,
    purpose: trimmedPurpose,
    destinationOfficeId: input.destinationOfficeId,
    destinationOfficeNameSnapshot: trimmedOfficeName,
    officeResolutionStatus: input.officeResolutionStatus,
    officeRequiresApprovalSnapshot: input.officeRequiresApprovalSnapshot,
    idPhysicallyInspected: true,
    idInspectionAttestationText: PHYSICAL_ID_ATTESTATION_TEXT,
    localRecordedAt: new Date().toISOString(),
    snapshotVersion: input.snapshotVersion || 'no-manifest',
    manifestId: input.manifestId,
    leaseStatusAtRecord: input.leaseStatusAtRecord,
    emergencyExceptionApplied: applyException,
    emergencyExceptionReason: exceptionReason,
    classification: 'OFFLINE MODE RECORDED',
    syncStatus: 'pending_sync',
    serverOutcome: null,
    serverMessage: null,
  };

  let record: EmergencyOfflineRecord;

  if (typeof storage.allocateSequenceAndPutRecord === 'function') {
    const res = await storage.allocateSequenceAndPutRecord(input.deviceUserId, async (nextSeq) => {
      record = {
        ...recordTemplate,
        localSequence: nextSeq,
      };
      return await encryptJsonPayload(input.deviceUserId, record.recordId, record);
    });
    record = {
      ...recordTemplate,
      localSequence: res.seq,
    };
  } else {
    const prevSeq = await storage.getLastSequence(input.deviceUserId);
    const nextSeq = prevSeq + 1;
    await storage.setLastSequence(input.deviceUserId, nextSeq);

    record = {
      ...recordTemplate,
      localSequence: nextSeq,
    };

    const blob = await encryptJsonPayload(input.deviceUserId, record.recordId, record);
    await storage.putRecordBlob(blob);
  }

  return record;
}

export async function listEmergencyRecords(deviceUserId: string): Promise<EmergencyOfflineRecord[]> {
  const blobs = await getStorage().getRecordBlobs(deviceUserId);
  const out: EmergencyOfflineRecord[] = [];
  for (const blob of blobs) {
    const rec = await decryptJsonPayload<EmergencyOfflineRecord>(deviceUserId, blob);
    out.push(rec);
  }
  return out.sort((a, b) => a.localSequence - b.localSequence);
}

export async function updateEmergencyRecordSyncState(
  deviceUserId: string,
  recordId: string,
  syncStatus: OfflineSyncState,
  serverOutcome: string | null,
  serverMessage: string | null = null,
): Promise<EmergencyOfflineRecord | null> {
  const all = await listEmergencyRecords(deviceUserId);
  const existing = all.find((r) => r.recordId === recordId);
  if (!existing) return null;

  const isConfirmedSynced = syncStatus === 'synced';
  const updated: EmergencyOfflineRecord = {
    ...existing,
    visitorFullName: isConfirmedSynced
      ? '[Synced Receipt - PII Cleared]'
      : existing.visitorFullName,
    declaredAddress: isConfirmedSynced
      ? '[Cleared upon server acknowledgement]'
      : existing.declaredAddress,
    syncStatus,
    serverOutcome,
    serverMessage,
  };
  const blob = await encryptJsonPayload(deviceUserId, recordId, updated);
  await getStorage().putRecordBlob(blob);
  return updated;
}

export async function getLastSequence(deviceUserId: string): Promise<number> {
  return await getStorage().getLastSequence(deviceUserId);
}

export async function clearEmergencyDeviceVault(deviceUserId: string): Promise<void> {
  await getStorage().clearDeviceVault(deviceUserId);
}
