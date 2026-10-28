/**
 * Canonical shared visual configuration for EARIST branded QR code generation.
 * Shared across browser and server rasterizers to guarantee visual parity.
 */
export const BRANDED_QR_CONFIG = {
  errorCorrectionLevel: 'H' as const,
  size: 360,
  margin: 2,
  darkColor: '#000000',
  lightColor: '#ffffff',
  logoRatio: 0.17, // 17% of QR width (strictly within 15-18% safe bounds)
  logoPadding: 6,
  logoBackingRadius: 6,
  canonicalLogoAsset: '/earist-logo.png',
} as const;

export type BrandedQrConfig = typeof BRANDED_QR_CONFIG;
