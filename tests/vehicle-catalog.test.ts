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
    it('returns filtered and sorted vehicle makes for car without injecting fallback makes on success', async () => {
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

      // CRITICAL: Fallback makes (e.g. Yamaha, Vespa, Suzuki) MUST NOT be injected on successful provider result
      expect(data.makes).not.toContain('Yamaha');
      expect(data.makes).not.toContain('Vespa');
      expect(data.makes).not.toContain('Kawasaki');
    });

    it('falls back to category-specific curated list for motorcycle when vPIC fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const req = new Request('http://localhost/api/vehicles/makes?type=motorcycle', { method: 'GET' });
      const res = await handleVehicleMakes(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.makes).toContain('Honda');
      expect(data.makes).toContain('Yamaha');
      expect(data.makes).toContain('Kawasaki');
      expect(data.makes).toContain('Vespa');

      // Motorcycle fallback MUST NOT contain 4-wheel makes
      expect(data.makes).not.toContain('Toyota');
      expect(data.makes).not.toContain('Ford');
      expect(data.makes).not.toContain('Isuzu');
      expect(data.makes).not.toContain('Subaru');
    });

    it('falls back to 4-wheel curated list for car when vPIC fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const req = new Request('http://localhost/api/vehicles/makes?type=car', { method: 'GET' });
      const res = await handleVehicleMakes(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.makes).toContain('Toyota');
      expect(data.makes).toContain('Mitsubishi');
      expect(data.makes).toContain('Nissan');

      // Car fallback MUST NOT contain motorcycle-only makes
      expect(data.makes).not.toContain('Yamaha');
      expect(data.makes).not.toContain('Kawasaki');
      expect(data.makes).not.toContain('Vespa');
    });

    it('deduplicates case-insensitively and canonicalizes acronyms like BMW and BYD', async () => {
      const mockMakes = {
        Results: [
          { Make_ID: 1, Make_Name: 'bmw', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 2, Make_Name: 'BMW', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 3, Make_Name: 'Bmw', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 4, Make_Name: 'byd', VehicleTypeName: 'Passenger Car' },
          { Make_ID: 5, Make_Name: 'BYD', VehicleTypeName: 'Passenger Car' },
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
      const data = await res.json();

      const bmwMatches = data.makes.filter((m: string) => m.toLowerCase() === 'bmw');
      expect(bmwMatches).toEqual(['BMW']);

      const bydMatches = data.makes.filter((m: string) => m.toLowerCase() === 'byd');
      expect(bydMatches).toEqual(['BYD']);
    });

    it('returns empty list for type "other" without calling vPIC GetAllMakes', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const req = new Request('http://localhost/api/vehicles/makes?type=other', { method: 'GET' });
      const res = await handleVehicleMakes(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.makes).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/vehicles/models', () => {
    it('returns models for a valid make and vehicle type without injecting fallback models', async () => {
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

    it('falls back to category-specific models for car when vPIC fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('vPIC down'));

      const req = new Request('http://localhost/api/vehicles/models?make=Honda&type=car', { method: 'GET' });
      const res = await handleVehicleModels(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toContain('Civic');
      expect(data.models).toContain('City');
      expect(data.models).toContain('CR-V');

      // Four-wheel fallback MUST NOT contain motorcycle models like Click or Beat
      expect(data.models).not.toContain('Click 125');
      expect(data.models).not.toContain('Beat');
      expect(data.models).not.toContain('PCX 160');
    });

    it('falls back to motorcycle-specific models for motorcycle when vPIC fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('vPIC down'));

      const req = new Request('http://localhost/api/vehicles/models?make=Honda&type=motorcycle', { method: 'GET' });
      const res = await handleVehicleModels(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toContain('Click 125');
      expect(data.models).toContain('Beat');
      expect(data.models).toContain('PCX 160');

      // Motorcycle fallback MUST NOT contain car models
      expect(data.models).not.toContain('Civic');
      expect(data.models).not.toContain('City');
      expect(data.models).not.toContain('Accord');
    });

    it('returns empty list for type "other" without calling vPIC', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const req = new Request('http://localhost/api/vehicles/models?make=CustomMake&type=other', { method: 'GET' });
      const res = await handleVehicleModels(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.models).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
