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
import { RED_CONCLUSIONS, attributeChecks, cancellationReason, checkState, normaliseCheckRun } from './check-run-ledger.mjs';

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
  //
  // THIS TEST USED TO ASSERT 'success', and its own comment gave the reasoning:
  // "`whatToAwait` in await-delegated.mjs is what makes that decision, so this
  // function stays literal about completed attempts." That was wrong, and the
  // name of the test already said so.
  //
  // Measured: `whatToAwait` asks `checkState` and only waits on `pending`
  // (await-delegated.mjs:94-95). With `checkState` answering `success`, the
  // caller never waits either. So the two functions agreed with each other and
  // neither one looked at the in-flight re-run.
  //
  // GitHub creates a NEW check run for every re-run and leaves the old attempt
  // `completed` for ever - measured on SHA cc7be5c (run 44524547400,
  // run_attempt 2), which has `golden-path id=135561535255 completed/failure`
  // AND `id=135572060029 completed/success`. For the whole duration of a re-run
  // the old green attempt is still readable, so "latest completed" answered
  // `success` for a suite that was actively being re-run because someone had
  // found a problem with it.
  const old = { ...check('x', 'completed', 'success', 9), started_at: '2026-01-01T00:00:01Z', id: 1 };
  const running = { ...check('x', 'in_progress', null, 9), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([old, running], [wf('.github/workflows/ci.yml', 9)]);
  const st = checkState(ledger.byName, 'x', { workflow: 'ci.yml' });
  assert.equal(st.state, 'pending', 'the in-flight attempt is the answer, and it has none yet');
  assert.match(st.reason, /re-run/, 'and the reason must say a re-run is in flight');
});

test('a stale unfinished attempt older than the last completed one does not block', () => {
  // The mirror case, and the reason the rule compares timestamps instead of
  // counting unfinished runs. A check run that was left hanging before the
  // attempt that DID finish must not hold the gate open for ever.
  const stale = { ...check('x', 'in_progress', null, 9), started_at: '2026-01-01T00:00:01Z', id: 1 };
  const done = { ...check('x', 'completed', 'success', 9), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([stale, done], [wf('.github/workflows/ci.yml', 9)]);
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

// ---------------------------------------------------------------------------
// TASK 4: cancelled is a FAIL, and the summary should still say why.
// ---------------------------------------------------------------------------

// A `completed` check whose conclusion is NULL is not a success, and the gate must
// not read it as one.
//
// GitHub can return `status: "completed"` with `conclusion: null` - the API
// documents it as transient, but the gate does not get to assume it resolves. The
// behaviour today is correct: `state` becomes the string "completed", which is in
// neither `RED_CONCLUSIONS` nor the gate's `success` filter, so it falls through to
// `absent` and fails closed.
//
// It was correct by ACCIDENT and asserted by nothing, which is one refactor from
// turning a finished-but-unreported check into a pass. An audit flagged it as a
// live defect; it is not one, but the absence of this test is.
test('a completed check with a NULL conclusion is not a success and not a pass', () => {
  const ledger = attributeChecks(
    [check('golden-path', 'completed', null, 21)],
    [wf('.github/workflows/plugin-lifecycle.yml', 21)],
  );
  const st = checkState(ledger.byName, 'golden-path', { workflow: 'plugin-lifecycle.yml' });
  assert.notEqual(st.state, 'success',
    'a null conclusion must never be reported as success');
  assert.notEqual(st.state, 'skipped',
    'and it is not "skipped" either - nothing said it was');
  assert.equal(st.state, 'completed',
    'the state falls through as its literal status, which the gate then treats as absent');
});

test('an in_progress check with a null conclusion is pending, not completed', () => {
  const ledger = attributeChecks(
    [check('golden-path', 'in_progress', null, 22)],
    [wf('.github/workflows/plugin-lifecycle.yml', 22)],
  );
  const st = checkState(ledger.byName, 'golden-path', { workflow: 'plugin-lifecycle.yml' });
  assert.equal(st.state, 'pending', 'a running check is pending and must never read as success');
});

test('a cancelled check that was never re-answered explains itself as unanswered', () => {
  const only = { ...check('rust', 'completed', 'cancelled', 12), started_at: '2026-01-01T00:00:00Z', id: 1 };
  const ledger = attributeChecks([only], [wf('.github/workflows/ci.yml', 12)]);
  const reason = cancellationReason(ledger.byName['rust'], ledger.byName['rust'][0]);
  assert.equal(reason, 'unanswered',
    'nothing replaced it, so there is no result - this is the case that must keep failing');
});

test('a cancelled check replaced by a later answer is named superseded, and still fails while it is the latest', () => {
  const cancelled = { ...check('rust', 'completed', 'cancelled', 13), started_at: '2026-01-01T00:00:00Z', id: 1 };
  const later = { ...check('rust', 'completed', 'success', 13), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([cancelled, later], [wf('.github/workflows/ci.yml', 13)]);
  // The REASON is about the cancelled row:
  assert.equal(cancellationReason(ledger.byName['rust'], ledger.byName['rust'][0]), 'superseded');
  // ...and the check as a whole passes, because a later attempt answered it.
  assert.equal(checkState(ledger.byName, 'rust', { workflow: 'ci.yml' }).state, 'success');
});

test('a cancelled check with a later RED answer is failed, not "superseded and fine"', () => {
  const cancelled = { ...check('rust', 'completed', 'cancelled', 14), started_at: '2026-01-01T00:00:00Z', id: 1 };
  const later = { ...check('rust', 'completed', 'failure', 14), started_at: '2026-01-01T00:10:00Z', id: 2 };
  const ledger = attributeChecks([cancelled, later], [wf('.github/workflows/ci.yml', 14)]);
  assert.equal(cancellationReason(ledger.byName['rust'], ledger.byName['rust'][0]), 'superseded');
  assert.equal(checkState(ledger.byName, 'rust', { workflow: 'ci.yml' }).state, 'failed');
});

test('a cancelled manual run is named manual, not superseded', () => {
  const run = { ...check('conformance', 'completed', 'cancelled', 15), started_at: '2026-01-01T00:00:00Z', id: 1 };
  const ledger = attributeChecks([run], [{ ...wf('.github/workflows/runtime-conformance.yml', 15), event: 'workflow_dispatch' }]);
  assert.equal(cancellationReason(ledger.byName['conformance'], ledger.byName['conformance'][0]), 'manual',
    'a person asked for this run; it did not finish, so the request went unanswered');
});

test('cancelled STAYS in RED_CONCLUSIONS', () => {
  // The whole point of TASK 4 is that classification must not become permission.
  assert.ok(RED_CONCLUSIONS.has('cancelled'), 'removing cancelled from RED_CONCLUSIONS would let the gate pass on a check that never answered');
});
