#!/usr/bin/env node
/**
 * Expected push workflows: which workflows owe a result on a commit, and why.
 *
 * WHY THIS MODULE EXISTS
 *
 * `verify-main.mjs` used to answer that question with two regexes over the raw
 * text of each workflow file. Two defects came out of that, both measured:
 *
 *   1. A PATH-FILTERED WORKFLOW THAT RAN AND FAILED WAS DROPPED FROM THE
 *      VERDICT ENTIRELY. `classifyMainRuns` only fed `unfiltered` through the
 *      state machine; for `filtered` it checked `if (!by[wf])` and recorded
 *      not-triggered, and nothing else. So a workflow that DID run and DID fail
 *      was neither `failed` nor `notTriggered` nor `succeeded` — it vanished,
 *      and the commit came back `VERIFIED`. Reproduced against the real function
 *      before this file was written:
 *
 *          ci.yml success + staging-preview.yml success
 *          + plugin-lifecycle.yml FAILURE   ->   state: VERIFIED
 *
 *      A red suite is not made green by having a `paths:` filter.
 *
 *   2. APPLICABILITY WAS INFERRED FROM THE PRESENCE OF THE WORD `paths:`.
 *      Whether a workflow OWES a run depends on the commit's changed files, not
 *      on whether its filter exists. Not knowing is a third answer, and the old
 *      code had only two: it filed every filtered workflow under "legitimately
 *      did not run", which is the wrong direction to be wrong in.
 *
 * WHAT REPLACES THEM
 *
 * The shared parser `lib/workflow-yaml.mjs`, which refuses what it cannot read
 * rather than guessing. It was already in the tree with four callers; writing a
 * fifth regex reader would have been the mistake `check-paths-filters.mjs` and
 * `impact.mjs` each made once already.
 *
 * The output is one record per workflow that could plausibly owe something, with
 * an EXPLICIT applicability and an EXPLICIT observation:
 *
 *   applicability  REQUIRED | NOT_APPLICABLE | UNKNOWN
 *   observation    NOT_CREATED | QUEUED | RUNNING | SUCCESS | FAILURE |
 *                  CANCELLED | TIMED_OUT | UNAVAILABLE
 *
 * The two are orthogonal and must never be collapsed. "Not applicable" is a
 * statement about the TRIGGER (with evidence: the changed files); "not created"
 * is a statement about GitHub. `UNKNOWN` is never converted to
 * `NOT_APPLICABLE` — that conversion is how a filter typo becomes a silent green.
 *
 * APPLICABILITY WITHOUT THE CHANGED FILE LIST
 *
 * Computing it needs the files the push changed. When they are not available the
 * honest answer is `UNKNOWN` for every filtered workflow, and `UNKNOWN` must be
 * resolved by WAITING, not by passing. `pushFiles()` obtains them from the API;
 * when it cannot, every caller sees `UNKNOWN` and the verdict cannot be VERIFIED.
 * That is deliberate: a verification that quietly degrades into "assume nothing
 * was owed" is the defect this module replaces.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../lib/workflow-yaml.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKFLOWS_DIR = join(HERE, '../../../.github/workflows');

export const APPLICABILITY = Object.freeze({
  REQUIRED: 'REQUIRED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN',
});

export const OBSERVATION = Object.freeze({
  NOT_CREATED: 'NOT_CREATED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  UNAVAILABLE: 'UNAVAILABLE',
});

/** A conclusion that means the run did not pass and was not merely replaced. */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']);

/**
 * GitHub's glob semantics for `paths:` / `paths-ignore:`.
 *
 * Deliberately the same translation `impact.mjs` and `check-paths-filters.mjs`
 * each carry: `**` crosses directories, `*` does not, `?` is one character, and
 * a bracket expression is a character class. The third copy is not ideal; the
 * alternative was to widen one of the other two into a shared module and change
 * what they import, and neither of them is being changed here. What matters for
 * this file is that the semantics are the ones the repository already uses, so
 * that a filter judged applicable here is judged applicable by the tools that
 * gate the merge.
 */
export function globToRegExp(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match nothing at all, so `apps/**​/x` matches `apps/x`.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 3; continue; }
        out += '.*'; i += 2; continue;
      }
      out += '[^/]*'; i += 1; continue;
    }
    if (ch === '?') { out += '[^/]'; i += 1; continue; }
    if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end !== -1) { out += glob.slice(i, end + 1); i = end + 1; continue; }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does a commit touching `files` make this trigger fire?
 *
 * @param {object} trigger the parsed `on.push` value
 * @param {string[]|null} files repository-relative changed paths, or null when
 *        the list is not available
 * @returns {{applicability: string, reason: string}}
 */
export function applicabilityOfPush(trigger, files) {
  if (!trigger || typeof trigger !== 'object') {
    // `push:` with no body (`push:` + nothing) fires for every branch. A `null`
    // trigger here means the workflow's push block was empty, which YAML allows
    // and GitHub reads as "all branches".
    return { applicability: APPLICABILITY.REQUIRED, reason: 'push trigger has no filters, so every push fires it' };
  }

  const branches = toList(trigger.branches);
  const branchesIgnore = toList(trigger['branches-ignore']);
  const tags = toList(trigger.tags);

  // A push whose only filter is `tags:` never fires for a branch push. This is
  // the `release-certification.yml` case the old code special-cased by looking
  // for the four-space string `tags:` — correct, but by coincidence of layout.
  if (tags.length && !branches.length && !branchesIgnore.length) {
    return {
      applicability: APPLICABILITY.NOT_APPLICABLE,
      reason: 'push trigger filters on tags only, and this is a branch push',
    };
  }
  if (branches.length && !branches.some((b) => globToRegExp(b).test('main'))) {
    return {
      applicability: APPLICABILITY.NOT_APPLICABLE,
      reason: `push trigger limits branches to ${branches.join(', ')}, which does not include main`,
    };
  }
  if (branchesIgnore.some((b) => globToRegExp(b).test('main'))) {
    return {
      applicability: APPLICABILITY.NOT_APPLICABLE,
      reason: `push trigger excludes main via branches-ignore (${branchesIgnore.join(', ')})`,
    };
  }

  const paths = toList(trigger.paths);
  const pathsIgnore = toList(trigger['paths-ignore']);
  if (!paths.length && !pathsIgnore.length) {
    return { applicability: APPLICABILITY.REQUIRED, reason: 'push trigger has no paths filter, so every push fires it' };
  }

  // Everything below needs the changed files. Without them the answer is unknown,
  // and unknown must be resolved by waiting rather than treated as not-owed.
  if (!Array.isArray(files)) {
    return {
      applicability: APPLICABILITY.UNKNOWN,
      reason: 'a paths filter applies and the changed files for this push are not available',
    };
  }

  if (paths.length) {
    const hit = paths.find((p) => {
      const negated = p.startsWith('!');
      const pattern = negated ? p.slice(1) : p;
      const re = globToRegExp(pattern);
      const matched = files.some((f) => re.test(f));
      return negated ? false : matched;
    });
    if (hit) return { applicability: APPLICABILITY.REQUIRED, reason: `push touched a path matching ${hit}` };
    return {
      applicability: APPLICABILITY.NOT_APPLICABLE,
      reason: `none of this push's ${files.length} changed file(s) match the trigger's paths filter`,
    };
  }

  // Only `paths-ignore`. It fires unless EVERY changed file matches an ignored
  // pattern. An empty file list is not evidence of that, so it is not "not owed".
  if (files.length === 0) {
    return { applicability: APPLICABILITY.UNKNOWN, reason: 'the push has no changed files recorded, so paths-ignore cannot be evaluated' };
  }
  const allIgnored = files.every((f) => pathsIgnore.some((p) => globToRegExp(p).test(f)));
  return allIgnored
    ? { applicability: APPLICABILITY.NOT_APPLICABLE, reason: 'every changed file matches the trigger\'s paths-ignore filter' }
    : { applicability: APPLICABILITY.REQUIRED, reason: 'at least one changed file is not covered by paths-ignore' };
}

function toList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

/**
 * Every workflow file, with the trigger set it declares.
 *
 * A file the shared parser refuses is reported as `unparsed`, NOT skipped. A
 * workflow that cannot be read is a workflow whose obligations are unknown, and
 * silently omitting it is the same shape as the defect above.
 *
 * @param {string} [workflowsDir]
 * @returns {Array<{workflow: string, triggers: object|null, unparsed: string|null}>}
 */
export function readWorkflowTriggers(workflowsDir = DEFAULT_WORKFLOWS_DIR) {
  const out = [];
  for (const file of readdirSync(workflowsDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    let text;
    try {
      text = readFileSync(join(workflowsDir, file), 'utf8');
    } catch (error) {
      out.push({ workflow: file, triggers: null, unparsed: `cannot read: ${error.message}` });
      continue;
    }
    const result = parse(text);
    if (!result.ok) {
      out.push({ workflow: file, triggers: null, unparsed: result.error });
      continue;
    }
    const on = result.value?.on;
    // `on:` can be a scalar (`on: push`), a sequence (`on: [push, pull_request]`),
    // or a mapping. Normalise all three to a mapping of event -> trigger.
    let triggers;
    if (typeof on === 'string') triggers = { [on]: null };
    else if (Array.isArray(on)) triggers = Object.fromEntries(on.map((e) => [String(e), null]));
    else if (on && typeof on === 'object') triggers = on;
    else triggers = {};
    out.push({ workflow: file, triggers, unparsed: null });
  }
  return out;
}

/**
 * The expected-workflow records for one push to `main`.
 *
 * @param {object} opts
 * @param {string} [opts.workflowsDir]
 * @param {string[]|null} [opts.files] changed paths; null when unavailable
 * @param {string} [opts.exclude] a workflow file that must never be in its own
 *        expectation set (the observer itself), or null
 * @returns {{expected: object[], selfReference: string[], unparsed: object[]}}
 */
export function expectedPushWorkflows({ workflowsDir = DEFAULT_WORKFLOWS_DIR, files = null, exclude = null } = {}) {
  const expected = [];
  const selfReference = [];
  const unparsed = [];

  for (const { workflow, triggers, unparsed: error } of readWorkflowTriggers(workflowsDir)) {
    if (error) { unparsed.push({ workflow, error }); continue; }
    if (!triggers || !Object.prototype.hasOwnProperty.call(triggers, 'push')) continue;

    if (exclude && workflow === exclude) {
      // The observer runs on this push, so it IS triggered — but a job cannot
      // wait for its own workflow, and listing it would make the expectation set
      // unsatisfiable. Recorded rather than dropped, because "we excluded it" and
      // "it does not apply" are different facts and only one is true.
      selfReference.push(workflow);
      continue;
    }

    const { applicability, reason } = applicabilityOfPush(triggers.push, files);
    expected.push({
      workflow,
      event: 'push',
      triggeredBy: Object.keys(triggers).sort(),
      applicability,
      expectedReason: reason,
    });
  }

  return { expected, selfReference, unparsed };
}

/**
 * Turn one workflow run into an observation. Kept a pure function so every case
 * in the test file drives the same mapping the CLI uses.
 *
 * @param {object|null} run the latest run for this workflow on this commit
 * @returns {{observation: string, detail: string}}
 */
export function observeRun(run) {
  if (!run) return { observation: OBSERVATION.NOT_CREATED, detail: 'no run for this workflow on this commit' };
  const status = String(run.status ?? '');
  const conclusion = run.conclusion === null || run.conclusion === undefined ? null : String(run.conclusion);
  if (status === 'completed') {
    if (conclusion === 'success') return { observation: OBSERVATION.SUCCESS, detail: 'completed success' };
    if (conclusion === 'timed_out') return { observation: OBSERVATION.TIMED_OUT, detail: 'completed timed_out' };
    if (conclusion === 'cancelled') return { observation: OBSERVATION.CANCELLED, detail: 'completed cancelled' };
    if (RED_CONCLUSIONS.has(conclusion)) return { observation: OBSERVATION.FAILURE, detail: `completed ${conclusion}` };
    // `neutral` / `skipped` are neither a pass nor a failure of the workflow, but
    // they are also not a verified result. UNAVAILABLE says exactly that.
    return { observation: OBSERVATION.UNAVAILABLE, detail: `completed with conclusion ${conclusion}` };
  }
  if (status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested') {
    return { observation: OBSERVATION.QUEUED, detail: `run is ${status}` };
  }
  if (status === 'in_progress') return { observation: OBSERVATION.RUNNING, detail: 'run is in_progress' };
  if (!status) return { observation: OBSERVATION.UNAVAILABLE, detail: 'run has no status field' };
  return { observation: OBSERVATION.UNAVAILABLE, detail: `run has unrecognised status ${status}` };
}

/**
 * A stable ordering for observations, so "the latest run wins" does not depend
 * on array order or on a timestamp GitHub does not promise to sort by.
 *
 * The old code compared `createdAt` with `>=`, which means two runs created in
 * the same second resolved to whichever happened to come last in the API
 * response — and a re-run keeps the SAME `createdAt` as the original, because it
 * is the same run. `attempt` is the field that actually distinguishes them.
 */
export function newerRun(a, b) {
  if (!a) return b;
  if (!b) return a;
  const attemptA = Number(a.attempt ?? 1);
  const attemptB = Number(b.attempt ?? 1);
  if (attemptA !== attemptB) return attemptA > attemptB ? a : b;
  const idA = String(a.runId ?? a.databaseId ?? '');
  const idB = String(b.runId ?? b.databaseId ?? '');
  if (idA !== idB) return idA > idB ? a : b;
  return b;
}
