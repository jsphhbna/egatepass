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

export type EmergencyLeaseStatus =
  | 'valid'
  | 'stale_lease'
  | 'expired_lease'
  | 'unverified_lease'
  | 'no_manifest';

export interface ManifestVerificationResult {
  leaseStatus: EmergencyLeaseStatus;
  cryptoValid: boolean;
  gateMatches: boolean;
  deviceMatches: boolean;
  expired: boolean;
  reason: string;
}

export function normalizeGateName(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === 'object') {
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

function toHex(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    out += (arr[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeSpkiToDer(raw: string): Uint8Array {
  const trimmed = raw
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  return decodeBase64(trimmed);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function computeManifestHashWebCrypto(payload: EmergencyManifestPayload): Promise<string> {
  const canonical = canonicalizeManifestPayload(payload);
  const encoded = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
}

export async function verifyEmergencyManifestCrypto(manifest: SignedEmergencyManifest): Promise<boolean> {
  try {
    if (!manifest || manifest.algorithm !== 'ECDSA_P256_SHA256') return false;
    if (!manifest.payload || !manifest.signature || !manifest.publicKeySpki || !manifest.manifestHash) {
      return false;
    }

    const expectedHash = await computeManifestHashWebCrypto(manifest.payload);
    if (expectedHash !== manifest.manifestHash) {
      return false;
    }

    const canonical = canonicalizeManifestPayload(manifest.payload);
    const dataBytes = new TextEncoder().encode(canonical);
    const spkiBytes = decodeSpkiToDer(manifest.publicKeySpki);
    const signatureBytes = decodeBase64(manifest.signature);

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'spki',
      toArrayBuffer(spkiBytes),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      toArrayBuffer(signatureBytes),
      toArrayBuffer(dataBytes),
    );
  } catch {
    return false;
  }
}

export async function evaluateEmergencyManifestLease(
  manifest: SignedEmergencyManifest | null | undefined,
  deviceUserId: string,
  assignedGate: string,
  nowMs: number = Date.now(),
): Promise<ManifestVerificationResult> {
  if (!manifest) {
    return {
      leaseStatus: 'no_manifest',
      cryptoValid: false,
      gateMatches: false,
      deviceMatches: false,
      expired: false,
      reason: 'No signed gate manifest cached on this device.',
    };
  }

  const cryptoValid = await verifyEmergencyManifestCrypto(manifest);
  const deviceMatches = manifest.payload?.deviceUserId === deviceUserId;
  const gateMatches =
    normalizeGateName(manifest.payload?.assignedGate) === normalizeGateName(assignedGate) &&
    normalizeGateName(manifest.payload?.normalizedGate) === normalizeGateName(assignedGate);

  if (!cryptoValid) {
    return {
      leaseStatus: 'unverified_lease',
      cryptoValid: false,
      gateMatches,
      deviceMatches,
      expired: false,
      reason: 'Manifest cryptographic signature verification failed.',
    };
  }

  if (!deviceMatches || !gateMatches) {
    return {
      leaseStatus: 'unverified_lease',
      cryptoValid: true,
      gateMatches,
      deviceMatches,
      expired: false,
      reason: 'Manifest device or gate binding does not match this Emergency Device.',
    };
  }

  const issuedAtMs = Date.parse(manifest.payload.issuedAt);
  const expiresAtMs = Date.parse(manifest.payload.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    return {
      leaseStatus: 'unverified_lease',
      cryptoValid: true,
      gateMatches: true,
      deviceMatches: true,
      expired: false,
      reason: 'Manifest lease timestamps are invalid.',
    };
  }

  if (nowMs > expiresAtMs) {
    return {
      leaseStatus: 'expired_lease',
      cryptoValid: true,
      gateMatches: true,
      deviceMatches: true,
      expired: true,
      reason: '24-hour signed manifest lease has expired. Offline records remain queued for mandatory review.',
    };
  }

  return {
    leaseStatus: 'valid',
    cryptoValid: true,
    gateMatches: true,
    deviceMatches: true,
    expired: false,
    reason: 'Signed manifest verified and within 24-hour lease window.',
  };
}
