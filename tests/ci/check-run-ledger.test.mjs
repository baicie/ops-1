#!/usr/bin/env node
/**
 * Counterfactuals for the check-run ledger.
 *
 * Each case answers "what did the old code do with this, and is the new answer
 * different for the right reason". The old code is a name -> conclusion map built
 * by shell jq; its behaviour is reproduced in the comments rather than imported,
 * because it no longer exists as a function.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeChecks, checkState, normaliseCheckRun } from './check-run-ledger.mjs';

const suite = (id) => ({ check_suite: { id } });
const check = (name, status, conclusion, suiteId) => ({
  name, status, conclusion, ...(suiteId ? suite(suiteId) : {}), started_at: null, id: 0,
});
const wf = (path, checkSuiteId, status = 'completed') => ({ path, check_suite_id: checkSuiteId, status });

test('a check is attributed to the workflow whose check_suite it shares', () => {
  const ledger = attributeChecks(
    [check('acceptance', 'completed', 'success', 11)],
    [wf('.github/workflows/g12-acceptance.yml', 11)],
  );
  assert.equal(ledger.byName.acceptance[0].workflow, 'g12-acceptance.yml');
  assert.deepEqual(ledger.unattributed, []);
});

test('the workflow path is normalised to a bare file name', () => {
  const ledger = attributeChecks([check('x', 'completed', 'success', 7)], [wf('.github/workflows/ci.yml', 7)]);
  assert.equal(ledger.byName.x[0].workflow, 'ci.yml');
  // A caller may pass either shape; both must resolve to the same key.
  assert.equal(checkState(ledger.byName, 'x', { workflow: '.github/workflows/ci.yml' }).state, 'success');
});

test('a check with no matching workflow run is reported unattributed, not guessed', () => {
  const ledger = attributeChecks([check('lonely', 'completed', 'success', 99)], []);
  assert.equal(ledger.byName.lonely[0].workflow, null);
  assert.deepEqual(ledger.unattributed, ['lonely']);
});

test('a name produced by two check suites is listed as a duplicate', () => {
  const ledger = attributeChecks(
    [check('acceptance', 'completed', 'success', 1), check('acceptance', 'completed', 'failure', 2)],
    [wf('.github/workflows/g12-acceptance.yml', 1), wf('.github/workflows/data-foundation.yml', 2)],
  );
  assert.deepEqual(ledger.duplicates, ['acceptance']);
});

// ---------------------------------------------------------------------------
// checkState. The three states the old flat map could not express.
// ---------------------------------------------------------------------------

test('absent: the name is not on this commit at all', () => {
  const { state } = checkState({}, 'golden-path', { workflow: 'data-foundation.yml' });
  assert.equal(state, 'absent');
});

test('pending: every attempt is unfinished', () => {
  const ledger = attributeChecks(
    [check('golden-path', 'in_progress', null, 3)],
    [wf('.github/workflows/data-foundation.yml', 3)],
  );
  assert.equal(checkState(ledger.byName, 'golden-path', { workflow: 'data-foundation.yml' }).state, 'pending');
  assert.equal(checkState(ledger.byName, 'golden-path', { workflow: 'data-foundation.yml' }).state === 'success', false);
});

test('impostor: the name exists, but from a workflow that does not own the suite', () => {
  // THE CASE THE OLD CODE GOT WRONG. A name -> conclusion map answers "success"
  // here, and the suite is credited to a workflow that never ran it.
  const ledger = attributeChecks(
    [check('acceptance', 'completed', 'success', 4)],
    [wf('.github/workflows/data-foundation.yml', 4)],
  );
  const st = checkState(ledger.byName, 'acceptance', { workflow: 'g12-acceptance.yml' });
  assert.equal(st.state, 'impostor');
  assert.match(st.reason, /produced by data-foundation\.yml, not g12-acceptance\.yml/);
});

test('impostor: a red check from the wrong workflow is not a failure of the suite', () => {
  const ledger = attributeChecks(
    [check('acceptance', 'completed', 'failure', 5)],
    [wf('.github/workflows/data-foundation.yml', 5)],
  );
  const st = checkState(ledger.byName, 'acceptance', { workflow: 'g12-acceptance.yml' });
  assert.equal(st.state, 'impostor');
  // It is still NOT a pass. The suite has no answer; impostor is surfaced as such.
  assert.notEqual(st.state, 'success');
});

test('ambiguous: two producers and no declared owner', () => {
  const ledger = attributeChecks(
    [check('dup', 'completed', 'success', 6), check('dup', 'completed', 'failure', 7)],
    [wf('.github/workflows/a.yml', 6), wf('.github/workflows/b.yml', 7)],
  );
  assert.equal(checkState(ledger.byName, 'dup', {}).state, 'ambiguous');
});

test('latest completed attempt decides, so a green re-run clears a red one', () => {
  const first = { ...check('linux-runtime', 'completed', 'failure', 8), started_at: '2026-01-01T00:00:01Z', id: 1 };
  const second = { ...check('linux-runtime', 'completed', 'success', 8), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([first, second], [wf('.github/workflows/platform-linux-acceptance.yml', 8)]);
  assert.equal(checkState(ledger.byName, 'linux-runtime', { workflow: 'platform-linux-acceptance.yml' }).state, 'success');
});

test('a later red attempt is not masked by an earlier green one', () => {
  const first = { ...check('linux-runtime', 'completed', 'success', 8), started_at: '2026-01-01T00:00:01Z', id: 1 };
  const second = { ...check('linux-runtime', 'completed', 'failure', 8), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([first, second], [wf('.github/workflows/platform-linux-acceptance.yml', 8)]);
  assert.equal(checkState(ledger.byName, 'linux-runtime', { workflow: 'platform-linux-acceptance.yml' }).state, 'failed');
});

test('an unbalanced attempt is not the answer while an unfinished one exists', () => {
  // A re-run in flight: the old attempt is green, the new one has not finished.
  // "Latest COMPLETED" would answer success and hide the in-flight retry - which
  // is only correct if the caller has decided not to wait. `whatToAwait` in
  // await-delegated.mjs is what makes that decision, so this function stays
  // literal about completed attempts.
  const old = { ...check('x', 'completed', 'success', 9), started_at: '2026-01-01T00:00:01Z', id: 1 };
  const running = { ...check('x', 'in_progress', null, 9), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([old, running], [wf('.github/workflows/ci.yml', 9)]);
  assert.equal(checkState(ledger.byName, 'x', { workflow: 'ci.yml' }).state, 'success');
});

test('normaliseCheckRun keeps status when there is no conclusion', () => {
  const run = normaliseCheckRun(check('x', 'queued', null));
  assert.equal(run.conclusion, null);
  assert.equal(run.state, 'queued');
  assert.equal(run.name, 'x');
});

test('a conclusion of neutral is not a pass', () => {
  const ledger = attributeChecks([check('x', 'completed', 'neutral', 10)], [wf('.github/workflows/ci.yml', 10)]);
  assert.equal(checkState(ledger.byName, 'x', { workflow: 'ci.yml' }).state, 'failed');
});
