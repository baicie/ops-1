import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/**
 * Regression tests for the two fail-open holes the v3 audit found in check-ui-metrics:
 *
 *   - `{"pages":{}}` looped zero times and exited 0, so a run that measured nothing read as a
 *     green pass;
 *   - without a route list, a pass that silently dropped a route was indistinguishable from one
 *     that covered everything.
 *
 * Both are properties of the gate itself, so they are tested by running the gate as a process.
 */

const SCRIPT = join(process.cwd(), 'scripts', 'check-ui-metrics.mjs');
const MANIFEST = join(process.cwd(), 'docs', 'design', 'ui-visual-v3', 'spec', 'route-manifest.json');
const TEMP_MANIFEST = join(mkdtempSync(join(tmpdir(), 'ow-manifest-')), 'routes.json');

/** One measurement that satisfies every §4.2 assertion at 1440. */
function page(viewport = 1440) {
  return {
    overflow: -15,
    identityKey: ['row-a', 'row-b'],
    viewport: { w: viewport, h: 900 },
    rowHeight: { p95: 40, n: 2 },
    columns: 4,
    distinctRatio: [1, 0.5],
    duplicateRunMax: 0,
    rows: 2,
    noDataPerTable: 0,
    cards: [],
  };
}

function artifact(pages) {
  return JSON.stringify({ config: { label: 'test' }, pages });
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function writeTemp(name, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ow-metrics-'));
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

writeFileSync(TEMP_MANIFEST, JSON.stringify({
  version: 1,
  routes: [
    { key: 'a', match: '^/a$' },
    { key: 'b', match: '^/b$' },
  ],
}));

test('a pass that recorded no page is a FAIL, not an empty success', () => {
  const file = writeTemp('_metrics_empty.json', artifact({}));
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /page-map-empty/);
});

test('a manifest route that no page measured is a FAIL, named', () => {
  const file = writeTemp('_metrics_missing.json', artifact({ '/a @1440': page() }));
  const result = run(['--manifest', TEMP_MANIFEST, file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /route-missing.*\bb\b/);
});

test('a measured route the manifest does not name is a FAIL', () => {
  const file = writeTemp('_metrics_unknown.json', artifact({ '/a @1440': page(), '/c @1440': page() }));
  const result = run(['--manifest', TEMP_MANIFEST, file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /route-unknown.*\/c/);
});

test('a pass that covers the manifest is green', () => {
  const file = writeTemp('_metrics_ok.json', artifact({ '/a @1440': page(), '/b @1440': page() }));
  const result = run(['--manifest', TEMP_MANIFEST, file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS \(2 page measurements/);
});

test('the repository manifest parses and names the detail routes by shape', () => {
  const result = run(['--manifest', MANIFEST, writeTemp('_metrics_repo.json', artifact({ '/admin/jobs @1440': page() }))]);
  // Only /admin/jobs is present, so this run must fail for the nine missing routes - but it must
  // fail with route-missing, never with "cannot compile the manifest".
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /cannot compile/);
  assert.match(result.stdout, /route-missing/);
});
