#!/usr/bin/env node
/**
 * The PASSES this gate used to hand out, and the mutations it must now refuse.
 *
 * Every case here was measured against the code as it was, not imagined. The three
 * that matter were found by driving the REAL `gate()` - not `delegatedVerdict` in
 * isolation - because the defect lived in how the two functions compose:
 *
 *   1. `browser-e2e` tested `green.length` before it looked at `red`, so on a
 *      `packages/**` change with `acceptance` RED and `golden-path` green it
 *      reported "delegated-verified: browser-e2e (golden-path)" and passed. A red
 *      required check, reported as a pass, in the gate whose entire job is to not
 *      do that.
 *
 *   2. Deleting the `acceptance` job left the same case passing. Absence is
 *      indistinguishable from "its paths did not match" at run time, so no runtime
 *      change can close it - `check-gate-contract.mjs` does, by refusing a table
 *      that names a job the workflow does not have.
 *
 *   3. A red check from a workflow WITH a path filter, for a change the analyzer
 *      did not require, was attributed nowhere: PART 3 opened by skipping every
 *      name in `DELEGATED_CHECK_OWNERS`, which is the set of names it exists to
 *      attribute.
 *
 * Run: node --test tests/ci/ci-gate.attribution.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gate, delegatedVerdict, delegatedOutcomeVerdict, JOB_TO_SUITE, REQUIRE_ANY_CHECK,
} from './ci-gate.mjs';
import { inspectContract } from './check-gate-contract.mjs';
import { parse } from './lib/workflow-yaml.mjs';

/** Every ci.yml job green, so only the delegated half is under test. */
const ALL_GREEN = Object.fromEntries(Object.keys(JOB_TO_SUITE).map((j) => [j, 'success']));

/** A check-run ledger the way `attributeChecks` produces one. */
function ledger(entries) {
  const byName = {};
  for (const [name, workflow, state] of entries) {
    (byName[name] ??= []).push({ name, workflow, state, conclusion: state, status: 'completed' });
  }
  return { byName, unattributed: [], duplicates: [], suites: {} };
}

/** `gate()` followed by the delegated judgement `main()` performs. */
function decide(entries, requiredSuites) {
  const impact = { suites: Object.fromEntries(
    ['rust', 'web', 'web-unit', 'contracts', 'spec-coverage', 'platform-only',
      'platform-image-build', 'quality-faults', 'linux-runtime', 'plugin-lifecycle',
      'runtime-conformance', 'data-foundation', 'browser-e2e', 'g12-acceptance',
    ].map((s) => [s, requiredSuites.includes(s)])), unmatched: [] };
  const l = ledger(entries);
  const result = gate(ALL_GREEN, impact, l);
  const requiredDelegated = result.delegated
    .map((line) => line.split(' ')[0])
    .filter((s) => s in { 'browser-e2e': 1, 'g12-acceptance': 1, 'data-foundation': 1 });
  const del = delegatedVerdict(l, requiredDelegated);
  const delegated = delegatedOutcomeVerdict(del, { waited: true });
  return {
    verdict: result.verdict === 'PASS' && delegated === 'PASS' ? 'PASS' : 'FAIL',
    failed: result.failed,
    delegatedFailed: del.failed,
    delegatedVerified: del.verified,
  };
}

// --- 1. a red alternative is never excused by a green one --------------------

test('an alternative that RAN AND FAILED is not excused by a green one', () => {
  // Measured before the fix: PASS, verified=["browser-e2e (golden-path)"].
  const r = decide([
    ['acceptance', 'g12-acceptance.yml', 'failure'],
    ['golden-path', 'data-foundation.yml', 'success'],
  ], ['browser-e2e']);
  assert.equal(r.verdict, 'FAIL', 'a red check reported as a pass is the defect this file exists for');
  assert.match(r.delegatedFailed.join(' '), /acceptance/);
});

test('an alternative that never ran does not fail a suite that has a green check', () => {
  // The disjoint-inputs case the ANY rule exists for: a tests/ui change starts
  // data-foundation and not g12-acceptance. Absence here is not a failure.
  const r = decide([['golden-path', 'data-foundation.yml', 'success']], ['browser-e2e']);
  assert.equal(r.verdict, 'PASS');
});

test('both alternatives green is a pass', () => {
  const r = decide([
    ['acceptance', 'g12-acceptance.yml', 'success'],
    ['golden-path', 'data-foundation.yml', 'success'],
  ], ['browser-e2e']);
  assert.equal(r.verdict, 'PASS');
});

test('a red check from an impostor workflow does not satisfy the alternative rule', () => {
  // `acceptance` is owned by g12-acceptance.yml. The same NAME from another
  // workflow must not be read as that check at all - neither as the green that
  // satisfies the suite nor as its red.
  const r = decide([
    ['acceptance', 'some-other.yml', 'success'],
    ['acceptance', 'g12-acceptance.yml', 'failure'],
  ], ['browser-e2e']);
  assert.equal(r.verdict, 'FAIL');
});

test('the ANY set is small and named, not a general escape from the ALL rule', () => {
  assert.deepEqual([...REQUIRE_ANY_CHECK], ['browser-e2e']);
});

// --- 2. a facet suite still needs every facet --------------------------------

test('data-foundation is a FACET suite: a green golden-path does not cover a red legacy-regression', () => {
  const r = decide([
    ['golden-path', 'data-foundation.yml', 'success'],
    ['legacy-regression', 'data-foundation.yml', 'failure'],
  ], ['data-foundation']);
  assert.equal(r.verdict, 'FAIL');
});

test('data-foundation: a MISSING facet is absent, which fails', () => {
  const r = decide([['golden-path', 'data-foundation.yml', 'success']], ['data-foundation']);
  assert.equal(r.verdict, 'FAIL');
});

// --- 3. PART 3 attribution ---------------------------------------------------

test('a red check from a PATH-FILTERED delegated workflow blocks, even when not required', () => {
  // `acceptance` lives in g12-acceptance.yml, which has a pull_request.paths
  // filter - it ran because the filters said this change is its business. Before
  // the fix this was reported nowhere: PART 3 skipped the name, and the analyzer
  // had not required the suite.
  const r = decide([['acceptance', 'g12-acceptance.yml', 'failure']], []);
  assert.equal(r.verdict, 'FAIL', `a red merge-gate check went unattributed; failed=${JSON.stringify(r.failed)}`);
});

test('a red check from an UNFILTERED delegated workflow does not block a change that did not require it', () => {
  // `linux-runtime` is produced by platform-linux-acceptance.yml, which has no
  // pull_request.paths filter and so runs for every PR. Counting it would make one
  // environment-dependent acceptance suite a merge criterion for a docs change -
  // the failure the deployment/merge distinction exists to prevent.
  const r = decide([['linux-runtime', 'platform-linux-acceptance.yml', 'failure']], []);
  assert.equal(r.verdict, 'PASS', `an unfiltered suite blocked a change that did not require it: ${JSON.stringify(r.failed)}`);
});

test('a red check from a DEPLOYMENT workflow is reported but never blocks', () => {
  const impact = { suites: { 'browser-e2e': false }, unmatched: [] };
  const result = gate(ALL_GREEN, impact, ledger([['deploy to staging host', 'staging-preview.yml', 'failure']]));
  assert.equal(result.verdict, 'PASS');
  assert.match(result.deploymentFailures.join(' '), /staging-preview\.yml/);
});

// --- 4. the static contract --------------------------------------------------
//
// Each case passes `tables` so ONLY the mutation under test can produce a
// finding. Without that, every fixture would also disagree with the real tables
// about the other nine workflows, and the assertion would pass for the wrong
// reason - the failure mode this file exists to catch.

const WF = (text) => parse(text).value;

/** A table set small enough that exactly one finding is possible. */
function tables(overrides = {}) {
  return {
    jobToSuite: {},
    delegated: {},
    delegatedCheckOwners: {},
    gateOwnership: {},
    nonGateWorkflows: {},
    unfilteredOnPr: [],
    suiteWorkflow: {},
    ...overrides,
  };
}

test('the contract refuses a delegated check name that no job produces', () => {
  // THE MUTATION: rename the job's `name:`. The gate would then read a check
  // nothing produces; every other static checker in this repository passed.
  const workflows = new Map([
    ['g12-acceptance.yml', WF('on: {}\njobs:\n  acceptance:\n    name: acceptance-renamed\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: WF('on: {}\n'),
    tables: tables({
      delegatedCheckOwners: { 'browser-e2e': { acceptance: 'g12-acceptance.yml' } },
      gateOwnership: { 'g12-acceptance.yml': 'merge' },
    }),
  });
  assert.ok(problems.some((p) => /not a job in g12-acceptance\.yml/.test(p)),
    `a renamed check name was not refused: ${JSON.stringify(problems)}`);
});

test('a job id with no `name:` satisfies its own check name', () => {
  const workflows = new Map([
    ['g12-acceptance.yml', WF('on: {}\njobs:\n  acceptance:\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: WF('on: {}\n'),
    tables: tables({
      delegatedCheckOwners: { 'browser-e2e': { acceptance: 'g12-acceptance.yml' } },
      gateOwnership: { 'g12-acceptance.yml': 'merge' },
    }),
  });
  assert.deepEqual(problems, []);
});

test('the contract refuses a JOB_TO_SUITE entry whose job is gone', () => {
  const workflows = new Map([
    ['ci.yml', WF('on: {}\njobs:\n  ci-gate:\n    needs: [rust]\n  rust:\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: workflows.get('ci.yml'),
    tables: tables({ jobToSuite: { rust: 'rust', ghost: 'spec-coverage' } }),
  });
  assert.ok(problems.some((p) => /"ghost", which is not a job in ci\.yml/.test(p)),
    `a mapping that outlived its job was not refused: ${JSON.stringify(problems)}`);
  assert.ok(!problems.some((p) => /"rust"/.test(p)), 'the job that does exist must not be reported');
});

test('the contract refuses a job the gate is not handed in needs:', () => {
  const workflows = new Map([
    ['ci.yml', WF('on: {}\njobs:\n  ci-gate:\n    needs: [rust]\n  rust:\n    runs-on: ubuntu-latest\n  web:\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: workflows.get('ci.yml'),
    tables: tables({ jobToSuite: { rust: 'rust', web: 'web' } }),
  });
  assert.ok(problems.some((p) => /"web", but ci-gate's needs: does not include it/.test(p)),
    `a mapped job missing from needs was not refused: ${JSON.stringify(problems)}`);
});

test('the contract refuses two tables that name different producers for one suite', () => {
  // MEASURED: `SUITE_WORKFLOW` said browser-e2e was produced by g12-acceptance
  // alone while `DELEGATED` said it was produced by two workflows. Each file was
  // internally consistent; the pair was not.
  const workflows = new Map([
    ['g12-acceptance.yml', WF('on: {}\njobs:\n  acceptance:\n    runs-on: ubuntu-latest\n')],
    ['data-foundation.yml', WF('on: {}\njobs:\n  golden-path:\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: WF('on: {}\n'),
    tables: tables({
      delegated: { 'browser-e2e': ['g12-acceptance.yml', 'data-foundation.yml'] },
      suiteWorkflow: { 'browser-e2e': 'g12-acceptance.yml' },
      delegatedCheckOwners: { 'browser-e2e': { acceptance: 'g12-acceptance.yml', 'golden-path': 'data-foundation.yml' } },
      gateOwnership: { 'g12-acceptance.yml': 'merge', 'data-foundation.yml': 'merge' },
    }),
  });
  assert.ok(problems.some((p) => /browser-e2e/.test(p) && /One of the two/.test(p)),
    `disagreeing producer tables were not refused: ${JSON.stringify(problems)}`);
});

test('the contract refuses an UNFILTERED_ON_PR entry that grew a path filter', () => {
  const workflows = new Map([
    ['reliability.yml', WF(`on:
  pull_request:
    paths:
      - 'tests/reliability/**'
jobs:
  quality-faults:
    runs-on: ubuntu-latest
`)],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: WF('on: {}\n'),
    tables: tables({ unfilteredOnPr: ['reliability.yml'], gateOwnership: { 'reliability.yml': 'merge' } }),
  });
  assert.ok(problems.some((p) => /has a pull_request\.paths filter/.test(p)),
    `a filter added to an "unfiltered" workflow was not refused: ${JSON.stringify(problems)}`);
});

test('the contract refuses a workflow that lost its filter without being listed', () => {
  const workflows = new Map([
    ['reliability.yml', WF('on:\n  pull_request:\njobs:\n  quality-faults:\n    runs-on: ubuntu-latest\n')],
  ]);
  const problems = inspectContract({
    workflows,
    ciYml: WF('on: {}\n'),
    tables: tables({ gateOwnership: { 'reliability.yml': 'merge' } }),
  });
  assert.ok(problems.some((p) => /it is not in UNFILTERED_ON_PR/.test(p)),
    `a workflow that now runs on every PR was not refused: ${JSON.stringify(problems)}`);
});
