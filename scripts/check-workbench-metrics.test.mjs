#!/usr/bin/env node
/**
 * Counterfactuals for scripts/check-workbench-metrics.mjs.
 *
 * The gate is only useful if removing evidence turns it red. These tests build a complete
 * four-label artifact set in a temporary directory, then delete a label, delete a compact page,
 * null an overflow, corrupt JSON, and narrow the baseline. Every mutation must exit non-zero with
 * a message naming the missing fact. The desktop fixture deliberately has no compact page: the
 * gate must not demand one there.
 *
 *   node --test scripts/check-workbench-metrics.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GATE = path.join(ROOT, 'scripts/check-workbench-metrics.mjs');
const LABELS = ['r1440-light-en', 'r1024-dark-zh-CN', 'r768-light-zh-CN', 'r390-dark-en'];
const COMPACT = new Set(['r768-light-zh-CN', 'r390-dark-en']);
const OBS = '/app/observability';
const ENTITY = '/app/observability/nodes/:id';
const INCIDENT = '/app/incidents/:id';
const DETAIL = '/app/incidents/:id detail-tab';
const REQUIRED = (label) => COMPACT.has(label) ? [OBS, ENTITY, INCIDENT, DETAIL] : [OBS, ENTITY, INCIDENT];
const TABS = ['investigation-tab-rail', 'investigation-tab-analysis', 'investigation-tab-detail'];
const REGIONS = {
  [OBS]: ['kpi', 'fleet', 'scope'],
  [ENTITY]: ['current', 'history', 'instances', 'events'],
  [INCIDENT]: ['rail', 'kpi', 'timeline', 'evidence', 'ai', 'verdict', 'lifecycle', 'audit', 'identity'],
  [DETAIL]: ['rail', 'kpi', 'timeline', 'evidence', 'ai', 'verdict', 'lifecycle', 'audit', 'identity'],
};
const CARDS = {
  [OBS]: ['obs-attention', 'obs-reporting', 'obs-stale', 'obs-unobservable'],
  [ENTITY]: ['obs-entity-cpu', 'obs-entity-memory', 'obs-entity-filesystem', 'obs-entity-instances'],
  [INCIDENT]: ['incidentEvidence', 'incidentVerified', 'incidentTimeline', 'incidentAudit'],
  [DETAIL]: ['incidentEvidence', 'incidentVerified', 'incidentTimeline', 'incidentAudit'],
};

function pageFor(label, pageId) {
  const compact = COMPACT.has(label);
  const detail = pageId === DETAIL;
  const incident = pageId === INCIDENT || detail;
  return {
    regions: REGIONS[pageId],
    gridColumns: detail ? null : 4,
    cards: CARDS[pageId].map((metric) => ({ metric, state: 'ready', value: '1' })),
    tabs: compact && incident ? TABS : [],
    visiblePane: compact && incident ? (detail ? 'detail' : 'analysis') : null,
    overflow: -15,
    headerHeight: 80,
  };
}

function configFor(label) {
  const parts = label.match(/^r(1440|1024|768|390)-(light|dark)-(en|zh-CN)$/);
  if (!parts) throw new Error('test fixture has an invalid label: ' + label);
  return {
    label,
    mode: 'after',
    viewport: { w: Number(parts[1]), h: parts[1] === '390' ? 844 : 900 },
    theme: parts[2],
    locale: parts[3],
  };
}

function artifactFor(label) {
  const pages = {};
  for (const pageId of REQUIRED(label)) pages[pageId] = pageFor(label, pageId);
  return { config: configFor(label), pages };
}

function writeArtifacts(dir, { omit = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const label of LABELS) {
    const doc = artifactFor(label);
    if (omit && omit.label === label) delete doc.pages[omit.pageId];
    fs.writeFileSync(path.join(dir, `_metrics_${label}.json`), JSON.stringify(doc, null, 1));
  }
}

function runGate(metricsDir, baseline, update = false) {
  const args = [GATE, metricsDir, baseline, ...(update ? ['--update'] : [])];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

function createEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsweave-workbench-gate-'));
  const metrics = path.join(root, 'metrics');
  const baseline = path.join(root, 'baseline.json');
  writeArtifacts(metrics);
  return { root, metrics, baseline };
}

function withEnv(fn) {
  const env = createEnv();
  try {
    return fn(env);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
}

function readBaseline(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeBaseline(env, doc, name = 'mutated-baseline.json') {
  const file = path.join(env.root, name);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

test('a complete four-label fixture passes, including desktop without a compact page', () => withEnv((env) => {
  const updated = runGate(env.metrics, env.baseline, true);
  assert.equal(updated.status, 0, updated.output);
  const checked = runGate(env.metrics, env.baseline);
  assert.equal(checked.status, 0, checked.output);
  assert.match(checked.output, /PASS \(4 labels/);
}));

test('deleting a label fails instead of silently checking three', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const doc = readBaseline(env.baseline);
  delete doc.labels['r390-dark-en'];
  const result = runGate(env.metrics, writeBaseline(env, doc));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /missing r390-dark-en/);
}));

test('deleting the compact Decision page fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const doc = readBaseline(env.baseline);
  delete doc.labels['r768-light-zh-CN'].pages[DETAIL];
  const result = runGate(env.metrics, writeBaseline(env, doc));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /detail-tab.*page missing/);
}));

test('a null overflow in the artifact fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const file = path.join(env.metrics, '_metrics_r390-dark-en.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.pages[OBS].overflow = null;
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /overflow must be a number/);
}));

test('a null overflow in the baseline fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const doc = readBaseline(env.baseline);
  doc.labels['r1440-light-en'].pages[ENTITY].overflow = null;
  const result = runGate(env.metrics, writeBaseline(env, doc));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /overflow must be a number/);
}));

test('missing KPI cards fail', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const file = path.join(env.metrics, '_metrics_r1440-light-en.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.pages[INCIDENT].cards;
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /cardIds/);
}));

test('malformed artifact JSON fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  fs.writeFileSync(path.join(env.metrics, '_metrics_r1440-light-en.json'), '{');
  const result = runGate(env.metrics, env.baseline);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /not valid JSON/);
}));

test('wrong field types fail', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const file = path.join(env.metrics, '_metrics_r1440-light-en.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.pages[OBS].tabs = 'none';
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /tabs must be/);
}));

test('missing regions, tabs or visiblePane fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const file = path.join(env.metrics, '_metrics_r1440-light-en.json');
  for (const [field, pattern] of [['regions', /regions/], ['tabs', /tabs/], ['visiblePane', /visiblePane/]]) {
    const doc = artifactFor('r1440-light-en');
    delete doc.pages[OBS][field];
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    const result = runGate(env.metrics, env.baseline);
    assert.notEqual(result.status, 0, field + ': ' + result.output);
    assert.match(result.output, pattern);
  }
}));

test('a baseline narrowed to one required page fails', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const doc = readBaseline(env.baseline);
  for (const pageId of [ENTITY, INCIDENT]) delete doc.labels['r1024-dark-zh-CN'].pages[pageId];
  const result = runGate(env.metrics, writeBaseline(env, doc));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /page missing from the baseline/);
}));

test('--update refuses to write when a compact capture is missing', () => withEnv((env) => {
  writeArtifacts(env.metrics, { omit: { label: 'r390-dark-en', pageId: DETAIL } });
  const result = runGate(env.metrics, env.baseline, true);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /detail-tab/);
  assert.equal(fs.existsSync(env.baseline), false, 'a failed --update must not leave a narrowed baseline behind');
}));

test('a before-mode artifact cannot be promoted into the baseline', () => withEnv((env) => {
  const file = path.join(env.metrics, '_metrics_r1440-light-en.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.config.mode = 'before';
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline, true);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /mode must be "after"/);
}));

test('one combination cannot be relabelled as another', () => withEnv((env) => {
  assert.equal(runGate(env.metrics, env.baseline, true).status, 0);
  const source = path.join(env.metrics, '_metrics_r390-dark-en.json');
  const target = path.join(env.metrics, '_metrics_r768-light-zh-CN.json');
  const doc = JSON.parse(fs.readFileSync(source, 'utf8'));
  doc.config.label = 'r768-light-zh-CN';
  // Keep the real 390/dark/en capture facts; only the claimed label changes.
  fs.writeFileSync(target, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /viewport\.width must be 768|theme must be "light"|locale must be "zh-CN"/);
}));

test('--update rejects a wrong-typed desktop detail page', () => withEnv((env) => {
  const file = path.join(env.metrics, '_metrics_r1440-light-en.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.pages[DETAIL] = 'garbage';
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  const result = runGate(env.metrics, env.baseline, true);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /detail-tab/);
  assert.equal(fs.existsSync(env.baseline), false, 'a failed --update must not write a baseline');
}));
