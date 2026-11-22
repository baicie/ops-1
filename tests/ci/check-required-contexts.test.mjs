#!/usr/bin/env node
/**
 * The required-contexts guard's counterfactuals.
 *
 * `check-required-contexts.mjs` reports zero problems on this repository today.
 * That is only meaningful if it CAN report a problem, so every case below is a
 * mutation that would make a required context disappear from a pull request and
 * leave it permanently unmergeable:
 *
 *   Expected - Waiting for status to be reported
 *
 * There is no timeout and no override for that state. The guard's value is that
 * the migration's precondition is checked before the ruleset is written, not
 * discovered by the first PR that cannot merge.
 *
 * Run: node --test tests/ci/check-required-contexts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRequiredContexts, producerWorkflowOf, inspectProducerHealth }
  from './check-required-contexts.mjs';
import { parse } from './lib/workflow-yaml.mjs';

const WF = (text) => parse(text).value;

/** A workflow that satisfies every context this repository needs, per file. */
function baseline() {
  return new Map([
    ['ci.yml', WF(`on:
  pull_request:
jobs:
  rust:
    runs-on: ubuntu-latest
  web:
    runs-on: ubuntu-latest
  web-unit:
    runs-on: ubuntu-latest
  contracts:
    runs-on: ubuntu-latest
  spec-coverage:
    runs-on: ubuntu-latest
  platform-only:
    runs-on: ubuntu-latest
  platform-image-build:
    runs-on: ubuntu-latest
  ci-gate:
    if: always()
    runs-on: ubuntu-latest
`)],
    ['reliability.yml', WF(`on:
  pull_request:
jobs:
  quality-faults:
    runs-on: ubuntu-latest
`)],
    ['platform-linux-acceptance.yml', WF(`on:
  pull_request:
jobs:
  linux-runtime:
    runs-on: ubuntu-latest
`)],
  ]);
}

test('the baseline itself is clean, so a failure below is the mutation', () => {
  assert.deepEqual(inspectRequiredContexts({ workflows: baseline() }), []);
});

test('every context resolves to a workflow', () => {
  assert.equal(producerWorkflowOf('rust'), 'ci.yml');
  assert.equal(producerWorkflowOf('ci-gate'), 'ci.yml',
    'ci-gate is not in JOB_TO_SUITE but is still produced by ci.yml');
  assert.equal(producerWorkflowOf('quality-faults'), 'reliability.yml');
  assert.equal(producerWorkflowOf('linux-runtime'), 'platform-linux-acceptance.yml');
  assert.equal(producerWorkflowOf('not-a-check'), null);
});

test('a PATH-FILTERED workflow is refused: the context would not appear', () => {
  const wf = baseline();
  wf.set('reliability.yml', WF(`on:
  pull_request:
    paths:
      - 'tests/reliability/**'
jobs:
  quality-faults:
    runs-on: ubuntu-latest
`));
  const problems = inspectRequiredContexts({ workflows: wf });
  assert.ok(problems.some((p) => /quality-faults/.test(p) && /paths/.test(p)),
    JSON.stringify(problems));
});

test('a workflow with NO pull_request trigger is refused', () => {
  const wf = baseline();
  wf.set('platform-linux-acceptance.yml', WF(`on:
  push:
    branches: [main]
jobs:
  linux-runtime:
    runs-on: ubuntu-latest
`));
  const problems = inspectRequiredContexts({ workflows: wf });
  assert.ok(problems.some((p) => /linux-runtime/.test(p) && /no pull_request/.test(p)),
    JSON.stringify(problems));
});

test('a job guarded by a CONDITIONAL if: is refused', () => {
  // The classic shape: a scope job decides whether the heavy job runs. A required
  // check that is skipped is not a pass, and GitHub reports the PR as waiting.
  const wf = baseline();
  wf.set('ci.yml', WF(`on:
  pull_request:
jobs:
  rust:
    if: needs.scope.outputs.rust == 'true'
    runs-on: ubuntu-latest
`));
  const problems = inspectRequiredContexts({ workflows: wf });
  assert.ok(problems.some((p) => /"rust"/.test(p) && /if:/.test(p)),
    JSON.stringify(problems));
});

test('if: always() is ACCEPTED - it is what keeps a required context alive', () => {
  // `always()` makes the job run even when its `needs:` failed, which is exactly
  // the property a required check needs. Refusing it would push people toward
  // removing the condition and quietly reintroducing skips.
  const wf = baseline();
  assert.deepEqual(inspectRequiredContexts({ workflows: wf }), []);
  assert.ok(/always/.test(String(wf.get('ci.yml').jobs['ci-gate'].if)));
});

test('a DELETED job is refused: the context has no producer', () => {
  const wf = baseline();
  wf.set('ci.yml', WF(`on:
  pull_request:
jobs:
  ci-gate:
    if: always()
    runs-on: ubuntu-latest
`));
  const problems = inspectRequiredContexts({ workflows: wf });
  // Every ci.yml context except ci-gate is now missing.
  for (const name of ['rust', 'web', 'web-unit', 'contracts', 'spec-coverage',
    'platform-only', 'platform-image-build']) {
    assert.ok(problems.some((p) => p.includes(`"${name}"`) && /no job/.test(p)),
      `${name} was deleted but not reported: ${JSON.stringify(problems)}`);
  }
});

test('a MATRIX job is refused: its check name carries the values', () => {
  const wf = baseline();
  wf.set('ci.yml', WF(`on:
  pull_request:
jobs:
  rust:
    strategy:
      matrix:
        os: [ubuntu, macos]
    runs-on: ubuntu-latest
  web:
    runs-on: ubuntu-latest
  web-unit:
    runs-on: ubuntu-latest
  contracts:
    runs-on: ubuntu-latest
  spec-coverage:
    runs-on: ubuntu-latest
  platform-only:
    runs-on: ubuntu-latest
  platform-image-build:
    runs-on: ubuntu-latest
  ci-gate:
    if: always()
    runs-on: ubuntu-latest
`));
  const problems = inspectRequiredContexts({ workflows: wf });
  assert.ok(problems.some((p) => /"rust"/.test(p) && /MATRIX/.test(p)),
    `a matrix job would report "rust (ubuntu)" not "rust": ${JSON.stringify(problems)}`);
});

test('a job whose display name is the context satisfies it', () => {
  // `full TypeScript lifecycle` is a job NAMED that, with a different id. The
  // lookup has to accept the reported name, not only the id.
  const wf = baseline();
  wf.set('ci.yml', WF(`on:
  pull_request:
jobs:
  rust:
    runs-on: ubuntu-latest
  web:
    runs-on: ubuntu-latest
  web-unit:
    runs-on: ubuntu-latest
  contracts:
    runs-on: ubuntu-latest
  spec-coverage:
    runs-on: ubuntu-latest
  platform-only:
    runs-on: ubuntu-latest
  platform-image-build:
    runs-on: ubuntu-latest
  gate:
    name: ci-gate
    if: always()
    runs-on: ubuntu-latest
`));
  assert.deepEqual(inspectRequiredContexts({ workflows: wf }), [],
    'a job id of "gate" with name: ci-gate reports the required context');
});

// --- producer health: the half a static read cannot see ----------------------
//
// Every property `inspectRequiredContexts` checks is a property of the FILE. All of
// them can hold while the workflow is DISABLED in repository settings, and a
// disabled workflow produces no check runs - so a required context never appears
// and every pull request waits on it for ever.

test('a DISABLED producer is reported, naming the context it costs', () => {
  const problems = inspectProducerHealth({
    contexts: ['rust', 'linux-runtime'],
    producerOf: (c) => (c === 'rust' ? 'ci.yml' : 'platform-linux-acceptance.yml'),
    workflows: [
      { path: '.github/workflows/ci.yml', state: 'active' },
      { path: '.github/workflows/platform-linux-acceptance.yml', state: 'disabled_manually' },
    ],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /platform-linux-acceptance\.yml is disabled_manually/);
  assert.match(problems[0], /waits on it for ever/);
});

test('disabled_inactivity is reported too: the reason does not change the effect', () => {
  const problems = inspectProducerHealth({
    contexts: ['quality-faults'],
    producerOf: () => 'reliability.yml',
    workflows: [{ path: '.github/workflows/reliability.yml', state: 'disabled_inactivity' }],
  });
  assert.ok(problems.some((p) => /disabled_inactivity/.test(p)), JSON.stringify(problems));
});

test('a producer the API does not list at all is reported', () => {
  // A workflow file that exists in the tree but not in the API is a file GitHub
  // has not registered - so it cannot run.
  const problems = inspectProducerHealth({
    contexts: ['rust'],
    producerOf: () => 'ci.yml',
    workflows: [],
  });
  assert.ok(problems.some((p) => /does not list it as a workflow at all/.test(p)), JSON.stringify(problems));
});

test('every producer active is clean', () => {
  assert.deepEqual(inspectProducerHealth({
    contexts: ['rust', 'quality-faults'],
    producerOf: (c) => (c === 'rust' ? 'ci.yml' : 'reliability.yml'),
    workflows: [
      { path: '.github/workflows/ci.yml', state: 'active' },
      { path: '.github/workflows/reliability.yml', state: 'active' },
    ],
  }), []);
});

test('a context with no producer is reported rather than skipped', () => {
  const problems = inspectProducerHealth({ contexts: ['ghost'], producerOf: () => null, workflows: [] });
  assert.ok(problems.some((p) => /no known producer/.test(p)));
});

test('a producer shared by two contexts is reported once, not twice', () => {
  const problems = inspectProducerHealth({
    contexts: ['rust', 'web'],
    producerOf: () => 'ci.yml',
    workflows: [{ path: '.github/workflows/ci.yml', state: 'disabled_manually' }],
  });
  assert.equal(problems.length, 1, 'one disabled workflow is one problem');
});
