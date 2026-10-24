function getBaseUrl(): string {
  try {
    const raw = (process.env.APP_BASE_URL || process.env.VITE_APP_URL || '').trim();
    const base = raw || 'https://egatepass.tech';
    return base.replace(/\/+$/, '');
  } catch {
    return 'https://egatepass.tech';
  }
}

export function resolveLogoUrl(): string {
  return `${getBaseUrl()}/earist-logo-email.png`;
}

export function resolveBuildingEmailUrl(): string {
  return `${getBaseUrl()}/earist-building-email-header.jpg`;
}

export const EARIST_LOGO_URL = resolveLogoUrl();
export const EARIST_BUILDING_EMAIL_URL = resolveBuildingEmailUrl();
