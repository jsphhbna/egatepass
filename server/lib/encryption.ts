import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { HttpError } from '../actors.js';

/**
 * Retrieves and validates the dedicated 256-bit AES encryption key for office visit delivery.
 * Fails closed if missing or insufficient.
 */
export function getDeliveryEncryptionKey(): Buffer {
  const rawKey = process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY?.trim();
  if (!rawKey) {
    throw new HttpError(503, 'delivery_encryption_key_missing');
  }

  // Support 64 hex characters (32 bytes) or 32 raw characters
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  if (Buffer.byteLength(rawKey, 'utf8') >= 32) {
    return Buffer.from(rawKey, 'utf8').subarray(0, 32);
  }

  throw new HttpError(503, 'delivery_encryption_key_insufficient');
}

/**
 * Encrypts a raw QR bearer token using AES-256-GCM.
 * Format: iv_hex:authTag_hex:ciphertext_hex
 */
export function encryptQrPayload(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('invalid_plaintext');
  }

  const key = getDeliveryEncryptionKey();
  const iv = randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted payload back to the canonical QR bearer token.
 */
export function decryptQrPayload(encryptedPayload: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('invalid_encrypted_payload');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('malformed_encrypted_payload');
  }

  const [ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('malformed_encrypted_payload_segments');
  }

  const key = getDeliveryEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
