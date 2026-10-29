import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const tesseractJsPkgPath = path.join(projectRoot, 'node_modules/tesseract.js/package.json');
const tesseractCorePkgPath = path.join(projectRoot, 'node_modules/tesseract.js-core/package.json');
const targetDir = path.join(projectRoot, 'public/tesseract');

if (!fs.existsSync(tesseractJsPkgPath)) {
  console.error(`[SYNC-OCR] Missing tesseract.js in node_modules at ${tesseractJsPkgPath}`);
  process.exit(1);
}

if (!fs.existsSync(tesseractCorePkgPath)) {
  console.error(`[SYNC-OCR] Missing tesseract.js-core in node_modules at ${tesseractCorePkgPath}`);
  process.exit(1);
}

const tesseractJsPkg = JSON.parse(fs.readFileSync(tesseractJsPkgPath, 'utf8'));
const tesseractCorePkg = JSON.parse(fs.readFileSync(tesseractCorePkgPath, 'utf8'));

console.log(`[SYNC-OCR] Synchronizing OCR assets for tesseract.js@${tesseractJsPkg.version} and tesseract.js-core@${tesseractCorePkg.version}`);

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 1. Worker asset from tesseract.js
const workerSrc = path.join(projectRoot, 'node_modules/tesseract.js/dist/worker.min.js');
if (!fs.existsSync(workerSrc)) {
  console.error(`[SYNC-OCR] Authoritative worker.min.js missing at ${workerSrc}`);
  process.exit(1);
}
const workerDest = path.join(targetDir, 'worker.min.js');
copyIfChanged(workerSrc, workerDest);

// 2. Core variants from tesseract.js-core
const coreDir = path.join(projectRoot, 'node_modules/tesseract.js-core');
const coreFiles = fs.readdirSync(coreDir).filter((file) => {
  return (file.endsWith('.wasm') || file.endsWith('.wasm.js')) && file.startsWith('tesseract-core');
});

if (coreFiles.length === 0) {
  console.error(`[SYNC-OCR] No core wasm/wasm.js variants found in ${coreDir}`);
  process.exit(1);
}

// Mandatory core variants that MUST be present for Tesseract v7 capability selection
const mandatoryVariants = [
  'tesseract-core.wasm.js',
  'tesseract-core-simd.wasm.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
];

for (const required of mandatoryVariants) {
  if (!coreFiles.includes(required)) {
    console.error(`[SYNC-OCR] Mandatory core variant ${required} missing from tesseract.js-core`);
    process.exit(1);
  }
}

for (const file of coreFiles) {
  const src = path.join(coreDir, file);
  const dest = path.join(targetDir, file);
  copyIfChanged(src, dest);
}

// 3. Verify language model is preserved
const langModelPath = path.join(targetDir, 'eng.traineddata.gz');
if (!fs.existsSync(langModelPath) || fs.statSync(langModelPath).size < 1000) {
  console.error(`[SYNC-OCR] Mandatory language model missing or invalid at ${langModelPath}`);
  process.exit(1);
}

console.log(`[SYNC-OCR] Successfully verified and synchronized OCR assets in ${targetDir}`);

function copyIfChanged(src, dest) {
  const srcBuf = fs.readFileSync(src);
  if (fs.existsSync(dest)) {
    const destBuf = fs.readFileSync(dest);
    if (Buffer.compare(srcBuf, destBuf) === 0) {
      return; // Already identical
    }
  }
  fs.writeFileSync(dest, srcBuf);
  console.log(`  Copied: ${path.basename(dest)} (${(srcBuf.length / 1024).toFixed(1)} KB)`);
}
