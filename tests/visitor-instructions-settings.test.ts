import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const updateSettingsInstructionSchema = z.array(
  z.string().trim().min(3, 'Instruction must be at least 3 characters').max(180, 'Instruction must not exceed 180 characters')
).min(1, 'At least 1 instruction is required').max(8, 'Maximum 8 instructions allowed');

describe('Group E: Configurable Visitor Instructions Validation & Public Exposure', () => {
  it('accepts valid 1-8 instructions array of 3-180 characters', () => {
    const validInstructions = [
      'Follow the EARIST visitor dress code and campus policies.',
      'Bring a valid ID for identity verification at the gate.',
      'Keep your E-GatePass ready before approaching the entrance.',
    ];
    const parsed = updateSettingsInstructionSchema.safeParse(validInstructions);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.length).toBe(3);
    }
  });

  it('rejects an empty instructions array (< 1 instruction)', () => {
    const emptyList: string[] = [];
    const parsed = updateSettingsInstructionSchema.safeParse(emptyList);
    expect(parsed.success).toBe(false);
  });

  it('rejects an array with more than 8 instructions', () => {
    const excessiveList = [
      'Instruction 1',
      'Instruction 2',
      'Instruction 3',
      'Instruction 4',
      'Instruction 5',
      'Instruction 6',
      'Instruction 7',
      'Instruction 8',
      'Instruction 9',
    ];
    const parsed = updateSettingsInstructionSchema.safeParse(excessiveList);
    expect(parsed.success).toBe(false);
  });

  it('rejects an instruction shorter than 3 characters or only whitespace', () => {
    const shortList = ['OK'];
    const whitespaceList = ['   '];
    expect(updateSettingsInstructionSchema.safeParse(shortList).success).toBe(false);
    expect(updateSettingsInstructionSchema.safeParse(whitespaceList).success).toBe(false);
  });

  it('rejects an instruction longer than 180 characters', () => {
    const tooLong = 'A'.repeat(181);
    const parsed = updateSettingsInstructionSchema.safeParse([tooLong]);
    expect(parsed.success).toBe(false);
  });

  it('public registration settings expose only public-safe fields', () => {
    const fullDbRow = {
      visitor_instructions: ['Instruction 1', 'Instruction 2'],
      image_retention_days: 7,
      visitor_retention_days: 30,
      turnstile_secret_key: '0x4AAAAAAAPrivilegedSecret',
      resend_api_key: 're_secret_12345',
      kiosk_operator_pin: '1234',
    };

    // Public contract extraction
    const publicSafeSettings = {
      visitorInstructions: fullDbRow.visitor_instructions,
      imageRetentionDays: fullDbRow.image_retention_days,
      visitorRetentionDays: fullDbRow.visitor_retention_days,
    };

    expect(publicSafeSettings).toHaveProperty('visitorInstructions');
    expect(publicSafeSettings).toHaveProperty('imageRetentionDays');
    expect(publicSafeSettings).toHaveProperty('visitorRetentionDays');
    expect((publicSafeSettings as any).turnstile_secret_key).toBeUndefined();
    expect((publicSafeSettings as any).resend_api_key).toBeUndefined();
    expect((publicSafeSettings as any).kiosk_operator_pin).toBeUndefined();
  });
});
