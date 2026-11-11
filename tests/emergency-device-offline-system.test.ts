import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actorsModule from '../server/actors.js';
import * as supabaseModule from '../server/supabase.js';
import {
  PHYSICAL_ID_ATTESTATION_TEXT,
  signEmergencyManifest,
  verifyEmergencyManifestSignature,
  type EmergencyManifestPayload,
} from '../server/lib/emergency-manifest.js';
import emergencyDeviceRoute from '../server/routes/gate/emergency-device.js';
import emergencyRecordsRoute from '../server/routes/admin/emergency-records.js';
import {
  evaluateEmergencyManifestLease,
  verifyEmergencyManifestCrypto,
  type SignedEmergencyManifest,
} from '../src/lib/offline/emergencyManifestVerifier';
import {
  clearEmergencyDeviceVault,
  enqueueEmergencyRecord,
  listEmergencyRecords,
  loadEncryptedManifest,
  saveEncryptedManifest,
  setEmergencyVaultStorageForTest,
  updateEmergencyRecordSyncState,
  type EmergencyVaultStorageAdapter,
  type EncryptedBlobRecord,
} from '../src/lib/offline/emergencyCryptoIdb';

function createMemoryVaultAdapter(): {
  adapter: EmergencyVaultStorageAdapter;
  rawBlobs: Map<string, EncryptedBlobRecord>;
  rawManifests: Map<string, EncryptedBlobRecord>;
} {
  const keys = new Map<string, CryptoKey>();
  const rawManifests = new Map<string, EncryptedBlobRecord>();
  const rawBlobs = new Map<string, EncryptedBlobRecord>();
  const sequences = new Map<string, number>();

  return {
    rawBlobs,
    rawManifests,
    adapter: {
      async getKey(keyId) {
        return keys.get(keyId) ?? null;
      },
      async putKey(keyId, key) {
        keys.set(keyId, key);
      },
      async getManifestBlob(deviceUserId) {
        return rawManifests.get(deviceUserId) ?? null;
      },
      async putManifestBlob(blob) {
        rawManifests.set(blob.deviceUserId, blob);
      },
      async getRecordBlobs(deviceUserId) {
        return Array.from(rawBlobs.values()).filter((b) => b.deviceUserId === deviceUserId);
      },
      async putRecordBlob(blob) {
        rawBlobs.set(`${blob.deviceUserId}:${blob.id}`, blob);
      },
      async getLastSequence(deviceUserId) {
        return sequences.get(deviceUserId) ?? 0;
      },
      async setLastSequence(deviceUserId, seq) {
        sequences.set(deviceUserId, seq);
      },
      async clearDeviceVault(deviceUserId) {
        rawManifests.delete(deviceUserId);
        sequences.delete(deviceUserId);
        keys.delete(`aes-gcm-v1:${deviceUserId}`);
        for (const k of Array.from(rawBlobs.keys())) {
          if (k.startsWith(`${deviceUserId}:`)) rawBlobs.delete(k);
        }
      },
    },
  };
}

describe('Emergency Device Offline Crypto, Vault, Sync & Reconciliation Suite', () => {
  const originalEnv = process.env;
  const deviceUserId = '11111111-1111-4111-8111-111111111111';
  const deviceId = '22222222-2222-4222-8222-222222222222';
  const officeId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY;
  });

  afterEach(async () => {
    setEmergencyVaultStorageForTest(null);
    process.env = originalEnv;
  });

  it('signs ECDSA P-256 SHA-256 (IEEE-P1363) manifest on server and verifies via client WebCrypto & lease evaluator', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY = privateKey;

    const nowMs = Date.parse('2026-11-12T08:00:00.000+08:00');
    const payload: EmergencyManifestPayload = {
      manifestId: '44444444-4444-4444-8444-444444444444',
      deviceUserId,
      deviceId,
      assignedGate: 'Main Gate',
      normalizedGate: 'main gate',
      snapshotVersion: '2026-11-12T00:00:00.000Z',
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + 24 * 60 * 60 * 1000).toISOString(),
      scope: 'emergency_offline_gate',
      allowEmergencyException: false,
      emergencyExceptionPolicyNote: null,
      expectedPasses: [
        {
          passId: '55555555-5555-4555-8555-555555555555',
          referenceCode: 'EGP-2026-0001',
          status: 'issued',
          visitorName: 'Juan Dela Cruz',
          purpose: 'Registrar Document Request',
          officeId,
          officeName: 'Office of the Registrar',
          requiresApproval: true,
          expectedGate: 'Main Gate',
          validUntil: '2026-11-12T09:00:00.000Z',
        },
      ],
      offices: [
        {
          id: officeId,
          name: 'Office of the Registrar',
          code: 'REG',
          requiresApprovalBeforePass: true,
        },
      ],
    };

    const signed = await signEmergencyManifest({} as any, payload);
    expect(verifyEmergencyManifestSignature(signed)).toBe(true);
    expect(await verifyEmergencyManifestCrypto(signed as unknown as SignedEmergencyManifest)).toBe(true);

    // Valid gate + device + within 24h lease
    const validRes = await evaluateEmergencyManifestLease(
      signed as unknown as SignedEmergencyManifest,
      deviceUserId,
      '  main   gate ',
      nowMs + 2 * 60 * 60 * 1000,
    );
    expect(validRes.leaseStatus).toBe('valid');
    expect(validRes.cryptoValid).toBe(true);
    expect(validRes.gateMatches).toBe(true);
    expect(validRes.deviceMatches).toBe(true);

    // Tampered payload rejected
    const tampered = structuredClone(signed) as unknown as SignedEmergencyManifest;
    tampered.payload.allowEmergencyException = true;
    expect(await verifyEmergencyManifestCrypto(tampered)).toBe(false);
    const tamperedEval = await evaluateEmergencyManifestLease(tampered, deviceUserId, 'Main Gate', nowMs + 1000);
    expect(tamperedEval.leaseStatus).toBe('unverified_lease');
    expect(tamperedEval.cryptoValid).toBe(false);

    // Wrong gate rejected
    const wrongGateEval = await evaluateEmergencyManifestLease(
      signed as unknown as SignedEmergencyManifest,
      deviceUserId,
      'Side Gate',
      nowMs + 1000,
    );
    expect(wrongGateEval.leaseStatus).toBe('unverified_lease');
    expect(wrongGateEval.gateMatches).toBe(false);

    // Expired lease (>24h)
    const expiredEval = await evaluateEmergencyManifestLease(
      signed as unknown as SignedEmergencyManifest,
      deviceUserId,
      'Main Gate',
      nowMs + 25 * 60 * 60 * 1000,
    );
    expect(expiredEval.leaseStatus).toBe('expired_lease');
    expect(expiredEval.expired).toBe(true);

    // Missing manifest
    const noManifestEval = await evaluateEmergencyManifestLease(null, deviceUserId, 'Main Gate', nowMs);
    expect(noManifestEval.leaseStatus).toBe('no_manifest');
  });

  it('encrypts emergency vault records with AES-GCM, enforces physical ID attestation & default-OFF exception policy, and preserves monotonic sequences', async () => {
    const memory = createMemoryVaultAdapter();
    setEmergencyVaultStorageForTest(memory.adapter);

    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY = privateKey;

    const signed = await signEmergencyManifest({} as any, {
      manifestId: '44444444-4444-4444-8444-444444444444',
      deviceUserId,
      deviceId,
      assignedGate: 'Main Gate',
      normalizedGate: 'main gate',
      snapshotVersion: 'snap-v1',
      issuedAt: '2026-11-12T00:00:00.000Z',
      expiresAt: '2026-11-13T00:00:00.000Z',
      scope: 'emergency_offline_gate',
      allowEmergencyException: false,
      emergencyExceptionPolicyNote: null,
      expectedPasses: [],
      offices: [{ id: officeId, name: 'Office of the Registrar', code: 'REG', requiresApprovalBeforePass: true }],
    });

    await saveEncryptedManifest(deviceUserId, signed as unknown as SignedEmergencyManifest);
    const rawManifestBlob = memory.rawManifests.get(deviceUserId);
    expect(rawManifestBlob).toBeDefined();
    expect(rawManifestBlob!.ciphertextB64).not.toContain('Office of the Registrar');
    const decryptedManifest = await loadEncryptedManifest(deviceUserId);
    expect(decryptedManifest?.manifestHash).toBe(signed.manifestHash);

    // Reject missing physical ID inspection attestation
    await expect(
      enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Maria Clara',
        declaredAddress: 'Sampaloc, Manila',
        purpose: 'Transcript Inquiry',
        destinationOfficeId: officeId,
        destinationOfficeNameSnapshot: 'Office of the Registrar',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: false,
        snapshotVersion: 'snap-v1',
        manifestId: signed.payload.manifestId,
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: false,
        allowEmergencyExceptionPolicy: false,
      }),
    ).rejects.toThrow('Physical identification inspection attestation is mandatory.');

    // Reject exception when policy flag is default OFF
    await expect(
      enqueueEmergencyRecord({
        deviceUserId,
        claimedGate: 'Main Gate',
        visitorFullName: 'Maria Clara',
        declaredAddress: 'Sampaloc, Manila',
        purpose: 'Transcript Inquiry',
        destinationOfficeId: officeId,
        destinationOfficeNameSnapshot: 'Office of the Registrar',
        officeResolutionStatus: 'resolved_snapshot',
        officeRequiresApprovalSnapshot: true,
        idPhysicallyInspected: true,
        snapshotVersion: 'snap-v1',
        manifestId: signed.payload.manifestId,
        leaseStatusAtRecord: 'valid',
        emergencyExceptionApplied: true,
        emergencyExceptionReason: 'Urgent dean clearance',
        allowEmergencyExceptionPolicy: false,
      }),
    ).rejects.toThrow('Emergency exceptions are disabled by Superadmin policy.');

    // Enqueue 2 valid records and verify encryption + monotonic sequence + permanent classification
    const rec1 = await enqueueEmergencyRecord({
      deviceUserId,
      claimedGate: 'Main Gate',
      visitorFullName: 'Maria Clara',
      declaredAddress: 'Sampaloc, Manila',
      purpose: 'Transcript Inquiry',
      destinationOfficeId: officeId,
      destinationOfficeNameSnapshot: 'Office of the Registrar',
      officeResolutionStatus: 'resolved_snapshot',
      officeRequiresApprovalSnapshot: true,
      idPhysicallyInspected: true,
      snapshotVersion: 'snap-v1',
      manifestId: signed.payload.manifestId,
      leaseStatusAtRecord: 'valid',
      emergencyExceptionApplied: false,
      allowEmergencyExceptionPolicy: false,
    });

    const rec2 = await enqueueEmergencyRecord({
      deviceUserId,
      claimedGate: 'Main Gate',
      visitorFullName: 'Jose Rizal',
      declaredAddress: 'Intramuros, Manila',
      purpose: 'Faculty Consultation',
      destinationOfficeId: officeId,
      destinationOfficeNameSnapshot: 'Office of the Registrar',
      officeResolutionStatus: 'resolved_snapshot',
      officeRequiresApprovalSnapshot: true,
      idPhysicallyInspected: true,
      snapshotVersion: 'snap-v1',
      manifestId: signed.payload.manifestId,
      leaseStatusAtRecord: 'valid',
      emergencyExceptionApplied: true,
      emergencyExceptionReason: 'Dean approved offline exception',
      allowEmergencyExceptionPolicy: true,
    });

    expect(rec1.localSequence).toBe(1);
    expect(rec2.localSequence).toBe(2);
    expect(rec1.classification).toBe('OFFLINE MODE RECORDED');
    expect(rec1.idInspectionAttestationText).toBe(PHYSICAL_ID_ATTESTATION_TEXT);
    expect(rec1.syncStatus).toBe('pending_sync');

    // Stored ciphertext reveals zero plaintext PII
    for (const blob of memory.rawBlobs.values()) {
      const decoded = Buffer.from(blob.ciphertextB64, 'base64').toString('utf8');
      expect(decoded).not.toContain('Maria Clara');
      expect(decoded).not.toContain('Sampaloc');
    }

    const listed = await listEmergencyRecords(deviceUserId);
    expect(listed.map((r) => r.localSequence)).toEqual([1, 2]);

    await updateEmergencyRecordSyncState(deviceUserId, rec1.recordId, 'synced', 'accepted', 'OK');
    const refreshed = await listEmergencyRecords(deviceUserId);
    expect(refreshed[0]?.syncStatus).toBe('synced');
    expect(refreshed[0]?.serverOutcome).toBe('accepted');

    await clearEmergencyDeviceVault(deviceUserId);
    expect(await listEmergencyRecords(deviceUserId)).toEqual([]);
  });

  it('enforces emergency_device actor auth, signs gate-scoped manifests, syncs batches monotonically, and restricts admin reconciliation', async () => {
    const rpcCalls: Array<{ fn: string; args: any }> = [];
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    process.env.EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY = privateKey;

    const chainFor = (resolved: { data?: any; count?: number | null; error?: any }) => {
      const b: any = {
        select: vi.fn(() => b),
        eq: vi.fn(() => b),
        in: vi.fn(() => b),
        is: vi.fn(() => b),
        not: vi.fn(() => b),
        or: vi.fn(() => b),
        gte: vi.fn(() => b),
        lte: vi.fn(() => b),
        order: vi.fn(() => b),
        limit: vi.fn(() => b),
        maybeSingle: vi.fn(async () => resolved),
        then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolved).then(onFulfilled, onRejected),
      };
      return b;
    };

    const mockAdmin: any = {
      from: vi.fn((table: string) => {
        if (table === 'app_settings') {
          return chainFor({
            data: { allow_emergency_exception: false, emergency_exception_policy_note: null },
            error: null,
          });
        }
        if (table === 'offices') {
          return chainFor({
            data: [{ id: officeId, name: 'Office of the Registrar', code: 'REG', requires_approval_before_pass: true }],
            error: null,
          });
        }
        if (table === 'passes') {
          return chainFor({
            data: [
              { id: '66666666-6666-4666-8666-666666666666', public_reference: 'EGP-MAIN-01', status: 'issued', expected_gate: 'Main Gate', valid_until: '2026-12-01T00:00:00Z', visitor_id: 'v1' },
              { id: '77777777-7777-4777-8777-777777777777', public_reference: 'EGP-SIDE-01', status: 'issued', expected_gate: 'Side Gate', valid_until: '2026-12-01T00:00:00Z', visitor_id: 'v2' },
            ],
            error: null,
          });
        }
        if (table === 'office_visits') {
          return chainFor({ data: [], error: null });
        }
        if (table === 'visitors') {
          return chainFor({
            data: [{ id: 'v1', full_name: 'Main Gate Visitor', purpose: 'Inquiry' }],
            error: null,
          });
        }
        return chainFor({ data: [], error: null });
      }),
      schema: vi.fn(() => ({
        rpc: vi.fn(async (fn: string, args: any) => {
          rpcCalls.push({ fn, args });
          if (fn === 'record_emergency_sync_item') {
            const isConflict = args.requested_local_sequence === 2;
            return {
              data: {
                accepted: !isConflict,
                httpStatus: isConflict ? 409 : 201,
                outcome: isConflict ? 'conflict_sequence_collision' : 'accepted',
                recordId: args.requested_record_id,
                classification: 'OFFLINE MODE RECORDED',
              },
              error: null,
            };
          }
          if (fn === 'reconcile_emergency_gate_record') {
            return {
              data: { id: args.requested_record_id, reconciliation_status: args.requested_decision },
              error: null,
            };
          }
          return { data: { ok: true }, error: null };
        }),
      })),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin,
      anon: mockAdmin,
    } as any);

    // 1. Unauthenticated fails closed 401
    const unauthRes = await emergencyDeviceRoute.fetch(new Request('http://localhost/api/gate/emergency-device'));
    expect(unauthRes.status).toBe(401);

    // 2. Signed manifest scoped strictly to actor's gate ('Main Gate', excluding 'Side Gate')
    vi.spyOn(actorsModule, 'requireEmergencyDeviceActor').mockResolvedValue({
      userId: deviceUserId,
      email: 'emergency@devices.egatepass.invalid',
      deviceId,
      deviceName: 'Emergency Tablet 1',
      deviceType: 'emergency_device',
      gate: 'Main Gate',
      alias: 'EMG-01',
    });

    const manifestRes = await emergencyDeviceRoute.fetch(
      new Request('http://localhost/api/gate/emergency-device', {
        headers: { Authorization: 'Bearer device-token' },
      }),
    );
    expect(manifestRes.status).toBe(200);
    const manifestBody = await manifestRes.json();
    expect(manifestBody.manifest.payload.assignedGate).toBe('Main Gate');
    expect(manifestBody.manifest.payload.allowEmergencyException).toBe(false);
    expect(manifestBody.manifest.payload.expectedPasses.map((p: any) => p.referenceCode)).toEqual(['EGP-MAIN']);
    expect(await verifyEmergencyManifestCrypto(manifestBody.manifest)).toBe(true);
    expect(rpcCalls.some((c) => c.fn === 'record_emergency_manifest')).toBe(true);

    // 3. Batch sync sorts out-of-order sequences monotonically (seq 1 before seq 2)
    const syncRes = await emergencyDeviceRoute.fetch(
      new Request('http://localhost/api/gate/emergency-device', {
        method: 'POST',
        headers: { Authorization: 'Bearer device-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
              recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
              claimedGate: 'Side Gate',
              visitorFullName: 'Second Visitor',
              declaredAddress: 'Quezon City, Metro Manila',
              purpose: 'Claim ID',
              destinationOfficeId: officeId,
              destinationOfficeNameSnapshot: 'Office of the Registrar',
              officeResolutionStatus: 'resolved_snapshot',
              officeRequiresApprovalSnapshot: true,
              idPhysicallyInspected: true,
              idInspectionAttestationText: PHYSICAL_ID_ATTESTATION_TEXT,
              localRecordedAt: '2026-11-12T08:05:00+08:00',
              localSequence: 2,
              snapshotVersion: 'snap-v1',
              manifestId: '44444444-4444-4444-8444-444444444444',
              leaseStatusAtRecord: 'valid',
              emergencyExceptionApplied: false,
            },
            {
              requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
              recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
              claimedGate: 'Main Gate',
              visitorFullName: 'First Visitor',
              declaredAddress: 'Sampaloc, Manila',
              purpose: 'Registrar',
              destinationOfficeId: officeId,
              destinationOfficeNameSnapshot: 'Office of the Registrar',
              officeResolutionStatus: 'resolved_snapshot',
              officeRequiresApprovalSnapshot: true,
              idPhysicallyInspected: true,
              idInspectionAttestationText: PHYSICAL_ID_ATTESTATION_TEXT,
              localRecordedAt: '2026-11-12T08:01:00+08:00',
              localSequence: 1,
              snapshotVersion: 'snap-v1',
              manifestId: '44444444-4444-4444-8444-444444444444',
              leaseStatusAtRecord: 'valid',
              emergencyExceptionApplied: false,
            },
          ],
        }),
      }),
    );
    expect(syncRes.status).toBe(200);
    const syncBody = await syncRes.json();
    expect(syncBody.acceptedCount).toBe(1);
    expect(syncBody.conflictCount).toBe(1);
    const syncItemSeqs = rpcCalls
      .filter((c) => c.fn === 'record_emergency_sync_item')
      .map((c) => c.args.requested_local_sequence);
    expect(syncItemSeqs).toEqual([1, 2]);

    // 4. Admin reconciliation endpoint enforces admin/superadmin & delegates to RPC
    vi.spyOn(actorsModule, 'requireStaffActor').mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      email: 'admin@earist.edu.ph',
      role: 'admin',
    });

    const reconcileRes = await emergencyRecordsRoute.fetch(
      new Request('http://localhost/api/admin/emergency-records', {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          decision: 'accepted',
          notes: 'Verified physical logbook entry at Main Gate.',
        }),
      }),
    );
    expect(reconcileRes.status).toBe(200);
    expect(rpcCalls.some((c) => c.fn === 'reconcile_emergency_gate_record')).toBe(true);
  });
});
