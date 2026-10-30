/**
 * server/lib/vpic.ts
 *
 * NHTSA vPIC vehicle catalog integration.
 * Used as a reference catalog for standardizing vehicle makes and models.
 * In-memory caching and controlled fallback ensure high resilience.
 */

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const makesCache = new Map<string, CacheEntry<string[]>>();
const modelsCache = new Map<string, CacheEntry<string[]>>();

export function clearVpicCacheForTesting(): void {
  makesCache.clear();
  modelsCache.clear();
}

// Common Philippine-market makes fallback when vPIC is slow or offline
export const POPULAR_PH_MAKES = [
  'Toyota',
  'Mitsubishi',
  'Honda',
  'Nissan',
  'Ford',
  'Suzuki',
  'Isuzu',
  'Hyundai',
  'Kia',
  'Mazda',
  'MG',
  'Geely',
  'Subaru',
  'Chevrolet',
  'BYD',
  'GAC',
  'Changan',
  'Foton',
  'Yamaha',
  'Kawasaki',
  'Kymco',
  'Vespa',
  'BMW',
  'Mercedes-Benz',
];

export const POPULAR_PH_MODELS: Record<string, string[]> = {
  Toyota: ['Vios', 'Innova', 'Fortuner', 'Hilux', 'Wigo', 'Rush', 'Corolla Altis', 'Avanza', 'Raize', 'Yaris Cross', 'Hiace'],
  Mitsubishi: ['Mirage', 'Mirage G4', 'Montero Sport', 'Xpander', 'Strada', 'Triton', 'L300'],
  Honda: ['City', 'Civic', 'CR-V', 'BR-V', 'HR-V', 'Brio', 'Click 125', 'Click 160', 'Beat', 'PCX 160', 'ADV 160'],
  Nissan: ['Navara', 'Terra', 'Almera', 'Urvan', 'Kicks'],
  Suzuki: ['Ertiga', 'Dzire', 'Jimny', 'S-Presso', 'Celerio', 'Raider 150', 'Burgman Street', 'Smash'],
  Ford: ['Ranger', 'Everest', 'Territory', 'Explorer'],
  Isuzu: ['D-Max', 'mu-X', 'Traviz', 'Elf'],
  Hyundai: ['Stargazer', 'Creta', 'Tucson', 'Santa Fe', 'H-100'],
  Yamaha: ['NMAX', 'Aerox', 'Mio', 'Sniper 155', 'Mio Gravis', 'Fazzio'],
};

export function mapInternalVehicleTypeToVpic(type?: string | null): string {
  const norm = (type || '').toLowerCase().trim();
  switch (norm) {
    case 'car':
      return 'passenger car';
    case 'motorcycle':
      return 'motorcycle';
    case 'van':
    case 'suv':
      return 'multipurpose passenger vehicle (mpv)';
    case 'pickup':
    case 'truck':
      return 'truck';
    default:
      return '';
  }
}

/**
 * Fetches vehicle makes for a vehicle type from vPIC, with caching and fallback.
 */
export async function getVehicleMakes(internalType?: string | null): Promise<string[]> {
  const cacheKey = (internalType || 'all').toLowerCase().trim();
  const cached = makesCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const vpicType = mapInternalVehicleTypeToVpic(internalType);
  const endpoint = vpicType
    ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetMakesForVehicleType/${encodeURIComponent(vpicType)}?format=json`
    : `https://vpic.nhtsa.dot.gov/api/vehicles/GetAllMakes?format=json`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`vPIC HTTP ${res.status}`);
    }

    const json = await res.json();
    const results = Array.isArray(json.Results) ? json.Results : [];

    const makeSet = new Set<string>();

    // Prioritize popular Philippine makes
    for (const phMake of POPULAR_PH_MAKES) {
      makeSet.add(phMake);
    }

    for (const r of results) {
      const name = (r.MakeName || r.Make_Name || '').trim();
      if (name && name.length >= 2) {
        // Title-case name for presentation
        const formatted = name
          .toLowerCase()
          .split(' ')
          .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        makeSet.add(formatted);
      }
    }

    const sorted = Array.from(makeSet).sort((a, b) => a.localeCompare(b));
    makesCache.set(cacheKey, { data: sorted, cachedAt: Date.now() });
    return sorted;
  } catch (err) {
    console.warn('vPIC fetch makes fallback triggered:', err instanceof Error ? err.message : 'timeout');
    // Return cached if expired, or popular PH makes
    if (cached) return cached.data;
    return POPULAR_PH_MAKES.slice().sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Fetches vehicle models for a make from vPIC, with caching and fallback.
 */
export async function getVehicleModels(make: string, internalType?: string | null): Promise<string[]> {
  const trimmedMake = make.trim();
  if (!trimmedMake) return [];

  const cacheKey = `${trimmedMake.toLowerCase()}:${(internalType || 'all').toLowerCase()}`;
  const cached = modelsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const vpicType = mapInternalVehicleTypeToVpic(internalType);
  const endpoint = vpicType
    ? `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(trimmedMake)}/vehicleType/${encodeURIComponent(vpicType)}?format=json`
    : `https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/${encodeURIComponent(trimmedMake)}?format=json`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`vPIC HTTP ${res.status}`);
    }

    const json = await res.json();
    const results = Array.isArray(json.Results) ? json.Results : [];

    const modelSet = new Set<string>();

    // Add popular PH models if available
    const phModels = POPULAR_PH_MODELS[trimmedMake];
    if (phModels) {
      for (const m of phModels) modelSet.add(m);
    }

    for (const r of results) {
      const name = (r.Model_Name || r.ModelName || '').trim();
      if (name && name.length >= 1) {
        modelSet.add(name);
      }
    }

    const sorted = Array.from(modelSet).sort((a, b) => a.localeCompare(b));
    modelsCache.set(cacheKey, { data: sorted, cachedAt: Date.now() });
    return sorted;
  } catch (err) {
    console.warn('vPIC fetch models fallback triggered:', err instanceof Error ? err.message : 'timeout');
    if (cached) return cached.data;
    const phModels = POPULAR_PH_MODELS[trimmedMake];
    if (phModels) return phModels.slice().sort((a, b) => a.localeCompare(b));
    return [];
  }
}
