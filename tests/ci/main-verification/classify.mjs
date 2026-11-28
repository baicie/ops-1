#!/usr/bin/env node
/**
 * What a commit on `main` was actually verified by, and what it was not.
 *
 * TWO QUESTIONS, KEPT APART ON PURPOSE
 *
 *   WAITING states   -> progress. They are not a verdict and must never be read
 *                       as one: `COLLECTING` in particular looks like work and
 *                       means nothing has been decided.
 *   FINAL verdicts   -> answers. `VERIFIED` is the only one that asserts a
 *                       commit was fully verified.
 *
 * The split exists because the previous implementation had one flat state set
 * where `INCOMPLETE` sat beside `VERIFIED`, and a wrapper that turned the exit
 * code into a green check could not tell them apart. A caller must be able to
 * ask "is this a final answer" without knowing which final answers exist.
 *
 * THE DEFECT THIS FILE IS BUILT ON
 *
 * The old classifier dropped path-filtered workflows from the verdict entirely.
 * Measured against the real function, before this file existed:
 *
 *     ci.yml success + staging-preview.yml success + plugin-lifecycle.yml FAILURE
 *       -> state: VERIFIED, failed: []
 *
 * `plugin-lifecycle.yml` ran, failed, and was not mentioned in any bucket. A
 * workflow's trigger having a `paths:` filter says when it owes a result; it says
 * nothing about whether a result it DID produce counts. It does.
 *
 * So every workflow with a push trigger is classified, and the three buckets are
 * exhaustive by construction: `required`, `notApplicable`, `unknown`. A record
 * that is in none of them cannot exist, because the loop adds every one.
 *
 * PRECEDENCE, AND WHY IT IS THAT ORDER
 *
 *   1. a red run is FAILED, whatever its applicability says. If it ran and it
 *      was red, the commit is broken; the trigger question does not enter into it.
 *   2. an UNAVAILABLE observation is a credential or API problem, which is
 *      reported as such and not as absence.
 *   3. UNKNOWN applicability is never resolved downward. It means the changed
 *      files were not available, so whether a result was owed is not knowable —
 *      which is INCOMPLETE, not "nothing owed".
 *   4. a REQUIRED workflow with no run is INCOMPLETE, never VERIFIED.
 *   5. only then, CANCELLED when nothing failed.
 *
 * CANCELLED is still not a pass. `cancel-in-progress: true` on pushes means two
 * merges in quick succession cancel the first commit's suites, which is the
 * documented policy — but the cancelled commit's suites never ran to completion,
 * so nothing about that commit was verified except that a newer commit replaced
 * it.
 */

import { APPLICABILITY, OBSERVATION, observeRun, newerRun } from './expected-workflows.mjs';

/** States a run passes through. Never a verdict. */
export const WAITING = Object.freeze(['WAITING', 'COLLECTING', 'INCOMPLETE']);

/** States that answer the question. */
export const FINAL = Object.freeze([
  'VERIFIED',
  'FAILED',
  'INCOMPLETE_TIMEOUT',
  'SUPERSEDED',
  'UNAVAILABLE',
]);

export const isFinal = (state) => FINAL.includes(state);
export const isWaiting = (state) => WAITING.includes(state);

/**
 * Exit codes for FINAL MODE, where the status is the answer.
 *
 * The historical CLI treats "nothing to read" as 2 and CANCELLED as 3, and those
 * are kept: existing callers parse them. `SUPERSEDED` is a non-success verdict
 * that is not a failure of the commit, so it keeps 3, and `INCOMPLETE_TIMEOUT`
 * is 1 like a failure because a result that does not exist is not mergeable.
 */
export const FINAL_EXIT = Object.freeze({
  VERIFIED: 0,
  FAILED: 1,
  INCOMPLETE_TIMEOUT: 1,
  UNAVAILABLE: 2,
  SUPERSEDED: 3,
});

/** The historical snapshot-mode codes, preserved for existing callers. */
export const SNAPSHOT_EXIT = Object.freeze({
  VERIFIED: 0,
  INCOMPLETE: 1,
  FAILED: 1,
  UNAVAILABLE: 2,
  CANCELLED: 3,
});

/**
 * Classify one commit's push runs.
 *
 * @param {object[]} runs the workflow runs for this commit
 * @param {object} expected from `expectedPushWorkflows`
 * @param {object} [opts]
 * @param {string|null} [opts.selfWorkflow] the observer's own workflow file
 * @param {boolean} [opts.waiting] true while the caller is still collecting, so
 *        an unresolved record reports INCOMPLETE rather than INCOMPLETE_TIMEOUT
 * @returns {{state: string, reason: string, records: object[], ...}}
 */
export function classifyMainRuns(runs, expected, opts = {}) {
  const { selfWorkflow = null, waiting = false } = opts;
  // `expected` accepts the old shape (an array of names, or {unfiltered,filtered})
  // so the existing fixtures and callers keep working. Both are converted to
  // records with the applicability the old shape actually asserted: names in
  // `unfiltered` were required; names in `filtered` were simply not required to
  // appear. The second is now UNKNOWN rather than NOT_APPLICABLE, because that is
  // what "may legitimately not run" really means without the changed files.
  const records = toRecords(expected, selfWorkflow);

  // Index the runs by workflow file, keeping the NEWEST attempt rather than the
  // last one in the array. A re-run keeps the same `createdAt`, so the old
  // timestamp comparison could not tell a re-run from its original.
  //
  // ONLY PUSH RUNS ARE INDEXED. The API is asked for `event=push` server-side,
  // and that filter is verified to work (a `event=pull_request` query against a
  // push commit returns 0), but the filter is not the guarantee — this is. A
  // `workflow_dispatch` on the same SHA has the same `head_sha` and can be GREEN
  // while the push run was red; letting it into the index would report the
  // dispatch as the push result. `run.event` absent is treated as acceptable
  // only for fixtures that predate the field, which is why the check is
  // `event && event !== 'push'` rather than `event !== 'push'`.
  const latest = new Map();
  const ignoredEvents = [];
  for (const run of runs ?? []) {
    const key = String(run.workflow ?? run.name ?? '');
    if (!key) continue;
    if (key === selfWorkflow) continue; // an observer cannot judge itself
    if (run.event && run.event !== 'push') {
      ignoredEvents.push(`${key}: ${run.event}`);
      continue;
    }
    latest.set(key, newerRun(latest.get(key), run));
  }

  const required = [];
  const notApplicable = [];
  const unknown = [];
  const failed = [];
  const cancelled = [];
  const pending = [];
  const succeeded = [];
  const unavailable = [];
  const notes = [];

  for (const record of records) {
    const run = latest.get(record.workflow) ?? null;
    const { observation, detail } = observeRun(run);
    record.observedRunId = run ? (run.runId ?? run.databaseId ?? null) : null;
    record.observedAttempt = run ? (run.attempt ?? null) : null;
    record.observation = observation;
    record.observationDetail = detail;

    // A run that exists is judged on its result no matter what the trigger says.
    // This is the fix: applicability decides what is OWED, the run decides what
    // HAPPENED, and a failure is a failure even from a workflow that did not owe
    // a run this time.
    if (observation === OBSERVATION.FAILURE) {
      failed.push(`${record.workflow}: ${detail}`);
      continue;
    }
    if (observation === OBSERVATION.TIMED_OUT) {
      failed.push(`${record.workflow}: ${detail}`);
      continue;
    }
    if (observation === OBSERVATION.UNAVAILABLE) {
      unavailable.push(`${record.workflow}: ${detail}`);
      continue;
    }

    switch (record.applicability) {
      case APPLICABILITY.REQUIRED:
        required.push(record.workflow);
        if (observation === OBSERVATION.SUCCESS) succeeded.push(record.workflow);
        else if (observation === OBSERVATION.CANCELLED) cancelled.push(record.workflow);
        else if (observation === OBSERVATION.NOT_CREATED) {
          pending.push(`${record.workflow}: owed a run (${record.expectedReason}) and none exists`);
        } else pending.push(`${record.workflow}: ${detail}`);
        break;

      case APPLICABILITY.NOT_APPLICABLE:
        // The trigger says no run was owed. A run that exists anyway and SUCCEEDED
        // is extra evidence and does not change the verdict; one that failed was
        // already caught above.
        notApplicable.push(record.workflow);
        if (observation === OBSERVATION.SUCCESS) record.note = 'ran anyway and passed';
        break;

      default: {
        unknown.push(record.workflow);
        // Unknown is never resolved downward. With a run present, its result still
        // counts (that is what the run is); with none, the question is open.
        if (observation === OBSERVATION.SUCCESS) succeeded.push(record.workflow);
        else if (observation === OBSERVATION.CANCELLED) cancelled.push(record.workflow);
        else pending.push(`${record.workflow}: applicability unknown (${record.expectedReason})`);
        break;
      }
    }
  }

  if (selfWorkflow && records.some((r) => r.workflow === selfWorkflow)) {
    notes.push(`${selfWorkflow} is the observer and is excluded from its own expectation set`);
  }
  if (ignoredEvents.length) {
    notes.push(`ignored runs that were not pushes: ${ignoredEvents.join(', ')}`);
  }

  let state; let reason;
  if (failed.length) {
    state = 'FAILED';
    reason = `${failed.length} workflow(s) failed on this commit: ${failed.join(', ')}`;
  } else if (unavailable.length) {
    state = 'UNAVAILABLE';
    reason = `${unavailable.length} workflow(s) could not be observed: ${unavailable.join(', ')}`;
  } else if (pending.length) {
    // WAITING keeps "still collecting" distinct from "the budget ran out". The
    // caller decides which one this is; the classifier cannot know.
    state = waiting ? 'INCOMPLETE' : 'INCOMPLETE_TIMEOUT';
    reason = waiting
      ? `${pending.length} workflow(s) have no answer yet: ${pending.join(', ')}`
      : `${pending.length} workflow(s) still had no answer when the budget ran out: ${pending.join(', ')}`;
  } else if (cancelled.length) {
    state = 'SUPERSEDED';
    reason = `${cancelled.length} workflow(s) were superseded by a newer push `
      + `(${cancelled.join(', ')}); this commit's suites never completed, so nothing about it was verified`;
  } else {
    state = 'VERIFIED';
    reason = `all ${required.length} required workflow(s) completed success`
      + (notApplicable.length ? `; ${notApplicable.length} did not apply` : '')
      + (unknown.length ? `; ${unknown.length} had unknown applicability but produced passing runs` : '');
  }

  return {
    state,
    reason,
    records,
    required,
    notApplicable,
    unknown,
    succeeded,
    failed,
    cancelled,
    pending,
    unavailable,
    ignoredEvents,
    notes,
    // The old field names, kept so an existing reader does not silently lose the
    // distinction it was written against. `notTriggered` now means specifically
    // NOT_APPLICABLE with the reason attached — it used to include workflows that
    // had failed, which is how the defect stayed invisible.
    notTriggered: records
      .filter((r) => r.applicability === APPLICABILITY.NOT_APPLICABLE)
      .map((r) => r.workflow),
    notTriggeredNote: notApplicable.length
      ? `not applicable to this commit (trigger evidence recorded per workflow): ${notApplicable.join(', ')}`
      : null,
  };
}

/**
 * Normalise the several accepted shapes of `expected` into records.
 *
 * Every record starts with `applicability: UNKNOWN` when the caller could only
 * supply a list — the old shape carried no trigger evidence, so nothing stronger
 * can be asserted without inventing it.
 */
function toRecords(expected, selfWorkflow) {
  if (Array.isArray(expected)) {
    return expected.filter((wf) => wf !== selfWorkflow).map((wf) => ({
      workflow: String(wf),
      event: 'push',
      applicability: APPLICABILITY.REQUIRED,
      expectedReason: 'named in the required set by the caller',
      observation: null,
      observationDetail: null,
      observedRunId: null,
      observedAttempt: null,
    }));
  }
  if (expected && Array.isArray(expected.expected)) {
    return expected.expected
      .filter((r) => r.workflow !== selfWorkflow)
      .map((r) => ({ ...r, observation: null, observationDetail: null, observedRunId: null, observedAttempt: null }));
  }
  const unfiltered = expected?.unfiltered ?? [];
  const filtered = expected?.filtered ?? [];
  return [
    ...unfiltered.map((wf) => ({
      workflow: String(wf),
      event: 'push',
      applicability: APPLICABILITY.REQUIRED,
      expectedReason: 'push trigger has no paths filter',
      observation: null,
      observationDetail: null,
      observedRunId: null,
      observedAttempt: null,
    })),
    ...filtered.map((wf) => ({
      workflow: String(wf),
      event: 'push',
      applicability: APPLICABILITY.UNKNOWN,
      expectedReason: 'path-filtered, and the caller supplied no trigger evidence',
      observation: null,
      observationDetail: null,
      observedRunId: null,
      observedAttempt: null,
    })),
  ].filter((r) => r.workflow !== selfWorkflow);
}
