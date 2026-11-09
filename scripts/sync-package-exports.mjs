#!/usr/bin/env node
// Generate `exports` for the workspace packages from their source files.
//
// A hand-maintained map is the kind of thing that works until someone adds a
// module, and then fails at build time with "Missing specifier" - or worse,
// silently resolves to a stale file. Generating it is cheap and cannot drift.
//
// Usage: node scripts/sync-package-exports.mjs [--check]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = [
  {
    manifest: 'packages/ui/package.json',
    dir: 'packages/ui/src',
    extra: { './icons': './src/Icons.tsx', './styles': './src/styles.css' },
  },
  {
    manifest: 'packages/platform-client/package.json',
    dir: 'packages/platform-client/src',
    extra: {
      './i18n': './src/i18n/index.tsx',
      './i18n/catalogs/*': './src/i18n/catalogs/*',
    },
  },
];

const check = process.argv.includes('--check');
let failures = 0;

for (const pkg of PACKAGES) {
  const manifestPath = join(ROOT, pkg.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const exports = { '.': './src/index.ts', ...pkg.extra };
  for (const name of readdirSync(join(ROOT, pkg.dir)).sort()) {
    if (!/\.(ts|tsx)$/.test(name) || name.includes('.test.') || name === 'index.ts') continue;
    if (name === 'Icons.tsx') continue; // exported as ./icons
    const stem = name.replace(/\.(ts|tsx)$/, '');
    exports[`./${stem}`] = `./src/${name}`;
  }
  const next = JSON.stringify({ ...manifest, exports }, null, 2) + '\n';
  if (check) {
    if (readFileSync(manifestPath, 'utf8') !== next) {
      console.error(`DRIFT ${pkg.manifest}: run node scripts/sync-package-exports.mjs`);
      failures += 1;
    }
    continue;
  }
  writeFileSync(manifestPath, next);
  console.log(`wrote ${pkg.manifest} (${Object.keys(exports).length} exports)`);
}

if (check) {
  if (failures) process.exit(1);
  console.log('package exports match their sources');
}
