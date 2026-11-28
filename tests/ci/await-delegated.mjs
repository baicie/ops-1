#!/usr/bin/env node
/**
 * Bounded wait for the suites another workflow produces.
 *
 * THE HOLE THIS CLOSES
 *
 * `ci-gate` lives in `ci.yml` and Actions has no cross-workflow `needs:`, so it
 * reads its siblings' results from the check-run API at whatever moment it
 * happens to start. When a sibling is still running the gate reported
 * `delegated-pending` and returned PASS. That is honest about what it saw and
 * wrong about what it means: `data-foundation`, `plugin-lifecycle`,
 * `runtime-conformance`, `g12-acceptance` and `browser-e2e` are not in the
 * branch ruleset, so nothing else enforces them. A suite that started, was
 * declared "pending", and then FAILED left a green gate behind it and a merge
 * that no check ever objected to.
 *
 * WHY NOT `unbounded__poll`
 *
 * Because a gate that never finishes is a gate somebody disables. The wait is
 * bounded by a budget derived from measured history, and when the budget runs out
 * the answer is FAIL - `delegated-timeout` - never PASS. A suite that did not
 * finish in the time its own p95 says it needs is not "probably fine"; it is a
 * result that does not exist, and this gate does not merge on those.
 *
 * BUDGET
 *
 * Measured on this repository from `actions/runs` (100 most recent completed
 * runs, re-measured 2026-11-19 over a larger sample):
 *
 *     workflow                        n    p50     p95     max
 *     data-foundation.yml            16   1476s   2040s   2040s
 *     plugin-lifecycle.yml            6   1083s   1258s   1258s
 *     g12-acceptance.yml             10    965s   1124s   1124s
 *     platform-linux-acceptance.yml  19    526s    623s    623s
 *     reliability.yml                14    135s    258s    258s
 *
 * The budget is set from those numbers, not from a round figure: a deadline
 * shorter than a suite's own p95 would fail healthy runs, which is the failure
 * mode that teaches people to bypass the gate.
 *
 * `DEFAULT_BUDGET_MS` is 60 minutes. It was 35, and 30 before that, each time
 * because the figure described the previous behaviour of the suites rather than
 * their current one. The 35-minute version cited `plugin-lifecycle.yml 1174 s`;
 * run 45372261894 measured **2963 s** once the Phase 7 steps actually executed
 * their assertions instead of skipping. `ci-gate` timed out at 2100 s with
 * `delegated-timeout: 1 suite(s) still running` - correctly, against a stale
 * input.
 *
 * The lesson is in the shape, not the number: a wait budget derived from how long
 * a suite took WHILE IT WAS DOING NOTHING will be too small the moment it starts
 * doing its job. Raise it with the measurement in hand, and never in the same
 * change that makes a suite slower without saying so.
 *
 * The caller may pass a larger or smaller one explicitly; `ci.yml` does, via
 * `GATE_BUDGET_MS`.
 *
 * WHAT COUNTS AS "WILL PRODUCE A RESULT"
 *
 * A check that exists and is unfinished: yes, wait - it is running.
 * A workflow RUN for the expected file on this commit, `queued` or `in_progress`:
 *   yes, wait - the check has not been created yet but the run has.
 * Neither: do not wait. Nothing was started, so no amount of waiting produces an
 *   answer, and the correct verdict is `absent` immediately rather than after 30
 *   minutes.
 */

import { checkState, UNFINISHED_STATUS } from './check-run-ledger.mjs';

/** 60 minutes. See the rationale above. */
export const DEFAULT_BUDGET_MS = 90 * 60 * 1000;
/** Start tight, then relax: cheap to catch the 146 s suites, still fine for 25 min ones. */
export const DEFAULT_POLL_MS = 20_000;
export const MAX_POLL_MS = 60_000;

/**
 * Which suites are worth waiting for, right now.
 *
 * @param {object} ledger from `attributeChecks`
 * @param {object[]} workflowRuns raw workflow runs on this commit
 * @param {Array<{name: string, workflow?: string|null}>} wanted suites to resolve
 * @returns {{waiting: string[], settled: Array<{name: string, state: string}>}}
 */
export function whatToAwait(ledger, workflowRuns, wanted) {
  const runningWorkflows = new Set();
  for (const wf of workflowRuns ?? []) {
    const status = String(wf?.status ?? '');
    if (!UNFINISHED_STATUS.has(status)) continue;
    const path = String(wf.path ?? '').replace(/^\.github\/workflows\//, '');
    if (path) runningWorkflows.add(path);
  }
  // A run that finished but produced no check for the suite we want is not worth
  // waiting for either.

  const waiting = [];
  const settled = [];
  for (const want of wanted) {
    // Both spellings are in use: the owner table writes bare file names, the
    // workflow-run API returns full paths. Normalise here rather than trusting
    // every caller and fixture to agree - the first version of this compared them
    // raw and silently stopped waiting for a workflow that was running.
    const wantWorkflow = want.workflow ? String(want.workflow).replace(/^\.github\/workflows\//, '') : null;
    const st = checkState(ledger.byName, want.name, { workflow: wantWorkflow });
    if (st.state === 'pending') { waiting.push(`${want.name} (check unfinished)`); continue; }
    if (st.state === 'absent' && wantWorkflow && runningWorkflows.has(wantWorkflow)) {
      // The workflow is running but has not created its check yet. This happens
      // for real: a job's check run is created when the job starts, so a queued
      // workflow is invisible to a check-run-only reader.
      waiting.push(`${want.name} (${wantWorkflow} is running but has not reported yet)`);
      continue;
    }
    settled.push({ name: want.name, state: st.state, reason: st.reason ?? '' });
  }
  return { waiting, settled };
}

/**
 * Poll until every wanted suite has an answer, or the budget runs out.
 *
 * `read` is injected so the counterfactuals can drive time and API responses
 * without touching the network or sleeping. It must resolve to
 * `{ledger, workflowRuns}` for the same commit.
 *
 * @param {object} opts
 * @param {(attempt: number) => Promise<{ledger: object, workflowRuns: object[]}>} opts.read
 * @param {Array<{name: string, workflow?: string|null}>} opts.wanted
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.pollMs]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{settled: object[], timedOut: string[], attempts: number, elapsedMs: number}>}
 */
export async function awaitDelegated(opts) {
  const {
    read,
    wanted,
    budgetMs = DEFAULT_BUDGET_MS,
    pollMs = DEFAULT_POLL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    log = () => {},
    // WHAT IS WORTH WAITING FOR is the one thing the two callers disagree about,
    // so it is the one thing injected. Everything else — the budget guard, the
    // backoff, the deadline clipping, the attempt counter — is shared, because
    // those are the parts that were measured into place and a second copy would
    // be a second thing to get wrong.
    //
    // The default is `whatToAwait`, which is what `ci-gate` means: a suite that
    // another workflow is *currently running* will produce a check, so wait for
    // it; a suite with neither a check nor a running workflow was never started,
    // and no amount of waiting will make it appear.
    waitFor = null,
  } = opts;

  // THE BUDGET IS VALIDATED HERE, because the loop below cannot survive a bad
  // one and neither of the two failure modes is acceptable.
  //
  // `budgetMs` arrives from `--budget-ms`, which `ci-gate.mjs` parsed as
  // `Number(argv[++i])` with no check, and from `GATE_BUDGET_MS`, a repository
  // variable anyone with settings access can set. Measured before this guard:
  //
  //   NaN  -> `elapsedMs >= NaN` is false for ever, so the poll loop NEVER
  //           exits. The gate job runs until its 45-minute timeout kills it, and
  //           a killed job reports `cancelled` - the one outcome that says
  //           nothing about the suites.
  //   -1   -> returns on the first read with `timedOut: []`, i.e. "nothing was
  //           still running", which is the opposite of what is true.
  //   0    -> same as -1.
  //
  // A configuration error is not a suite result. It is thrown so the CLI can
  // report CONFIGURATION_ERROR and exit non-zero, rather than being mistaken for
  // a timeout (the suites) or a crash (the harness).
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    const error = new RangeError(
      `await-delegated: budgetMs must be a positive finite number, got ${String(budgetMs)}. ` +
      'This is a configuration error, not a suite result: NaN would never expire and a ' +
      'non-positive budget reports "nothing still running" before reading anything.',
    );
    error.code = 'CONFIGURATION_ERROR';
    throw error;
  }

  const decide = waitFor ?? ((snapshot) => {
    const { ledger, workflowRuns, wanted: w } = snapshot;
    return whatToAwait(ledger, workflowRuns, w ?? wanted);
  });

  const started = now();
  let attempt = 0;
  let wait = pollMs;

  // At least one read, even with a zero budget: the caller may already know the
  // answers and be using this only to re-check once.
  for (;;) {
    attempt += 1;
    const snapshot = await read(attempt);
    const { waiting, settled } = decide(snapshot);
    const elapsedMs = now() - started;

    if (waiting.length === 0) {
      log(`all delegated suites settled after ${attempt} read(s), ${Math.round(elapsedMs / 1000)}s`);
      return { settled, timedOut: [], attempts: attempt, elapsedMs };
    }

    log(`still waiting (${Math.round(elapsedMs / 1000)}s of ${Math.round(budgetMs / 1000)}s): ${waiting.join('; ')}`);

    if (elapsedMs >= budgetMs) {
      return { settled, timedOut: waiting, attempts: attempt, elapsedMs };
    }

    // Sleep no longer than the remaining budget, so the deadline is the deadline.
    const remaining = budgetMs - elapsedMs;
    await sleep(Math.min(wait, remaining));
    wait = Math.min(Math.round(wait * 1.5), MAX_POLL_MS);
  }
}
