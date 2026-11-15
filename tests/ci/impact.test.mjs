#!/usr/bin/env node
/**
 * Counterfactuals for the impact analyzer.
 *
 * The analyzer decides which CI suites a change requires. A decision table that
 * is only ever asserted on its happy path is the same trap this repository has
 * hit repeatedly: a suite that passes because it was never asked a hard question.
 * Each case below is a scenario from the task brief, and each expectation is a
 * fact about what must NOT be skippable.
 *
 * Run: node --test tests/ci/impact.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, SUITES } from './impact.mjs';

/** Suites the decision turned on. */
function on(files) {
  return SUITES.filter((s) => analyse(files).suites[s]);
}

test('A low-risk documentation change runs no acceptance suite', () => {
  assert.deepEqual(on(['docs/adr/ADR-023.md']), []);
  assert.deepEqual(on(['README.md']), []);
  assert.deepEqual(on(['docs/ci/baseline.md', 'rules/03-security.md']), []);
});

test('BUT the gate still exists: a docs change is ignored, not unmapped', () => {
  // "ignored" and "unmapped" both produce no suites here, and they are not the
  // same fact. Ignored is a deliberate exclusion; unmapped means the table has a
  // hole and everything gets requested. Conflating them would let a new
  // top-level directory become silently untested.
  const d = analyse(['docs/adr/ADR-023.md']);
  assert.equal(d.ignored.length, 1);
  assert.equal(d.unmatched.length, 0);
});

test('B a kernel gateway change reaches the gateway acceptance', () => {
  const suites = on(['apps/kernel/src/gateway.rs']);
  for (const required of ['rust', 'data-foundation', 'linux-runtime', 'g12-acceptance']) {
    assert.ok(suites.includes(required), `${required} must run for a gateway change`);
  }
});

test('B a capabilities change reaches conformance and lifecycle', () => {
  const suites = on(['apps/kernel/src/capabilities.rs']);
  for (const required of ['runtime-conformance', 'plugin-lifecycle']) {
    assert.ok(suites.includes(required), `${required} must run for a capabilities change`);
  }
});

test('C a node runtime change reaches the native linux suite', () => {
  const suites = on(['apps/node/src/runtime.rs']);
  assert.ok(suites.includes('linux-runtime'));
  assert.ok(suites.includes('data-foundation'));
});

test('D a contract change reaches the cross-language conformance', () => {
  const suites = on(['contracts/examples/pipeline-definition.json']);
  assert.ok(suites.includes('contracts'));
  assert.ok(suites.includes('runtime-conformance'));
});

test('E a plugin change reaches lifecycle and conformance', () => {
  const suites = on(['plugins/hello-go/main.go']);
  assert.ok(suites.includes('plugin-lifecycle'));
  assert.ok(suites.includes('runtime-conformance'));
});

test('F a web change reaches browser acceptance and the unit suites', () => {
  for (const file of ['apps/platform-console/src/App.tsx', 'apps/ops-web/src/main.tsx', 'packages/ui/src/button.tsx']) {
    const suites = on([file]);
    assert.ok(suites.includes('web'), `${file} must run web`);
    assert.ok(suites.includes('web-unit'), `${file} must run web-unit`);
  }
});

test('G the test harness itself is treated as high risk', () => {
  // The 42-step harness is not covered by any assertion that reads it, so a
  // change to it has to run the things it drives.
  const suites = on(['tests/ci/data_foundation_ci.sh']);
  assert.ok(suites.includes('data-foundation'));
  assert.ok(suites.includes('linux-runtime'));
});

test('H the coverage checker changing runs the coverage checker', () => {
  assert.ok(on(['tests/ci/check-spec-coverage.mjs']).includes('spec-coverage'));
});

test('I a lock file takes every language with it', () => {
  assert.ok(on(['Cargo.lock']).includes('rust'));
  assert.ok(on(['pnpm-lock.yaml']).includes('web'));
  assert.ok(on(['pnpm-lock.yaml']).includes('browser-e2e'));
});

test('J editing a workflow runs at least one gate', () => {
  // Otherwise "fix the CI" would be the one change CI does not check.
  assert.ok(on(['.github/workflows/ci.yml']).length > 0);
});

test('K an unmapped path fails closed: everything runs', () => {
  const d = analyse(['some/new/top-level/thing.bin']);
  assert.deepEqual(d.unmatched, ['some/new/top-level/thing.bin']);
  for (const suite of SUITES) {
    assert.equal(d.suites[suite], true, `${suite} must run when a path is unmapped`);
  }
});

test('L one unmapped file among mapped ones still fails closed', () => {
  const d = analyse(['apps/node/src/runtime.rs', 'brand-new-dir/x.rs']);
  assert.equal(d.unmatched.length, 1);
  for (const suite of SUITES) assert.equal(d.suites[suite], true);
});

test('M rules ADD: a high-risk file does not lose the suites its directory asked for', () => {
  // apps/kernel/src/gateway.rs matches both `apps/kernel/**` and its own rule.
  // If matching short-circuited on the first hit, the gateway acceptance would be
  // the only thing requested and rust/data-foundation would be lost.
  const suites = on(['apps/kernel/src/gateway.rs']);
  assert.ok(suites.includes('rust'), 'the directory rule must still contribute');
  assert.ok(suites.includes('g12-acceptance'), 'the specific rule must contribute too');
});

test('N every suite in the vocabulary is reachable by some path', () => {
  // A suite nobody can request is either dead vocabulary or a missing rule.
  const reachable = new Set();
  for (const file of [
    'apps/kernel/src/gateway.rs', 'apps/kernel/src/capabilities.rs', 'apps/node/src/runtime.rs',
    'apps/pipeline-worker/src/main.rs', 'apps/opsctl/src/main.rs', 'crates/x/src/lib.rs',
    'contracts/x.json', 'apps/platform-console/src/a.tsx', 'apps/ops-web/src/a.tsx',
    'packages/ui/src/a.tsx', 'tests/ui/a.spec.ts', 'plugins/x/main.go', 'tests/ci/a.sh',
    'tests/acceptance/a.sh', 'tests/runtime/a.py', 'tests/contract/a.py',
    'tests/reliability/a.sh', 'scripts/a.sh', 'deployments/linux/a.service',
    'Cargo.lock', 'pnpm-lock.yaml', '.github/workflows/ci.yml',
  ]) {
    for (const suite of on([file])) reachable.add(suite);
  }
  const missing = SUITES.filter((s) => !reachable.has(s));
  assert.deepEqual(missing, [], `unreachable suites: ${missing.join(', ')}`);
});
