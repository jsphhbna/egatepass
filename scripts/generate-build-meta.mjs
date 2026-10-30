import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

function getCommitSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.trim();
  }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown-' + Date.now();
  }
}

const meta = {
  commitSha: getCommitSha(),
  builtAt: new Date().toISOString(),
  version: '1.0.0',
};

const targetPath = resolve(process.cwd(), 'public', 'build-meta.json');
mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

console.log(`[BUILD-META] Generated ${targetPath} with SHA ${meta.commitSha}`);
