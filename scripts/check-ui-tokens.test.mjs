import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/**
 * Regression tests for the gap that let two spacing budgets sit in ui-debt.json from #15
 * onward while no script ever emitted their rule names.
 *
 * `spacing-off-scale` was budgeted at 108 and read by nothing: the gate printed six rules, the
 * debt file listed eight, and the two extra keys could never fail. That is worse than an
 * unguarded number, because a budget line reads as evidence of a gate. The rule now exists;
 * these tests hold the properties that keep it from going vacuous again:
 *
 *   - an off-scale literal in CSS or in a Tailwind arbitrary value fails the run;
 *   - an on-scale literal stays legal, because code-rules B6 allows the 4/8/12/16/24/32 scale;
 *   - a budget key no rule emits is an error, not a silent zero;
 *   - a stylesheet that matches zero spacing declarations fails instead of passing.
 *
 * Every case runs the gate against a COPY of the tree in the OS temp directory (`--root`). The
 * gate never touches the working tree, so a killed run cannot leave a mutated stylesheet behind
 * and two gates running at once cannot read each other's edits.
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'check-ui-tokens.mjs');
const BUDGET = join(ROOT, 'docs', 'design', 'ui-visual-v3', 'spec', 'ui-debt.json');
// The gate reads these four roots and nothing else.
const COPIED = ['packages/ui/src', 'packages/platform-client/src', 'apps/platform-console/src', 'apps/ops-web/src'];

/** A throwaway tree with the scanned sources and the script itself. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ow-tokens-'));
  cpSync(SCRIPT, join(dir, 'scripts', 'check-ui-tokens.mjs'), { recursive: true });
  for (const rel of COPIED) cpSync(join(ROOT, rel), join(dir, rel), { recursive: true });
  return dir;
}

const run = (dir, args) =>
  spawnSync(process.execPath, [join(dir, 'scripts', 'check-ui-tokens.mjs'), '--root', dir, ...args], {
    encoding: 'utf8',
  });

const stylesOf = (dir) => join(dir, 'packages', 'ui', 'src', 'styles.css');
const appendCss = (dir, rule) => writeFileSync(stylesOf(dir), readFileSync(stylesOf(dir), 'utf8') + '\n' + rule + '\n');

test('the committed budget only names rules the gate emits', () => {
  const dir = fixture();
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /spacing-off-scale\s+\d+\s+budget \d+/);
});

test('an off-scale spacing literal in CSS fails the run', () => {
  const dir = fixture();
  appendCss(dir, '.probe-off-scale { padding: 17px; }');
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 1, '17px is on no scale step, so the gate must fail');
  assert.match(result.stdout, /spacing-off-scale/);
  assert.match(result.stdout, /probe-off-scale|padding: 17px/);
});

test('an on-scale spacing literal stays legal, because B6 allows the scale', () => {
  const dir = fixture();
  appendCss(dir, '.probe-on-scale { padding: 16px; }');
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 0, 'code-rules B6 permits 4/8/12/16/24/32 without a token');
});

test('a var() spacing declaration is the good state, not a literal', () => {
  const dir = fixture();
  appendCss(dir, '.probe-token { padding: var(--ow-space-4); gap: var(--ow-space-2) var(--ow-space-3); }');
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 0, 'token-backed spacing must never be counted as an off-scale literal');
});

test('an off-scale Tailwind arbitrary value fails the run', () => {
  const dir = fixture();
  const page = join(dir, 'apps', 'ops-web', 'src', 'Probe.tsx');
  writeFileSync(page, 'export function Probe() { return <div className="mt-[19px]" />; }\n');
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 1, 'mt-[19px] is a raw value no token and no scale step backs');
  assert.match(result.stdout, /Probe\.tsx/);
  assert.match(result.stdout, /mt-\[19px\]/);
});

test('a budget key no rule emits is an error, not a silent zero', () => {
  const dir = fixture();
  const stale = join(dir, 'stale-debt.json');
  writeFileSync(stale, JSON.stringify({ 'radius-tier': 0, 'spacing-token-literal': 52 }));
  const result = run(dir, ['--ratchet', stale]);
  assert.equal(result.status, 2, 'an unimplemented rule must stop the gate, not print ok');
  assert.match(result.stderr, /never emitted/);
  assert.match(result.stderr, /spacing-token-literal/);
});

test('a stylesheet with no spacing declarations fails instead of passing', () => {
  const dir = fixture();
  const css = readFileSync(stylesOf(dir), 'utf8');
  // Rename every spacing property so the rule's selector matches nothing.
  writeFileSync(stylesOf(dir), css.replace(/\b(padding|margin|gap|row-gap|column-gap)\b(?=\s*[:\-])/g, 'x$1'));
  const result = run(dir, ['--ratchet', BUDGET]);
  assert.equal(result.status, 2, 'zero scanned declarations means the rule stopped reading, not that the CSS is clean');
  assert.match(result.stderr, /scanned 0 spacing declarations/);
});

test('the gate reports its scan volume', () => {
  const dir = fixture();
  const result = run(dir, ['--ratchet', BUDGET]);
  const m = result.stdout.match(/scanned: (\d+) TSX files, (\d+) spacing declarations/);
  assert.ok(m, 'a pass must print what it read, or green cannot be told from empty');
  assert.ok(Number(m[1]) > 50, 'the TSX sweep must cover both applications, not one');
  assert.ok(Number(m[2]) > 500, 'the CSS sweep must read the whole stylesheet');
});
