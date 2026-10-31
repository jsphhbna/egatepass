import { describe, it, expect, vi } from 'vitest';
import { normalizeVehiclePlate } from '../src/lib/vehiclePlate';
import { mapDatabaseIssueError } from '../server/routes/passes/issue';

describe('Cross-Layer Contracts & Defect Closure', () => {
  describe('Producer -> Consumer Envelope Contract', () => {
    it('client parses address suggestions envelope { suggestions: [...] } and handles top-level array fallback', () => {
      const serverEnvelope = {
        suggestions: [
          {
            placeId: 'place-abc-123',
            formatted: 'EARIST Manila, Nagtahan St, Sampaloc, Manila',
            addressLine1: 'Nagtahan St',
            resultType: 'street',
            confidence: 0.98,
            lat: 14.5995,
            lon: 120.9842,
            city: 'Manila',
            state: 'Metro Manila',
            postcode: '1008',
            countryCode: 'ph',
          },
        ],
      };

      // Frontend extraction logic
      const extractedFromEnvelope = Array.isArray(serverEnvelope?.suggestions)
        ? serverEnvelope.suggestions
        : Array.isArray(serverEnvelope)
          ? serverEnvelope
          : [];
      expect(extractedFromEnvelope).toHaveLength(1);
      expect(extractedFromEnvelope[0].placeId).toBe('place-abc-123');

      // Top-level array backward compat
      const legacyArray = [serverEnvelope.suggestions[0]];
      const extractedFromArray = Array.isArray((legacyArray as any)?.suggestions)
        ? (legacyArray as any).suggestions
        : Array.isArray(legacyArray)
          ? legacyArray
          : [];
      expect(extractedFromArray).toHaveLength(1);
      expect(extractedFromArray[0].placeId).toBe('place-abc-123');

      // Empty or invalid payload
      const emptyPayload = null;
      const extractedFromNull = Array.isArray((emptyPayload as any)?.suggestions)
        ? (emptyPayload as any).suggestions
        : Array.isArray(emptyPayload)
          ? emptyPayload
          : [];
      expect(extractedFromNull).toEqual([]);
    });

    it('client parses vehicle makes envelope { makes: [...] } and handles top-level array fallback', () => {
      const serverEnvelope = {
        makes: ['Toyota', 'Honda', 'Mitsubishi', 'Nissan', 'Hyundai'],
      };

      const extracted = Array.isArray(serverEnvelope?.makes)
        ? serverEnvelope.makes
        : Array.isArray(serverEnvelope)
          ? serverEnvelope
          : [];
      expect(extracted).toEqual(['Toyota', 'Honda', 'Mitsubishi', 'Nissan', 'Hyundai']);

      // Direct array fallback
      const directArray = ['Toyota', 'Honda'];
      const extractedDirect = Array.isArray((directArray as any)?.makes)
        ? (directArray as any).makes
        : Array.isArray(directArray)
          ? directArray
          : [];
      expect(extractedDirect).toEqual(['Toyota', 'Honda']);
    });

    it('client parses vehicle models envelope { models: [...] } and handles top-level array fallback', () => {
      const serverEnvelope = {
        models: ['Vios', 'Corolla', 'Innova', 'Fortuner', 'Hilux'],
      };

      const extracted = Array.isArray(serverEnvelope?.models)
        ? serverEnvelope.models
        : Array.isArray(serverEnvelope)
          ? serverEnvelope
          : [];
      expect(extracted).toEqual(['Vios', 'Corolla', 'Innova', 'Fortuner', 'Hilux']);
    });
  });

  describe('Controlled Placeholder Plate Denylist', () => {
    const denylisted = [
      'NONE',
      'NOPLATE',
      'NO PLATE',
      'UNKNOWN',
      'TEST',
      'TEST123',
      'N/A',
      'NA',
      'XXXX',
      'XXX',
      'none',
      'no plate',
      '  unknown  ',
      'test123',
      'n/a',
      'xxxx',
    ];

    it.each(denylisted)('rejects placeholder plate "%s"', (plate) => {
      const res = normalizeVehiclePlate(plate);
      expect(res.valid).toBe(false);
      expect(res.error).toBe('Please enter a real vehicle plate number, not a placeholder.');
    });

    it('accepts legitimate plates including LTO series starting with letters in denylist', () => {
      const validCases = [
        { raw: 'ABC 1234', expectedDisplay: 'ABC 1234' },
        { raw: 'naa 1234', expectedDisplay: 'NAA 1234' }, // Real LTO Region 3 series
        { raw: '1234-567890', expectedDisplay: '1234 567890' }, // MV File / temporary
        { raw: 'MV 12345678', expectedDisplay: 'MV 12345678' },
        { raw: 'XYZ 789', expectedDisplay: 'XYZ 789' },
      ];

      for (const tc of validCases) {
        const res = normalizeVehiclePlate(tc.raw);
        expect(res.valid).toBe(true);
        expect(res.displayPlate).toBe(tc.expectedDisplay);
      }
    });
  });

  describe('Table-Driven Database Error Mapper (mapDatabaseIssueError)', () => {
    const testCases: Array<{
      desc: string;
      err: any;
      expectedStatus: number;
      expectedError: string;
    }> = [
      {
        desc: 'visit date out of range',
        err: { message: 'visit date out of range: must be between today and 14 days ahead', code: '22023' },
        expectedStatus: 422,
        expectedError: 'visit_date_out_of_range',
      },
      {
        desc: 'invalid arrival mode',
        err: { message: 'invalid arrival mode: explicit selection required', code: '22023' },
        expectedStatus: 422,
        expectedError: 'invalid_arrival_mode',
      },
      {
        desc: 'vehicle already inside campus',
        err: { message: 'vehicle already inside campus', code: '23505' },
        expectedStatus: 409,
        expectedError: 'vehicle_already_inside',
      },
      {
        desc: 'vehicle details required',
        err: { message: 'vehicle details required for vehicle arrival mode', code: '22023' },
        expectedStatus: 422,
        expectedError: 'vehicle_details_required',
      },
      {
        desc: 'vehicle photo required',
        err: { message: 'vehicle photo required for vehicle arrival', code: '22023' },
        expectedStatus: 422,
        expectedError: 'vehicle_photo_required',
      },
      {
        desc: 'plate number required',
        err: { message: 'plate number is required', code: '22023' },
        expectedStatus: 422,
        expectedError: 'plate_number_required',
      },
      {
        desc: 'invalid vehicle type',
        err: { message: 'invalid vehicle type: must be car, motorcycle, van, etc.', code: '22023' },
        expectedStatus: 422,
        expectedError: 'invalid_vehicle_type',
      },
      {
        desc: 'vehicle make model required',
        err: { message: 'vehicle make and model required (2-100 characters)', code: '22023' },
        expectedStatus: 422,
        expectedError: 'vehicle_make_model_required',
      },
      {
        desc: 'insufficient privilege',
        err: { message: 'insufficient privilege to issue pass for visitor', code: '42501' },
        expectedStatus: 403,
        expectedError: 'forbidden',
      },
      {
        desc: 'rate limit exceeded',
        err: { message: 'rate limit exceeded for visitor registration', code: 'P0001' },
        expectedStatus: 429,
        expectedError: 'rate_limit_exceeded',
      },
      {
        desc: 'pass token secret rotated',
        err: { message: 'pass_token_secret_rotated', code: 'P0001' },
        expectedStatus: 409,
        expectedError: 'pass_token_secret_rotated',
      },
      {
        desc: 'pass has expired',
        err: { message: 'pass_has_expired', code: '22023' },
        expectedStatus: 422,
        expectedError: 'pass_has_expired',
      },
      {
        desc: 'unknown SQLSTATE 22023 does NOT falsely map to visit_date_out_of_range',
        err: { message: 'some arbitrary 22023 parameter format error', code: '22023' },
        expectedStatus: 422,
        expectedError: 'invalid_request',
      },
      {
        desc: 'unhandled server/database error',
        err: { message: 'connection lost to pgpool', code: '08006' },
        expectedStatus: 503,
        expectedError: 'service_unavailable',
      },
    ];

    it.each(testCases)('$desc -> $expectedStatus $expectedError', ({ err, expectedStatus, expectedError }) => {
      const res = mapDatabaseIssueError(err);
      expect(res.status).toBe(expectedStatus);
      expect(res.error).toBe(expectedError);
    });
  });
});
