#!/usr/bin/env node
/**
 * The workflow surface checker, tested against the mistakes it exists to catch.
 *
 * Every case below is a mutation that LOOKS reasonable in review and changes
 * what CI guarantees. The point of the file is that each one is reported - a
 * checker whose counterfactuals pass is a checker that licenses the refactor it
 * was meant to gate.
 *
 * Two defects in earlier versions are pinned here as cases:
 *
 *   - a `paths:` list was truncated at the first comment (`g12-acceptance.yml`
 *     reported 6 of its 28 entries);
 *   - a step written `- name:` then `run:` was invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotWorkflow, compare, normaliseTriggers, stepDigest }
  from './workflow-snapshot.mjs';
import { parse } from './lib/workflow-yaml.mjs';

const BASE = `name: ci
on:
  pull_request:
    paths:
      - 'apps/**'
      # a comment in the middle of the list
      - 'docs/**'
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: verify
        run: |
          set -euo pipefail
          node check.mjs
  gate:
    needs: [build]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo gate
`;

const snap = (text) => ({ 'ci.yml': snapshotWorkflow(text) });
const diff = (mutated) => compare(snap(BASE), snap(mutated));

// ---- the parser ------------------------------------------------------------

test('a comment inside a paths list does not truncate it', () => {
  // Measured: g12-acceptance.yml reported 6 trigger paths; it has 28.
  const s = snapshotWorkflow(BASE);
  assert.deepEqual(s.triggers.pull_request.paths, ['apps/**', 'docs/**']);
});

test('on is a key, not the YAML 1.1 boolean true', () => {
  const r = parse(BASE);
  assert.equal(r.ok, true);
  assert.ok('on' in r.value, 'on must survive as a key');
  assert.ok(!('true' in r.value), 'on must not become true');
});

test('a construct outside the subset is REFUSED, not silently dropped', () => {
  const r = parse('a: &anchor 1\nb: *anchor\n');
  assert.equal(r.ok, false, 'anchors are not in the subset and must be refused');
  const s = snapshotWorkflow('a: &anchor 1\n');
  assert.ok(s.unparsed, 'a refused parse must be reported as unparsed, never as an empty surface');
});

test('an unparsed workflow makes comparison refuse', () => {
  const d = compare(snap(BASE), snap('a: &x 1\n'));
  assert.ok(d.some((x) => /UNPARSED/.test(x)), JSON.stringify(d));
});

// ---- 12 mutations ----------------------------------------------------------

test('01 a removed required job is reported', () => {
  const d = diff(BASE.replace(/  gate:\n(?:.*\n)*$/, ''));
  assert.ok(d.some((x) => /gate: job REMOVED/.test(x)), JSON.stringify(d));
});

test('02 a removed need is reported', () => {
  const d = diff(BASE.replace('    needs: [build]\n', ''));
  assert.ok(d.some((x) => /gate: needs changed/.test(x)), JSON.stringify(d));
});

test('03 a changed timeout is reported', () => {
  const d = diff(BASE.replace('timeout-minutes: 20', 'timeout-minutes: 60'));
  assert.ok(d.some((x) => /build: timeout changed/.test(x)), JSON.stringify(d));
});

test('04 a widened permission is reported', () => {
  const d = diff(BASE.replace('      contents: read\n    steps:', '      contents: write\n    steps:'));
  assert.ok(d.some((x) => /permissions changed/.test(x)), JSON.stringify(d));
});

test('05 a changed concurrency group is reported', () => {
  const d = diff(BASE.replace('cancel-in-progress: true', 'cancel-in-progress: false'));
  assert.ok(d.some((x) => /concurrency changed/.test(x)), JSON.stringify(d));
});

test('06 a removed step is reported', () => {
  const d = diff(BASE.replace('      - uses: actions/checkout@v4\n', ''));
  assert.ok(d.some((x) => /step count/.test(x)), JSON.stringify(d));
});

test('07 a changed multi-line shell body is reported', () => {
  // The whole reason the snapshot stores a digest: `set -euo pipefail` removed
  // is one line, and the step still looks the same in review.
  const d = diff(BASE.replace('set -euo pipefail', ''));
  assert.ok(d.some((x) => /SHELL BODY changed/.test(x)), JSON.stringify(d));
});

test('07b adding || true to a command is reported', () => {
  const d = diff(BASE.replace('node check.mjs', 'node check.mjs || true'));
  assert.ok(d.some((x) => /SHELL BODY changed/.test(x)), JSON.stringify(d));
});

test('07c removing an explicit non-zero exit is reported, and so is its shape', () => {
  // A gate step that used to `exit 1` on failure and no longer does still looks
  // like the same step. The digest catches it; the shape flags say WHY.
  const withExit = BASE.replace('          node check.mjs', '          node check.mjs || exit 1');
  const d = compare(snap(withExit), snap(BASE));
  assert.ok(d.some((x) => /SHELL BODY changed/.test(x)), JSON.stringify(d));
  assert.ok(d.some((x) => /exitNonZero true -> false/.test(x)), `expected the flag delta, got ${JSON.stringify(d)}`);
});

test('08 a removed path filter is reported', () => {
  const d = diff(BASE.replace("      - 'docs/**'\n", ''));
  assert.ok(d.some((x) => /triggers changed/.test(x)), JSON.stringify(d));
});

test('09 a changed workflow_dispatch input is reported', () => {
  const withDispatch = BASE.replace('on:\n', 'on:\n  workflow_dispatch:\n    inputs:\n      sha:\n        description: target\n');
  const s = snap(withDispatch);
  assert.ok(s['ci.yml'].triggers.workflow_dispatch, 'the input block must be seen at all');
  const d = compare(snap(BASE), s);
  assert.ok(d.some((x) => /triggers changed/.test(x)), JSON.stringify(d));
});

test('10 adding continue-on-error is reported', () => {
  const d = diff(BASE.replace('      - run: echo gate', '      - run: echo gate\n        continue-on-error: true'));
  assert.ok(d.some((x) => /step \(.*\) changed/.test(x)), JSON.stringify(d));
});

test('11 a changed upload-artifact step is reported', () => {
  const withUpload = BASE.replace('      - run: echo gate',
    '      - uses: actions/upload-artifact@v4\n        with:\n          name: out\n          path: a.txt');
  const without = withUpload.replace('path: a.txt', 'path: b.txt');
  const d = compare(snap(withUpload), snap(without));
  assert.ok(d.some((x) => /step \(.*\) changed/.test(x)), JSON.stringify(d));
});

test('12 fail-closed becoming fail-open is reported', () => {
  // `if: always()` -> `if: success()`, or a gate step gaining a `|| true`. The
  // second is a shell-body change; the first is a job `if`.
  const d = diff(BASE.replace('    timeout-minutes: 5', '    if: always()\n    timeout-minutes: 5'));
  assert.ok(d.some((x) => /gate: if changed/.test(x)), JSON.stringify(d));
});

test('13 a step that starts with a name is not invisible', () => {
  // Measured: folding a step into a job left the parser reporting the original
  // step count, so the change went unreported.
  const d = diff(BASE.replace('      - run: echo gate', '      - name: named\n        run: echo gate'));
  assert.ok(d.length > 0, 'a named step must be seen');
});

// ---- the digest ------------------------------------------------------------

test('the digest notices every byte and reveals no content', () => {
  const a = stepDigest('echo "$DEPLOY_TOKEN"\nssh root@10.0.0.1 deploy');
  const b = stepDigest('echo "$DEPLOY_TOKEN"\nssh root@10.0.0.2 deploy');
  assert.notEqual(a.runDigest, b.runDigest, 'a changed host must change the digest');
  const serialised = JSON.stringify(a);
  assert.ok(!serialised.includes('DEPLOY_TOKEN'), 'no command text may reach the snapshot');
  assert.ok(!serialised.includes('10.0.0.1'), 'no host may reach the snapshot');
  assert.equal(a.shape.ssh, true, 'but the shape must say an ssh command is present');
});

test('an identical tree compares clean', () => {
  assert.deepEqual(compare(snap(BASE), snap(BASE)), []);
});

// ---- triggers --------------------------------------------------------------

test('paths-ignore and branches are captured', () => {
  const t = normaliseTriggers({ push: { 'paths-ignore': ['docs/**'], branches: ['main'] } });
  assert.deepEqual(t.push['paths-ignore'], ['docs/**']);
  assert.deepEqual(t.push.branches, ['main']);
});

test('an inline trigger array is understood', () => {
  assert.deepEqual(Object.keys(normaliseTriggers(['push', 'pull_request'])).sort(), ['pull_request', 'push']);
});
