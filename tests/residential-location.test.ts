import { describe, it, expect } from 'vitest';
import {
  normalizeCoordinates as clientNormalize,
  DEFAULT_OSM_TILE_URL,
  DEFAULT_OSM_ATTRIBUTION,
  DEFAULT_CAMPUS_COORDINATES,
} from '../src/lib/homeLocation.js';
import { normalizeCoordinates as serverNormalize } from '../server/lib/home-location.js';

describe('Approximate Residential Location & Coordinate Normalization Contract', () => {
  describe('1. Coordinate Normalization & Precision Contract', () => {
    it('accepts valid coordinates within Philippine / global bounds and rounds to 3 decimals', () => {
      // Manila coordinates: 14.5995123, 120.9842123 -> 14.6, 120.984
      const res = clientNormalize(14.5995123, 120.9842123);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.location.lat).toBe(14.6);
        expect(res.location.lon).toBe(120.984);
      }
    });

    it('accepts valid negative coordinates and rounds correctly', () => {
      // Southern/Western hemisphere coordinates: -33.868812, -70.648271
      const res = clientNormalize(-33.868812, -70.648271);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.location.lat).toBe(-33.869);
        expect(res.location.lon).toBe(-70.648);
      }
    });

    it('normalizes negative zero to standard positive zero', () => {
      const res = clientNormalize(-0.00001, -0.00004);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(Object.is(res.location.lat, 0)).toBe(true);
        expect(Object.is(res.location.lon, 0)).toBe(true);
      }
    });

    it('rejects missing or null latitude or longitude when required', () => {
      const nullLat = clientNormalize(null, 120.984);
      expect(nullLat.valid).toBe(false);
      if (!nullLat.valid) {
        expect(nullLat.error).toBe('missing_coordinates');
      }

      const nullLon = clientNormalize(14.6, undefined);
      expect(nullLon.valid).toBe(false);
      if (!nullLon.valid) {
        expect(nullLon.error).toBe('missing_coordinates');
      }
    });

    it('permits missing coordinates when required=false', () => {
      const optional = clientNormalize(null, null, false);
      expect(optional.valid).toBe(false);
      if (!optional.valid) {
        expect(optional.error).toBe('missing_coordinates');
      }
    });

    it('rejects non-numeric inputs, NaN, and Infinity', () => {
      const nanRes = clientNormalize(NaN, 120.984);
      expect(nanRes.valid).toBe(false);
      if (!nanRes.valid) expect(nanRes.error).toBe('invalid_coordinate_type');

      const infRes = clientNormalize(14.6, Infinity);
      expect(infRes.valid).toBe(false);
      if (!infRes.valid) expect(infRes.error).toBe('invalid_coordinate_type');

      const strRes = clientNormalize('not-a-number', 120.984);
      expect(strRes.valid).toBe(false);
      if (!strRes.valid) expect(strRes.error).toBe('invalid_coordinate_type');
    });

    it('rejects latitude outside -90 to 90', () => {
      const lowLat = clientNormalize(-90.001, 120.984);
      expect(lowLat.valid).toBe(false);
      if (!lowLat.valid) expect(lowLat.error).toBe('coordinate_out_of_bounds');

      const highLat = clientNormalize(90.001, 120.984);
      expect(highLat.valid).toBe(false);
      if (!highLat.valid) expect(highLat.error).toBe('coordinate_out_of_bounds');
    });

    it('rejects longitude outside -180 to 180', () => {
      const lowLon = clientNormalize(14.6, -180.001);
      expect(lowLon.valid).toBe(false);
      if (!lowLon.valid) expect(lowLon.error).toBe('coordinate_out_of_bounds');

      const highLon = clientNormalize(14.6, 180.001);
      expect(highLon.valid).toBe(false);
      if (!highLon.valid) expect(highLon.error).toBe('coordinate_out_of_bounds');
    });

    it('maintains strict client and server normalization symmetry', () => {
      const testCases: [unknown, unknown][] = [
        [14.59951, 120.98421],
        [-12.3456, 45.6789],
        [-0.0001, 0.0001],
        [90, 180],
        [-90, -180],
        [91, 100],
        [10, 181],
        [NaN, 10],
        [10, Infinity],
        [null, 10],
      ];

      for (const [lat, lon] of testCases) {
        const cRes = clientNormalize(lat, lon);
        const sRes = serverNormalize(lat, lon);

        expect(cRes.valid).toBe(sRes.valid);
        if (cRes.valid && sRes.valid) {
          expect(cRes.location.lat).toBe(sRes.location.lat);
          expect(cRes.location.lon).toBe(sRes.location.lon);
        } else if (!cRes.valid && !sRes.valid) {
          expect(cRes.error).toBe(sRes.error);
        }
      }
    });
  });

  describe('2. OpenStreetMap Centralized Configuration & Attribution Contract', () => {
    it('provides standard public OSM tile URL and attribution', () => {
      expect(DEFAULT_OSM_TILE_URL).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
      expect(DEFAULT_OSM_ATTRIBUTION).toContain('OpenStreetMap');
      expect(DEFAULT_OSM_ATTRIBUTION).toContain('https://www.openstreetmap.org/copyright');
    });

    it('provides default campus coordinates in Manila', () => {
      expect(DEFAULT_CAMPUS_COORDINATES.lat).toBe(14.6);
      expect(DEFAULT_CAMPUS_COORDINATES.lon).toBe(120.998);
    });
  });

  describe('3. Nominatim Location Search Proxy Contract', () => {
    it('rejects non-GET methods with 405 Method Not Allowed', async () => {
      const { handleLocationSearch } = await import('../server/routes/location/search.js');
      const req = new Request('https://egatepass.tech/api/location/search?q=Manila', { method: 'POST' });
      const res = await handleLocationSearch(req);
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error).toBe('method_not_allowed');
    });

    it('rejects short or empty query with 400 Bad Request', async () => {
      const { handleLocationSearch } = await import('../server/routes/location/search.js');
      const req1 = new Request('https://egatepass.tech/api/location/search?q=', { method: 'GET' });
      const res1 = await handleLocationSearch(req1);
      expect(res1.status).toBe(400);

      const req2 = new Request('https://egatepass.tech/api/location/search?q=a', { method: 'GET' });
      const res2 = await handleLocationSearch(req2);
      expect(res2.status).toBe(400);
    });

    it('rejects queries longer than 100 characters with 400 Bad Request', async () => {
      const { handleLocationSearch } = await import('../server/routes/location/search.js');
      const longQuery = 'A'.repeat(101);
      const req = new Request(`https://egatepass.tech/api/location/search?q=${longQuery}`, { method: 'GET' });
      const res = await handleLocationSearch(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('query_too_long');
    });
  });
});
