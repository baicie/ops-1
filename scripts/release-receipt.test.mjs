#!/usr/bin/env node
/**
 * The release receipt: every way it used to certify something it should not.
 *
 * A receipt says "this exact SHA was certified". It is the only artifact in this
 * repository that makes that claim, so the cases below are not style checks - each
 * one is a way a forger, a stale document, or an unlucky API response could have
 * produced CERTIFIED from evidence that did not support it.
 *
 * The first two were MEASURED against the code as it was, by driving the real
 * `verifyReceipt`:
 *
 *   1. a receipt recording `rust: "failure"` for a run whose `rust` was also
 *      `failure` came back CERTIFIED, because the comparison only ran when the
 *      RECEIPT claimed success. The receipt and the run agreeing that a required
 *      suite is red is not agreement about certification.
 *
 *   2. `suiteStates` treated a success as sticky (`if (out[name] === 'success')
 *      continue`), so once any attempt of a name had succeeded, a NEWER failing
 *      attempt was dropped. A re-run could not clear it and an old green masked a
 *      fresh red.
 *
 * Run: node --test scripts/release-receipt.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA, REQUIRED_SUITES, suiteStates, verifyReceipt, PASSING_STATES, CERTIFICATION_STATES, REQUIRED_SUITE_PRODUCER,
  suitesWithoutProducer,
} from './release-receipt.mjs';

const SHA = 'a'.repeat(40);
const REPO = 'baicie/ops-1';
const ALL_OK = Object.fromEntries(REQUIRED_SUITES.map((n) => [n, 'success']));

const receipt = (over = {}) => ({
  schema: SCHEMA,
  subject: { repository: REPO, sha: SHA, ref: 'refs/tags/v1' },
  trigger: { runId: 7, attempt: 1 },
  suites: { ...ALL_OK },
  ...over,
});

/** A `fetchRun` stub. `suites` defaults to every required suite green. */
const runFor = (over = {}) => () => ({
  head_sha: SHA, conclusion: 'success', attempt: 1, event: 'push',
  workflow: 'ci.yml', suites: { ...ALL_OK }, ...over,
});

const EXPECTED = { repository: REPO, sha: SHA };

// --- the two measured defects ------------------------------------------------

test('TASK-01 a required suite that is FAILURE on both sides is not CERTIFIED', () => {
  // Measured before the fix: problems=[], verdict CERTIFIED.
  const problems = verifyReceipt(
    receipt({ suites: { ...ALL_OK, rust: 'failure' } }),
    runFor({ suites: { ...ALL_OK, rust: 'failure' } }),
    EXPECTED,
  );
  assert.ok(problems.some((p) => /rust/.test(p) && /failure/.test(p)),
    `a red required suite certified: ${JSON.stringify(problems)}`);
});

test('TASK-01 the receipt agreeing with the run about a failure is not agreement', () => {
  // Both sides say `cancelled` - the same shape as above with a different status.
  const problems = verifyReceipt(
    receipt({ suites: { ...ALL_OK, web: 'cancelled' } }),
    runFor({ suites: { ...ALL_OK, web: 'cancelled' } }),
    EXPECTED,
  );
  assert.ok(problems.length > 0);
});

test('TASK-02 a NEWER failing attempt is not masked by an older success', () => {
  // The sticky-success rule returned {rust: "success"} for this input.
  const runs = [
    { name: 'rust', conclusion: 'success', status: 'completed', id: 1, started_at: '2026-01-01T00:00:00Z' },
    { name: 'rust', conclusion: 'failure', status: 'completed', id: 2, started_at: '2026-01-01T01:00:00Z' },
  ];
  assert.equal(suiteStates(runs).states.rust, 'failed',
    'a later failure must decide; the old green is only true of the old attempt');
});

test('TASK-02 API order does not change the answer', () => {
  const a = [
    { name: 'rust', conclusion: 'success', status: 'completed', id: 1, started_at: '2026-01-01T00:00:00Z' },
    { name: 'rust', conclusion: 'failure', status: 'completed', id: 2, started_at: '2026-01-01T01:00:00Z' },
  ];
  const b = [a[1], a[0]];
  assert.deepEqual(suiteStates(a).states, suiteStates(b).states,
    'the ledger orders by attempt, so the array order must not matter');
});

test('TASK-02 an unfinished re-run means the answer is not settled', () => {
  // The old green is still `completed/success` while the re-run is in flight.
  const runs = [
    { name: 'golden-path', conclusion: 'success', status: 'completed', id: 1, started_at: '2026-01-01T00:00:00Z' },
    { name: 'golden-path', conclusion: null, status: 'in_progress', id: 2, started_at: '2026-01-01T01:00:00Z' },
  ];
  assert.equal(suiteStates(runs).states['golden-path'], 'pending',
    'certifying during a re-run uses an answer that was called to be revisited');
});

// --- every non-success status fails closed -----------------------------------

for (const status of ['failure', 'cancelled', 'timed_out', 'pending', 'skipped',
  'neutral', 'action_required', 'stale', 'startup_failure', 'waiting', 'queued']) {
  test(`a required suite that is ${status} is refused`, () => {
    const problems = verifyReceipt(
      receipt({ suites: { ...ALL_OK, rust: status } }),
      runFor({ suites: { ...ALL_OK, rust: status } }),
      EXPECTED,
    );
    assert.ok(problems.length > 0, `"${status}" was accepted as a pass`);
  });
}

test('an UNKNOWN status fails closed: the allowlist is what passes', () => {
  assert.deepEqual([...PASSING_STATES], ['success'],
    'only success passes; a status nobody has seen must not');
  const problems = verifyReceipt(
    receipt({ suites: { ...ALL_OK, rust: 'reticulating' } }),
    runFor({ suites: { ...ALL_OK, rust: 'reticulating' } }),
    EXPECTED,
  );
  assert.ok(problems.length > 0);
});

test('a required suite MISSING from the run is refused even if the receipt omits it', () => {
  const s = { ...ALL_OK };
  delete s['ci-gate'];
  const problems = verifyReceipt(receipt({ suites: s }), runFor({ suites: s }), EXPECTED);
  assert.ok(problems.some((p) => /ci-gate/.test(p)));
});

// --- TASK-04: the expectation comes from outside the receipt -----------------

test('TASK-04 a receipt for a DIFFERENT commit than the one asked about is refused', () => {
  // Without this, a self-consistent receipt for any commit certifies itself.
  const problems = verifyReceipt(receipt(), runFor(), { repository: REPO, sha: 'b'.repeat(40) });
  assert.ok(problems.some((p) => /expected/.test(p)), JSON.stringify(problems));
});

test('TASK-04 a receipt for a DIFFERENT repository is refused', () => {
  const problems = verifyReceipt(receipt(), runFor(), { repository: 'other/repo', sha: SHA });
  assert.ok(problems.some((p) => /expected other\/repo/.test(p)), JSON.stringify(problems));
});

test('TASK-04 a receipt whose cited attempt is not the run attempt is refused', () => {
  const problems = verifyReceipt(receipt({ trigger: { runId: 7, attempt: 1 } }),
    runFor({ attempt: 2 }), EXPECTED);
  assert.ok(problems.some((p) => /attempt/.test(p)), JSON.stringify(problems));
});

test('TASK-04 a receipt citing a run from the wrong workflow is refused', () => {
  const problems = verifyReceipt(receipt(), runFor({ workflow: 'staging-preview.yml' }),
    { ...EXPECTED, workflow: 'ci.yml' });
  assert.ok(problems.some((p) => /ci\.yml/.test(p)), JSON.stringify(problems));
});

test('TASK-04 a receipt citing a run of the wrong event is refused', () => {
  const problems = verifyReceipt(receipt(), runFor({ event: 'workflow_dispatch' }),
    { ...EXPECTED, event: 'push' });
  assert.ok(problems.some((p) => /workflow_dispatch/.test(p)), JSON.stringify(problems));
});

test('TASK-04 no expectation at all still checks the receipt against the RUN', () => {
  // The function does the strongest check it can without outside input. The CLI is
  // what refuses to run without one - see the file's own comment.
  const problems = verifyReceipt(
    receipt({ suites: { ...ALL_OK, rust: 'failure' } }),
    runFor({ suites: { ...ALL_OK, rust: 'failure' } }),
    null,
  );
  assert.ok(problems.length > 0, 'a red suite must never certify, expectation or not');
});

// --- TASK-06: incomplete evidence -------------------------------------------------

test('TASK-06 INCOMPLETE check data refuses certification', () => {
  const problems = verifyReceipt(receipt(),
    runFor({ incomplete: 'check runs: 100 of 240 read (one page requested)' }), EXPECTED);
  assert.ok(problems.some((p) => /INCOMPLETE/.test(p)),
    `a receipt computed from part of the evidence certified: ${JSON.stringify(problems)}`);
});

test('TASK-06 the reason survives into the message, so an operator can look', () => {
  const problems = verifyReceipt(receipt(), runFor({ incomplete: 'jobs: 100 of 140 read' }), EXPECTED);
  assert.ok(problems.some((p) => /100 of 140/.test(p)));
});

// --- the positive path -------------------------------------------------------

test('a fully green receipt for the expected commit certifies', () => {
  assert.deepEqual(verifyReceipt(receipt(), runFor(), EXPECTED), []);
});

test('a genuine refusal is not turned into a pass by an absent expectation', () => {
  // Every suite green, but the run concluded failure: the receipt is describing a
  // run that did not succeed.
  const problems = verifyReceipt(receipt(), runFor({ conclusion: 'failure' }), EXPECTED);
  assert.ok(problems.some((p) => /not success/.test(p)));
});

// --- TASK-07: the states are separate, and none implies the next --------------
//
// The receipt used to carry one `verdict: "CERTIFIED"`, which was read as a release
// approval while it actually meant "this commit's merge-gate checks were green".
// Measured on f06835cb: that commit's own ledger contains
// `deploy to staging host=failed` next to twenty-nine green checks. Both are true,
// and one word could not say so.

test('TASK-07 CODE_CERTIFIED is accepted: it is what the merge-gate evidence supports', () => {
  assert.deepEqual(verifyReceipt(receipt({ state: 'CODE_CERTIFIED' }), runFor(), EXPECTED), []);
});

for (const state of ['ARTIFACT_VERIFIED', 'STAGING_ACCEPTED', 'PRODUCTION_APPROVED']) {
  test(`TASK-07 ${state} is refused by this file: the evidence is elsewhere`, () => {
    const problems = verifyReceipt(receipt({ state }), runFor(), EXPECTED);
    assert.ok(problems.some((p) => /needs evidence this receipt does not contain/.test(p)),
      `${state} was granted without its evidence: ${JSON.stringify(problems)}`);
  });
}

test('TASK-07 an undefined state fails closed', () => {
  const problems = verifyReceipt(receipt({ state: 'SHIP_IT' }), runFor(), EXPECTED);
  assert.ok(problems.some((p) => /not one of/.test(p)), JSON.stringify(problems));
});

test('TASK-07 a green staging deploy does not upgrade a code receipt', () => {
  // The inverse mistake: staging passing is not a reason to claim more than
  // CODE_CERTIFIED either. The state is what the EVIDENCE supports, not the best
  // news available.
  const problems = verifyReceipt(receipt({ state: 'STAGING_ACCEPTED' }),
    runFor({ suites: { ...ALL_OK } }), EXPECTED);
  assert.ok(problems.length > 0);
});

test('TASK-07 a receipt with no state field is still checked for its suites', () => {
  // Older receipts carry only `verdict`. They are not rejected for lacking the new
  // field, but the suite rules still apply to them.
  const old = receipt();
  delete old.state;
  assert.deepEqual(verifyReceipt(old, runFor(), EXPECTED), []);
  const bad = receipt({ suites: { ...ALL_OK, rust: 'failure' } });
  delete bad.state;
  assert.ok(verifyReceipt(bad, runFor({ suites: { ...ALL_OK, rust: 'failure' } }), EXPECTED).length > 0);
});

// --- TASK-05: a check name is not a producer declaration ---------------------
//
// `checkState` can report `impostor` and `ambiguous`, but only when the caller says
// which workflow it expects. The certification path did not, so any workflow - or
// any app - reporting a check called `rust` was credited as this repository's.

test('TASK-05 every required suite declares a producer', () => {
  assert.deepEqual(suitesWithoutProducer(), [],
    'a required suite with no declared producer is an unowned check');
});

test('TASK-05 every declared producer is a workflow that exists', async () => {
  const { readdirSync } = await import('node:fs');
  const files = new Set(readdirSync('.github/workflows').filter((n) => n.endsWith('.yml')));
  for (const [suite, wf] of Object.entries(REQUIRED_SUITE_PRODUCER)) {
    assert.ok(files.has(wf), `${suite} names ${wf}, which is not a workflow file`);
  }
});

test('TASK-05 a green check of the right NAME from the wrong workflow is not the suite', () => {
  const runs = [
    { name: 'rust', conclusion: 'success', status: 'completed', id: 1,
      started_at: '2026-01-01T00:00:00Z', check_suite: { id: 99 } },
  ];
  // Workflow 99 is some other file; ci.yml is workflow 10 and produced nothing.
  const r = suiteStates(runs, { rust: 'ci.yml' },
    [{ check_suite_id: 99, path: '.github/workflows/some-other.yml' }]);
  assert.equal(r.states.rust, 'impostor',
    `a name alone was credited: ${JSON.stringify(r.states)}`);
});

test('TASK-05 an impostor green is refused by verifyReceipt, not just reported', () => {
  const run = runFor();
  run.suites = { ...ALL_OK, rust: 'impostor' };
  run.reasons = { rust: 'check named "rust" was produced by some-other.yml, not ci.yml' };
  const problems = verifyReceipt(receipt(), () => run, EXPECTED);
  assert.ok(problems.some((p) => /rust/.test(p) && /cannot be attributed/.test(p)),
    JSON.stringify(problems));
});

test('TASK-05 an ambiguous producer is refused too', () => {
  const run = runFor();
  run.suites = { ...ALL_OK, web: 'ambiguous' };
  run.reasons = { web: 'check named "web" was produced by 2 workflows' };
  const problems = verifyReceipt(receipt(), () => run, EXPECTED);
  assert.ok(problems.some((p) => /web/.test(p) && /cannot be attributed/.test(p)),
    JSON.stringify(problems));
});

test('TASK-05 the right producer is still credited', () => {
  const runs = [
    { name: 'rust', conclusion: 'success', status: 'completed', id: 1,
      started_at: '2026-01-01T00:00:00Z', check_suite: { id: 10 } },
  ];
  const r = suiteStates(runs, { rust: 'ci.yml' },
    [{ check_suite_id: 10, path: '.github/workflows/ci.yml' }]);
  assert.equal(r.states.rust, 'success');
});
