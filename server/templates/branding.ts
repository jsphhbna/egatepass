function resolveLogoUrl(): string {
  try {
    const raw = (process.env.APP_BASE_URL || process.env.VITE_APP_URL || '').trim();
    const base = raw || 'https://egatepass.tech';
    const normalized = base.replace(/\/+$/, '');
    return `${normalized}/earist-logo.png`;
  } catch {
    return 'https://egatepass.tech/earist-logo.png';
  }
}

export const EARIST_LOGO_URL = resolveLogoUrl();
