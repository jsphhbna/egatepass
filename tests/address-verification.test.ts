import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchAddressAutocomplete, verifyPlaceDetails } from '../server/lib/geoapify.js';

describe('Address Verification & Geoapify Integration', () => {
  const originalApiKey = process.env.GEOAPIFY_API_KEY;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.GEOAPIFY_API_KEY = 'test-geoapify-key-123456';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.GEOAPIFY_API_KEY = originalApiKey;
    global.fetch = originalFetch;
  });

  describe('searchAddressAutocomplete', () => {
    it('returns empty array when query is less than 4 characters', async () => {
      const results = await searchAddressAutocomplete('Man');
      expect(results).toEqual([]);
    });

    it('queries Geoapify autocomplete with Philippines filter and returns sanitized suggestions', async () => {
      const mockPayload = {
        results: [
          {
            place_id: 'place_earist_123',
            formatted: 'Nagtahan St, Sampaloc, Manila, Metro Manila, Philippines',
            address_line1: 'Nagtahan St',
            city: 'Manila',
            state: 'Metro Manila',
            postcode: '1008',
            country_code: 'ph',
            lat: 14.5995,
            lon: 120.9842,
            result_type: 'street',
            rank: { confidence: 0.95, match_type: 'full_match' },
          },
          {
            place_id: 'place_invalid_us',
            formatted: 'Manila St, California, USA',
            country_code: 'us',
            lat: 37.7749,
            lon: -122.4194,
            result_type: 'street',
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as any);

      const results = await searchAddressAutocomplete('Nagtahan Manila');

      expect(results).toHaveLength(1);
      expect(results[0].placeId).toBe('place_earist_123');
      expect(results[0].formatted).toBe('Nagtahan St, Sampaloc, Manila, Metro Manila, Philippines');
      expect(results[0].countryCode).toBe('ph');
      expect(results[0].city).toBe('Manila');
      expect(results[0].confidence).toBe(0.95);

      // Verify endpoint and filter
      const fetchCall = (global.fetch as any).mock.calls[0];
      const calledUrl = new URL(fetchCall[0]);
      expect(calledUrl.origin).toBe('https://api.geoapify.com');
      expect(calledUrl.searchParams.get('filter')).toBe('countrycode:ph');
      expect(calledUrl.searchParams.get('apiKey')).toBe('test-geoapify-key-123456');
    });

    it('handles GeoJSON feature collection response format', async () => {
      const mockGeoJson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              place_id: 'feature_place_456',
              formatted: 'Valencia St, Sampaloc, Manila, Philippines',
              city: 'Manila',
              country_code: 'ph',
              lat: 14.601,
              lon: 120.992,
              result_type: 'street',
              rank: { confidence: 0.88 },
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockGeoJson,
      } as any);

      const results = await searchAddressAutocomplete('Valencia');
      expect(results).toHaveLength(1);
      expect(results[0].placeId).toBe('feature_place_456');
      expect(results[0].formatted).toBe('Valencia St, Sampaloc, Manila, Philippines');
    });

    it('throws address_rate_limited on HTTP 429', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
      } as any);

      await expect(searchAddressAutocomplete('Earist Nagtahan')).rejects.toThrow('address_rate_limited');
    });
  });

  describe('verifyPlaceDetails', () => {
    it('successfully revalidates a specific Philippines location', async () => {
      const mockDetails = {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              place_id: 'earist_gate_1',
              formatted: 'EARIST, Nagtahan St, Sampaloc, Manila, 1008 Metro Manila, Philippines',
              city: 'Manila',
              state: 'Metro Manila',
              postcode: '1008',
              country_code: 'ph',
              lat: 14.5995,
              lon: 120.9842,
              result_type: 'amenity',
              rank: { confidence: 1.0 },
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockDetails,
      } as any);

      const verified = await verifyPlaceDetails('earist_gate_1', 'Main Building Room 204');

      expect(verified.placeId).toBe('earist_gate_1');
      expect(verified.formatted).toContain('EARIST, Nagtahan St');
      expect(verified.countryCode).toBe('ph');
      expect(verified.city).toBe('Manila');
      expect(verified.addressDetail).toBe('Main Building Room 204');
      expect(verified.lat).toBe(14.5995);
      expect(verified.lon).toBe(120.9842);
    });

    it('rejects broad results (result_type = country or state)', async () => {
      const broadCountry = {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              place_id: 'ph_country',
              formatted: 'Philippines',
              country_code: 'ph',
              lat: 12.8797,
              lon: 121.774,
              result_type: 'country',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => broadCountry,
      } as any);

      await expect(verifyPlaceDetails('ph_country')).rejects.toThrow('address_too_broad');
    });

    it('rejects broad state/region only results like Metro Manila', async () => {
      const broadState = {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              place_id: 'metro_manila_state',
              formatted: 'Metro Manila',
              country_code: 'ph',
              lat: 14.5995,
              lon: 120.9842,
              result_type: 'state',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => broadState,
      } as any);

      await expect(verifyPlaceDetails('metro_manila_state')).rejects.toThrow('address_too_broad');
    });

    it('rejects coordinates outside Philippines bounding box', async () => {
      const outOfBounds = {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              place_id: 'tokyo_in_disguise',
              formatted: 'Tokyo Street, Manila, Philippines',
              country_code: 'ph',
              lat: 35.6762, // Japan latitude, outside PH (4.0-22.0)
              lon: 139.6503,
              result_type: 'street',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => outOfBounds,
      } as any);

      await expect(verifyPlaceDetails('tokyo_in_disguise')).rejects.toThrow('address_coordinates_out_of_bounds');
    });

    it('rejects non-Philippines country code', async () => {
      const nonPh = {
        type: 'FeatureCollection',
        features: [
          {
            properties: {
              place_id: 'singapore_place',
              formatted: 'Orchard Rd, Singapore',
              country_code: 'sg',
              lat: 1.3048,
              lon: 103.8318,
              result_type: 'street',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => nonPh,
      } as any);

      await expect(verifyPlaceDetails('singapore_place')).rejects.toThrow('address_must_be_philippines');
    });

    it('fails closed when GEOAPIFY_API_KEY is not configured', async () => {
      delete process.env.GEOAPIFY_API_KEY;
      await expect(verifyPlaceDetails('any_place')).rejects.toThrow('address_verification_unavailable');
    });
  });
});
