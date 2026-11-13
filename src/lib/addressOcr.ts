/**
 * src/lib/addressOcr.ts
 *
 * Extracts structured Philippine address suggestions (house/building, street,
 * barangay, city/municipality, province, region) from OCR address text.
 * Strictly avoids collecting or suggesting postal codes.
 */

import citiesData from '../../data/reference/psgc/cities.json';
import provincesData from '../../data/reference/psgc/provinces.json';

export interface DetectedAddressDetails {
  raw: string;
  street: string;
  houseBuilding?: string;
  barangay?: string;
  city?: string;
  province?: string;
  cityCode?: string;
  barangayCode?: string;
  provinceCode?: string;
  regionCode?: string;
}

const MANILA_DISTRICTS = [
  'Sampaloc',
  'Tondo',
  'Binondo',
  'Quiapo',
  'San Nicolas',
  'Santa Cruz',
  'Sta. Cruz',
  'Ermita',
  'Malate',
  'Paco',
  'Pandacan',
  'Port Area',
  'San Andres',
  'San Miguel',
  'Intramuros',
  'Santa Mesa',
  'Sta. Mesa',
];

export function parseAddressFromOcr(rawAddress: string): DetectedAddressDetails | null {
  if (!rawAddress || typeof rawAddress !== 'string') return null;
  const cleanRaw = rawAddress.trim().replace(/\s+/g, ' ');
  if (cleanRaw.length < 5) return null;

  let remaining = cleanRaw;

  // 1. Strip postal code / zip if present in raw OCR text so it doesn't pollute street tokens,
  // strictly avoiding collecting or returning postal codes per Phase 3 & 9 requirements.
  remaining = remaining.replace(/\b(?:zip|postal(?:\s*code)?)\s*:?\s*\d{4}\b/gi, ' ');
  remaining = remaining.replace(/\b(1\d{3}|[2-9]\d{3})\b/g, ' ').replace(/\s+/g, ' ').trim();

  // 2. Extract Province by scanning provincesData
  let province: string | undefined;
  let provinceCode: string | undefined;
  let regionCode: string | undefined;

  for (const prov of provincesData as any[]) {
    // Avoid matching province name if it's part of an explicit city name (e.g. "Quezon City", "Cebu City", "Iloilo City")
    const provRegex = new RegExp(`\\b${prov.name}\\b(?!\\s+city\\b)`, 'i');
    if (provRegex.test(remaining)) {
      province = prov.name;
      provinceCode = prov.code;
      regionCode = prov.regionCode;
      remaining = remaining.replace(provRegex, ' ').trim();
      break;
    }
  }

  // 3. Extract Barangay first (e.g. Brgy. 408, Barangay Central, Brgy Sto. Nino)
  // Extracting barangay before city prevents barangays like "Brgy San Jose" matching San Jose City
  let barangay: string | undefined;
  const bgyMatch = remaining.match(/\b(?:brgy\.?|barangay|bgy\.?)\s*([0-9a-zA-Z\s.-]+?)(?:,|$)/i);
  if (bgyMatch && bgyMatch[1]) {
    barangay = bgyMatch[1].trim().replace(/\s+/g, ' ');
    remaining = remaining.replace(bgyMatch[0], ' ').trim();
  }

  // 4. Extract City / Municipality
  let city: string | undefined;
  let cityCode: string | undefined;

  const sortedCities = [...(citiesData as any[])].sort((a, b) => {
    if (a.isHuc && !b.isHuc) return -1;
    if (!a.isHuc && b.isHuc) return 1;
    if (a.isCity && !b.isCity) return -1;
    if (!a.isCity && b.isCity) return 1;
    return b.name.length - a.name.length;
  });

  // Pass 0: Check for explicit Manila / City of Manila first to prevent Manila districts
  // (like Sampaloc, Santa Cruz, San Miguel) matching same-named provincial municipalities
  if (/\b(?:city\s+of\s+manila|manila\s+city|manila)\b/i.test(remaining)) {
    city = 'City of Manila';
    cityCode = '1380600000';
    regionCode = '1300000000'; // NCR
    remaining = remaining.replace(/\b(?:city\s+of\s+manila|manila\s+city|manila)\b/gi, ' ').trim();
  }

  // Pass 1: Look for exact city name or explicit city phrases ("City of X", "X City")
  if (!city) {
    for (const c of sortedCities) {
      const escapedFullName = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const baseName = c.name
        .replace(/^(?:City\s+of\s+|Municipality\s+of\s+)/i, '')
        .replace(/\s+City$/i, '')
        .trim();
      const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const explicitRegex = new RegExp(`\\b(?:${escapedFullName}|city\\s+of\\s+${escapedBase}|${escapedBase}\\s+city)\\b`, 'i');
      if (explicitRegex.test(remaining)) {
        city = c.name;
        cityCode = c.code;
        if (!regionCode && c.regionCode) regionCode = c.regionCode;
        if (!provinceCode && c.provinceCode) provinceCode = c.provinceCode;
        remaining = remaining.replace(explicitRegex, ' ').trim();
        break;
      }
    }
  }

  // Pass 2: Look for Manila or Manila Districts (if not part of a street name)
  if (!city) {
    const isManilaDistrict = MANILA_DISTRICTS.some((district) => {
      const dRegex = new RegExp(`\\b${district}\\b(?!\\s*(?:st|street|ave|avenue|rd|road|blvd|boulevard|lane|way)\\b)`, 'i');
      return dRegex.test(cleanRaw);
    });

    if (isManilaDistrict || /\b(?:city\s+of\s+manila|manila\s+city|manila)\b/i.test(remaining)) {
      city = 'City of Manila';
      cityCode = '1380600000';
      regionCode = '1300000000'; // NCR
      remaining = remaining.replace(/\b(?:city\s+of\s+manila|manila\s+city|manila)\b/gi, ' ').trim();
    }
  }

  // Pass 3: Look for base city/municipality name not followed by a street suffix
  if (!city) {
    for (const c of sortedCities) {
      const baseName = c.name.replace(/^(?:City\s+of\s+|Municipality\s+of\s+)/i, '').trim();
      const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const baseRegex = new RegExp(`\\b${escapedBase}\\b(?!\\s*(?:st|street|ave|avenue|rd|road|blvd|boulevard|lane|way)\\b)`, 'i');
      if (baseRegex.test(remaining)) {
        city = c.name;
        cityCode = c.code;
        if (!regionCode && c.regionCode) regionCode = c.regionCode;
        if (!provinceCode && c.provinceCode) provinceCode = c.provinceCode;
        remaining = remaining.replace(baseRegex, ' ').trim();
        break;
      }
    }
  }

  // 5. Clean remaining for street / houseBuilding
  const streetTokens = remaining
    .replace(/^[,\s.-]+|[,\s.-]+$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let houseBuilding: string | undefined;
  let street = '';

  if (streetTokens.length >= 2) {
    houseBuilding = streetTokens[0];
    street = streetTokens.slice(1).join(', ');
  } else if (streetTokens.length === 1) {
    street = streetTokens[0]!;
  }

  // If we couldn't parse anything meaningful, return null
  if (!street && !barangay && !city && !province) {
    return null;
  }

  return {
    raw: cleanRaw,
    street: street || cleanRaw,
    houseBuilding,
    barangay,
    city,
    province,
    cityCode,
    provinceCode,
    regionCode,
  };
}
