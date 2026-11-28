#!/usr/bin/env node
/**
 * The bounded wait for a push to `main`.
 *
 * NOT A SECOND POLLER
 *
 * `await-delegated.mjs` already implements the bounded poll: a budget, a
 * backoff that starts tight and caps, a deadline that is the deadline (sleep
 * clipped to the remaining budget), and a configuration guard for a NaN budget.
 * `ci-gate` uses it and measured 2716 s of waiting on 4375c988.
 *
 * The brief forbids copying it, so this file does not. It calls `awaitDelegated`
 * with a different `waitFor` decision, which is the one thing the two callers
 * genuinely disagree about. Everything measured into place — deadline clipping,
 * backoff, attempt counting, the CONFIGURATION_ERROR guard — is shared.
 *
 * WHAT IS DIFFERENT, AND WHY IT IS NOT A DETAIL
 *
 * `ci-gate`'s rule, `whatToAwait`, says: a suite with no check and no running
 * workflow was never started, so do not wait — report `absent` immediately. That
 * is right for the gate, which waits on suites produced BY workflows that are
 * already running.
 *
 * It is WRONG for a push observer, and the difference is a real defect this file
 * was written to catch. On a push, GitHub schedules the workflows over the
 * following seconds; `ci.yml` itself may not have a run yet at the moment the
 * observer starts. Under the gate's rule a workflow GitHub had not yet scheduled
 * would be reported "absent" on the first read and the observer would declare a
 * verdict about a push that had barely begun. Measured against `awaitDelegated`
 * with the gate's rule:
 *
 *     wanted ci.yml, no run anywhere
 *       -> settled after 1 read(s), state: absent, timedOut: []
 *
 * — i.e. "nothing to wait for", for a workflow that starts four seconds later.
 *
 * So this file's rule inverts the default: a REQUIRED workflow with no run is
 * waited on. A workflow that is genuinely never going to run resolves when the
 * budget expires (INCOMPLETE_TIMEOUT), which is the correct answer for "an
 * obligation with no result" — and it is the answer the brief asks for, not a
 * pass. `NOT_APPLICABLE` workflows are not waited on at all: nothing was owed.
 *
 * THE BUDGET
 *
 * Measured on this repository, from the push runs of 4375c988:
 *
 *     ci.yml                   06:25:52 -> 07:16:30    3038 s   (50.6 min)
 *     plugin-lifecycle.yml     06:25:52 -> 07:16:14    3022 s   (50.4 min)
 *     data-foundation.yml      06:25:52 -> 06:49:09    1397 s   (23.3 min)
 *     staging-preview.yml      06:25:52 -> 06:44:11    1099 s   (18.3 min)
 *     runtime-conformance.yml  06:25:52 -> 06:30:20     268 s   ( 4.5 min)
 *
 * The slowest is 3038 s. A budget under ~55 minutes fails healthy pushes, which
 * is the failure mode that teaches people to ignore the tool. 90 minutes is the
 * floor; the JOB TIMEOUT must exceed
 *
 *     waitBudget + setup + finalCollection,
 *
 * and that inequality is asserted in the test file rather than left to whoever
 * edits the workflow next.
 */

import { awaitDelegated, DEFAULT_POLL_MS, MAX_POLL_MS } from '../await-delegated.mjs';
import { APPLICABILITY, observeRun } from './expected-workflows.mjs';

/** 90 minutes. See the measurement above. */
export const DEFAULT_BUDGET_MS = 90 * 60 * 1000;

/**
 * Which obligations still have no answer, and which are done.
 *
 * Deliberately a pure function of one snapshot so the counterfactuals drive it
 * directly, and so the production loop and the tests cannot diverge.
 *
 * @param {{expected: object[], runs: object[]|null, error: string|null}} snapshot
 * @returns {{waiting: string[], settled: object[]}}
 */
export function whatToAwaitOnPush(snapshot) {
  const waiting = [];
  const settled = [];

  // A red or unavailable observation is an ANSWER, not something to wait out.
  // Waiting on a failed workflow until the budget expires would convert a
  // precise failure into a timeout, which is strictly less informative.
  const byWorkflow = new Map();
  for (const run of snapshot?.runs ?? []) {
    const current = byWorkflow.get(run.workflow);
    if (!current || Number(run.attempt ?? 1) >= Number(current.attempt ?? 1)) byWorkflow.set(run.workflow, run);
  }

  for (const record of snapshot?.expected ?? []) {
    if (record.applicability === APPLICABILITY.NOT_APPLICABLE) {
      settled.push({ name: record.workflow, state: 'not-applicable', reason: record.expectedReason });
      continue;
    }
    const run = byWorkflow.get(record.workflow) ?? null;
    const { observation, detail } = observeRun(run);

    if (observation === 'NOT_CREATED') {
      // THE INVERSION. On a push this is "GitHub has not scheduled it yet" far
      // more often than "it will never run", and the two are indistinguishable
      // from here. Treating it as settled would be the absent-on-first-read
      // defect; the budget decides, and its answer is INCOMPLETE_TIMEOUT.
      waiting.push(`${record.workflow} (no run yet; ${record.applicability.toLowerCase()})`);
      continue;
    }
    if (observation === 'QUEUED' || observation === 'RUNNING') {
      waiting.push(`${record.workflow} (${detail})`);
      continue;
    }
    settled.push({ name: record.workflow, state: observation.toLowerCase(), reason: detail });
  }

  return { waiting, settled };
}

/**
 * Poll until every workflow the commit owes has an answer, or the budget ends.
 *
 * `read` is injected, exactly as in `await-delegated`: the counterfactuals drive
 * time and API responses without sleeping or touching the network, and the
 * production caller supplies the real one. This is what stops a test from
 * passing against a reimplementation.
 *
 * @param {object} opts
 * @param {(attempt: number) => Promise<{runs: object[], expected: object[], error: string|null}>} opts.read
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.pollMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{last: object|null, waiting: string[], timedOut: boolean, attempts: number,
 *                    elapsedMs: number, error: string|null}>}
 */
export async function awaitPush({ read, budgetMs = DEFAULT_BUDGET_MS, pollMs = DEFAULT_POLL_MS, sleep, now, log = () => {} }) {
  let last = null;
  let lastWaiting = [];

  const readAndDecide = async (attempt) => {
    const snapshot = await read(attempt);
    last = snapshot;
    if (snapshot?.error) {
      // An API failure is its own answer, and it is not a reason to keep polling:
      // a 403 will not become a 200 because we waited.
      return { waiting: [], settled: [] };
    }
    const { waiting, settled } = whatToAwaitOnPush(snapshot);
    lastWaiting = waiting;
    return { waiting, settled };
  };

  const result = await awaitDelegated({
    read: readAndDecide,
    wanted: [],
    waitFor: (snapshot) => snapshot,
    budgetMs,
    pollMs,
    sleep,
    now,
    log,
  });

  const error = last?.error ?? null;
  return {
    last,
    waiting: lastWaiting,
    // A timeout is only a timeout if something was actually still owed. With an
    // API error the loop returns on the first read and this stays false, so the
    // caller reports UNAVAILABLE rather than blaming the budget.
    timedOut: !error && result.timedOut.length > 0,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
    error,
  };
}

export { DEFAULT_POLL_MS, MAX_POLL_MS };
