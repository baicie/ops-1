#!/usr/bin/env node
/**
 * check-workbench-metrics.mjs - the DS-V1-2 workbench regression gate.
 *
 * Why this is not a pixel diff: the repository's tracked PNG budget is full (408 files) and the
 * task forbids spending it on a matrix. A screenshot diff also needs pinned fonts and a pinned
 * browser, or it fails on rendering noise. So the curated baseline is a small JSON of the facts
 * a redesign can break and a reviewer would otherwise have to re-open six screenshots to see:
 * region order, KPI column count, which KPI identities exist, the tab model, and overflow.
 *
 *   node scripts/check-workbench-metrics.mjs artifacts/ui/visual-v2/after docs/.../workbench-baseline.json
 *   node scripts/check-workbench-metrics.mjs artifacts/ui/visual-v2/after docs/.../workbench-baseline.json --update
 *
 * Exit: 0 all selected combinations match; 1 a regression; 2 the gate could not run.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const [dirArg, baselineArg, ...rest] = process.argv.slice(2);
if (!dirArg || !baselineArg) {
  console.error('check-workbench-metrics: usage: <metrics-dir> <baseline.json> [--update]');
  process.exit(2);
}
const DIR = path.resolve(ROOT, dirArg);
const BASELINE = path.resolve(ROOT, baselineArg);
const UPDATE = rest.includes('--update');
if (!fs.existsSync(DIR)) {
  console.error('check-workbench-metrics: no metrics directory ' + dirArg);
  process.exit(2);
}

/** Four curated combinations: both themes, both languages, desktop/tablet/phone. */
const LABELS = ['r1440-light-en', 'r1024-dark-zh-CN', 'r768-light-zh-CN', 'r390-dark-en'];
const PAGES = ['/app/observability', '/app/observability/nodes/:id', '/app/incidents/:id', '/app/incidents/:id detail-tab'];
const REQUIRED = ['/app/observability', '/app/observability/nodes/:id', '/app/incidents/:id'];

function read(label) {
  const file = path.join(DIR, `_metrics_${label}.json`);
  if (!fs.existsSync(file)) return { error: 'missing ' + path.relative(ROOT, file) };
  try {
    return { doc: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (cause) {
    return { error: label + ' is not valid JSON: ' + cause.message };
  }
}

const fields = (page) => ({
  regions: page?.regions ?? null,
  gridColumns: page?.gridColumns ?? null,
  cardIds: Array.isArray(page?.cards) ? page.cards.map((card) => card.metric ?? null) : null,
  tabs: page?.tabs ?? null,
  visiblePane: page?.visiblePane ?? null,
  overflow: page?.overflow ?? null,
  headerHeight: page?.headerHeight ?? null,
});

if (UPDATE) {
  const labels = {};
  for (const label of LABELS) {
    const { doc, error } = read(label);
    if (error) { console.error('check-workbench-metrics: ' + error); process.exit(2); }
    const pages = {};
    for (const page of PAGES) {
      if (doc.pages && doc.pages[page]) pages[page] = fields(doc.pages[page]);
    }
    const missing = REQUIRED.filter((page) => !pages[page]);
    if (missing.length) {
      console.error('check-workbench-metrics: refusing to narrow the baseline; ' + label + ' is missing ' + missing.join(', '));
      process.exit(2);
    }
    labels[label] = { pages };
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify({
    version: 1,
    description: 'Curated DS-V1-2 regressions: region order, KPI identity/columns, tab model, overflow. Times and copy are deliberately not stored.',
    labels,
  }, null, 2) + '\n');
  console.log('check-workbench-metrics: wrote ' + path.relative(ROOT, BASELINE) + ' (' + LABELS.length + ' labels)');
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error('check-workbench-metrics: no baseline at ' + baselineArg);
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const baselineLabels = Object.entries(baseline.labels || {});
if (baselineLabels.length === 0) {
  console.error('check-workbench-metrics: the baseline declares no labels; that asserts nothing');
  process.exit(2);
}
for (const [label, entry] of baselineLabels) {
  const missing = REQUIRED.filter((page) => !entry.pages || !entry.pages[page]);
  if (missing.length) {
    console.error('check-workbench-metrics: baseline ' + label + ' is missing ' + missing.join(', ') + '; a narrowed baseline is not evidence');
    process.exit(2);
  }
}
const failures = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 24;

for (const [label, expected] of Object.entries(baseline.labels || {})) {
  const { doc, error } = read(label);
  if (error) { failures.push(error); continue; }
  for (const [page, want] of Object.entries(expected.pages || {})) {
    const got = doc.pages && doc.pages[page] ? fields(doc.pages[page]) : null;
    if (!got) { failures.push(label + ' ' + page + ': page missing from the artifact'); continue; }
    for (const key of ['regions', 'gridColumns', 'cardIds', 'tabs', 'visiblePane']) {
      if (!same(got[key], want[key])) {
        failures.push(label + ' ' + page + ' ' + key + ': expected ' + JSON.stringify(want[key]) + ', got ' + JSON.stringify(got[key]));
      }
    }
    if (typeof got.overflow === 'number' && typeof want.overflow === 'number' && got.overflow > want.overflow + 1) {
      failures.push(label + ' ' + page + ' overflow: baseline ' + want.overflow + ', got ' + got.overflow);
    }
    // Incident titles/owners are seed data; the header can legitimately grow a line between
    // runs. The structural facts above are the regression this gate owns.
    if (!page.startsWith('/app/incidents') && !near(got.headerHeight, want.headerHeight)) {
      failures.push(label + ' ' + page + ' headerHeight: baseline ' + want.headerHeight + ', got ' + got.headerHeight);
    }
  }
}

for (const failure of failures) console.log('FAIL  ' + failure);
console.log(failures.length
  ? 'check-workbench-metrics: FAIL (' + failures.length + ' regression(s))'
  : 'check-workbench-metrics: PASS (' + Object.keys(baseline.labels || {}).length + ' labels x ' +
    Math.max(...Object.values(baseline.labels || {}).map((entry) => Object.keys(entry.pages || {}).length), 0) + ' pages)');
process.exit(failures.length ? 1 : 0);
