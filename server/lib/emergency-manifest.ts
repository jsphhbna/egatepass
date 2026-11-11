import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const PHYSICAL_ID_ATTESTATION_TEXT =
  'I confirm that the visitor physically presented an identification document and that I visually inspected it.';

export const EMERGENCY_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EmergencyManifestExpectedPass {
  passId: string;
  referenceCode: string;
  status: string;
  visitorName: string;
  purpose: string;
  officeId: string | null;
  officeName: string | null;
  requiresApproval: boolean;
  expectedGate: string;
  validUntil: string | null;
}

export interface EmergencyManifestOffice {
  id: string;
  name: string;
  code: string | null;
  requiresApprovalBeforePass: boolean;
}

export interface EmergencyManifestPayload {
  manifestId: string;
  deviceUserId: string;
  deviceId: string;
  assignedGate: string;
  normalizedGate: string;
  snapshotVersion: string;
  issuedAt: string;
  expiresAt: string;
  scope: 'emergency_offline_gate';
  allowEmergencyException: boolean;
  emergencyExceptionPolicyNote: string | null;
  expectedPasses: EmergencyManifestExpectedPass[];
  offices: EmergencyManifestOffice[];
}

export interface SignedEmergencyManifest {
  payload: EmergencyManifestPayload;
  manifestHash: string;
  algorithm: 'ECDSA_P256_SHA256';
  keyId: string;
  publicKeySpki: string;
  signature: string;
}

interface StoredSigningKeyRow {
  id: string;
  algorithm: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
}

export function normalizeGateName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeManifestPayload(payload: EmergencyManifestPayload): string {
  return JSON.stringify(sortJsonValue(payload));
}

export function computeManifestHash(payload: EmergencyManifestPayload): string {
  const canonical = canonicalizeManifestPayload(payload);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function parsePrivateKeyMaterial(raw: string): KeyObject {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) {
    return createPrivateKey({ key: trimmed, format: 'pem' });
  }
  return createPrivateKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

function parsePublicKeySpki(raw: string): KeyObject {
  const trimmed = raw.trim();
  if (trimmed.includes('-----BEGIN')) {
    return createPublicKey({ key: trimmed, format: 'pem' });
  }
  return createPublicKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

async function resolveSigningKeyMaterial(admin: SupabaseClient): Promise<{
  keyId: string;
  publicKeySpki: string;
  privateKey: KeyObject;
}> {
  const envKey = process.env.EMERGENCY_MANIFEST_SIGNING_PRIVATE_KEY?.trim();
  if (envKey) {
    const privateKey = parsePrivateKeyMaterial(envKey);
    const publicKeySpki = createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    return {
      keyId: 'env-p256-v1',
      publicKeySpki,
      privateKey,
    };
  }

  const { data: existing, error: fetchErr } = await admin
    .schema('api')
    .rpc('get_active_emergency_signing_key');
  if (fetchErr) throw fetchErr;

  const existingRow = existing as StoredSigningKeyRow | null;
  if (existingRow?.privateKeyPkcs8 && existingRow?.publicKeySpki) {
    return {
      keyId: existingRow.id || 'default-p256-v1',
      publicKeySpki: existingRow.publicKeySpki,
      privateKey: parsePrivateKeyMaterial(existingRow.privateKeyPkcs8),
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const publicKeySpki = (publicKey as Buffer).toString('base64');
  const privateKeyPkcs8 = (privateKey as Buffer).toString('base64');

  const { data: stored, error: storeErr } = await admin
    .schema('api')
    .rpc('store_emergency_signing_key', {
      requested_id: 'default-p256-v1',
      requested_public_key_spki: publicKeySpki,
      requested_private_key_pkcs8: privateKeyPkcs8,
    });
  if (storeErr) throw storeErr;

  const storedRow = stored as StoredSigningKeyRow | null;
  if (!storedRow?.privateKeyPkcs8 || !storedRow?.publicKeySpki) {
    throw new Error('emergency_signing_key_unavailable');
  }

  return {
    keyId: storedRow.id || 'default-p256-v1',
    publicKeySpki: storedRow.publicKeySpki,
    privateKey: parsePrivateKeyMaterial(storedRow.privateKeyPkcs8),
  };
}

export async function signEmergencyManifest(
  admin: SupabaseClient,
  payload: EmergencyManifestPayload,
): Promise<SignedEmergencyManifest> {
  const { keyId, publicKeySpki, privateKey } = await resolveSigningKeyMaterial(admin);
  const canonical = canonicalizeManifestPayload(payload);
  const manifestHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  const signature = cryptoSign('sha256', Buffer.from(canonical, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');

  return {
    payload,
    manifestHash,
    algorithm: 'ECDSA_P256_SHA256',
    keyId,
    publicKeySpki,
    signature,
  };
}

export function verifyEmergencyManifestSignature(manifest: SignedEmergencyManifest): boolean {
  try {
    if (manifest.algorithm !== 'ECDSA_P256_SHA256') return false;
    const expectedHash = computeManifestHash(manifest.payload);
    if (expectedHash !== manifest.manifestHash) return false;
    const canonical = canonicalizeManifestPayload(manifest.payload);
    const pubKey = parsePublicKeySpki(manifest.publicKeySpki);
    return cryptoVerify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      { key: pubKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(manifest.signature, 'base64'),
    );
  } catch {
    return false;
  }
}
