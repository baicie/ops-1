#!/usr/bin/env node
/**
 * check-ui-metrics.mjs - the geometry half of the UI spec gate.
 *
 * Reads the _metrics_*.json files the audit harness writes and fails on the numbers a human
 * review cannot check by eye. The rule that matters: a page with no measurement is a FAIL,
 * not a pass - artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json recorded 223px of
 * horizontal overflow on /admin/jobs/{id} and shipped anyway, because nothing read it.
 *
 *   node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ROOT = process.cwd();

function expand(list) {
  const out = [];
  for (const item of list) {
    const p = resolve(item);
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

let failures = 0;
let pages = 0;
for (const file of expand(inputs)) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const label = (doc.config && doc.config.label) || relative(ROOT, file);
  const pageMap = doc.pages || {};
  let localFailures = 0;
  for (const [route, m] of Object.entries(pageMap)) {
    if (!m || typeof m !== 'object' || m.error) continue;
    pages += 1;
    if (typeof m.overflow !== 'number') {
      console.log('FAIL  overflow-unmeasured  ' + label + '  ' + route);
      localFailures += 1;
      continue;
    }
    if (m.overflow > 0) {
      const worst = (m.offenders || [])[0];
      const who = worst ? ' worst: <' + worst.tag + '> ' + (worst.cls || '') + ' right=' + worst.right : '';
      console.log('FAIL  overflow>0  ' + label + '  ' + route + '  +' + m.overflow + 'px' + who);
      localFailures += 1;
    }
  }
  console.log((localFailures ? 'FAIL  ' : 'ok    ') + label + '  pages=' + Object.keys(pageMap).length + '  violations=' + localFailures);
  failures += localFailures;
}

// rule 2 - template geometry: fail closed when the measurement is absent ---------
if (process.argv.includes('--template')) {
  for (const file of expand(inputs)) {
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
console.log(failures === 0
  ? 'check-ui-metrics: PASS (' + pages + ' page measurements, no horizontal overflow)'
  : 'check-ui-metrics: FAIL (' + failures + ' violation(s) across ' + pages + ' page measurements)');
process.exit(failures === 0 ? 0 : 1);
