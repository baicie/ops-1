#!/usr/bin/env node
// Keep every plugin's identity module a byte copy of the canonical source.
//
// Each OCI backend image is built from its own `plugins/<name>/backend` context,
// so a plugin cannot import `plugins/shared/plugin-identity.mjs`: the file would
// be outside the image. Copying is therefore required; letting the copies drift
// is not. The canonical file lives in `plugins/shared/`, and this script writes -
// or with --check, verifies - the copies.
//
// Usage:
//   node scripts/sync-plugin-identity.mjs            # write the copies
//   node scripts/sync-plugin-identity.mjs --check    # verify (CI gate)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'plugins/shared/plugin-identity.mjs');
const TARGETS = [
  'plugins/data-catalog/backend/identity.mjs',
  'plugins/data-integration/backend/identity.mjs',
  'plugins/zabbix-source/backend/identity.mjs',
];

const check = process.argv.includes('--check');
const source = readFileSync(SOURCE, 'utf8');
let failures = 0;

for (const relative of TARGETS) {
  const target = join(ROOT, relative);
  if (check) {
    if (!existsSync(target)) {
      console.error(`MISSING ${relative}: run node scripts/sync-plugin-identity.mjs`);
      failures += 1;
      continue;
    }
    if (readFileSync(target, 'utf8') !== source) {
      console.error(`DRIFT   ${relative}: run node scripts/sync-plugin-identity.mjs`);
      failures += 1;
    }
    continue;
  }
  writeFileSync(target, source);
  console.log(`wrote   ${relative}`);
}

if (check) {
  if (failures > 0) {
    console.error(`\n${failures} plugin identity module(s) disagree with ${SOURCE}`);
    process.exit(1);
  }
  console.log(`plugin identity modules match the canonical source (${TARGETS.length} checked)`);
}
