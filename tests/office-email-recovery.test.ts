import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptQrPayload, decryptQrPayload, getDeliveryEncryptionKey } from '../server/lib/encryption.js';

describe('Office Pass Token Encryption & Delivery Key Contract', () => {
  const originalKey = process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  it('successfully encrypts and decrypts QR token payloads round-trip', () => {
    const rawToken = 'pass_live_tok_secret_value_1234567890abcdefghijklmnopqrstuvwxyz';
    const encrypted = encryptQrPayload(rawToken);

    expect(encrypted).not.toBe(rawToken);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.length).toBeGreaterThan(32);

    const decrypted = decryptQrPayload(encrypted);
    expect(decrypted).toBe(rawToken);
  });

  it('produces different ciphertexts for identical plaintext due to random IV', () => {
    const rawToken = 'pass_token_consistent_test_value';
    const enc1 = encryptQrPayload(rawToken);
    const enc2 = encryptQrPayload(rawToken);

    expect(enc1).not.toBe(enc2);
    expect(decryptQrPayload(enc1)).toBe(rawToken);
    expect(decryptQrPayload(enc2)).toBe(rawToken);
  });

  it('fails decryption when ciphertext is tampered or corrupted', () => {
    const rawToken = 'secure_raw_pass_token_12345';
    const encrypted = encryptQrPayload(rawToken);
    const buf = Buffer.from(encrypted, 'base64');
    // Tamper with the last byte
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decryptQrPayload(tampered)).toThrow();
  });

  it('fails closed when delivery encryption key is missing or too short', () => {
    delete process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY;
    expect(() => getDeliveryEncryptionKey()).toThrow(/delivery_encryption_key_missing/);

    process.env.OFFICE_VISIT_DELIVERY_ENCRYPTION_KEY = 'short_key';
    expect(() => getDeliveryEncryptionKey()).toThrow(/delivery_encryption_key_insufficient/);
  });
});
