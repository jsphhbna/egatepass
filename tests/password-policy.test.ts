import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_HELPER_TEXT as CLIENT_HELPER_TEXT,
  getPasswordPolicyError as getClientPasswordPolicyError,
  isValidPassword as isClientValidPassword,
  passwordSchema as clientPasswordSchema,
} from '../src/lib/passwordPolicy';
import {
  PASSWORD_POLICY_HELPER_TEXT as SERVER_HELPER_TEXT,
  getPasswordPolicyError as getServerPasswordPolicyError,
  passwordSchema as serverPasswordSchema,
} from '../server/password-policy';

describe('REPAIR GROUP L: Canonical Password Policy Matrix', () => {
  it('has identical helper text and minimum length across client and server', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(CLIENT_HELPER_TEXT).toBe(SERVER_HELPER_TEXT);
    expect(CLIENT_HELPER_TEXT).toBe('At least 12 characters, including uppercase, lowercase, numbers, and symbols.');
  });

  const matrix = [
    { password: 'Short1!a', valid: false, reason: 'too short (<12 chars)' },
    { password: 'ALLUPPERCASE123!@#', valid: false, reason: 'no lowercase' },
    { password: 'alllowercase123!@#', valid: false, reason: 'no uppercase' },
    { password: 'NoDigitsHere!@#$Abc', valid: false, reason: 'no digit' },
    { password: 'NoSymbolsAllowed123Abc', valid: false, reason: 'no symbol' },
    { password: 'ValidP@ssw0rd123!', valid: true, reason: 'valid 12+ mixed password' },
    { password: 'Correct-Horse-Battery-Staple-99!', valid: true, reason: 'valid long passphrase with symbol/digit' },
  ];

  it.each(matrix)('evaluates matrix item: %s ($reason)', ({ password, valid }) => {
    // Client validator
    expect(isClientValidPassword(password)).toBe(valid);
    expect(getClientPasswordPolicyError(password) === null).toBe(valid);

    // Server validator
    expect(getServerPasswordPolicyError(password) === null).toBe(valid);

    // Client zod schema
    const clientResult = clientPasswordSchema.safeParse(password);
    expect(clientResult.success).toBe(valid);

    // Server zod schema
    const serverResult = serverPasswordSchema.safeParse(password);
    expect(serverResult.success).toBe(valid);
  });
});
