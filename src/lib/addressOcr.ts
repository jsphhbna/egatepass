/**
 * src/lib/addressOcr.ts
 *
 * Extracts structured Philippine address components (house/building, street,
 * barangay, city/municipality, province, postal code) from OCR address text.
 * Used to suggest non-intrusive autofill cards on ID uploads.
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
  postalCode?: string;
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

  // 1. Extract 4-digit postal code (usually at the end or preceded by ZIP/Postal)
  let postalCode: string | undefined;
  const postalMatch = remaining.match(/\b(1\d{3}|[2-9]\d{3})\b/);
  if (postalMatch) {
    postalCode = postalMatch[1];
    remaining = remaining.replace(postalMatch[0], ' ').trim();
  }

  // 2. Extract Province by scanning provincesData
  let province: string | undefined;
  let provinceCode: string | undefined;
  let regionCode: string | undefined;

  for (const prov of provincesData as any[]) {
    const provRegex = new RegExp(`\\b${prov.name}\\b`, 'i');
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

  // 4. Extract City / Municipality or Manila District
  let city: string | undefined;
  let cityCode: string | undefined;

  // Check Manila Districts first
  const isManilaDistrict = MANILA_DISTRICTS.some((district) => {
    const dRegex = new RegExp(`\\b${district}\\b`, 'i');
    return dRegex.test(cleanRaw);
  });

  if (isManilaDistrict || /\b(?:city\s+of\s+manila|manila\s+city|manila)\b/i.test(remaining)) {
    city = 'City of Manila';
    cityCode = '1380600000';
    regionCode = '1300000000'; // NCR
    remaining = remaining.replace(/\b(?:city\s+of\s+manila|manila\s+city|manila)\b/gi, ' ').trim();
  } else {
    // Check known cities (prefer longer base names first)
    const sortedCities = [...(citiesData as any[])].sort((a, b) => b.name.length - a.name.length);
    for (const c of sortedCities) {
      const baseName = c.name.replace(/^(?:City\s+of\s+|Municipality\s+of\s+)/i, '').trim();
      const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cRegex = new RegExp(`\\b(?:city\\s+of\\s+${escapedBase}|${escapedBase}\\s+city|${escapedBase})\\b`, 'i');
      if (cRegex.test(remaining)) {
        city = c.name;
        cityCode = c.code;
        if (!regionCode && c.regionCode) regionCode = c.regionCode;
        if (!provinceCode && c.provinceCode) provinceCode = c.provinceCode;
        remaining = remaining.replace(cRegex, ' ').trim();
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
    postalCode,
    cityCode,
    provinceCode,
    regionCode,
  };
}
