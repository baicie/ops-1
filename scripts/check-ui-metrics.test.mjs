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
  return JSON.stringify({ config: { label: 'test', theme: 'light', locale: 'en' }, pages });
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

/* ── the execution matrix: declared, not inferred ───────────────────────────── */

const MATRIX = join(mkdtempSync(join(tmpdir(), 'ow-matrix-')), 'matrix.json');
writeFileSync(MATRIX, JSON.stringify({
  version: 1,
  routes: [
    { key: 'a', match: '^/a$' },
    { key: 'b', match: '^/b$' },
  ],
  viewports: [1440, 1024],
  themes: ['light'],
  locales: ['en'],
}));

function matrixArtifact(pages, config = {}) {
  return JSON.stringify({ config: { label: 'test', theme: 'light', locale: 'en', ...config }, pages });
}

test('a complete matrix is green across both viewports and both routes', () => {
  const file = writeTemp('_metrics_matrix_ok.json', matrixArtifact({
    '/a @1440': page(1440), '/b @1440': page(1440),
    '/a @1024': page(1024), '/b @1024': page(1024),
  }));
  const result = run(['--matrix', MATRIX, file]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /matrix\s+4\/4 combinations measured/);
});

test('deleting one combination from the matrix turns the gate red', () => {
  const file = writeTemp('_metrics_matrix_missing.json', matrixArtifact({
    '/a @1440': page(1440), '/b @1440': page(1440), '/a @1024': page(1024),
  }));
  const result = run(['--matrix', MATRIX, file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /matrix-missing.*b @1024 light en/);
});

test('measuring the same combination in two artifacts is a duplicate, not coverage', () => {
  const first = writeTemp('_metrics_matrix_first.json', matrixArtifact({
    '/a @1440': page(1440), '/b @1440': page(1440), '/a @1024': page(1024), '/b @1024': page(1024),
  }));
  const second = writeTemp('_metrics_matrix_second.json', matrixArtifact({ '/a @1440': page(1440) }));
  const result = run(['--matrix', MATRIX, first, second]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /matrix-duplicate/);
});

test('an artifact that does not name its theme and locale is unmeasured', () => {
  const file = writeTemp('_metrics_matrix_config.json', matrixArtifact({ '/a @1440': page(1440) }, { theme: undefined, locale: undefined }));
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /config-unmeasured/);
});

test('a measurement without a viewport cannot be scoped and is a FAIL', () => {
  const missing = page(1440);
  delete missing.viewport;
  const file = writeTemp('_metrics_no_viewport.json', artifact({ '/a @1440': missing }));
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /viewport-unmeasured/);
});

test('a malformed measurement is a named FAIL, not a stack trace', () => {
  const file = writeTemp('_metrics_format.json', JSON.stringify({ config: { label: 'bad', theme: 'light', locale: 'en' }, pages: [] }));
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /measurement-format/);
});

test('invalid JSON in an artifact is a named FAIL, not a stack trace', () => {
  const file = writeTemp('_metrics_broken.json', '{not json');
  const result = run([file]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /measurement-format/);
});

test('manifest and matrix flags together are rejected, not silently mixed', () => {
  const file = writeTemp('_metrics_both.json', matrixArtifact({ '/a @1440': page(1440) }));
  const result = run(['--manifest', TEMP_MANIFEST, '--matrix', MATRIX, file]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /answer different questions/);
});

test('a corrupt matrix manifest is exit 2, not an empty pass', () => {
  const broken = writeTemp('matrix-broken.json', '{not json');
  const file = writeTemp('_metrics_any.json', matrixArtifact({ '/a @1440': page(1440) }));
  const result = run(['--matrix', broken, file]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /not valid JSON/);
});

test('the repository manifest parses and names the detail routes by shape', () => {
  const result = run(['--manifest', MANIFEST, writeTemp('_metrics_repo.json', artifact({ '/admin/jobs @1440': page() }))]);
  // Only /admin/jobs is present, so this run must fail for the nine missing routes - but it must
  // fail with route-missing, never with "cannot compile the manifest".
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /cannot compile/);
  assert.match(result.stdout, /route-missing/);
});
