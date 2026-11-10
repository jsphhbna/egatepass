import { describe, it, expect } from 'vitest';
import { generateTemporaryPassword } from '../server/routes/admin/offices';
import { getPasswordPolicyError, passwordSchema } from '../server/password-policy';

describe('Admin Dedicated Office Account Provisioning (Phase F)', () => {
  it('generates high-entropy temporary passwords meeting institutional password policy', () => {
    for (let i = 0; i < 20; i++) {
      const pwd = generateTemporaryPassword();
      expect(pwd.length).toBe(16);
      expect(getPasswordPolicyError(pwd)).toBeNull();
      const parseResult = passwordSchema.safeParse(pwd);
      expect(parseResult.success).toBe(true);
      expect(/[A-Z]/.test(pwd)).toBe(true);
      expect(/[a-z]/.test(pwd)).toBe(true);
      expect(/\d/.test(pwd)).toBe(true);
      expect(/[^A-Za-z0-9]/.test(pwd)).toBe(true);
    }
  });

  it('generates distinct cryptographic temporary passwords across invocations', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
    expect(passwords.size).toBe(50);
  });
});
