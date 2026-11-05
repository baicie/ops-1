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
 * The baseline is a gate, not evidence that can be narrowed into passing:
 *
 *   * all four curated labels are required, and only those labels;
 *   * the desktop labels require the three wide pages; the 768/390 labels also require the
 *     compact Decision tab measurement;
 *   * every required page must carry non-empty regions, the expected KPI identities, the
 *     expected tab model, a visible-pane fact, a numeric overflow and a numeric header height;
 *   * --update validates the same facts, so a missing page or malformed metric cannot be written
 *     into a new baseline either.
 *
 * Exit: 0 all selected combinations match; 1 a regression; 2 the gate could not run, the
 * baseline is incomplete/invalid, or the artifact is missing a required fact.
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
if (rest.some((arg) => arg !== '--update')) {
  console.error('check-workbench-metrics: unknown argument ' + rest.filter((arg) => arg !== '--update').join(', '));
  process.exit(2);
}
if (!fs.existsSync(DIR)) {
  console.error('check-workbench-metrics: no metrics directory ' + dirArg);
  process.exit(2);
}

const OBS = '/app/observability';
const ENTITY = '/app/observability/nodes/:id';
const INCIDENT = '/app/incidents/:id';
const DETAIL = '/app/incidents/:id detail-tab';

/** Four curated combinations: both themes, both languages, desktop/tablet/phone. */
const LABELS = ['r1440-light-en', 'r1024-dark-zh-CN', 'r768-light-zh-CN', 'r390-dark-en'];
const COMPACT = new Set(['r768-light-zh-CN', 'r390-dark-en']);
const REQUIRED = Object.fromEntries(LABELS.map((label) => [
  label,
  COMPACT.has(label) ? [OBS, ENTITY, INCIDENT, DETAIL] : [OBS, ENTITY, INCIDENT],
]));

const REQUIRED_REGIONS = {
  [OBS]: ['kpi', 'fleet', 'scope'],
  [ENTITY]: ['current', 'history', 'instances', 'events'],
  [INCIDENT]: ['rail', 'kpi', 'timeline', 'evidence', 'ai', 'verdict', 'lifecycle', 'audit', 'identity'],
  [DETAIL]: ['rail', 'kpi', 'timeline', 'evidence', 'ai', 'verdict', 'lifecycle', 'audit', 'identity'],
};
const EXPECTED_CARDS = {
  [OBS]: ['obs-attention', 'obs-reporting', 'obs-stale', 'obs-unobservable'],
  [ENTITY]: ['obs-entity-cpu', 'obs-entity-memory', 'obs-entity-filesystem', 'obs-entity-instances'],
  [INCIDENT]: ['incidentEvidence', 'incidentVerified', 'incidentTimeline', 'incidentAudit'],
  [DETAIL]: ['incidentEvidence', 'incidentVerified', 'incidentTimeline', 'incidentAudit'],
};
const TABS = ['investigation-tab-rail', 'investigation-tab-analysis', 'investigation-tab-detail'];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 24;

function expectedTabs(label, pageId) {
  return COMPACT.has(label) && (pageId === INCIDENT || pageId === DETAIL) ? TABS : [];
}

function expectedPane(label, pageId) {
  if (!COMPACT.has(label)) return null;
  if (pageId === DETAIL) return 'detail';
  if (pageId === INCIDENT) return 'analysis';
  return null;
}

/** The facts this gate compares. Artifact pages carry `cards`; the baseline carries `cardIds`. */
function factsFromPage(page, source, label, pageId) {
  if (!isObject(page)) return { error: label + ' ' + pageId + ': page is not an object' };
  const cardIds = source === 'artifact'
    ? (Array.isArray(page.cards) && page.cards.every((card) => isObject(card) && typeof card.metric === 'string')
      ? page.cards.map((card) => card.metric)
      : undefined)
    : page.cardIds;
  return {
    regions: page.regions,
    gridColumns: page.gridColumns,
    cardIds,
    tabs: page.tabs,
    visiblePane: page.visiblePane,
    overflow: page.overflow,
    headerHeight: page.headerHeight,
  };
}

/**
 * Validate one page's facts. This is the same function for --update and verification: a baseline
 * cannot be written from a page that verification would reject, and a baseline cannot pass with a
 * page shape verification would reject.
 */
function validateFacts(facts, label, pageId) {
  const errors = [];
  const prefix = label + ' ' + pageId + ' ';
  if (!isStringArray(facts.regions) || facts.regions.length === 0) {
    errors.push(prefix + 'regions must be a non-empty string array');
  } else {
    const missing = (REQUIRED_REGIONS[pageId] || []).filter((region) => !facts.regions.includes(region));
    if (missing.length) errors.push(prefix + 'regions missing ' + missing.join(', '));
  }
  const columnsExpected = pageId === DETAIL ? null : 'positive integer';
  if (columnsExpected === null ? facts.gridColumns !== null : !(Number.isInteger(facts.gridColumns) && facts.gridColumns > 0)) {
    errors.push(prefix + 'gridColumns must be ' + (columnsExpected === null ? 'null for the compact Decision tab' : 'a positive integer'));
  }
  const cards = EXPECTED_CARDS[pageId] || [];
  if (!isStringArray(facts.cardIds) || !same(facts.cardIds, cards)) {
    errors.push(prefix + 'cardIds must be ' + JSON.stringify(cards) + ', got ' + JSON.stringify(facts.cardIds));
  }
  const tabs = expectedTabs(label, pageId);
  if (!isStringArray(facts.tabs) || !same(facts.tabs, tabs)) {
    errors.push(prefix + 'tabs must be ' + JSON.stringify(tabs) + ', got ' + JSON.stringify(facts.tabs));
  }
  if (facts.visiblePane !== expectedPane(label, pageId)) {
    errors.push(prefix + 'visiblePane must be ' + JSON.stringify(expectedPane(label, pageId)) + ', got ' + JSON.stringify(facts.visiblePane));
  }
  if (typeof facts.overflow !== 'number' || !Number.isFinite(facts.overflow)) {
    errors.push(prefix + 'overflow must be a number, got ' + JSON.stringify(facts.overflow));
  }
  if (typeof facts.headerHeight !== 'number' || !Number.isFinite(facts.headerHeight)) {
    errors.push(prefix + 'headerHeight must be a number, got ' + JSON.stringify(facts.headerHeight));
  }
  return errors;
}

function readArtifact(label) {
  const file = path.join(DIR, `_metrics_${label}.json`);
  if (!fs.existsSync(file)) return { error: 'missing ' + path.relative(ROOT, file) };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    return { error: label + ' is not valid JSON: ' + cause.message };
  }
  if (!isObject(doc)) return { error: label + ' artifact root is not an object' };
  if (!isObject(doc.config) || doc.config.label !== label) {
    return { error: label + ' artifact config.label is missing or does not match the file name' };
  }
  if (doc.config.mode !== 'after') {
    return { error: label + ' artifact config.mode must be "after", got ' + JSON.stringify(doc.config.mode) };
  }
  // Four labels are four distinct captures, not four file names. Without this check a 390 dark
  // en artifact copied to the 768 light zh-CN name has the same cards/tabs/overflow and would
  // pass; the label would claim a width/language/theme that was never rendered.
  const parts = label.match(/^r(1440|1024|768|390)-(light|dark)-(en|zh-CN)$/);
  if (!parts) return { error: label + ' is not a recognised viewport-theme-locale label' };
  const width = Number(parts[1]);
  const theme = parts[2];
  const locale = parts[3];
  if (!isObject(doc.config.viewport) || doc.config.viewport.w !== width) {
    return { error: label + ' artifact viewport.width must be ' + width + ', got ' + JSON.stringify(doc.config.viewport?.w) };
  }
  if (doc.config.theme !== theme) {
    return { error: label + ' artifact theme must be "' + theme + '", got ' + JSON.stringify(doc.config.theme) };
  }
  if (doc.config.locale !== locale) {
    return { error: label + ' artifact locale must be "' + locale + '", got ' + JSON.stringify(doc.config.locale) };
  }
  if (!isObject(doc.pages)) return { error: label + ' artifact pages is not an object' };
  return { doc };
}

function artifactFacts(label, pageId, doc) {
  if (!isObject(doc.pages) || !isObject(doc.pages[pageId])) {
    return { error: label + ' ' + pageId + ': page missing from the artifact' };
  }
  const facts = factsFromPage(doc.pages[pageId], 'artifact', label, pageId);
  if (facts.error) return { error: facts.error };
  const errors = validateFacts(facts, label, pageId);
  return errors.length ? { error: errors.join('; ') } : { facts };
}

function baselineFacts(label, pageId, entry) {
  if (!isObject(entry.pages) || !isObject(entry.pages[pageId])) {
    return { error: label + ' ' + pageId + ': page missing from the baseline' };
  }
  const facts = factsFromPage(entry.pages[pageId], 'baseline', label, pageId);
  if (facts.error) return { error: facts.error };
  const errors = validateFacts(facts, label, pageId);
  return errors.length ? { error: errors.join('; ') } : { facts };
}

function fail(errors) {
  for (const error of errors) console.error('check-workbench-metrics: ' + error);
  process.exit(2);
}

if (UPDATE) {
  const labels = {};
  const errors = [];
  for (const label of LABELS) {
    const { doc, error } = readArtifact(label);
    if (error) { errors.push(error); continue; }
    const pages = {};
    for (const pageId of REQUIRED[label]) {
      const { facts, error: pageError } = artifactFacts(label, pageId, doc);
      if (pageError) { errors.push(pageError); continue; }
      pages[pageId] = facts;
    }
    // A compact capture is not required on desktop, but if the key exists it must still be valid.
    // `isObject(doc.pages[DETAIL])` would treat a string/null/array as absent and let --update
    // write a baseline that verification would later reject; the key's presence is the fact.
    if (!COMPACT.has(label) && isObject(doc.pages) && DETAIL in doc.pages) {
      const { facts, error: detailError } = artifactFacts(label, DETAIL, doc);
      if (detailError) errors.push(detailError);
      else pages[DETAIL] = facts;
    }
    labels[label] = { pages };
  }
  if (errors.length) fail(errors);
  for (const label of LABELS) {
    const missing = REQUIRED[label].filter((pageId) => !labels[label].pages[pageId]);
    if (missing.length) errors.push(label + ' is missing ' + missing.join(', '));
  }
  if (errors.length) fail(errors);
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
let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch (cause) {
  console.error('check-workbench-metrics: baseline is not valid JSON: ' + cause.message);
  process.exit(2);
}
if (!isObject(baseline) || !isObject(baseline.labels)) {
  console.error('check-workbench-metrics: baseline must be an object with a labels object');
  process.exit(2);
}
const baselineLabels = Object.keys(baseline.labels);
const missingLabels = LABELS.filter((label) => !baselineLabels.includes(label));
const extraLabels = baselineLabels.filter((label) => !LABELS.includes(label));
if (missingLabels.length || extraLabels.length) {
  const parts = [];
  if (missingLabels.length) parts.push('missing ' + missingLabels.join(', '));
  if (extraLabels.length) parts.push('unexpected ' + extraLabels.join(', '));
  console.error('check-workbench-metrics: baseline labels must be exactly ' + LABELS.join(', ') + ' (' + parts.join('; ') + ')');
  process.exit(2);
}

const baselineErrors = [];
for (const label of LABELS) {
  const entry = baseline.labels[label];
  if (!isObject(entry)) { baselineErrors.push(label + ': entry is not an object'); continue; }
  for (const pageId of REQUIRED[label]) {
    const { error } = baselineFacts(label, pageId, entry);
    if (error) baselineErrors.push(error);
  }
  // A desktop compact page is optional, but a baseline that carries one must not be malformed.
  if (!COMPACT.has(label) && isObject(entry.pages) && DETAIL in entry.pages) {
    const { error } = baselineFacts(label, DETAIL, entry);
    if (error) baselineErrors.push(error);
  }
}
if (baselineErrors.length) fail(baselineErrors);

const failures = [];
for (const label of LABELS) {
  const expected = baseline.labels[label];
  const { doc, error } = readArtifact(label);
  if (error) { failures.push(error); continue; }
  for (const pageId of Object.keys(expected.pages)) {
    const { facts: want, error: wantError } = baselineFacts(label, pageId, expected);
    if (wantError) { failures.push(wantError); continue; }
    const { facts: got, error: pageError } = artifactFacts(label, pageId, doc);
    if (pageError) { failures.push(pageError); continue; }
    for (const key of ['regions', 'gridColumns', 'cardIds', 'tabs', 'visiblePane']) {
      if (!same(got[key], want[key])) {
        failures.push(label + ' ' + pageId + ' ' + key + ': expected ' + JSON.stringify(want[key]) + ', got ' + JSON.stringify(got[key]));
      }
    }
    if (got.overflow > want.overflow + 1) {
      failures.push(label + ' ' + pageId + ' overflow: baseline ' + want.overflow + ', got ' + got.overflow);
    }
    // Incident titles/owners are seed data; the header can legitimately grow a line between
    // runs. The structural facts above are the regression this gate owns.
    if (!pageId.startsWith('/app/incidents') && !near(got.headerHeight, want.headerHeight)) {
      failures.push(label + ' ' + pageId + ' headerHeight: baseline ' + want.headerHeight + ', got ' + got.headerHeight);
    }
  }
}

for (const failure of failures) console.log('FAIL  ' + failure);
console.log(failures.length
  ? 'check-workbench-metrics: FAIL (' + failures.length + ' regression(s))'
  : 'check-workbench-metrics: PASS (' + LABELS.length + ' labels x required pages)');
process.exit(failures.length ? 1 : 0);
