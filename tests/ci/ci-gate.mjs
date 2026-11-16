#!/usr/bin/env node
/**
 * The merge gate: decide, from real job results, whether a pull request may merge.
 *
 * WHY THIS IS A SCRIPT AND NOT `needs:`
 *
 * GitHub's `needs` only orders jobs INSIDE one workflow. The suites this
 * repository needs live in nine workflow files, and no `needs:` can wait for
 * another workflow's run. A gate that claims to aggregate across workflows while
 * writing `needs: [rust, web]` would silently pass on the suites it cannot see.
 *
 * So the gate is a job in `ci.yml` that is handed the ACTUAL results of every job
 * it depends on, and it decides. It never inspects "the latest run" or another
 * workflow's timeline: it reads `needs.*.result`, which GitHub fills in for this
 * run, for this commit.
 *
 * THE THREE WAYS A GATE LIES, AND WHAT THIS DOES ABOUT EACH
 *
 *   1. A required job never ran (path filter, `if:`, workflow not triggered).
 *      GitHub reports a skipped job as `skipped`, not `success` — but a gate that
 *      only fails on `failure` would call it a pass. Here `skipped` is a FAIL for
 *      any suite the impact analyzer asked for, and only a note for one it did
 *      not.
 *
 *   2. A job "passed" without doing anything. `continue-on-error` turns a failed
 *      step into a successful job. The gate cannot see inside a job, so it cannot
 *      answer this. Nothing in this repository answers it today either: a
 *      `check-workflow-hygiene.mjs` was described here before it was written, and
 *      `docs/ci/failure-analysis.md` records that gap as open rather than assuming
 *      it closed. Until such a checker exists and runs in CI, a `continue-on-error`
 *      step is invisible to every merge gate in this repository.
 *
 *   3. The decision is made for the wrong commit. Everything here is scoped to
 *      `github.event.pull_request.head.sha`; the gate job has no way to look at
 *      another commit's results.
 *
 * WHAT "REQUIRED" MEANS
 *
 * The impact analyzer says which suites this change needs. The gate requires
 * exactly those, plus HARD_REQUIRED, which are required for every change
 * regardless of what the analyzer says. A suite the analyzer did not request may
 * be skipped, and the gate says so in its summary rather than pretending it ran.
 *
 * Usage:
 *   node tests/ci/ci-gate.mjs --needs-json '<json>' --impact-json '<json>'
 *   node tests/ci/ci-gate.mjs --selftest
 *
 * Exit: 0 pass, 1 fail, 2 bad usage.
 */

import { analyse, SUITES } from './impact.mjs';

/**
 * Suites that every pull request must run, whatever it changed.
 *
 * These are the checks that are already required by the branch ruleset, and the
 * ones that catch a repository-wide mistake no path filter can attribute:
 * formatting, typecheck, the coverage wiring itself.
 */
export const HARD_REQUIRED = [
  // Only the two that are about the CI wiring itself, and cost seconds.
  //
  // `rust`, `web` and `web-unit` used to be here. They are now decided by the
  // analyzer, which is what lets a documentation change skip them - measured at
  // 8/30 of recent commits actually requiring `rust`, against 30/30 running it.
  //
  // The risk this accepts: a change the analyzer maps to nothing (an IGNORED
  // path - docs, rules, root markdown) skips compilation entirely. That is the
  // point; a .md file cannot break a build. Anything NOT in IGNORED that the
  // rules do not cover turns every suite on (fail-closed), so the hole would be
  // a path someone deliberately added to IGNORED.
  //
  // What stays: these two are the checks that catch the CI wiring being wrong,
  // which is exactly the failure a "nothing needs to run" decision must not be
  // able to hide.
  'contracts',
  'spec-coverage',
];

/**
 * Job id -> suite name for the impact vocabulary.
 *
 * Every job of `ci.yml` that asserts something about a suite is here, not only
 * the seven the ruleset requires. Six of them (`zabbix-plugin`,
 * `b2-plugin-identity`, `g13a-roundtrip`, `g13a1-gateway`, `g13b14-claim`,
 * `g13b16-effect`, `g13b17-principal`, `artifact-budget`) run on every pull
 * request and were, until this map was completed, invisible to the gate: they
 * appeared in neither `required` nor `notes`, so a red one contributed nothing
 * to the decision. That is "a check the merge gate does not read", which is the
 * class of defect this whole overhaul exists to remove.
 *
 * A job with no obvious impact suite still needs an answer to "what breaks if it
 * is red". `artifact-budget` is mapped to `spec-coverage` because both are L0
 * policy about what the repository is allowed to contain; the security and
 * acceptance jobs are mapped to the suite they actually drive.
 *
 * Suites produced by ANOTHER workflow cannot be in this map - see `DELEGATED`.
 */
export const JOB_TO_SUITE = {
  rust: 'rust',
  web: 'web',
  'web-unit': 'web-unit',
  contracts: 'contracts',
  'spec-coverage': 'spec-coverage',
  'platform-only': 'platform-only',
  'platform-image-build': 'platform-image-build',
  'runtime-image-build': 'platform-image-build',
  'zabbix-plugin': 'plugin-lifecycle',
  'b2-plugin-identity': 'data-foundation',
  'g13a-roundtrip': 'data-foundation',
  'g13a1-gateway': 'g12-acceptance',
  'g13b14-claim': 'data-foundation',
  'g13b16-effect': 'data-foundation',
  'g13b17-principal': 'data-foundation',
  'artifact-budget': 'spec-coverage',
};

/** Suite -> the workflow outside ci.yml that produces it. */
export const DELEGATED = {
  'linux-runtime': 'platform-linux-acceptance.yml',
  'quality-faults': 'reliability.yml',
  'data-foundation': 'data-foundation.yml',
  'plugin-lifecycle': 'plugin-lifecycle.yml',
  'runtime-conformance': 'runtime-conformance.yml',
  'browser-e2e': 'data-foundation.yml',
  'g12-acceptance': 'g12-acceptance.yml',
};

/**
 * Suite -> the CHECK NAME a delegated workflow reports.
 *
 * `DELEGATED` names the workflow, which is not something GitHub's check-run API
 * can be asked about. The check-run API is keyed by check name, and the name is
 * the job's `name:` (or its id when it has none) - so it is often not the suite
 * name. `plugin-lifecycle.yml`'s job is named `full TypeScript lifecycle`;
 * `data-foundation.yml` reports `golden-path`.
 *
 * Two of these are ambiguous and are recorded as such rather than guessed:
 *
 *   data-foundation -> golden-path, legacy-regression. BOTH jobs run in that
 *   workflow and both must be green. browser-e2e maps to the same two, because
 *   the browser block is a step inside golden-path, not a job of its own.
 *
 * A suite with no entry here is one whose result the gate cannot attribute even
 * with the API, and it stays reported as delegated-unverified.
 */
export const DELEGATED_CHECKS = {
  'linux-runtime': ['linux-runtime'],
  'quality-faults': ['quality-faults'],
  'data-foundation': ['golden-path', 'legacy-regression'],
  'browser-e2e': ['golden-path'],
  'plugin-lifecycle': ['full TypeScript lifecycle'],
  'runtime-conformance': ['conformance'],
  'g12-acceptance': ['acceptance'],
};

/**
 * Decide what to do about the suites produced by other workflows, given the
 * check runs that exist on this commit.
 *
 * WHY THIS EXISTS
 *
 * `gate()` says "delegated" for seven suites and passes. That is honest, and it
 * is also the entire exploit surface of this design: a suite the impact analyzer
 * requires, whose workflow never started (a path filter that does not match a
 * file the analyzer mapped, a `paths:` typo, a workflow disabled in the UI),
 * produces no result for `ci-gate` to see — so it is reported as delegated and
 * the gate goes green. The analyzer and the filters are two hand-maintained
 * tables, and this audit measured 22 disagreements between them. Under the old
 * behaviour every one of those was a silent hole.
 *
 * The check-run API closes it, because it is keyed by (commit, check name) and
 * does not care which file the check came from. Anything a delegated workflow
 * produces appears there.
 *
 * STATES, and why "absent" is not "red":
 *
 *   verified     a check with that name succeeded on this commit.
 *   failed       it exists and did not succeed. A merge blocker.
 *   skipped      it exists and was skipped. A merge blocker for a required
 *                suite: "skipped" is the failure this gate exists to catch.
 *   pending      it exists and is still running (`queued`, `in_progress`,
 *                `waiting`, `requested`). NOT a failure, and NOT verified.
 *   absent       no check with that name on this commit. The workflow did not
 *                run for it. That is the hole described above, and it is
 *                reported as a FAIL.
 *
 * PENDING HAD TO BE SPLIT OUT, and the first version of this function got it
 * wrong. `ci-gate` lives in `ci.yml` and cannot wait on another workflow's run
 * (no cross-workflow `needs`), so it reads its siblings at whatever moment it
 * starts. Measured on this branch's first run with the check-run lookup: the gate
 * executed while `acceptance`, `full TypeScript lifecycle` and `golden-path` were
 * still `in_progress`, folded all three into `failed`, and went red against three
 * checks that then passed. It was the first red on a branch whose other 23 checks
 * were green, which is precisely the "the gate is broken" noise this file exists
 * to avoid.
 *
 * The property that matters is ABSENT: a workflow that never STARTED for a change
 * the analyzer required, so no result can ever exist. A workflow that started is a
 * different fact - it will produce a result, and the branch ruleset already
 * enforces the two that gate merges (`linux-runtime`, `quality-faults`). So
 * `pending` is reported, never counted as a pass, and does not fail this job.
 *
 * It is still not a pass: the gate prints `delegated-pending` for each, so a
 * reader of the summary can see the decision was made before those results
 * existed. `absent` remains a FAIL.
 *
 * @param {Record<string,string|null>} checks check name -> conclusion, from the
 *        API. A name that is not present at all is `null`; a name that is present
 *        but unfinished carries its status (`in_progress`, `queued`, ...).
 * @param {string[]} suites delegated suites the impact analyzer required
 * @returns {{verified: string[], failed: string[], skipped: string[], pending:
 *            string[], absent: string[], unverifiable: string[]}}
 */
const UNFINISHED = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export function delegatedVerdict(checks, suites) {
  const verified = [];
  const failed = [];
  const skipped = [];
  const pending = [];
  const absent = [];
  const unverifiable = [];
  for (const suite of suites) {
    const names = DELEGATED_CHECKS[suite];
    if (!names) { unverifiable.push(suite); continue; }
    const states = names.map((n) => [n, checks[n] ?? null]);
    const missing = states.filter(([, c]) => c === null).map(([n]) => n);
    const unfinished = states.filter(([, c]) => c !== null && UNFINISHED.has(c)).map(([n, c]) => `${n}: ${c}`);
    // A check that is skipped is red for this purpose even when a sibling is
    // still running: the answer for that facet is already known and it is "no".
    const skippedNow = states.filter(([, c]) => c === 'skipped').map(([n]) => n);
    const red = states.filter(([, c]) => c !== null && c !== 'success'
      && !UNFINISHED.has(c) && c !== 'skipped').map(([n, c]) => `${n}: ${c}`);

    if (skippedNow.length) { skipped.push(`${suite} (${skippedNow.join(', ')} was skipped)`); continue; }
    if (red.length) { failed.push(`${suite} (${red.join(', ')})`); continue; }
    if (unfinished.length) { pending.push(`${suite} (${unfinished.join(', ')}); the result did not exist when this gate ran`); continue; }
    if (missing.length) { absent.push(`${suite} (no check named ${missing.join(', ')} on this commit; ${DELEGATED[suite]} did not run for it)`); continue; }
    verified.push(suite);
  }
  return { verified, failed, skipped, pending, absent, unverifiable };
}

/**
 * @param {Record<string,string>} needs job id -> result ('success'|'failure'|'cancelled'|'skipped')
 * @param {{suites: Record<string, boolean>, unmatched: string[]}} impact
 * @returns {{verdict: 'PASS'|'FAIL', required: string[], failed: string[],
 *            skippedRequired: string[], notWired: string[], notes: string[]}}
 */
/**
 * Normalise `needs` to job id -> result string.
 *
 * `toJSON(needs)` in an Actions workflow does NOT produce `{"rust": "success"}`.
 * It produces `{"rust": {"result": "success", "outputs": {}}}`, and my first
 * version of this function compared that object to the string `'success'`,
 * so every job read as failed:
 *
 *     failed: rust (job rust: [object Object])
 *
 * measured on this branch's first real run (43695561054) - all nineteen checks
 * green, the gate red. Accepting both shapes keeps the unit tests readable while
 * handling what GitHub actually sends.
 */
export function normaliseNeeds(raw) {
  const out = {};
  for (const [jobId, value] of Object.entries(raw ?? {})) {
    if (value && typeof value === 'object' && 'result' in value) out[jobId] = String(value.result);
    else out[jobId] = String(value);
  }
  return out;
}

export function gate(rawNeeds, impact) {
  const needs = normaliseNeeds(rawNeeds);
  const required = new Set(HARD_REQUIRED);
  for (const suite of SUITES) {
    if (impact.suites[suite]) required.add(suite);
  }

  const failed = [];
  const skippedRequired = [];
  const notWired = [];
  const notes = [];
  const delegated = [];

  // suite -> every ci.yml job that asserts it. One suite can be asserted by
  // several jobs (`data-foundation` by five), and each one that ran is part of
  // the answer. An earlier version of this loop used
  // `Object.keys(JOB_TO_SUITE).find(...)`, which returns the FIRST match: with
  // more than one job per suite it would have read one and ignored the rest, so
  // a red `g13b17-principal` would have contributed nothing to the verdict.
  const ownedBySuite = {};
  for (const [jobId, suite] of Object.entries(JOB_TO_SUITE)) {
    (ownedBySuite[suite] ??= []).push(jobId);
  }

  // ---------------------------------------------------------------------------
  // PART 0 — wiring completeness, decided before anything else.
  //
  // Every job this map names must appear in `needs`. If one does not, the gate's
  // own `needs:` list is stale: `ci.yml` runs that job on every pull request but
  // the gate was never handed its result. Nothing downstream can notice — the
  // suite loop only iterates what is REQUIRED, and a dropped job is not in
  // `needs` for part 2 to iterate either. The omission would be entirely silent,
  // which is the one outcome a gate must never produce about itself.
  // ---------------------------------------------------------------------------
  for (const jobId of Object.keys(JOB_TO_SUITE)) {
    if (jobId in needs) continue;
    const suite = JOB_TO_SUITE[jobId];
    notWired.push(`${suite} (job ${jobId} is mapped but absent from needs: ${jobId} is not in ci-gate's needs list)`);
  }

  for (const suite of [...required].sort()) {
    const owned = ownedBySuite[suite] ?? [];

    if (owned.length === 0) {
      if (DELEGATED[suite]) {
        // Produced by another workflow. This gate cannot see it and must not
        // claim to have checked it.
        delegated.push(`${suite} -> ${DELEGATED[suite]}`);
        continue;
      }
      // Required, but no job here produces it and no other workflow is named.
      // That is a defect in the gate, and it must not read as "the suite was fine".
      notWired.push(suite);
      continue;
    }

    const present = owned.filter((j) => j in needs);
    const absent = owned.filter((j) => !(j in needs));
    if (absent.length > 0) {
      // The job exists in the workflow but the gate was not handed its result:
      // `needs:` is stale. Silently checking the others would report a suite as
      // verified when part of it was never read.
      notWired.push(`${suite} (job ${absent.join(', ')} not in needs)`);
    }
    if (present.length === 0) continue;

    for (const jobId of present) {
      const result = needs[jobId];
      if (result === 'success') continue;
      if (result === 'skipped') {
        // A skipped required job is the failure mode this gate exists for. GitHub
        // marks it `skipped`, and a gate that tests `!== 'failure'` passes it.
        skippedRequired.push(`${suite} (job ${jobId} was skipped)`);
        continue;
      }
      failed.push(`${suite} (job ${jobId}: ${result})`);
    }

    // Partly owned: this workflow asserts one facet of the suite, another
    // workflow asserts the rest. Say both, so neither is read as the whole.
    if (DELEGATED[suite]) {
      delegated.push(`${suite} (partly) -> ${DELEGATED[suite]}; this gate read ${present.join(', ')}`);
    }
  }

  // ---------------------------------------------------------------------------
  // PART 2 — every job the gate was handed must have succeeded.
  //
  // `ci.yml` has no path filter: all fifteen of its jobs run on every pull
  // request. So the question "did this change require that suite" is already
  // answered by GitHub — it ran the job. A job that ran and did not succeed is a
  // red check on this commit, and a merge gate that reads it and then does
  // nothing is worse than no gate, because the check list looks covered.
  //
  // Part 1 above decides "did every suite this change requires get a result".
  // That alone is not enough: before this part existed, `JOB_TO_SUITE` named only
  // the seven ruleset-required jobs, so a red `g13b17-principal` — a required-
  // looking check that runs on every PR — produced a green gate. The map now
  // names all fifteen; this loop makes the map's completeness load-bearing
  // instead of decorative, and an unmapped job is reported rather than dropped.
  // ---------------------------------------------------------------------------
  for (const [jobId, result] of Object.entries(needs)) {
    if (jobId === 'ci-gate') continue;
    const suite = JOB_TO_SUITE[jobId];

    if (suite && !required.has(suite)) {
      // It ran even though the impact analyzer did not ask for it. It still has
      // to be green: it is a check on this commit either way.
      if (result === 'skipped') {
        notes.push(`${suite} (job ${jobId}) skipped, which this change did not require`);
        continue;
      }
      if (result !== 'success') {
        failed.push(`${suite} (job ${jobId}: ${result}; ran on this commit although the change did not require it)`);
      }
      continue;
    }
    if (suite) continue; // required, already decided in part 1

    // No mapping at all. A new job in ci.yml that nobody mapped is a check the
    // gate cannot attribute. It is a FAIL when red — the gate must not be the
    // place a red check goes to be forgotten — and a note when green, so adding
    // one is visible in the summary rather than only in a review of this file.
    if (result === 'success') {
      notes.push(`${jobId} is not mapped to an impact suite; the gate cannot attribute its result`);
    } else {
      failed.push(`${jobId}: ${result}; this job is not mapped to an impact suite, but it ran on this commit`);
    }
  }

  if (impact.unmatched.length > 0) {
    notes.push(`unmapped paths forced every suite on: ${impact.unmatched.join(', ')}`);
  }

  const verdict = failed.length || skippedRequired.length || notWired.length ? 'FAIL' : 'PASS';
  return {
    verdict,
    required: [...required].sort(),
    failed,
    skippedRequired,
    notWired,
    delegated,
    notes,
  };
}

/**
 * A `needs` object with every job `ci.yml` owns green.
 *
 * Built from JOB_TO_SUITE rather than spelled out, so adding a job to the map
 * cannot leave these fixtures asserting a wiring that no longer exists. The
 * previous fixtures listed seven job ids by hand; when the map grew to fifteen,
 * five cases started failing with `notWired` - the selftest caught it, which is
 * what it is for, but the failure was in the fixtures and not the gate.
 */
const ALL_OWNED_GREEN = Object.fromEntries(Object.keys(JOB_TO_SUITE).map((j) => [j, 'success']));

const ALL_SUITES_ON = { suites: Object.fromEntries(SUITES.map((s) => [s, true])), unmatched: [] };
const ALL_SUITES_OFF = { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] };

const SELFTEST = [
  {
    name: 'all required green',
    needs: ALL_OWNED_GREEN,
    impact: ALL_SUITES_ON,
    want: 'PASS',
  },
  {
    name: 'rust failed',
    because: 'failed',
    needs: { ...ALL_OWNED_GREEN, rust: 'failure' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  // A required suite SKIPPED -> fail. This is the counterfactual that matters:
  // a gate written `result !== 'failure'` passes this one, which is exactly how
  // a path filter or an `if:` becomes a silent hole in the merge gate.
  {
    // `contracts` is still HARD_REQUIRED; `rust` is not, because a docs change
    // legitimately skips it. A skipped hard-required suite must fail.
    name: 'a hard-required suite skipped',
    because: 'skipped',
    needs: { ...ALL_OWNED_GREEN, contracts: 'skipped' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    // And the counterpart: `rust` skipped is now LEGITIMATE when the analyzer did
    // not require it. If this ever fails, someone re-added rust to HARD_REQUIRED
    // without meaning to - or the analyzer stopped mapping .md to nothing.
    name: 'rust skipped on a change that does not require it',
    needs: { ...ALL_OWNED_GREEN, rust: 'skipped' },
    impact: ALL_SUITES_OFF,
    want: 'PASS',
  },
  // A required suite CANCELLED -> fail, and classified as failed rather than
  // skipped: the job started and was interrupted, which is not the same as
  // never having been asked to run.
  {
    name: 'rust cancelled',
    because: 'failed',
    needs: { ...ALL_OWNED_GREEN, rust: 'cancelled' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    // The suite must be one this workflow OWNS. A delegated suite being skipped
    // is not this gate's failure to report - it cannot see that workflow run.
    name: 'impact-required suite skipped',
    because: 'skipped',
    needs: { ...ALL_OWNED_GREEN, 'platform-only': 'skipped' },
    impact: { ...ALL_SUITES_OFF, suites: { ...ALL_SUITES_OFF.suites, 'platform-only': true } },
    want: 'FAIL',
  },
  {
    name: 'non-required suite skipped',
    needs: ALL_OWNED_GREEN,
    impact: ALL_SUITES_OFF,
    want: 'PASS',
  },
  {
    name: 'required suite not wired',
    because: 'notWired',
    needs: { web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    name: 'unmapped path with all wired green',
    needs: ALL_OWNED_GREEN,
    impact: { ...ALL_SUITES_ON, unmatched: ['x/y.bin'] },
    want: 'PASS',
  },
  // THE SHAPE GITHUB ACTUALLY SENDS.
  //
  // Every other case here passes `{"rust": "success"}`, which is not what
  // `toJSON(needs)` produces. That is why the selftest passed while the gate
  // reported `rust (job rust: [object Object])` on its first real run: the tests
  // and the workflow were feeding it different data and only the workflow was
  // right. This case is the workflow's shape.
  {
    name: 'real toJSON(needs) shape: objects with result and outputs',
    needs: Object.fromEntries(Object.entries(ALL_OWNED_GREEN).map(([j, r]) => [j, { result: r, outputs: {} }])),
    impact: ALL_SUITES_ON,
    want: 'PASS',
  },
  {
    name: 'real shape: a failure inside the object is still a failure',
    because: 'failed',
    needs: Object.fromEntries(Object.entries({ ...ALL_OWNED_GREEN, rust: 'failure' }).map(([j, r]) => [j, { result: r, outputs: {} }])),
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    name: 'real shape: a skipped object is still skipped, not a pass',
    because: 'skipped',
    needs: Object.fromEntries(Object.entries({ ...ALL_OWNED_GREEN, contracts: 'skipped' }).map(([j, r]) => [j, { result: r, outputs: {} }])),
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  // A delegated suite the impact analyzer required is REPORTED, not treated as
  // either a pass or a wiring defect. Silently dropping it would be the fake
  // aggregate the overhaul brief forbids; failing on it would block every
  // high-risk PR forever.
  {
    name: 'delegated suite is reported, not a failure',
    needs: ALL_OWNED_GREEN,
    impact: { ...ALL_SUITES_OFF, suites: { ...ALL_SUITES_OFF.suites, 'linux-runtime': true } },
    want: 'PASS',
    because: 'delegated',
  },
  // ---------------------------------------------------------------------------
  // Every ci.yml job that runs is read by the gate.
  //
  // These are the cases that would have caught the defect this selftest suite
  // was extended for: the map used to name only the seven ruleset-required jobs,
  // so eight jobs ran on every pull request and contributed nothing to the
  // verdict. A red `g13b17-principal` produced a green gate.
  // ---------------------------------------------------------------------------
  {
    name: 'a NOISE job of ci.yml failing still fails the gate',
    because: 'failed',
    // data-foundation is asserted by five jobs; one of them red is enough.
    needs: { ...ALL_OWNED_GREEN, 'g13b17-principal': 'failure' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    name: 'a suite asserted by several jobs is green only if every one is',
    // Four of the five data-foundation jobs green, one skipped, and the suite IS
    // required for this change. The skipped job is enough to fail it: a suite is
    // verified only when every job that asserts it ran.
    because: 'skipped',
    needs: { ...ALL_OWNED_GREEN, 'g13b14-claim': 'skipped' },
    impact: { ...ALL_SUITES_OFF, suites: { ...ALL_SUITES_OFF.suites, 'data-foundation': true } },
    want: 'FAIL',
  },
  {
    name: 'a job the map names but needs omits is NOT silently ignored',
    because: 'notWired',
    needs: Object.fromEntries(Object.entries(ALL_OWNED_GREEN).filter(([j]) => j !== 'g13b16-effect')),
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
  },
  {
    name: 'an unmapped job in needs is reported as unattributed',
    needs: { ...ALL_OWNED_GREEN, 'brand-new-job': 'success' },
    impact: ALL_SUITES_OFF,
    want: 'PASS',
    becauseNotes: /brand-new-job is not mapped/,
  },
  {
    name: 'an unmapped job FAILING fails the gate, not just a note',
    because: 'failed',
    // It ran on this commit and it is red. Whether anyone mapped it is a defect
    // in the map, and the gate must not be where a red check is forgotten.
    needs: { ...ALL_OWNED_GREEN, 'brand-new-job': 'failure' },
    impact: ALL_SUITES_OFF,
    want: 'FAIL',
    becauseFailed: /brand-new-job: failure/,
  },
];

/**
 * Counterfactuals for `delegatedVerdict`.
 *
 * These are the cases that decide whether "delegated" is a statement of fact or
 * an escape hatch. Each `suites` list is what the analyzer required; each `checks`
 * object is what the API returned for this commit.
 */
const DELEGATED_SELFTEST = [
  {
    name: 'delegated: every check present and green verifies',
    suites: ['linux-runtime', 'quality-faults'],
    checks: { 'linux-runtime': 'success', 'quality-faults': 'success' },
    want: { verified: 2, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // The hole the API exists to close: the analyzer requires the suite, the
    // workflow never ran, and there is no check to be red.
    name: 'delegated: a suite with no check on this commit is ABSENT, not green',
    suites: ['data-foundation'],
    checks: {},
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 1, unverifiable: 0 },
  },
  {
    name: 'delegated: a red check is a failure',
    suites: ['runtime-conformance'],
    checks: { conformance: 'failure' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // `skipped` must never read as success here either. It is the same failure
    // mode as a skipped required job inside ci.yml. It has its own bucket now, so
    // a reader can tell "was skipped" from "ran and failed".
    name: 'delegated: a skipped check is a failure, in its own bucket',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'skipped' },
    want: { verified: 0, failed: 0, skipped: 1, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    name: 'delegated: a cancelled check is a failure',
    suites: ['g12-acceptance'],
    checks: { acceptance: 'cancelled' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // data-foundation is asserted by TWO jobs; one green is not the suite green.
    name: 'delegated: a suite with two producing jobs needs both',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'success', 'legacy-regression': 'failure' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    name: 'delegated: a suite with two producing jobs and only one present is absent',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'success' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 1, unverifiable: 0 },
  },
  {
    // browser-e2e is a step inside golden-path, not a job of its own. It maps to
    // the same check, and this case records that so a later reader does not
    // "fix" the map by inventing a check name that will never exist.
    name: 'delegated: browser-e2e is read from golden-path',
    suites: ['browser-e2e'],
    checks: { 'golden-path': 'success' },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // The API reports a run that has started but not finished as its STATUS, not
    // its conclusion. Measured live in the gate's own log:
    // {"acceptance":"in_progress","golden-path":"in_progress"}. `in_progress` and
    // `queued` are not successes and must not be read as one - but they are not
    // failures either. `ci-gate` cannot wait on another workflow's run, so it
    // necessarily sees its siblings mid-flight; folding that into `failed` made it
    // the first red on a branch whose other 23 checks were green.
    name: 'delegated: a check still in progress is PENDING, not a failure',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'in_progress', 'legacy-regression': 'queued' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 1, absent: 0, unverifiable: 0 },
  },
  {
    // The dangerous mixture: one facet already answered "no" while the other is
    // still running. The known answer wins - waiting cannot turn skipped into
    // success.
    name: 'delegated: a skipped facet is a failure even while a sibling runs',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'in_progress', 'legacy-regression': 'skipped' },
    want: { verified: 0, failed: 0, skipped: 1, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // Same for a hard failure next to an unfinished one.
    name: 'delegated: a red facet is a failure even while a sibling runs',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'in_progress', 'legacy-regression': 'failure' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    name: 'delegated: a suite with no check mapping is reported unverifiable',
    suites: ['a-suite-nobody-mapped'],
    checks: { anything: 'success' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 1 },
  },
];

function selftest() {
  let bad = 0;
  for (const c of SELFTEST) {
    const got = gate(c.needs, c.impact);
    const okVerdict = got.verdict === c.want;
    // A verdict alone is not enough: three different defects all produce FAIL, and
    // a gate that fails for the wrong reason passes this selftest while being
    // wrong. Assert the reason too.
    let okReason = true;
    if (c.because === 'skipped') okReason = got.skippedRequired.length > 0 && got.failed.length === 0;
    else if (c.because === 'failed') okReason = got.failed.length > 0 && got.skippedRequired.length === 0;
    else if (c.because === 'notWired') okReason = got.notWired.length > 0 && got.failed.length === 0;
    else if (c.because === 'delegated') okReason = got.delegated.length > 0 && got.failed.length === 0;
    // A PASS can still be wrong in the notes: an unmapped job must be named, not
    // silently dropped. `becauseNotes` is how a case asserts what the reader of
    // the Actions summary will actually see.
    if (c.becauseNotes) okReason = okReason && c.becauseNotes.test(got.notes.join('\n'));
    // Same idea for the failure text: a FAIL for the right verdict and the wrong
    // reason is the defect class this whole file exists to prevent.
    if (c.becauseFailed) okReason = okReason && c.becauseFailed.test(got.failed.join('\n'));
    const ok = okVerdict && okReason;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ${c.want}${c.because ? ` because ${c.because}` : ''}, got ${got.verdict} (failed=${got.failed.length} skipped=${got.skippedRequired.length} notWired=${got.notWired.length} delegated=${got.delegated.length})\n`);
  }
  for (const c of DELEGATED_SELFTEST) {
    const got = delegatedVerdict(c.checks, c.suites);
    const ok = got.verified.length === c.want.verified
      && got.failed.length === c.want.failed
      && got.skipped.length === c.want.skipped
      && got.pending.length === c.want.pending
      && got.absent.length === c.want.absent
      && got.unverifiable.length === c.want.unverifiable;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ${JSON.stringify(c.want)}, got verified=${got.verified.length} failed=${got.failed.length} skipped=${got.skipped.length} pending=${got.pending.length} absent=${got.absent.length} unverifiable=${got.unverifiable.length}\n`);
  }
  const total = SELFTEST.length + DELEGATED_SELFTEST.length;
  process.stdout.write(bad === 0 ? `gate selftest: ${total}/${total} pass\n` : `gate selftest: ${bad} FAILED\n`);
  return bad === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();

  let needsJson = null;
  let impactJson = null;
  let checksJson = null;
  let files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--needs-json') { needsJson = argv[++i]; }
    else if (argv[i] === '--impact-json') { impactJson = argv[++i]; }
    else if (argv[i] === '--checks-json') { checksJson = argv[++i]; }
    else if (argv[i] === '--files') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) files.push(argv[++i]); }
    else { process.stderr.write(`ci-gate: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!needsJson) { process.stderr.write('ci-gate: --needs-json is required\n'); return 2; }

  let needs;
  try { needs = JSON.parse(needsJson); } catch { process.stderr.write('ci-gate: --needs-json is not JSON\n'); return 2; }
  const impact = impactJson ? JSON.parse(impactJson) : analyse(files);

  const result = gate(needs, impact);
  let verdict = result.verdict;

  // The delegated suites: `gate()` can only say "another workflow owns this".
  // With the check-run results for THIS commit it can say whether they passed.
  // Without them it still reports each one, but as unverified - it never claims
  // a suite it did not read.
  let del = null;
  if (checksJson !== null) {
    let checks;
    try { checks = JSON.parse(checksJson); } catch { process.stderr.write('ci-gate: --checks-json is not JSON\n'); return 2; }
    const requiredDelegated = result.delegated
      .map((line) => line.split(' ')[0])
      .filter((s) => s in DELEGATED_CHECKS);
    del = delegatedVerdict(checks, requiredDelegated);
    // `pending` is NOT a failure: the workflow started, so a result will exist.
    // `skipped` and `absent` are, and `absent` is the one this lookup exists for.
    if (del.failed.length || del.skipped.length || del.absent.length) verdict = 'FAIL';
  }

  const out = { ...result, verdict };
  if (del) out.delegatedResults = del;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`\nverdict: ${verdict}\n`);
  if (del) {
    for (const v of del.verified) process.stdout.write(`  delegated-verified: ${v}\n`);
    for (const f of del.failed) process.stdout.write(`  delegated-failed: ${f}\n`);
    for (const s of del.skipped) process.stdout.write(`  delegated-skipped: ${s}\n`);
    for (const p of del.pending) process.stdout.write(`  delegated-pending: ${p}\n`);
    for (const a of del.absent) process.stdout.write(`  delegated-absent: ${a}\n`);
    for (const u of del.unverifiable) process.stdout.write(`  delegated-unverifiable: ${u}\n`);
  }
  if (verdict === 'FAIL') {
    for (const f of result.failed) process.stdout.write(`  failed: ${f}\n`);
    for (const s of result.skippedRequired) process.stdout.write(`  skipped: ${s}\n`);
    for (const n of result.notWired) process.stdout.write(`  not wired: ${n}\n`);
    for (const d of result.delegated) process.stdout.write(`  out of scope: ${d}\n`);
    return 1;
  }
  for (const d of result.delegated) process.stdout.write(`  delegated: ${d}\n`);
  for (const n of result.notes) process.stdout.write(`  note: ${n}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
