// Deploys the current source to the stable app (`npm start`): type check and
// tests first, then a production build into its own release folder, then
// the switch to it. If any step fails, the deployed version stays as it was.
//
// Usage: npm run deploy [-- -m "What changed"]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = path.join(root, 'deploy');
const releasesDir = path.join(deployDir, 'releases');
// Releases kept for tabs still running them: the newest few, and every one
// from the last week (a tab can stay open for days while fixes go out).
const KEEP = 5;
const KEEP_DAYS = 7;

const messageArg = process.argv.findIndex((a) => a === '-m' || a === '--message');
const notes = messageArg > 0 ? process.argv[messageArg + 1] ?? '' : '';

function step(title, command, args) {
  console.log(`\n▸ ${title}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n✗ ${title} failed. Nothing was deployed; the stable app is unchanged.`);
    process.exit(1);
  }
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

step('Dictionary', process.execPath, ['scripts/build-dictionary.mjs', '--if-missing']);
step('Type check', 'npm', ['run', 'typecheck']);
step('Tests', 'npm', ['test']);

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const version = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const commit = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain') !== '';
const release = { version, deployedAt: now.toISOString(), commit: commit ? `${commit}${dirty ? ' + local changes' : ''}` : '', notes };

console.log(`\n▸ Build ${version}`);
const outDir = path.join(releasesDir, version);
process.env.VITE_APP_VERSION = version;
const { build } = await import('vite');
await build({ root, base: `/r/${version}/`, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(release, null, 2));

// The switch: one rename, so the server never sees a half-written pointer.
const pointer = path.join(deployDir, 'current.json');
fs.writeFileSync(`${pointer}.tmp`, JSON.stringify(release, null, 2));
fs.renameSync(`${pointer}.tmp`, pointer);

// Older releases stay for tabs still running them; only old ones go. A tab
// whose release is gone is told so by the stable app (see serve.mjs).
const deployedAt = (dir) => {
  try {
    return Date.parse(JSON.parse(fs.readFileSync(path.join(releasesDir, dir, 'release.json'), 'utf8')).deployedAt);
  } catch {
    return fs.statSync(path.join(releasesDir, dir)).mtimeMs;
  }
};
const weekAgo = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
const old = fs
  .readdirSync(releasesDir)
  .filter((d) => d !== version && fs.statSync(path.join(releasesDir, d)).isDirectory())
  .sort()
  .reverse()
  .slice(KEEP - 1)
  .filter((d) => !(deployedAt(d) > weekAgo));
for (const dir of old) fs.rmSync(path.join(releasesDir, dir), { recursive: true, force: true });

console.log(`\n✓ Deployed version ${version}${release.commit ? ` (${release.commit})` : ''}.`);
try {
  const res = await fetch('http://127.0.0.1:4173/version.json', { signal: AbortSignal.timeout(1000) });
  if (res.ok) console.log('  The stable app at http://localhost:4173 offers the update to open tabs.');
} catch {
  console.log('  The stable server is not running, so open tabs cannot be told about this version.');
  console.log('  Start it with: npm start   (then open http://localhost:4173)');
}
