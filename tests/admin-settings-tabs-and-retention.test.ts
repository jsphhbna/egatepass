import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETENTION_POLICY,
  normalizeRetentionPolicy,
  type RetentionPolicy,
} from '../src/lib/retentionPolicy';
import {
  createRetentionInputValues,
  validateRetentionInputs,
  getRetentionInputError,
} from '../src/lib/retentionInput';

describe('Admin Settings — Granular Retention Categories (Phase D)', () => {
  it('normalizes retention policy with default granular category controls', () => {
    const emptyPolicy = normalizeRetentionPolicy({});
    expect(emptyPolicy.photoRetentionEnabled).toBe(true);
    expect(emptyPolicy.idRetentionEnabled).toBe(true);
    expect(emptyPolicy.vehiclePhotoRetentionEnabled).toBe(true);
    expect(emptyPolicy.visitorRetentionEnabled).toBe(true);
    expect(emptyPolicy.returningProfileRetentionEnabled).toBe(true);
    expect(emptyPolicy.vehiclePhotoRetentionDays).toBe(30);
    expect(emptyPolicy.returningProfileRetentionDays).toBe(30);
    expect(emptyPolicy.automaticCleanupEnabled).toBe(true);
    expect(Array.isArray(emptyPolicy.retentionOverrides)).toBe(true);
  });

  it('preserves Superadmin granular category overrides and custom retention days', () => {
    const customConfig = {
      visitorRetentionDays: 60,
      photoRetentionDays: 14,
      idRetentionDays: 45,
      vehiclePhotoRetentionDays: 15,
      returningProfileRetentionDays: 90,
      auditRetentionDays: 730,
      reconciliationRetentionDays: 180,
      automaticCleanupEnabled: false,
      photoRetentionEnabled: false, // Disabled
      idRetentionEnabled: true,
      vehiclePhotoRetentionEnabled: false, // Disabled
      visitorRetentionEnabled: true,
      returningProfileRetentionEnabled: true,
      retentionOverrides: [
        {
          timestamp: '2026-11-10T10:00:00Z',
          actor: 'admin@earist.edu.ph',
          reason: 'Legal compliance hold on photos',
          changes: { photoRetentionEnabled: { previous: true, current: false } },
        },
      ],
    };

    const normalized = normalizeRetentionPolicy(customConfig);
    expect(normalized.photoRetentionEnabled).toBe(false);
    expect(normalized.vehiclePhotoRetentionEnabled).toBe(false);
    expect(normalized.photoRetentionDays).toBe(14);
    expect(normalized.vehiclePhotoRetentionDays).toBe(15);
    expect(normalized.returningProfileRetentionDays).toBe(90);
    expect(normalized.retentionOverrides).toHaveLength(1);
    expect(normalized.retentionOverrides?.[0].reason).toBe('Legal compliance hold on photos');
  });

  it('creates retention input values with all granular fields', () => {
    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      vehiclePhotoRetentionDays: 20,
      returningProfileRetentionDays: 45,
    };

    const inputs = createRetentionInputValues(policy);
    expect(inputs.vehiclePhotoRetentionDays).toBe('20');
    expect(inputs.returningProfileRetentionDays).toBe('45');
    expect(inputs.visitorRetentionDays).toBe(String(policy.visitorRetentionDays));
    expect(inputs.photoRetentionDays).toBe(String(policy.photoRetentionDays));
  });

  it('validates retention input bounds correctly for vehicle photos and returning profiles', () => {
    // Valid inputs
    const valid = validateRetentionInputs({
      visitorRetentionDays: '30',
      imageRetentionDays: '7',
      photoRetentionDays: '7',
      idRetentionDays: '30',
      vehiclePhotoRetentionDays: '30',
      returningProfileRetentionDays: '30',
      auditRetentionDays: '365',
      reconciliationRetentionDays: '90',
    });
    expect(valid.success).toBe(true);

    // Invalid vehicle photos (> 90 days)
    const errVehicle = getRetentionInputError('vehiclePhotoRetentionDays', '100');
    expect(errVehicle).toBeDefined();

    // Invalid returning profile (< 7 days)
    const errProfile = getRetentionInputError('returningProfileRetentionDays', '3');
    expect(errProfile).toBeDefined();

    // Invalid negative days
    const errNegative = getRetentionInputError('photoRetentionDays', '-5');
    expect(errNegative).toBeDefined();
  });
});
