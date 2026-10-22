import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

await build({
  entryPoints: [join(root, 'server/templates/index.ts')],
  outfile: join(root, 'server/templates/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  sourcemap: true,
  target: 'node22',
});

console.log('Email templates bundle generated at server/templates/index.js');
