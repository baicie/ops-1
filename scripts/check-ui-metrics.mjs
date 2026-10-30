#!/usr/bin/env node
/**
 * check-ui-metrics.mjs - the geometry half of the UI spec gate.
 *
 * Reads the _metrics_*.json files the audit harness writes and fails on the numbers a human
 * review cannot check by eye. Two rules shape everything below.
 *
 *   1. A page with no measurement is a FAIL, not a pass. artifacts/ui/visual-v3/audit/
 *      _metrics_r390-light-en.json recorded 223px of horizontal overflow on /admin/jobs/{id} and
 *      shipped anyway, because nothing read it. Every assertion here therefore fails closed: a
 *      field the artifact does not carry is a violation, never a skip. The same rule applies to a
 *      directory that expands to no files - "the harness produced nothing" is the loudest failure
 *      there is, not a green run.
 *
 *   2. The thresholds are the spec's, not this file's. They are parsed out of table-spec.md §4.2
 *      (and §2.2 for the two viewport-scoped caps) at startup and printed with the section that
 *      derives them, so a threshold and its reason travel together. A spec this script cannot read
 *      is exit 2: a gate that quietly invents its own number is worse than no gate at all.
 *
 *   node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit
 *   node scripts/check-ui-metrics.mjs --template artifacts/ui/visual-v3/audit
 *
 * Exit: 0 every assertion passed; 1 at least one violation; 2 the gate could not run (no input,
 * or a spec it cannot parse).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SPEC = resolve(ROOT, process.env.UI_METRICS_SPEC || 'docs/design/ui-visual-v3/spec/table-spec.md');
const argv = process.argv.slice(2);
const inputs = argv.filter((a) => !a.startsWith('--'));
const withTemplate = argv.includes('--template');

/* ── thresholds: parsed from the spec, never retyped ───────────────────────── */

function specRows(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

/** The §4.2 row whose first cell opens with `name`, read as {op, value, section}. */
function comparisonRow(rows, name) {
  const cells = rows.find((row) => (row[0] || '').startsWith('`' + name));
  if (!cells) return { error: 'table-spec.md §4.2 has no row starting with `' + name + '`' };
  const hit = cells.join(' ').match(/([<>])\s*(-?\d+(?:\.\d+)?)/);
  if (!hit) return { error: '§4.2 row `' + name + '` states no comparison this gate can read' };
  const sections = (cells[cells.length - 1].match(/§[0-9.]+(?:\s*,\s*§[0-9.]+)*/) || [''])[0];
  return { op: hit[1], value: Number(hit[2]), section: sections.replace(/\s*,\s*/g, ' ') || '§?' };
}

/** A §4.2 row whose threshold is a §2.2 lookup ("over the viewport cap"); only its section is read. */
function lookupRow(rows, name) {
  const cells = rows.find((row) => (row[0] || '').startsWith('`' + name));
  if (!cells) return { error: 'table-spec.md §4.2 has no row starting with `' + name + '`' };
  return { section: (cells[cells.length - 1].match(/§[0-9.]+/) || ['§?'])[0] };
}

/** A §2.2 cap: the `**N**` bolded number on the row that starts with `needle`. */
function capRow(rows, needle) {
  const cells = rows.find((row) => (row[0] || '').includes(needle) && /\*\*\d/.test(row.join(' ')));
  if (!cells) return { error: 'table-spec.md §2.2 has no cap row for "' + needle + '"' };
  const hit = cells.join(' ').match(/\*\*(\d+)/);
  return hit ? { value: Number(hit[1]) } : { error: '§2.2 row "' + needle + '" carries no **N** cap' };
}

function loadThresholds() {
  if (!existsSync(SPEC)) return { error: 'spec not found: ' + SPEC };
  const rows = specRows(readFileSync(SPEC, 'utf8'));
  const need = {
    overflow: comparisonRow(rows, 'overflow > 0'),
    identity: comparisonRow(rows, 'distinct(identityKey)'),
    rowHeight: comparisonRow(rows, 'rowHeight.p95'),
    columns: lookupRow(rows, 'columns'),
    distinctRatio: comparisonRow(rows, 'min(distinctRatio)'),
    duplicateRunMax: comparisonRow(rows, 'duplicateRunMax'),
    noDataPerTable: comparisonRow(rows, 'noDataPerTable'),
    cardFactCount: comparisonRow(rows, 'cardFactCount'),
    wide: capRow(rows, '≥ 1024'),
    mid: capRow(rows, '1023'),
    cards: capRow(rows, '< 768'),
  };
  const errors = Object.entries(need)
    .filter(([, row]) => row.error)
    .map(([key, row]) => key + ': ' + row.error);
  if (errors.length) return { error: errors.join('\n  ') };
  // §2.2's "< 768" cell and §4.2's cardFactCount row both cap the card at the same number. If they
  // ever disagree the spec is self-contradictory and neither number can be trusted.
  if (need.cards.value !== need.cardFactCount.value) {
    return {
      error:
        'the spec contradicts itself: §2.2 caps a card at ' + need.cards.value + ' facts while §4.2 caps ' +
        'cardFactCount at ' + need.cardFactCount.value,
    };
  }
  return need;
}

const T = loadThresholds();
if (T.error) {
  console.error('check-ui-metrics: cannot read the thresholds from ' + relative(ROOT, SPEC));
  console.error('  ' + T.error);
  process.exit(2);
}

/* ── input expansion ───────────────────────────────────────────────────────── */

function expand(list) {
  const out = [];
  for (const item of list) {
    const p = resolve(item);
    if (!existsSync(p)) {
      console.error('check-ui-metrics: no such file or directory: ' + item);
      process.exit(2);
    }
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) if (/_metrics_.*\.json$/.test(name)) out.push(join(p, name));
    } else out.push(p);
  }
  return out;
}

if (inputs.length === 0) {
  console.error('check-ui-metrics: pass one or more _metrics_*.json files or a directory');
  process.exit(2);
}
const files = expand(inputs);
if (files.length === 0) {
  // Fail closed: a directory with no measurement is the failure mode this gate exists for.
  console.error('check-ui-metrics: ' + inputs.join(', ') + ' expanded to zero _metrics_*.json files');
  console.error('  the audit harness did not run, or wrote somewhere else; that is a FAIL, not an empty pass');
  process.exit(1);
}

/* ── the nine assertions of §4.2 ───────────────────────────────────────────── */

const CODES = [
  'page-errored',
  'overflow-unmeasured',
  'overflow>0',
  'identity-unmeasured',
  'identity-duplicate',
  'viewport-unmeasured',
  'row-height-unmeasured',
  'row-height-high',
  'columns-unmeasured',
  'columns-over-cap',
  'distinct-unmeasured',
  'distinct-malformed',
  'distinct-ratio-low',
  'duplicate-run-unmeasured',
  'duplicate-run-max',
  'no-data-unmeasured',
  'no-data-per-table',
  'card-facts-unmeasured',
  'card-facts-high',
];
const tally = Object.fromEntries(CODES.map((code) => [code, 0]));

function columnLabel(m, index) {
  const labels = Array.isArray(m.columnLabels) ? m.columnLabels : [];
  const label = labels[index];
  return label ? ' "' + label + '"' : '';
}

/** Every §4.2 assertion that applies to one page measurement. Returns the violations. */
function violationsFor(m) {
  const found = [];
  const add = (code, detail) => found.push({ code, detail });
  const vw = m.viewport && typeof m.viewport.w === 'number' ? m.viewport.w : null;

  // §1.5, §2.6 - overflow is a hard assertion on every route and viewport.
  if (typeof m.overflow !== 'number') add('overflow-unmeasured', 'no number for document.scrollWidth - clientWidth');
  else if (m.overflow > T.overflow.value) {
    const worst = (m.offenders || [])[0];
    const who = worst ? '  worst: <' + worst.tag + '> ' + (worst.cls || '') + ' right=' + worst.right : '';
    add('overflow>0', '+' + m.overflow + 'px' + who);
  }

  // §2.1, §2.5 - one identity per row, and no two rows may share it.
  if (!Array.isArray(m.identityKey)) add('identity-unmeasured', 'no identityKey[] in the artifact');
  else if (m.identityKey.length > 0) {
    const distinct = new Set(m.identityKey).size;
    const ratio = Math.round((distinct / m.identityKey.length) * 1000) / 1000;
    if (ratio < T.identity.value) {
      const repeat = m.identityKey.length - distinct;
      add('identity-duplicate', distinct + '/' + m.identityKey.length + ' distinct = ' + ratio.toFixed(3) +
        ' (that is ' + repeat + ' row(s) sharing an identity) < ' + T.identity.value);
    }
  }

  if (vw === null) {
    // Two of the nine thresholds are scoped by viewport (§2.3 says a card is not a row, §2.2 caps a
    // table by width). Without the width the gate cannot know which rule applies, and guessing the
    // stricter one would fail every phone run - so it says so instead of guessing.
    add('viewport-unmeasured', 'no viewport.w: §2.2 and §2.3 cannot be scoped to this page');
  } else if (vw >= 768) {
    // §2.3 - a row is 40px, and 42 is the tolerance before a wrapped cell has crept back in.
    const p95 = m.rowHeight && typeof m.rowHeight.p95 === 'number' ? m.rowHeight.p95 : null;
    if (p95 === null) add('row-height-unmeasured', 'no rowHeight.p95 for a ≥768 viewport');
    else if (p95 > T.rowHeight.value) {
      add('row-height-high', 'p95 ' + p95 + 'px > ' + T.rowHeight.value + 'px (n=' + ((m.rowHeight && m.rowHeight.n) || '?') + ')');
    }
    // §2.2 - two caps, one rule: a column earns its width.
    const cap = vw >= 1024 ? T.wide.value : T.mid.value;
    if (typeof m.columns !== 'number') add('columns-unmeasured', 'no columns count for a ≥768 viewport');
    else if (m.columns > cap) add('columns-over-cap', m.columns + ' > ' + cap + ' at ' + vw + 'px');
  }

  // §2.2 - the floor under every kept column.
  if (!Array.isArray(m.distinctRatio)) add('distinct-unmeasured', 'no distinctRatio[] in the artifact');
  else {
    const malformed = m.distinctRatio.filter((v) => v !== null && typeof v !== 'number');
    if (malformed.length) add('distinct-malformed', malformed.length + ' entry/entries are neither a ratio nor null');
    const kept = m.distinctRatio.filter((v) => typeof v === 'number');
    // §2.2's n >= 10 is per table. A page can show 14 rows split 8/6 across two tables, in which case
    // every column is legitimately null; an artifact that only carries page-level rows cannot tell
    // that apart from a measurement that produced nothing, so it falls back to the page count.
    const anyTableMeasurable = Array.isArray(m.tableRowCounts)
      ? m.tableRowCounts.some((n) => n >= 10)
      : typeof m.rows === 'number' && m.rows >= 10;
    const smallPage = !anyTableMeasurable;
    if (kept.length === 0 && m.distinctRatio.length > 0 && !smallPage) {
      // Every column came back null on a page with rows on screen: the measurement ran and produced
      // nothing usable, which is not the same as "the columns are fine".
      add('distinct-unmeasured', 'all ' + m.distinctRatio.length + ' column(s) unmeasured on a page with ' + m.rows + ' row(s)');
    } else if (kept.length) {
      const min = Math.min(...kept);
      if (min < T.distinctRatio.value) {
        const at = m.distinctRatio.indexOf(min);
        add('distinct-ratio-low', min + ' < ' + T.distinctRatio.value + ' at column ' + at + columnLabel(m, at) +
          ' of ' + m.distinctRatio.length);
      }
    }
  }

  // §2.4 - three identical rows in a row is one fact, not three.
  if (typeof m.duplicateRunMax !== 'number') add('duplicate-run-unmeasured', 'no duplicateRunMax in the artifact');
  else if (m.duplicateRunMax > T.duplicateRunMax.value) {
    add('duplicate-run-max', 'a run of ' + m.duplicateRunMax + ' identical rows > ' + T.duplicateRunMax.value);
  }

  // §2.7 - NO_DATA at most once per table; a page reports its worst table.
  if (typeof m.noDataPerTable !== 'number') add('no-data-unmeasured', 'no noDataPerTable in the artifact');
  else if (m.noDataPerTable > T.noDataPerTable.value) {
    add('no-data-per-table', m.noDataPerTable + ' NO_DATA cell(s) in one table > ' + T.noDataPerTable.value);
  }

  // §2.5 - at 390 the card carries at most three facts. Above 768 there is no card, so nothing to
  // assert; the cards[] array is what separates "no card rows here" from "nobody measured".
  if (vw !== null && vw < 768) {
    if (!Array.isArray(m.cards)) add('card-facts-unmeasured', 'no cards[] in the artifact, so cardFactCount cannot be trusted');
    else if (m.cards.length > 0) {
      if (typeof m.cardFactCount !== 'number') add('card-facts-unmeasured', m.cards.length + ' card row(s) but no cardFactCount');
      else if (m.cardFactCount > T.cardFactCount.value) {
        add('card-facts-high', m.cardFactCount + ' facts on a card > ' + T.cardFactCount.value);
      }
    }
  }
  return found;
}

/* ── the run ───────────────────────────────────────────────────────────────── */

console.log('check-ui-metrics: thresholds read from ' + relative(ROOT, SPEC));
console.log(
  '  overflow ≤ ' + T.overflow.value + ' (' + T.overflow.section + ')' +
  ' · identity distinct = ' + T.identity.value + ' (' + T.identity.section + ')' +
  ' · rowHeight.p95 ≤ ' + T.rowHeight.value + ' @≥768 (' + T.rowHeight.section + ')' +
  ' · columns ≤ ' + T.wide.value + ' @≥1024 / ≤ ' + T.mid.value + ' @768–1023 (' + T.columns.section + ')',
);
console.log(
  '  distinctRatio ≥ ' + T.distinctRatio.value + ' (' + T.distinctRatio.section + ')' +
  ' · duplicateRunMax ≤ ' + T.duplicateRunMax.value + ' (' + T.duplicateRunMax.section + ')' +
  ' · noDataPerTable ≤ ' + T.noDataPerTable.value + ' (' + T.noDataPerTable.section + ')' +
  ' · cardFactCount ≤ ' + T.cardFactCount.value + ' @<768 (' + T.cardFactCount.section + ')',
);

let failures = 0;
let pages = 0;
for (const file of files) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const label = (doc.config && doc.config.label) || relative(ROOT, file);
  const pageMap = doc.pages || {};
  let localFailures = 0;
  for (const [route, m] of Object.entries(pageMap)) {
    // A route the harness recorded as failed is an unmeasured page, and an unmeasured page is a
    // FAIL - the same rule as a missing field, one level up. Silence here would let a route drop
    // out of the audit without changing the verdict.
    if (!m || typeof m !== 'object' || m.error) {
      console.log('FAIL  ' + 'page-errored'.padEnd(26) + label + '  ' + route + '  ' + (m && m.error ? String(m.error) : 'no measurement object'));
      tally['page-errored'] += 1;
      localFailures += 1;
      continue;
    }
    pages += 1;
    for (const violation of violationsFor(m)) {
      console.log('FAIL  ' + violation.code.padEnd(26) + label + '  ' + route + '  ' + violation.detail);
      tally[violation.code] += 1;
      localFailures += 1;
    }
  }
  console.log((localFailures ? 'FAIL  ' : 'ok    ') + label + '  pages=' + Object.keys(pageMap).length + '  violations=' + localFailures);
  failures += localFailures;
}

/* ── rule 2: template geometry, also fail closed ───────────────────────────── */

if (withTemplate) {
  for (const file of files) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const label = (doc.config && doc.config.label) || relative(ROOT, file);
    const shape = (doc.config && doc.config.template) || {};
    const missing = ['headerHeight', 'firstBlockY', 'controlRow'].filter((k) => !(k in shape));
    if (missing.length) {
      console.log('FAIL  template-unmeasured  ' + label + '  missing: ' + missing.join(', '));
      failures += 1;
      continue;
    }
    if (shape.headerHeight !== 80) {
      console.log('FAIL  header-height  ' + label + '  ' + shape.headerHeight + ' != 80');
      failures += 1;
    }
    if (shape.firstBlockY !== 160) {
      console.log('FAIL  first-block-y  ' + label + '  ' + shape.firstBlockY + ' != 160');
      failures += 1;
    }
    for (const row of shape.controlRow || []) {
      const heights = [...new Set(row.heights)];
      if (heights.length > 1) {
        console.log('FAIL  control-row-mixed  ' + label + '  ' + row.selector + ' -> ' + heights.join('/'));
        failures += 1;
      }
    }
  }
}

console.log('');
const fired = CODES.filter((code) => tally[code] > 0);
console.log('  by assertion: ' + (fired.length ? fired.map((code) => code + ' ' + tally[code]).join(' | ') : 'none fired'));
console.log(failures === 0
  ? 'check-ui-metrics: PASS (' + pages + ' page measurements, 9 §4.2 assertions each)'
  : 'check-ui-metrics: FAIL (' + failures + ' violation(s) across ' + pages + ' page measurements)');
process.exit(failures === 0 ? 0 : 1);
