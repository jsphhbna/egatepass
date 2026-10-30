import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleVehicleMakes } from '../server/routes/vehicles/makes.js';
import { handleVehicleModels } from '../server/routes/vehicles/models.js';
import { clearVpicCacheForTesting } from '../server/lib/vpic.js';

describe('Vehicle Catalog Integration (vPIC Proxy & Fallbacks)', () => {
  beforeEach(() => {
    clearVpicCacheForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/vehicles/makes', () => {
    it('returns filtered and sorted vehicle makes for car', async () => {
      const mockMakes = {
        Results: [
          { Make_ID: 448, Make_Name: 'TOYOTA', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 474, Make_Name: 'HONDA', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 460, Make_Name: 'FORD', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 999, Make_Name: 'MITSUBISHI', VehicleTypeName: 'Passenger Car' },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
        return new Response(JSON.stringify(mockMakes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const req = new Request('http://localhost/api/vehicles/makes?type=car', { method: 'GET' });
      const res = await handleVehicleMakes(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');

      const data = await res.json();
      expect(Array.isArray(data.makes)).toBe(true);
      expect(data.makes).toContain('Toyota');
      expect(data.makes).toContain('Honda');
      expect(data.makes).toContain('Ford');
      expect(data.makes).toContain('Mitsubishi');
    });

    it('falls back to curated list when upstream vPIC fetch fails or times out', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const req = new Request('http://localhost/api/vehicles/makes?type=motorcycle', { method: 'GET' });
      const res = await handleVehicleMakes(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.makes).toContain('Honda');
      expect(data.makes).toContain('Yamaha');
      expect(data.makes).toContain('Kawasaki');
    });
  });

  describe('GET /api/vehicles/models', () => {
    it('returns models for a valid make and vehicle type', async () => {
      const mockModels = {
        Results: [
          { Model_ID: 101, Model_Name: 'Corolla', Make_Name: 'Toyota' },
          { Model_ID: 102, Model_Name: 'Vios', Make_Name: 'Toyota' },
          { Model_ID: 103, Model_Name: 'Fortuner', Make_Name: 'Toyota' },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
        return new Response(JSON.stringify(mockModels), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const req = new Request('http://localhost/api/vehicles/models?make=Toyota&type=car', { method: 'GET' });
      const res = await handleVehicleModels(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('s-maxage=86400');

      const data = await res.json();
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models).toContain('Corolla');
      expect(data.models).toContain('Vios');
      expect(data.models).toContain('Fortuner');
    });

    it('returns empty list when make parameter is missing', async () => {
      const req = new Request('http://localhost/api/vehicles/models?type=car', { method: 'GET' });
      const res = await handleVehicleModels(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toEqual([]);
    });

    it('falls back to curated models if upstream vPIC returns empty or fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('vPIC down'));

      const req = new Request('http://localhost/api/vehicles/models?make=Toyota&type=car', { method: 'GET' });
      const res = await handleVehicleModels(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toContain('Vios');
      expect(data.models).toContain('Fortuner');
      expect(data.models).toContain('Innova');
    });
  });
});
