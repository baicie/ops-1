#!/usr/bin/env node
/**
 * The certification ledger's counterfactuals.
 *
 * `release-certification.yml` used this to decide what a commit's checks were:
 *
 *   [.check_runs[] | {name, s: (.conclusion // .status)}] | unique_by(.name)
 *
 * `unique_by` keeps the LAST occurrence in ARRAY ORDER. GitHub does not promise an
 * order, so that is not "the latest attempt wins" - it is "whichever the API
 * happened to put last". These cases pin the replacement, which asks the same
 * `checkState` the merge gate uses.
 *
 * The four measured inputs, and what the old filter returned for each:
 *
 *   old success, NEW failure        -> rust=success      WRONG
 *   new failure FIRST               -> rust=failure      (right by luck)
 *   old success, NEW in_progress    -> rust=success      WRONG
 *   old in_progress, NEW success    -> rust=in_progress  WRONG
 *
 * Run: node --test scripts/ci/release-check-ledger.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseChecks } from './release-check-ledger.mjs';

/** One check run, shaped like the REST API returns it. */
const check = (name, { conclusion = 'success', status = 'completed', id = 1, started = '2026-01-01T00:00:00Z' } = {}) =>
  ({ name, conclusion, status, id, started_at: started, check_suite: { id: 10 } });

const isPending = (state) => state === 'pending' || ['queued', 'in_progress', 'waiting', 'requested'].includes(state);

test('an OLD success does not mask a NEW failure', () => {
  // The old filter returned "rust=success" for exactly this input.
  const r = summariseChecks([
    check('rust', { conclusion: 'success', id: 1, started: '2026-01-01T00:00:00Z' }),
    check('rust', { conclusion: 'failure', id: 2, started: '2026-01-01T02:00:00Z' }),
  ]);
  assert.equal(r.entries.rust.state, 'failed');
});

test('the answer does not depend on the order the API returned them in', () => {
  const a = [
    check('rust', { conclusion: 'success', id: 1, started: '2026-01-01T00:00:00Z' }),
    check('rust', { conclusion: 'failure', id: 2, started: '2026-01-01T02:00:00Z' }),
  ];
  const forward = summariseChecks(a).entries.rust.state;
  const backward = summariseChecks([...a].reverse()).entries.rust.state;
  assert.equal(forward, backward,
    'the ledger orders by attempt, so array position must not decide the answer');
});

test('an OLD success during a NEW in-flight re-run is PENDING, not success', () => {
  // The old filter returned "rust=success" here too - and a re-run exists because
  // someone doubted that success.
  const r = summariseChecks([
    check('rust', { conclusion: 'success', id: 1, started: '2026-01-01T00:00:00Z' }),
    check('rust', { conclusion: null, status: 'in_progress', id: 2, started: '2026-01-01T02:00:00Z' }),
  ]);
  assert.ok(isPending(r.entries.rust.state),
    `expected a pending state, got ${r.entries.rust.state}`);
  assert.ok(r.pending.includes('rust'));
});

test('a completed success AFTER an in-flight attempt is the answer', () => {
  const r = summariseChecks([
    check('rust', { conclusion: null, status: 'in_progress', id: 1, started: '2026-01-01T00:00:00Z' }),
    check('rust', { conclusion: 'success', id: 2, started: '2026-01-01T02:00:00Z' }),
  ]);
  assert.equal(r.entries.rust.state, 'success');
});

test('a name produced by TWO workflows is ambiguous, not credited', () => {
  // `check_suite.id` is the only field that says which workflow produced a check.
  // The old filter threw it away, so any app's `rust` counted as this
  // repository's.
  const runs = [
    { ...check('rust', { conclusion: 'success', id: 1 }), check_suite: { id: 10 } },
    { ...check('rust', { conclusion: 'failure', id: 2, started: '2026-01-01T02:00:00Z' }), check_suite: { id: 11 } },
  ];
  const r = summariseChecks(runs, [
    { check_suite_id: 10, path: '.github/workflows/ci.yml' },
    { check_suite_id: 11, path: '.github/workflows/other.yml' },
  ]);
  assert.equal(r.entries.rust.state, 'ambiguous',
    'two producers of one name cannot be resolved by name alone');
});

test('the same name from ONE workflow is resolved normally', () => {
  const runs = [
    { ...check('rust', { conclusion: 'success', id: 1 }), check_suite: { id: 10 } },
    { ...check('rust', { conclusion: 'failure', id: 2, started: '2026-01-01T02:00:00Z' }), check_suite: { id: 10 } },
  ];
  const r = summariseChecks(runs, [{ check_suite_id: 10, path: '.github/workflows/ci.yml' }]);
  assert.equal(r.entries.rust.state, 'failed');
});

test('an empty check-run response is reported as EMPTY, not as an empty ledger', () => {
  const r = summariseChecks([]);
  assert.equal(r.empty, true, 'the caller must be able to tell "no checks" from "nothing read"');
});

test('a check with no workflow attribution is reported, not silently dropped', () => {
  const r = summariseChecks([check('external-app-check', { conclusion: 'success' })]);
  assert.ok(r.unattributed.includes('external-app-check'));
});

test('several names are all present: the ledger is not a filter', () => {
  const r = summariseChecks([
    check('rust', { conclusion: 'success' }),
    check('web', { conclusion: 'success' }),
    check('golden-path', { conclusion: 'failure' }),
  ]);
  assert.deepEqual(Object.keys(r.entries).sort(), ['golden-path', 'rust', 'web']);
});
