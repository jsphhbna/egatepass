import { describe, expect, it } from 'vitest';
import {
  getRetentionInputError,
  validateRetentionInputs,
  type RetentionInputValues,
} from '../src/lib/retentionInput';

const validInputs: RetentionInputValues = {
  visitorRetentionDays: '30',
  imageRetentionDays: '7',
  auditRetentionDays: '365',
  reconciliationRetentionDays: '90',
};

describe('retention input validation', () => {
  it.each([
    ['visitorRetentionDays', '', false],
    ['visitorRetentionDays', '6', false],
    ['visitorRetentionDays', '7', true],
    ['visitorRetentionDays', '365', true],
    ['visitorRetentionDays', '366', false],
    ['visitorRetentionDays', '67000000', false],
    ['imageRetentionDays', '', false],
    ['imageRetentionDays', '0', false],
    ['imageRetentionDays', '1', true],
    ['imageRetentionDays', '90', true],
    ['imageRetentionDays', '91', false],
    ['auditRetentionDays', '', false],
    ['auditRetentionDays', '89', false],
    ['auditRetentionDays', '90', true],
    ['auditRetentionDays', '1095', true],
    ['auditRetentionDays', '1096', false],
    ['auditRetentionDays', '90000000', false],
    ['reconciliationRetentionDays', '', false],
    ['reconciliationRetentionDays', '29', false],
    ['reconciliationRetentionDays', '30', true],
    ['reconciliationRetentionDays', '365', true],
    ['reconciliationRetentionDays', '366', false],
  ] as const)('validates %s value %j as %s', (field, value, valid) => {
    expect(getRetentionInputError(field, value) === undefined).toBe(valid);
  });

  it.each([
    ['visitorRetentionDays', '7.5'],
    ['imageRetentionDays', '1.5'],
    ['auditRetentionDays', '90.5'],
    ['reconciliationRetentionDays', '30.5'],
  ] as const)('rejects non-integer %s input', (field, value) => {
    expect(getRetentionInputError(field, value)).toContain('whole number');
  });

  it('reports every invalid field and returns no parsed policy', () => {
    const result = validateRetentionInputs({
      visitorRetentionDays: '',
      imageRetentionDays: '0',
      auditRetentionDays: '1096',
      reconciliationRetentionDays: '30.5',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toMatchObject({
        visitorRetentionDays: expect.any(String),
        imageRetentionDays: expect.any(String),
        auditRetentionDays: expect.any(String),
        reconciliationRetentionDays: expect.any(String),
      });
    }
  });

  it('parses valid input strings into the numeric API payload', () => {
    const result = validateRetentionInputs(validInputs);
    expect(result).toEqual({
      success: true,
      data: {
        visitorRetentionDays: 30,
        imageRetentionDays: 7,
        auditRetentionDays: 365,
        reconciliationRetentionDays: 90,
      },
      errors: {},
    });
  });
});
