#!/usr/bin/env node
/**
 * Counterfactuals for the bounded wait.
 *
 * The property under test is not "the gate waits". It is "the gate does not
 * return PASS on a result that does not exist". Every case below that fails to
 * settle must end in a timeout, and a timeout must be a FAIL at the call site -
 * which `ci-gate.mjs`'s main() decides and `tests/ci/ci-gate.wait.test.mjs` pins.
 *
 * Time is injected: `sleep` advances a virtual clock and `now` reads it. No
 * case below takes real time, so this file costs nothing in CI and cannot flake
 * on a slow runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitDelegated, whatToAwait, DEFAULT_BUDGET_MS, MAX_POLL_MS } from './await-delegated.mjs';
import { attributeChecks } from './check-run-ledger.mjs';

const check = (name, status, conclusion, suiteId) => ({
  name, status, conclusion, check_suite: { id: suiteId }, started_at: null, id: 0,
});
const wf = (path, checkSuiteId, status = 'completed') => ({ path, check_suite_id: checkSuiteId, status });

/** A clock and a sleeper sharing one virtual time. */
function clock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    elapsed: () => t,
    sleeps,
  };
}

const DF = '.github/workflows/data-foundation.yml';
const wanted = [
  { name: 'golden-path', workflow: DF },
  { name: 'legacy-regression', workflow: DF },
];

test('every suite already answered: one read, no sleep', async () => {
  const c = clock();
  const out = await awaitDelegated({
    read: () => ({
      ledger: attributeChecks(
        [check('golden-path', 'completed', 'success', 1), check('legacy-regression', 'completed', 'success', 1)],
        [wf(DF, 1)],
      ),
      workflowRuns: [wf(DF, 1)],
    }),
    wanted, sleep: c.sleep, now: c.now,
  });
  assert.equal(out.attempts, 1);
  assert.deepEqual(out.timedOut, []);
  assert.equal(c.sleeps.length, 0);
});

test('a suite that finishes mid-wait settles without timing out', async () => {
  const c = clock();
  let reads = 0;
  const out = await awaitDelegated({
    read: () => {
      reads += 1;
      // Answer only on the third read.
      const green = reads >= 3;
      return {
        ledger: attributeChecks([
          check('golden-path', green ? 'completed' : 'in_progress', green ? 'success' : null, 1),
          check('legacy-regression', green ? 'completed' : 'queued', green ? 'success' : null, 1),
        ], [wf(DF, 1)]),
        workflowRuns: [wf(DF, 1, green ? 'completed' : 'in_progress')],
      };
    },
    wanted, sleep: c.sleep, now: c.now,
  });
  assert.equal(out.timedOut.length, 0);
  assert.equal(reads, 3);
  assert.ok(out.elapsedMs > 0);
});

test('a suite that never finishes TIMES OUT - it never becomes a pass', async () => {
  const c = clock();
  const out = await awaitDelegated({
    read: () => ({
      ledger: attributeChecks([check('golden-path', 'in_progress', null, 1)], [wf(DF, 1, 'in_progress')]),
      workflowRuns: [wf(DF, 1, 'in_progress')],
    }),
    wanted, sleep: c.sleep, now: c.now, budgetMs: 60_000,
  });
  assert.equal(out.timedOut.length, 2, 'both facets were still unanswered');
  assert.ok(out.elapsedMs >= 60_000, `budget respected: ${out.elapsedMs}`);
  // The critical assertion: the outcome is a timeout, and nothing here says pass.
  assert.ok(out.settled.every((s) => s.state !== 'success'));
});

test('the deadline is the deadline - sleep is clipped to the remaining budget', async () => {
  const c = clock();
  await awaitDelegated({
    read: () => ({
      ledger: attributeChecks([check('golden-path', 'in_progress', null, 1)], [wf(DF, 1, 'in_progress')]),
      workflowRuns: [wf(DF, 1, 'in_progress')],
    }),
    wanted, sleep: c.sleep, now: c.now, budgetMs: 25_000, pollMs: 20_000,
  });
  // 20s, then 5s - not 20s, then 30s overshooting the budget.
  assert.deepEqual(c.sleeps, [20_000, 5_000]);
  assert.equal(c.elapsed(), 25_000);
});

test('a suite nobody started is NOT waited for - absent is immediate', async () => {
  // No check, and no workflow run for the owning file. Waiting 30 minutes for a
  // workflow that was never triggered produces nothing; the answer is absent now.
  const c = clock();
  const out = await awaitDelegated({
    read: () => ({ ledger: attributeChecks([], []), workflowRuns: [] }),
    wanted, sleep: c.sleep, now: c.now,
  });
  assert.equal(out.attempts, 1);
  assert.deepEqual(out.timedOut, []);
  assert.equal(c.sleeps.length, 0);
  assert.ok(out.settled.every((s) => s.state === 'absent'));
});

test('a workflow that is running but has not created its check yet IS waited for', async () => {
  // Real behaviour: a job's check run appears when the job starts. A queued
  // workflow has a run and no check, and giving up on it would report absent for
  // a suite that is about to report.
  const c = clock();
  let reads = 0;
  const out = await awaitDelegated({
    read: () => {
      reads += 1;
      const done = reads >= 2;
      return {
        ledger: attributeChecks(
          done ? [check('golden-path', 'completed', 'success', 1)] : [],
          [wf(DF, 1, done ? 'completed' : 'queued')],
        ),
        workflowRuns: [wf(DF, 1, done ? 'completed' : 'queued')],
      };
    },
    wanted, sleep: c.sleep, now: c.now, budgetMs: 120_000,
  });
  assert.equal(reads, 2);
  // legacy-regression never reported and its workflow has FINISHED, so it is
  // settled absent on the first read - it is not something to wait for. The
  // distinction this pins: absent-and-not-coming is immediate, pending-and-running
  // is waited for. Only the latter can become a timeout.
  assert.deepEqual(out.timedOut, []);
  assert.equal(out.settled.find((s) => s.name === 'legacy-regression').state, 'absent');
  assert.equal(out.settled.find((s) => s.name === 'golden-path').state, 'success');
});

test('the default budget covers the slowest measured suite', () => {
  // data-foundation.yml p95 measured at 1530 s on 2026-11-17. A budget below
  // that fails healthy runs, which is the failure mode that teaches people to
  // bypass the gate.
  const P95_SLOWEST_MS = 1530 * 1000;
  assert.ok(DEFAULT_BUDGET_MS > P95_SLOWEST_MS,
    `budget ${DEFAULT_BUDGET_MS}ms must exceed the slowest p95 ${P95_SLOWEST_MS}ms`);
});

test('the poll interval backs off but is capped', async () => {
  const c = clock();
  await awaitDelegated({
    read: () => ({
      ledger: attributeChecks([check('golden-path', 'in_progress', null, 1)], [wf(DF, 1, 'in_progress')]),
      workflowRuns: [wf(DF, 1, 'in_progress')],
    }),
    wanted, sleep: c.sleep, now: c.now, budgetMs: 10 * 60_000, pollMs: 20_000,
  });
  assert.ok(c.sleeps.every((s) => s <= MAX_POLL_MS),
    `no sleep exceeded the cap: ${c.sleeps.join(',')}`);
  assert.ok(c.sleeps.length > 3, 'it kept polling');
});

test('an API error is not an empty commit', async () => {
  // The old pipeline ended in `2>/dev/null || echo '{}'`, so a TLS handshake
  // timeout - measured against api.github.com in this session - became "no checks
  // exist" and then "absent" for every suite. A thrown reader must propagate, not
  // be folded into a verdict.
  const c = clock();
  await assert.rejects(
    awaitDelegated({
      read: () => { throw new Error('TLS handshake timeout'); },
      wanted, sleep: c.sleep, now: c.now,
    }),
    /TLS handshake timeout/,
  );
});

test('whatToAwait names the reason, so the wait log is readable', () => {
  const ledger = attributeChecks([check('golden-path', 'in_progress', null, 1)], [wf(DF, 1, 'in_progress')]);
  const { waiting, settled } = whatToAwait(ledger, [wf(DF, 1, 'in_progress')], wanted);
  assert.equal(waiting.length, 2);
  assert.ok(waiting.some((w) => /check unfinished/.test(w)));
  assert.ok(waiting.some((w) => /has not reported yet/.test(w)));
  assert.equal(settled.length, 0);
});
