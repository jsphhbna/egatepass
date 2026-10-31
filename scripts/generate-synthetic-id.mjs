import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const fixturesDir = path.resolve('tests/fixtures');
fs.mkdirSync(fixturesDir, { recursive: true });

const svg = `
<svg width="800" height="500" viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
  <rect width="800" height="500" fill="#cbd5e1" />
  <rect x="20" y="20" width="760" height="460" fill="none" stroke="#000000" stroke-width="4" />
  
  <text x="400" y="60" font-family="Arial, sans-serif" font-size="22" font-weight="bold" text-anchor="middle" fill="#000000">REPUBLIC OF THE PHILIPPINES</text>
  <text x="400" y="95" font-family="Arial, sans-serif" font-size="18" font-weight="bold" text-anchor="middle" fill="#000000">PHILIPPINE IDENTIFICATION SYSTEM</text>
  
  <text x="60" y="160" font-family="Arial, sans-serif" font-size="16" fill="#333333">Last Name / Apelyido</text>
  <text x="60" y="200" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#000000">DELA CRUZ</text>
  
  <text x="60" y="260" font-family="Arial, sans-serif" font-size="16" fill="#333333">Given Names / Mga Pangalan</text>
  <text x="60" y="300" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#000000">JUAN PEDRO</text>
  
  <text x="60" y="360" font-family="Arial, sans-serif" font-size="16" fill="#333333">Middle Name / Gitnang Apelyido</text>
  <text x="60" y="400" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#000000">SANTOS</text>
</svg>
`;

const outputPath = path.join(fixturesDir, 'synthetic-philippine-id.png');
await sharp(Buffer.from(svg))
  .png()
  .toFile(outputPath);

console.log(`[GEN-FIXTURE] Generated high-contrast synthetic ID at ${outputPath}`);
