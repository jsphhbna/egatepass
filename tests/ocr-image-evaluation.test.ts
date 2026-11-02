import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

// Levenshtein distance for CER/WER computation
function computeLevenshtein<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

function computeCER(groundTruth: string, recognized: string): number {
  const gtChars = Array.from(groundTruth.toLowerCase());
  const recChars = Array.from(recognized.toLowerCase());
  if (gtChars.length === 0) return recChars.length === 0 ? 0 : 1;
  const dist = computeLevenshtein(gtChars, recChars);
  return dist / gtChars.length;
}

function computeWER(groundTruth: string, recognized: string): number {
  const gtWords = groundTruth.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const recWords = recognized.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (gtWords.length === 0) return recWords.length === 0 ? 0 : 1;
  const dist = computeLevenshtein(gtWords, recWords);
  return dist / gtWords.length;
}

describe('OCR Layer A: Real Image Buffer & Quality Evaluation (Priority 3)', () => {
  it('1. Generates synthetic ID document image buffer and validates Sharp decode', async () => {
    // Generate synthetic Philippine ID card layout via SVG overlay in Sharp
    const svgOverlay = Buffer.from(`
      <svg width="600" height="380" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#f4f6f8"/>
        <text x="50" y="40" font-family="Arial" font-size="18" font-weight="bold" fill="#1e293b">REPUBLIKA NG PILIPINAS</text>
        <text x="50" y="65" font-family="Arial" font-size="14" fill="#475569">PHILIPPINE IDENTIFICATION CARD</text>
        <text x="50" y="110" font-family="Arial" font-size="12" fill="#64748b">Apelyido / Last Name</text>
        <text x="50" y="130" font-family="Arial" font-size="16" font-weight="bold" fill="#0f172a">RIZAL</text>
        <text x="50" y="165" font-family="Arial" font-size="12" fill="#64748b">Mga Pangalan / Given Names</text>
        <text x="50" y="185" font-family="Arial" font-size="16" font-weight="bold" fill="#0f172a">JOSE PROTACIO</text>
        <text x="50" y="220" font-family="Arial" font-size="12" fill="#64748b">Gitnang Apelyido / Middle Name</text>
        <text x="50" y="240" font-family="Arial" font-size="16" font-weight="bold" fill="#0f172a">MERCADO</text>
        <text x="50" y="275" font-family="Arial" font-size="12" fill="#64748b">Tirahan / Address</text>
        <text x="50" y="295" font-family="Arial" font-size="14" fill="#0f172a">CALAMBA LAGUNA PHILIPPINES</text>
      </svg>
    `);

    const imageBuffer = await sharp({
      create: {
        width: 600,
        height: 380,
        channels: 3,
        background: { r: 244, g: 246, b: 248 },
      },
    })
      .composite([{ input: svgOverlay, top: 0, left: 0 }])
      .png()
      .toBuffer();

    expect(imageBuffer.length).toBeGreaterThan(1000);
    const meta = await sharp(imageBuffer).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(380);
    expect(meta.format).toBe('png');
  });

  it('2. Evaluates high-contrast and grayscale image preprocessing for OCR clarity', async () => {
    const rawImage = await sharp({
      create: {
        width: 400,
        height: 250,
        channels: 3,
        background: { r: 200, g: 200, b: 200 },
      },
    })
      .png()
      .toBuffer();

    // Grayscale raw buffer conversion
    const grayscaleRaw = await sharp(rawImage)
      .grayscale()
      .raw()
      .toBuffer();

    expect(grayscaleRaw.length).toBe(400 * 250); // Exactly 1 channel (1 byte per pixel)
  });

  it('3. Mathematical CER and WER edge cases and precision', () => {
    // Exact match: 0% error
    expect(computeCER('DELA CRUZ', 'DELA CRUZ')).toBe(0);
    expect(computeWER('DELA CRUZ', 'DELA CRUZ')).toBe(0);

    // 1 substitution out of 4 words: exactly 25% WER
    const gt = '123 Rizal St Manila';
    const rec = '123 Rizal Street Manila';
    expect(computeWER(gt, rec)).toBe(0.25);

    // Case normalization: identical case-insensitively
    expect(computeCER('MANILA', 'manila')).toBe(0);
    expect(computeWER('MANILA', 'manila')).toBe(0);

    // Empty vs non-empty
    expect(computeCER('', '')).toBe(0);
    expect(computeCER('abc', '')).toBe(1);
    expect(computeWER('', '')).toBe(0);
    expect(computeWER('abc', '')).toBe(1);
  });
});
