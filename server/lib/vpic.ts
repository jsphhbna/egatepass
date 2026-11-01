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

const CANONICAL_ACRONYMS: Record<string, string> = {
  bmw: 'BMW',
  byd: 'BYD',
  mg: 'MG',
  gac: 'GAC',
  gmc: 'GMC',
  ktm: 'KTM',
  tvs: 'TVS',
};

export function formatVehicleName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (CANONICAL_ACRONYMS[lower]) {
    return CANONICAL_ACRONYMS[lower];
  }
  return lower
    .split(' ')
    .map((word) => {
      if (CANONICAL_ACRONYMS[word]) return CANONICAL_ACRONYMS[word];
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Common Philippine-market makes fallback when vPIC is slow or offline
export const POPULAR_PH_MAKES_FOUR_WHEEL = [
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
  'BMW',
  'Mercedes-Benz',
];

export const POPULAR_PH_MAKES_TWO_WHEEL = [
  'Honda',
  'Yamaha',
  'Kawasaki',
  'Suzuki',
  'Kymco',
  'Vespa',
  'BMW',
  'KTM',
  'TVS',
];

// Backwards compatibility export
export const POPULAR_PH_MAKES = POPULAR_PH_MAKES_FOUR_WHEEL;

export const POPULAR_PH_MODELS_BY_TYPE_AND_MAKE: Record<string, Record<string, string[]>> = {
  motorcycle: {
    Honda: ['Click 125', 'Click 160', 'Beat', 'PCX 160', 'ADV 160', 'Wave 110', 'XRM 125', 'Winner X'],
    Yamaha: ['NMAX', 'Aerox', 'Mio', 'Sniper 155', 'Mio Gravis', 'Fazzio'],
    Suzuki: ['Raider 150', 'Burgman Street', 'Smash', 'Gixxer'],
    Kawasaki: ['Barako II', 'Ninja 400', 'Versys', 'Z400'],
    Kymco: ['Like 150i', 'Super Z', 'AK550'],
    Vespa: ['Primavera', 'Sprint', 'GTS'],
    BMW: ['G 310 R', 'G 310 GS', 'R 1250 GS'],
    KTM: ['Duke 200', 'Duke 390', 'RC 390'],
    TVS: ['Dazz', 'Apache RTR', 'Ntorq 125'],
  },
  four_wheel: {
    Toyota: ['Vios', 'Innova', 'Fortuner', 'Hilux', 'Wigo', 'Rush', 'Corolla Altis', 'Avanza', 'Raize', 'Yaris Cross', 'Hiace', 'Camry'],
    Mitsubishi: ['Mirage', 'Mirage G4', 'Montero Sport', 'Xpander', 'Strada', 'Triton', 'L300'],
    Honda: ['City', 'Civic', 'CR-V', 'BR-V', 'HR-V', 'Brio', 'Accord'],
    Nissan: ['Navara', 'Terra', 'Almera', 'Urvan', 'Kicks'],
    Suzuki: ['Ertiga', 'Dzire', 'Jimny', 'S-Presso', 'Celerio'],
    Ford: ['Ranger', 'Everest', 'Territory', 'Explorer'],
    Isuzu: ['D-Max', 'mu-X', 'Traviz', 'Elf'],
    Hyundai: ['Stargazer', 'Creta', 'Tucson', 'Santa Fe', 'H-100'],
    Kia: ['Seltos', 'Sonet', 'Carnival', 'Stonic'],
    Mazda: ['Mazda 2', 'Mazda 3', 'CX-30', 'CX-5'],
    MG: ['MG 5', 'ZS', 'One', 'Cyberster'],
    Geely: ['Coolray', 'Okavango', 'Emgrand'],
    Subaru: ['Forester', 'XV', 'Outback', 'WRX'],
    Chevrolet: ['Tracker', 'Trailblazer', 'Tahoe'],
    BYD: ['Atto 3', 'Dolphin', 'Seal', 'Sealion 6'],
    GAC: ['Empow', 'Emkoo', 'GS3 Emzoom'],
    Changan: ['Alsvin', 'CS35 Plus', 'CS55 Plus'],
    Foton: ['Transvan', 'Thunder', 'Gratour'],
    BMW: ['3 Series', '5 Series', 'X1', 'X3', 'X5'],
    'Mercedes-Benz': ['A-Class', 'C-Class', 'E-Class', 'GLA', 'GLC'],
  },
};

// Backwards compatibility export
export const POPULAR_PH_MODELS = POPULAR_PH_MODELS_BY_TYPE_AND_MAKE.four_wheel;

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
  const normType = (internalType || 'all').toLowerCase().trim();
  if (normType === 'other') {
    return [];
  }

  const cacheKey = normType;
  const cached = makesCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const isMotorcycle = normType === 'motorcycle';
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

    // Case-insensitive deduplication using canonical formatted name
    const makeMap = new Map<string, string>();

    for (const r of results) {
      const name = (r.MakeName || r.Make_Name || '').trim();
      if (name && name.length >= 2) {
        const formatted = formatVehicleName(name);
        const lowerKey = formatted.toLowerCase();
        if (!makeMap.has(lowerKey)) {
          makeMap.set(lowerKey, formatted);
        }
      }
    }

    const sorted = Array.from(makeMap.values()).sort((a, b) => a.localeCompare(b));
    makesCache.set(cacheKey, { data: sorted, cachedAt: Date.now() });
    return sorted;
  } catch (err) {
    console.warn('vPIC fetch makes fallback triggered:', err instanceof Error ? err.message : 'timeout');
    if (cached) return cached.data;
    const fallbackList = isMotorcycle ? POPULAR_PH_MAKES_TWO_WHEEL : POPULAR_PH_MAKES_FOUR_WHEEL;
    return fallbackList.slice().sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Fetches vehicle models for a make from vPIC, with caching and fallback.
 */
export async function getVehicleModels(make: string, internalType?: string | null): Promise<string[]> {
  const trimmedMake = make.trim();
  if (!trimmedMake || trimmedMake === 'Other / Not Listed') return [];

  const normType = (internalType || 'all').toLowerCase().trim();
  if (normType === 'other') {
    return [];
  }

  const cacheKey = `${trimmedMake.toLowerCase()}:${normType}`;
  const cached = modelsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const isMotorcycle = normType === 'motorcycle';
  const categoryKey = isMotorcycle ? 'motorcycle' : 'four_wheel';
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

    const modelMap = new Map<string, string>();

    for (const r of results) {
      const name = (r.Model_Name || r.ModelName || '').trim();
      if (name && name.length >= 1) {
        const lowerKey = name.toLowerCase();
        if (!modelMap.has(lowerKey)) {
          modelMap.set(lowerKey, name);
        }
      }
    }

    const sorted = Array.from(modelMap.values()).sort((a, b) => a.localeCompare(b));
    modelsCache.set(cacheKey, { data: sorted, cachedAt: Date.now() });
    return sorted;
  } catch (err) {
    console.warn('vPIC fetch models fallback triggered:', err instanceof Error ? err.message : 'timeout');
    if (cached) return cached.data;
    const typeModels = POPULAR_PH_MODELS_BY_TYPE_AND_MAKE[categoryKey];
    const phModels = typeModels?.[trimmedMake];
    if (phModels) return phModels.slice().sort((a, b) => a.localeCompare(b));
    return [];
  }
}
