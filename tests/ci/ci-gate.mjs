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

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyse, SUITES } from './impact.mjs';
import { attributeChecks, cancellationReason, checkState, UNFINISHED_STATUS } from './check-run-ledger.mjs';
import { awaitDelegated, DEFAULT_BUDGET_MS } from './await-delegated.mjs';

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
  // L0 static checks. Mapped to `spec-coverage`, which is itself a required
  // context and is the suite that owns "the repository's own tooling is sound".
  // An unmapped job is a note when green and a FAIL when red; mapping it makes
  // the gate's own completeness check cover it.
  lint: 'spec-coverage',
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
  // `artifact-budget` is GONE AS A JOB, not as a check. Its step folded into the
  // `spec-coverage` job (a 7-second check that waited 480s for a runner in a
  // 19-job fanout); the suite is still produced, by `spec-coverage` itself.
  //
  // Deleting the entry is required rather than tidy: the gate asserts that every
  // mapped job appears in its own `needs:` list, so a mapping for a job that no
  // longer exists reports `not wired: spec-coverage (job artifact-budget is
  // mapped but absent from needs)` - which is exactly what this change hit on
  // its first CI run.
};

/** Suite -> the workflow outside ci.yml that produces it. */
export const DELEGATED = {
  'linux-runtime': 'platform-linux-acceptance.yml',
  'quality-faults': 'reliability.yml',
  'data-foundation': 'data-foundation.yml',
  'plugin-lifecycle': 'plugin-lifecycle.yml',
  'runtime-conformance': 'runtime-conformance.yml',
  // `browser-e2e` is produced by whichever workflow actually runs Playwright for
  // the changed tree. For `packages/**` and both web apps that is
  // `g12-acceptance.yml`, not `data-foundation.yml`: data-foundation's
  // `pull_request.paths` does not match `packages/**` at all, so demanding its
  // check name for a platform-client change failed the gate with
  // `delegated-absent: browser-e2e (no check named golden-path)` on PR #127.
  //
  // The suite name is coarse - two workflows can both run a browser - and the
  // honest fix is to name the one the analyzer's rules actually point at. If a
  // path starts requiring browser-e2e from data-foundation, it needs its own
  // suite name rather than widening this map.
  // TWO producers, and that is the accurate statement rather than a shortcut.
  //
  // `browser-e2e` is the suite "a browser ran against this tree". Two workflows
  // do that for different inputs: `g12-acceptance.yml` for packages/** and the
  // two web apps, `data-foundation.yml` (RUN_BROWSER_SMOKE=1, four Playwright
  // specs) for tests/ui/**, tests/acceptance/** and the lockfile. Neither one
  // covers the other's paths.
  //
  // Naming a single producer was wrong in both directions: data-foundation made
  // PR #127 fail with delegated-absent for a packages/** change, and
  // g12-acceptance would do the same for a tests/ui change. The consensus rule
  // below (ANY producer's check being green satisfies the suite) is what a shared
  // suite name has to mean.
  'browser-e2e': ['g12-acceptance.yml', 'data-foundation.yml'],
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
  // Any ONE of these satisfies browser-e2e (see REQUIRE_ALL_CHECKS).
  'browser-e2e': ['acceptance', 'golden-path'],
  'plugin-lifecycle': ['full TypeScript lifecycle'],
  'runtime-conformance': ['conformance'],
  'g12-acceptance': ['acceptance'],
};

/**
 * Suite -> (check name -> the workflow that must have produced it).
 *
 * THE TABLE ABOVE IS DERIVED FROM THIS ONE, not maintained beside it. Two tables
 * that both claim to say which check belongs to which suite is the same shape as
 * the analyzer/filter drift this whole file exists to catch - and it would drift
 * the same way, silently, because nothing compares them.
 *
 * The workflow is what makes an attribution claim checkable. `acceptance` is
 * produced by `g12-acceptance.yml`; if `data-foundation.yml` ever grew a job by
 * that name, a name-only lookup would credit whichever started later. A red
 * required check could then be masked by a green impostor - and this session has
 * already been bitten by a gate reading the wrong thing and reporting success.
 */
export const DELEGATED_CHECK_OWNERS = {
  'linux-runtime': { 'linux-runtime': 'platform-linux-acceptance.yml' },
  'quality-faults': { 'quality-faults': 'reliability.yml' },
  'data-foundation': {
    'golden-path': 'data-foundation.yml',
    'legacy-regression': 'data-foundation.yml',
  },
  'browser-e2e': {
    acceptance: 'g12-acceptance.yml',
    'golden-path': 'data-foundation.yml',
  },
  'plugin-lifecycle': { 'full TypeScript lifecycle': 'plugin-lifecycle.yml' },
  'runtime-conformance': { conformance: 'runtime-conformance.yml' },
  'g12-acceptance': { acceptance: 'g12-acceptance.yml' },
};

// The derived view, asserted equal to the hand-written table above by the
// selftest, so the two cannot disagree without a red test.
export const DELEGATED_CHECKS_FROM_OWNERS = Object.fromEntries(
  Object.entries(DELEGATED_CHECK_OWNERS).map(([suite, owners]) => [suite, Object.keys(owners)]),
);

/**
 * Suites whose listed checks are ALTERNATIVES rather than facets.
 *
 * `data-foundation` is a facet case: one suite, two jobs that both run, and both
 * must be green - `golden-path` passing says nothing about `legacy-regression`.
 *
 * `browser-e2e` is not. It means "a browser ran against this tree", and two
 * workflows do that for disjoint inputs. A packages/** change starts
 * g12-acceptance and not data-foundation; a tests/ui change does the reverse.
 * Requiring both would demand a check that could not exist - the same defect that
 * failed PR #127 in the other direction.
 *
 * So the default is ALL (a facet is the more common shape and the stricter one),
 * and a suite named here is satisfied by any one green check.
 *
 * WHAT "ANY" MUST NOT MEAN, AND DID
 *
 * The first implementation tested `green.length` FIRST and continued on a hit, so
 * a red alternative was never looked at. Measured through `gate()` itself:
 *
 *   packages/** change, `acceptance` = failure, `golden-path` = success  -> PASS
 *   packages/** change, `acceptance` never ran,      `golden-path` = success -> PASS
 *
 * The first is a red required check reported green. The second is worse: DELETING
 * the `acceptance` job left the suite passing, because the missing check it was
 * meant to demand was excused by the one check that did run. `PART 3` cannot catch
 * either - it opens by skipping every name in `DELEGATED_CHECK_OWNERS`, so
 * `acceptance` is invisible there too.
 *
 * The tolerance the disjoint inputs actually require is "a producer whose paths do
 * not match this change does not start, and that is not a failure". It is NOT
 * "a producer that DID start and went red is ignored because a different producer
 * was green". So the alternatives are read as:
 *
 *   any red          -> FAIL   (a check that ran and failed is never excused)
 *   any green        -> PASS   (the changing-path producer ran and passed)
 *   none ran at all  -> PASS   (neither producer's paths matched this change)
 *
 * An absent alternative no longer distinguishes "its paths did not match" from
 * "the job was deleted", which is why the static check
 * `tests/ci/check-gate-contract.mjs` asserts that every name these tables key on
 * still exists as a job in the workflow that owns it. That is the right place for
 * it: absence is a property of the TREE, and the runtime gate only sees a commit.
 */
export const REQUIRE_ANY_CHECK = new Set(['browser-e2e']);

/**
 * WHICH GATE OWNS WHICH WORKFLOW. Three different questions, three different
 * owners, and conflating them is how a staging outage became a merge blocker.
 *
 *   MERGE GATE      - is this code safe to merge? Pre-merge quality, security and
 *                     the acceptance the impact analyzer requires.
 *   RELEASE GATE    - is this artifact what it claims to be? Identity, build
 *                     completeness, signature.
 *   DEPLOYMENT GATE - did it actually deploy and stay healthy?
 *
 * `ci-gate` is the MERGE gate. It must decide (1) and must NOT decide (2) or (3):
 * a failed staging deploy is a fact about the environment, not about the patch,
 * and a PR whose code is fine must remain mergeable while the deployment is being
 * fixed.
 *
 * ATTRIBUTION IS BY WORKFLOW IDENTITY, not by check name. A check name is a
 * string an author chooses; two workflows can produce the same one, and a workflow
 * can rename a job without anyone noticing. The workflow FILE is what `ci-gate`
 * can attribute through `check_suite.id -> workflow_runs[].path`, and it is what
 * this table keys on.
 *
 * WHY NOT "ignore every unknown check": that is the opposite failure. A new CI job
 * nobody mapped would go silently unnoticed, and the gate would pass while a
 * required check was red. `OWNERSHIP_COMPLETENESS` below is what stops that: every
 * workflow file in the repository must appear in this table, and the selftest
 * fails if one does not.
 */
/**
 * `ci-gate`'s own job budget in `ci.yml`, and how much of it the wait must leave
 * free for checkout plus the check-run/ledger reads.
 *
 * These are duplicated numbers - `timeout-minutes: 45` cannot be imported from
 * YAML - so they are asserted against the file by the selftest instead of being
 * trusted. The pair only exists so an operator who raises `GATE_BUDGET_MS` gets a
 * CONFIGURATION_ERROR instead of a job killed at 45 minutes reporting `cancelled`.
 */
export const GATE_JOB_TIMEOUT_MS = 110 * 60 * 1000;
export const GATE_TIMEOUT_SLACK_MS = 10 * 60 * 1000;

export const GATE_OWNERSHIP = {
  // --- MERGE GATE: a red check here blocks the merge -------------------------
  'ci.yml': 'merge',
  // Suites in their own workflow files, produced for specific paths. Whether one
  // is REQUIRED is decided by the impact analyzer, not by this table.
  'data-foundation.yml': 'merge',
  'g12-acceptance.yml': 'merge',
  'plugin-lifecycle.yml': 'merge',
  'runtime-conformance.yml': 'merge',
  'reliability.yml': 'merge',
  'platform-linux-acceptance.yml': 'merge',
  'typed-pipeline-contracts.yml': 'merge',

  // --- DEPLOYMENT GATE: reported, never a merge blocker ----------------------
  //
  // `staging-preview.yml` builds a release image, deploys it to the staging host,
  // smokes it, and records evidence. Every one of those is a statement about the
  // HOST. A PR is not unmergeable because the staging node is full.
  //
  // This is not a relaxation: the checks in this workflow were never merge
  // criteria. Before this table existed, PART 3 treated their failure as a merge
  // failure - which meant one full staging node would have blocked every code
  // change on the repository once `ci-gate` became required.
  'staging-preview.yml': 'deployment',
};

/**
 * Workflows that must exist in `.github/workflows/` but produce no check this
 * gate reads. Kept explicit so `OWNERSHIP_COMPLETENESS` can still demand an entry
 * for them - an unlisted file is the blind spot, not an unlisted check.
 */
export const NON_GATE_WORKFLOWS = {
  // Certification, not a merge criterion. It runs on a tag or an explicit
  // dispatch, produces a receipt, and decides nothing about whether code may
  // merge - a commit that fails certification can still be merged (ADR-029).
  'release-certification.yml': 'certification only; never a merge criterion',
};

/**
 * Workflows with NO `pull_request.paths` filter, so they start for every PR.
 *
 * Derived from the files rather than trusted, by `check-gate-contract.mjs`: an
 * entry here that HAS grown a path filter would silently exempt its checks from
 * PART 3's attribution, and a file that lost its filter without being added here
 * would make that check a merge criterion for documentation edits.
 *
 * `ci.yml` is not in this set - it has no filter either, but its jobs are decided
 * by `JOB_TO_SUITE` in parts 1 and 2, and PART 3 must never re-attribute them.
 */
export const UNFILTERED_ON_PR = [
  'platform-linux-acceptance.yml',
  'reliability.yml',
];

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
 *            string[], absent: string[], unverifiable: string[], impostor:
 *            string[], ambiguous: string[]}}
 */
const UNFINISHED = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/**
 * Fold a flat name -> conclusion map into the ledger shape.
 *
 * `delegatedVerdict` used to take this map directly. It no longer can, because a
 * flat map has already thrown away the two facts that decide the hard cases: the
 * attempt history behind a re-run, and which workflow produced the check. Kept as
 * a named adapter rather than an inline literal so the lossiness is visible: any
 * caller still holding a flat map gets `workflow: null`, which the verdict
 * reports as `ambiguous` when a name has several producers and as normal
 * `absent`/`success` when it has one.
 */
export function ledgerFromFlat(checks) {
  const byName = {};
  for (const [name, state] of Object.entries(checks ?? {})) {
    if (state === null || state === undefined) continue;
    byName[name] = [{ name, state: String(state), status: String(state), conclusion: null, workflow: null, suiteId: null, startedAt: null, runId: null }];
  }
  return { byName, unattributed: [], duplicates: [], suites: {} };
}

/**
 * Decide each delegated suite from the ledger.
 *
 * THE STATES, and why `pending` is no longer a PASS:
 *
 *   verified      every facet (or, for an alternative suite, one alternative) is
 *                 `success` on this commit, produced by the workflow that owns it.
 *   failed        it exists and did not pass. A merge blocker.
 *   skipped       it exists and was skipped. A merge blocker for a required suite.
 *   pending       still running when the caller gave up waiting. THE CALLER NOW
 *                 WAITS (`await-delegated.mjs`), and a suite still unfinished
 *                 after the budget is a `timeout`, not a pass.
 *   absent        no check with that name on this commit. The workflow did not run.
 *   impostor      a check with that name exists, produced by a DIFFERENT workflow
 *                 than the one that owns the suite.
 *   ambiguous     the name has producers in more than one workflow and the caller
 *                 did not say which one it wanted.
 *   unverifiable  the suite has no check mapping at all.
 *
 * `pending` is retained as a state because a caller may still choose to read
 * without waiting (the CLI's `--no-wait`). In that mode it is reported and does
 * not fail - but it is never a pass, and the CLI prints the explicit warning that
 * the decision was made before the result existed.
 */
export function delegatedVerdict(checks, suites) {
  const ledger = checks && checks.byName ? checks : ledgerFromFlat(checks);
  const verified = [];
  const failed = [];
  const skipped = [];
  const pending = [];
  const absent = [];
  const unverifiable = [];
  const impostor = [];
  const ambiguous = [];

  for (const suite of suites) {
    const owners = DELEGATED_CHECK_OWNERS[suite];
    if (!owners) { unverifiable.push(suite); continue; }
    const names = Object.keys(owners);

    const states = names.map((n) => [n, checkState(ledger.byName, n, { workflow: owners[n] })]);
    const byState = (s) => states.filter(([, st]) => st.state === s).map(([n, st]) => `${n}: ${st.reason}`);

    const green = states.filter(([, st]) => st.state === 'success').map(([n]) => n);
    // A red row says WHY when the check was cancelled: "superseded", "unanswered",
    // "manual". The VERDICT is unchanged - `cancelled` stays red - but a reader can
    // tell "another attempt re-answered this" from "nothing ever answered it",
    // which are the same word in the summary today.
    const red = states
      .filter(([, st]) => st.state === 'failed')
      .map(([n, st]) => {
        if (!/cancelled/i.test(st.reason ?? '')) return `${n}: ${st.reason}`;
        const runsForName = ledger.byName[n] ?? [];
        const target = runsForName.find((r) => r.state === 'cancelled');
        const why = target ? cancellationReason(runsForName, target) : null;
        return `${n}: ${st.reason} [${why ?? 'unattributed'}]`;
      });
    const skippedNow = states.filter(([, st]) => st.state === 'skipped').map(([n]) => n);
    const unfinished = byState('pending');
    const missing = states.filter(([, st]) => st.state === 'absent').map(([n, st]) => `${n}: ${st.reason}`);
    const impostors = byState('impostor');
    const ambiguousNow = byState('ambiguous');

    // Alternatives: see `REQUIRE_ANY_CHECK`. ONE green is enough BECAUSE the two
    // producers cover disjoint inputs, but a red check is decided before the green
    // ones are looked at - excusing a failure because another producer passed is
    // how a deleted or broken job reads as green.
    if (REQUIRE_ANY_CHECK.has(suite)) {
      if (red.length) { failed.push(`${suite} (${red.join('; ')})`); continue; }
      if (impostors.length) { impostor.push(`${suite} (${impostors.join('; ')})`); continue; }
      if (ambiguousNow.length) { ambiguous.push(`${suite} (${ambiguousNow.join('; ')})`); continue; }
      if (skippedNow.length) { skipped.push(`${suite} (${skippedNow.join(', ')} was skipped)`); continue; }
      if (green.length) { verified.push(`${suite} (${green.join(', ')})`); continue; }
      if (unfinished.length) { pending.push(`${suite} (${unfinished.join('; ')}); no alternative had finished when this gate gave up`); continue; }
      // Neither producer ran. That is the shape a change with no browser-bearing
      // paths takes, and it is not a failure - but it is also indistinguishable
      // from a deleted job at run time, so `check-gate-contract.mjs` asserts each
      // name still exists in its workflow.
      absent.push(`${suite} (none of ${names.join(', ')} exists on this commit from the workflow that owns it)`);
      continue;
    }

    if (skippedNow.length) { skipped.push(`${suite} (${skippedNow.join(', ')} was skipped)`); continue; }
    if (red.length) { failed.push(`${suite} (${red.join('; ')})`); continue; }
    if (impostors.length) { impostor.push(`${suite} (${impostors.join('; ')})`); continue; }
    if (ambiguousNow.length) { ambiguous.push(`${suite} (${ambiguousNow.join('; ')})`); continue; }
    if (unfinished.length) { pending.push(`${suite} (${unfinished.join('; ')}); the result did not exist when this gate gave up`); continue; }
    if (missing.length) { absent.push(`${suite} (${missing.join('; ')})`); continue; }
    verified.push(suite);
  }
  return { verified, failed, skipped, pending, absent, unverifiable, impostor, ambiguous };
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

/**
 * The one place the delegated-suite verdict is computed.
 *
 * `main()` and the AWAIT_SELFTEST both call this. They used not to: `main()`
 * carried the rule inline and the selftest carried a hand-written copy of it,
 * so a change to one left the other asserting yesterday's gate. That is the
 * defect TASK-14 names - "tests cannot copy the production formula and still be
 * a test of the production formula" - and the copy was byte-for-byte identical,
 * which is exactly what made it invisible.
 *
 * `waited` is the caller's decision, not a property of the result: `--no-wait`
 * reads without judging, and a pending suite is only a FAIL when the gate was
 * supposed to wait for it.
 *
 * @param {object} del result of `delegatedVerdict`
 * @param {{waited: boolean}} opts
 * @returns {'PASS'|'FAIL'}
 */
export function delegatedOutcomeVerdict(del, { waited }) {
  const fatal = del.failed.length || del.skipped.length || del.absent.length
    || del.impostor.length || del.ambiguous.length
    || (waited && del.pending.length);
  return fatal ? 'FAIL' : 'PASS';
}

export function gate(rawNeeds, impact, ledgerForGate = null) {
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
  // PART 2 — every job the gate was handed must have succeeded, or been skipped
  // for a reason the ruleset allows.
  //
  // `ci.yml` HAS A PATH-LIKE FILTER NOW: the `scope` job decides which heavy
  // groups run, and five jobs are conditional on it. That changed this part's
  // premise, and the change had a cost worth recording: PR #144 (a
  // `gateway.rs`-only change) skipped `web` and `web-unit`, both of which the
  // ruleset requires, and the merge endpoint answered
  //
  //     9 of 9 required status checks are expected
  //
  // because a SKIPPED required check is as unusable as a missing one. The
  // workflow was fixed to run every ruleset-required job unconditionally; this
  // comment is the other half, so the next person gating a job knows the rule:
  // **the scope fan-out must never reach a job the ruleset names.**
  //
  // For the jobs that may legitimately be skipped, a skip is a note rather than a
  // failure — and only when the impact analyzer did not require that suite.
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

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // PART 3 — attribute every OTHER workflow's checks to the gate that owns them.
  //
  // Parts 1 and 2 only see what `ci.yml` hands the gate: its own `needs`. Checks
  // produced by another workflow are invisible there unless the impact analyzer
  // happened to require their suite.
  //
  // THE DEFECT THIS REPLACES. The first version of this part treated EVERY red
  // check from ANY other workflow as a merge failure. That is wrong in one
  // direction and dangerous in the other:
  //
  //   - wrong: `staging-preview.yml` deploys to the staging host. `deploy to
  //     staging host` going red says the node is full or the host is unhealthy -
  //     a statement about the environment, not about the patch. Counting it as a
  //     merge failure would mean one full staging node blocks every code change
  //     on the repository. That is not hypothetical: it is what `main` looked
  //     like on 2026-11-19, and it is what made `ci-gate` red on a push whose
  //     nine required checks were green.
  //
  //   - dangerous: the obvious repair, "ignore checks from workflows I do not
  //     know", turns a new CI job nobody mapped into a silent hole.
  //
  // So ownership is explicit (`GATE_OWNERSHIP`), keyed on the WORKFLOW FILE
  // rather than the check name, and completeness is asserted separately
  // (`OWNERSHIP_COMPLETENESS`) so an unlisted workflow fails the build instead of
  // being ignored.
  //
  // WHAT HAPPENS TO A DEPLOYMENT-GATE FAILURE: it is reported in
  // `deploymentFailures`, and it does not enter `failed`. The verdict is
  // unaffected. An operator reading the summary still sees it - that is the
  // difference between "not a merge blocker" and "not noticed".
  // ---------------------------------------------------------------------------
  const deploymentFailures = [];
  const unattributedWorkflows = new Set();

  // Which check names this gate must NOT re-attribute here.
  //
  // Two kinds, and the difference between them is the whole risk boundary:
  //
  //   1. Names `delegatedVerdict` was actually handed for this change. It has
  //      judged them; re-reporting would give one red check two reasons.
  //
  //   2. Names whose workflow runs on EVERY pull request - `ci.yml` always, and
  //      the delegated workflows with no `pull_request.paths` at all
  //      (`platform-linux-acceptance.yml`, `reliability.yml`). Their checks are
  //      reported for every change, so "this red should block" would make one of
  //      them a merge criterion for documentation edits - the exact failure the
  //      DEPLOYMENT-gate distinction above exists to prevent. Whether those
  //      suites are required is the impact analyzer's decision, and it has made
  //      it by the time this loop runs.
  //
  // A workflow WITH a `pull_request.paths` filter is the dangerous case, and it is
  // not skipped: it ran because the filters said this change is its business, so a
  // red check from it is a fact about this patch. Before this, EVERY name in
  // `DELEGATED_CHECK_OWNERS` was skipped unconditionally, so a red `acceptance` or
  // `golden-path` on a change the analyzer did not require was attributed nowhere -
  // PART 3's own rule ("a red check from a merge-gate owner blocks") did not apply
  // to the nine names PART 3 exists to attribute.
  const judgedDelegatedNames = new Set();
  for (const suite of required) {
    if (!DELEGATED[suite]) continue;
    for (const name of Object.keys(DELEGATED_CHECK_OWNERS[suite] ?? {})) judgedDelegatedNames.add(name);
  }
  const alwaysRunsOnPullRequest = new Set(['ci.yml', ...UNFILTERED_ON_PR]);

  for (const [name, runs] of Object.entries(ledgerForGate?.byName ?? {})) {
    if (runs.length === 0) continue;
    // Skip only what `delegatedVerdict` decided, and what runs on every PR.
    if (judgedDelegatedNames.has(name)) continue;
    if (runs.every((r) => r.workflow != null && alwaysRunsOnPullRequest.has(r.workflow))) continue;

    const st = checkState(ledgerForGate.byName, name, {});
    if (st.state !== 'failed') continue;

    const workflows = [...new Set(runs.map((r) => r.workflow ?? null))];
    for (const wf of workflows) {
      const owner = wf == null ? null : (GATE_OWNERSHIP[wf] ?? NON_GATE_WORKFLOWS[wf] ?? null);
      const from = wf ?? 'unattributable';

      if (owner === 'deployment') {
        deploymentFailures.push(`${name} (${from}: ${st.reason})`);
        continue;
      }
      if (owner === 'merge') {
        failed.push(`${name} (${from}: ${st.reason}; the ${from} workflow is a merge-gate owner, so this blocks)`);
        continue;
      }
      // Unknown workflow, or a check with no workflow attribution at all. This is
      // the dangerous case: either a workflow nobody registered, or an API
      // response that lost the suite join. Both fail closed.
      unattributedWorkflows.add(from);
      failed.push(`${name} (${from}: ${st.reason}; this workflow is not registered in GATE_OWNERSHIP, so the gate cannot tell whether it is a merge criterion - failing closed)`);
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
    deploymentFailures,
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
// The delegated suites after the wait budget ran out. `pending` is only a FAIL
// when the caller WAITED - `main()` decides that - so the verdict rule is in
// `main()`, and these pin the bucket the rule reads.
const AWAIT_SELFTEST = [
  {
    // H. A suite still running when the budget expires. `delegatedVerdict` puts it
    // in `pending`; `main()` turns a non-empty `pending` into FAIL when it waited.
    name: 'await: a suite still running after the budget is pending, and pending fails',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'in_progress', 'legacy-regression': 'queued' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 1, absent: 0, unverifiable: 0 },
    expectVerdict: 'FAIL',
  },
  {
    // A completion that arrives with a non-success conclusion after a long wait is
    // a failure, not a timeout. The distinction matters: timeout means "unknown",
    // this means "no".
    name: 'await: a suite that finishes red after waiting is a failure',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'completed', 'legacy-regression': 'failure' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
    expectVerdict: 'FAIL',
  },
  {
    // M. A rerun produces a SECOND check run for the same name. The latest
    // completed attempt decides - that is what rerunning means - and the earlier
    // red attempt must not keep the suite red.
    name: 'await: a rerun that passed clears the earlier red attempt',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'success' },
    attempts: { 'linux-runtime': ['failure', 'success'] },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
    expectVerdict: 'PASS',
  },
  {
    // And the reverse: green then red. The newest attempt is the answer.
    name: 'await: a rerun that failed overrides the earlier green attempt',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'failure' },
    attempts: { 'linux-runtime': ['success', 'failure'] },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
    expectVerdict: 'FAIL',
  },
  {
    // A re-run still IN FLIGHT: the old attempt is green, the new one has not
    // finished.
    //
    // THIS EXPECTED `PASS` AND THE JUSTIFICATION WAS FALSE. The comment said
    // "correct only because the caller decided not to wait" - but the caller does
    // not make that decision. `whatToAwait` waits on `pending` and on nothing
    // else (await-delegated.mjs:94-95), so with `checkState` answering `success`
    // the in-flight re-run was never waited for, by anyone, at any layer.
    //
    // GitHub leaves the old attempt `completed` for ever and creates a new check
    // run for every re-run - measured on SHA cc7be5c (run 44524547400,
    // run_attempt 2): `golden-path id=135561535255 completed/failure` and
    // `id=135572060029 completed/success` coexist. So for the minutes a re-run
    // takes, a suite that someone found a problem with read as green.
    //
    // The in-flight attempt is the answer, and it does not have one yet: pending,
    // and pending fails.
    name: 'await: an in-flight rerun is pending, not the green attempt before it',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'success' },
    attempts: { 'linux-runtime': ['success', 'in_progress'] },
    want: { verified: 0, failed: 0, skipped: 0, pending: 1, absent: 0, unverifiable: 0 },
    expectVerdict: 'FAIL',
  },
];

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
    // browser-e2e is produced by g12-acceptance for the paths the analyzer maps
    // to it (packages/**, both web apps). This was `golden-path` - a check
    // data-foundation.yml only produces for changes its own path filter matches,
    // which `packages/**` does not. PR #127 failed with delegated-absent because
    // of it.
    name: 'delegated: browser-e2e is read from the acceptance check',
    suites: ['browser-e2e'],
    checks: { acceptance: 'success' },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // The API reports a run that has started but not finished as its STATUS, not
    // its conclusion. Measured live in the gate's own log:
    // {"acceptance":"in_progress","golden-path":"in_progress"}. `in_progress` and
    // `queued` are not successes and must not be read as one - but they are not
    // failures either: the caller WAITS on them and only reports `pending` when
    // the budget runs out, which is then a timeout and a FAIL.
    name: 'delegated: a check still in progress is PENDING, not a pass',
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
  // browser-e2e has TWO producers and they are alternatives, not facets.
  {
    // The packages/** case: g12-acceptance ran, data-foundation did not.
    name: 'delegated: browser-e2e is satisfied by acceptance alone',
    suites: ['browser-e2e'],
    checks: { acceptance: 'success' },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // The tests/ui/** case: data-foundation ran, g12-acceptance did not.
    name: 'delegated: browser-e2e is satisfied by golden-path alone',
    suites: ['browser-e2e'],
    checks: { 'golden-path': 'success' },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // Neither producer ran at all: no browser touched this tree.
    name: 'delegated: browser-e2e with neither producer is absent',
    suites: ['browser-e2e'],
    checks: { other: 'success' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 1, unverifiable: 0 },
  },
  {
    // One producer failed and the other never ran: still a failure. An
    // alternative that ran and broke is an answer.
    name: 'delegated: browser-e2e fails when a producer ran and failed',
    suites: ['browser-e2e'],
    checks: { acceptance: 'failure' },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // data-foundation is a FACET suite: both jobs must be green. This is the
    // case that separates the two shapes.
    name: 'delegated: data-foundation needs both jobs, unlike browser-e2e',
    suites: ['data-foundation'],
    checks: { 'golden-path': 'success' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 1, unverifiable: 0 },
  },
  {
    name: 'delegated: a suite with no check mapping is reported unverifiable',
    suites: ['a-suite-nobody-mapped'],
    checks: { anything: 'success' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 1 },
  },

  // ---------------------------------------------------------------------------
  // ATTRIBUTION. These are why the ledger exists. Before it, a check name was
  // taken at face value no matter which workflow produced it, so a green check by
  // the wrong workflow could satisfy a required suite - and this repository has
  // already been bitten once by a gate that read the wrong thing and reported
  // success (a red g13b17-principal produced a green gate).
  // ---------------------------------------------------------------------------
  {
    // The impostor, green. `acceptance` is g12-acceptance's check. A job of that
    // name in data-foundation.yml must NOT satisfy g12-acceptance.
    name: 'delegated: a green check from the WRONG workflow does not verify',
    suites: ['g12-acceptance'],
    checks: { acceptance: 'success' },
    from: { acceptance: 'data-foundation.yml' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0, impostor: 1 },
  },
  {
    // The impostor, red. The other direction: a red check from the wrong workflow
    // must not block a suite whose own check never ran.
    name: 'delegated: a red check from the WRONG workflow does not fail the suite',
    suites: ['g12-acceptance'],
    checks: { acceptance: 'failure' },
    from: { acceptance: 'data-foundation.yml' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0, impostor: 1 },
  },
  {
    // The right workflow, and it is green.
    name: 'delegated: the owning workflow satisfies the suite',
    suites: ['g12-acceptance'],
    checks: { acceptance: 'success' },
    from: { acceptance: 'g12-acceptance.yml' },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // A re-run: the first attempt failed, the second passed. The latest completed
    // attempt is the answer - that is what re-running means.
    name: 'delegated: a re-run that passed clears the earlier failure',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'success' },
    attempts: { 'linux-runtime': ['failure', 'success'] },
    want: { verified: 1, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // And the reverse: green then red. The latest attempt is red, so the suite is.
    name: 'delegated: a re-run that failed is a failure even after a green attempt',
    suites: ['linux-runtime'],
    checks: { 'linux-runtime': 'failure' },
    attempts: { 'linux-runtime': ['success', 'failure'] },
    want: { verified: 0, failed: 1, skipped: 0, pending: 0, absent: 0, unverifiable: 0 },
  },
  {
    // A name with two producers and no owner in the table: the caller cannot say
    // which one it wanted, so the gate refuses to guess. This is the state a
    // suite would be in if it were mapped in DELEGATED_CHECKS but not in
    // DELEGATED_CHECK_OWNERS - the reason the owner table exists.
    name: 'delegated: a two-producer name with no declared owner is ambiguous',
    suites: ['a-suite-nobody-mapped'],
    checks: { conformance: 'success' },
    from: { conformance: 'runtime-conformance.yml' },
    alsoFrom: { conformance: 'data-foundation.yml' },
    want: { verified: 0, failed: 0, skipped: 0, pending: 0, absent: 0, unverifiable: 1, ambiguous: 0 },
  },
];
/**
 * Turn a compact fixture into the ledger `delegatedVerdict` now reads.
 *
 * A fixture says `checks: {acceptance: 'success'}`; the ledger needs to know
 * which workflow produced it, because that is what attribution means. The
 * default is the OWNING workflow from DELEGATED_CHECK_OWNERS - i.e. "the right
 * one" - and a case overrides it per name with `from:` to simulate an impostor.
 * `attempts:` produces several runs of one name in order, which is how a re-run
 * is expressed; `started_at` rises with each so "latest" is well defined.
 * `unowned: true` leaves the workflow null, which is the shape a flat
 * name -> conclusion map collapses to.
 */
function fixtureLedger(c) {
  const owners = {};
  for (const suite of c.suites) Object.assign(owners, DELEGATED_CHECK_OWNERS[suite] ?? {});
  const byName = {};
  let tick = 0;
  for (const [name, state] of Object.entries(c.checks ?? {})) {
    const workflow = c.unowned
      ? null
      : (c.from?.[name] ?? owners[name] ?? null);
    const attempts = c.attempts?.[name] ?? [state];
    byName[name] = attempts.map((attemptState) => {
      tick += 1;
      const finished = !UNFINISHED.has(attemptState);
      return {
        name,
        state: attemptState,
        status: finished ? 'completed' : attemptState,
        conclusion: finished ? attemptState : null,
        workflow,
        suiteId: workflow == null ? null : `suite-${workflow}`,
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString(),
        runId: String(tick),
      };
    });
  }
  // `unowned` also has to look like two producers, or `checkState` sees a single
  // unattributed run and reports it as an ordinary answer rather than ambiguous.
  if (c.unowned) {
    for (const name of Object.keys(byName)) {
      const base = byName[name][0];
      byName[name].push({ ...base, workflow: 'reliability.yml', suiteId: 'suite-reliability.yml', startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString() });
    }
  }
  return { byName, unattributed: [], duplicates: [], suites: {} };
}

function selftest() {
  let bad = 0;
  // Tracked explicitly so the summary reports how many assertions actually ran.
  const baseChecks = SELFTEST.length;
  let inlineChecks = 0;
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
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ${c.want}${c.because ? ` because ${c.because}` : ''}, got ${got.verdict} (failed=${got.failed.length} skipped=${got.skippedRequired.length} notWired=${got.notWired.length} delegated=${got.delegated.length})\n`);
  }
  // EVERY job ci.yml owns must be individually fatal. `rust` used to be the only
  // one with a counterfactual, so "does a red `web` fail the gate" was answered by
  // reasoning about the loop rather than by running it - and the loop has been
  // wrong before (a `find()` that read only the first job of a multi-job suite).
  for (const jobId of Object.keys(JOB_TO_SUITE)) {
    const needs = { ...ALL_OWNED_GREEN, [jobId]: 'failure' };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, true])), unmatched: [] };
    const got = gate(needs, impact);
    const named = got.failed.some((f) => f.includes(jobId)) || got.skippedRequired.some((f) => f.includes(jobId));
    const ok = got.verdict === 'FAIL' && named;
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a red ${jobId} fails the gate and is named: ${got.verdict}\n`);
  }

  // L0 lint must be a gate input, not a decorative job.
  {
    const needs = { ...ALL_OWNED_GREEN, lint: 'failure' };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, true])), unmatched: [] };
    const got = gate(needs, impact);
    const ok = got.verdict === 'FAIL' && got.failed.some((f) => /lint/.test(f));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a red lint job fails the gate: got ${got.verdict}\n`);
  }
  // And it must be wired: a job in JOB_TO_SUITE that ci-gate's needs omits is
  // reported by PART 0, which is what makes adding a job here load-bearing.
  {
    const needs = { ...ALL_OWNED_GREEN };
    delete needs.lint;
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(needs, impact);
    const ok = got.verdict === 'FAIL' && got.notWired.some((n) => /lint/.test(n));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} the lint job is reported when ci-gate's needs omits it: ${JSON.stringify(got.notWired)}\n`);
  }
  // PART 3 — OWNERSHIP. These replace an earlier expectation that was wrong:
  // "a red check from another workflow fails the gate". It failed every staging
  // deploy failure into the merge decision, which would have blocked every code
  // change on the repository the moment `ci-gate` became required.
  {
    // A DEPLOYMENT-GATE failure is reported, and does NOT block.
    const ledger = {
      byName: {
        'deploy to staging host': [{ name: 'deploy to staging host', state: 'failure', status: 'completed', conclusion: 'failure', workflow: 'staging-preview.yml', suiteId: 's1', startedAt: '2026-01-01T00:00:00Z', runId: '1' }],
      },
      unattributed: [], duplicates: [], suites: {},
    };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    const ok = got.verdict === 'PASS'
      && got.failed.length === 0
      && got.deploymentFailures.length === 1
      && /deploy to staging host/.test(got.deploymentFailures[0]);
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a staging deploy failure is reported as a deployment failure, not a merge blocker: ${got.verdict} ${JSON.stringify(got.deploymentFailures)}\n`);
  }
  {
    // A MERGE-GATE workflow's red check still blocks. The point is the split, not
    // an exemption for everything outside ci.yml.
    const ledger = {
      byName: {
        // `acceptance` is owned by the delegated tables, so PART 3 skips it by
        // design. Use a check name those tables do not claim.
        'typed-pipeline-contracts': [{ name: 'typed-pipeline-contracts', state: 'failure', status: 'completed', conclusion: 'failure', workflow: 'typed-pipeline-contracts.yml', suiteId: 's2', startedAt: '2026-01-01T00:00:00Z', runId: '2' }],
      },
      unattributed: [], duplicates: [], suites: {},
    };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    const ok = got.verdict === 'FAIL' && got.failed.some((f) => /typed-pipeline-contracts\.yml/.test(f));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a red check from a MERGE-gate workflow still blocks: ${got.verdict}\n`);
  }
  {
    // AN UNREGISTERED WORKFLOW fails closed. This is the guard against the easy
    // repair: "ignore what I do not know".
    const ledger = {
      byName: {
        'some-new-check': [{ name: 'some-new-check', state: 'failure', status: 'completed', conclusion: 'failure', workflow: 'brand-new.yml', suiteId: 's3', startedAt: '2026-01-01T00:00:00Z', runId: '3' }],
      },
      unattributed: [], duplicates: [], suites: {},
    };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    const ok = got.verdict === 'FAIL' && got.failed.some((f) => /brand-new\.yml/.test(f));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a red check from an UNREGISTERED workflow fails closed: ${got.verdict}\n`);
  }
  {
    // Unattributable (no workflow join at all) fails closed too: the gate cannot
    // tell whose it is, so it must not assume it is harmless.
    const ledger = {
      byName: {
        mystery: [{ name: 'mystery', state: 'failure', status: 'completed', conclusion: 'failure', workflow: null, suiteId: null, startedAt: '2026-01-01T00:00:00Z', runId: '4' }],
      },
      unattributed: ['mystery'], duplicates: [], suites: {},
    };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    const ok = got.verdict === 'FAIL' && got.failed.some((f) => /unattributable/.test(f));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} an unattributable red check fails closed: ${got.verdict}\n`);
  }
  {
    // A GREEN deployment check is not a substitute for a required suite: passing
    // staging must not make up for a missing data-foundation result.
    const ledger = {
      byName: {
        'deploy to staging host': [{ name: 'deploy to staging host', state: 'success', status: 'completed', conclusion: 'success', workflow: 'staging-preview.yml', suiteId: 's5', startedAt: '2026-01-01T00:00:00Z', runId: '5' }],
      },
      unattributed: [], duplicates: [], suites: {},
    };
    const impact = { suites: { ...Object.fromEntries(SUITES.map((x) => [x, false])), 'data-foundation': true }, unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    // data-foundation is delegated; gate() marks it delegated and does not fail on
    // that alone. What must NOT happen is the green staging check counting as it.
    const ok = !got.delegatedResults && !/deploy to staging host/.test(got.delegated.join(' '));
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} a green deployment check does not stand in for a required suite: ${got.verdict}\n`);
  }
  // And a name the delegated tables own is decided by delegatedVerdict, not here -
  // otherwise one red check would be reported twice with two different reasons.
  {
    const ledger = {
      byName: {
        'linux-runtime': [{ name: 'linux-runtime', state: 'failure', status: 'completed', conclusion: 'failure', workflow: 'platform-linux-acceptance.yml', suiteId: 's3', startedAt: '2026-01-01T00:00:00Z', runId: '3' }],
      },
      unattributed: [], duplicates: [], suites: {},
    };
    const impact = { suites: Object.fromEntries(SUITES.map((x) => [x, false])), unmatched: [] };
    const got = gate(ALL_OWNED_GREEN, impact, ledger);
    const ok = got.failed.filter((f) => /linux-runtime/.test(f)).length === 0;
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} PART 3 does not double-report a delegated check: ${JSON.stringify(got.failed)}\n`);
  }

  // AWAIT_SELFTEST: the same buckets, but each case also states the VERDICT its
  // bucket produces. The brief is explicit that helper return values are not
  // enough - these assert the decision, and the verdict rule itself lives in
  // `main()`; `verdictFrom` below mirrors it so a case can check both.
  for (const c of AWAIT_SELFTEST) {
    const got = delegatedVerdict(fixtureLedger(c), c.suites);
    const bucketsOk = got.verified.length === c.want.verified
      && got.failed.length === c.want.failed
      && got.skipped.length === c.want.skipped
      && got.pending.length === c.want.pending
      && got.absent.length === c.want.absent
      && got.unverifiable.length === c.want.unverifiable;
    // The SAME function main() calls, not a copy of its formula. A test that
    // restates the rule can only fail when the rule changes in one place, which
    // is a test of the copy.
    const verdict = delegatedOutcomeVerdict(got, { waited: true });
    const verdictOk = verdict === c.expectVerdict;
    const ok = bucketsOk && verdictOk;
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: buckets=${bucketsOk} verdict=${verdict}(want ${c.expectVerdict})\n`);
  }

  // The job timeout is the only place the wait budget has to fit, and it lives in
  // YAML where nothing can import it. Read it back and compare, so raising one
  // number without the other fails here rather than as a `cancelled` job.
  {
    const ciYml = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
    const gateJob = ciYml.slice(ciYml.indexOf('\n  ci-gate:'));
    const match = /timeout-minutes:\s*(\d+)/.exec(gateJob);
    const minutes = match ? Number(match[1]) : null;
    const ok = minutes !== null
      && minutes * 60 * 1000 === GATE_JOB_TIMEOUT_MS
      && DEFAULT_BUDGET_MS <= GATE_JOB_TIMEOUT_MS - GATE_TIMEOUT_SLACK_MS;
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} GATE_JOB_TIMEOUT_MS agrees with ci.yml and fits the budget `
      + `(yml=${minutes}min const=${GATE_JOB_TIMEOUT_MS / 60000}min budget=${DEFAULT_BUDGET_MS / 60000}min slack=${GATE_TIMEOUT_SLACK_MS / 60000}min)\n`);
  }

  for (const c of DELEGATED_SELFTEST) {
    const got = delegatedVerdict(fixtureLedger(c), c.suites);
    const ok = got.verified.length === c.want.verified
      && got.failed.length === c.want.failed
      && got.skipped.length === c.want.skipped
      && got.pending.length === c.want.pending
      && got.absent.length === c.want.absent
      && got.unverifiable.length === c.want.unverifiable
      // `undefined` in a fixture means "must be zero", which keeps the 20 cases
      // written before attribution existed readable.
      && got.impostor.length === (c.want.impostor ?? 0)
      && got.ambiguous.length === (c.want.ambiguous ?? 0);
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ${JSON.stringify(c.want)}, got verified=${got.verified.length} failed=${got.failed.length} skipped=${got.skipped.length} pending=${got.pending.length} absent=${got.absent.length} unverifiable=${got.unverifiable.length} impostor=${got.impostor.length} ambiguous=${got.ambiguous.length}\n`);
  }

  // OWNERSHIP COMPLETENESS: every workflow file in the repository must be named in
  // GATE_OWNERSHIP or NON_GATE_WORKFLOWS.
  //
  // This is the guard that lets PART 3 be selective without being blind. A new
  // workflow nobody registered is not silently ignored - it fails here, before it
  // ever reaches the gate, and the message says which file and what to do.
  {
    const wfDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
    const files = readdirSync(wfDir).filter((n) => n.endsWith('.yml'));
    const missing = files.filter((f) => !(f in GATE_OWNERSHIP) && !(f in NON_GATE_WORKFLOWS));
    const stale = [...Object.keys(GATE_OWNERSHIP), ...Object.keys(NON_GATE_WORKFLOWS)]
      .filter((f) => !files.includes(f));
    const ok = missing.length === 0 && stale.length === 0;
    inlineChecks += 1;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} every workflow is registered in GATE_OWNERSHIP`
      + `${missing.length ? `; UNREGISTERED: ${missing.join(', ')}` : ''}`
      + `${stale.length ? `; STALE ENTRIES: ${stale.join(', ')}` : ''}\n`);
  }

  // The two tables that both claim to say which check belongs to which suite must
  // not be able to disagree. Two copies of one fact is exactly the drift this
  // file exists to catch, so the derived one is compared to the hand-written one
  // here rather than trusted.
  {
    const mismatch = [];
    for (const suite of new Set([...Object.keys(DELEGATED_CHECKS), ...Object.keys(DELEGATED_CHECKS_FROM_OWNERS)])) {
      const a = [...(DELEGATED_CHECKS[suite] ?? [])].sort().join(',');
      const b = [...(DELEGATED_CHECKS_FROM_OWNERS[suite] ?? [])].sort().join(',');
      if (a !== b) mismatch.push(`${suite}: ${a || '(none)'} vs ${b || '(none)'}`);
    }
    const ok = mismatch.length === 0;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} the check table and the owner table agree${ok ? '' : `: ${mismatch.join('; ')}`}\n`);
  }
  // Count what actually ran, not the size of two arrays: the inline cases above
  // (PART 3, the owner-table agreement) are not in either array, and a total that
  // ignores them under-reports the coverage.
  const ran = baseChecks + DELEGATED_SELFTEST.length + inlineChecks;
  process.stdout.write(bad === 0 ? `gate selftest: ${ran}/${ran} pass\n` : `gate selftest: ${bad} of ${ran} FAILED\n`);
  return bad === 0 ? 0 : 1;
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();

  let needsJson = null;
  let impactJson = null;
  let checksJson = null;
  let workflowRunsJson = null;
  let noWait = false;
  let fetchMode = false;
  let budgetMs = DEFAULT_BUDGET_MS;
  let files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--needs-json') { needsJson = argv[++i]; }
    else if (argv[i] === '--impact-json') { impactJson = argv[++i]; }
    else if (argv[i] === '--checks-json') { checksJson = argv[++i]; }
    else if (argv[i] === '--workflow-runs-json') { workflowRunsJson = argv[++i]; }
    else if (argv[i] === '--fetch') { fetchMode = true; }
    else if (argv[i] === '--no-wait') { noWait = true; }
    else if (argv[i] === '--budget-ms') {
      // Validated at the point of parsing, so a bad value is a CONFIGURATION_ERROR
      // with an exit code the workflow can distinguish from a suite result. The
      // caller passes `GATE_BUDGET_MS` through `"${GATE_BUDGET_MS:?...}"`, which
      // catches an UNSET variable but not a value that is set and wrong - and the
      // repository variable is editable without touching this file.
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed <= 0) {
        process.stderr.write(
          `ci-gate: --budget-ms must be a positive finite number, got ${JSON.stringify(raw)}\n` +
          '  this is a configuration error, not a suite result: NaN would never expire and a\n' +
          '  non-positive budget reports "nothing still running" before it has read anything.\n',
        );
        return 2;
      }
      budgetMs = parsed;
    }
    else if (argv[i] === '--files') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) files.push(argv[++i]); }
    else { process.stderr.write(`ci-gate: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!needsJson) { process.stderr.write('ci-gate: --needs-json is required\n'); return 2; }

  let needs;
  try { needs = JSON.parse(needsJson); } catch { process.stderr.write('ci-gate: --needs-json is not JSON\n'); return 2; }
  const impact = impactJson ? JSON.parse(impactJson) : analyse(files);

  // ---------------------------------------------------------------------------
  // Read the ledger BEFORE `gate()` runs, not after.
  //
  // `gate()` needs it for PART 3 (no red check on this commit goes unmentioned),
  // and the delegated verdict needs it for attribution. Reading it in two places
  // is how the first version of this drifted into reading twice and judging a
  // third time; there is one reader and both consumers get its output.
  //
  // A THROWN FETCH IS NOT AN EMPTY COMMIT. The old pipeline ended in
  // `2>/dev/null || echo '{}'`, so a TLS handshake timeout - measured against
  // api.github.com in this session - became "no checks exist" and then
  // `delegated-absent` for every suite: red for a reason that has nothing to do
  // with the commit, and indistinguishable from the real defect the lookup exists
  // to catch. It is reported as `delegated-api-error` and the gate fails.
  // ---------------------------------------------------------------------------
  let ledger = null;
  let apiError = null;
  let readLedgerRef = null;
  const wantLedger = fetchMode || checksJson !== null;
  if (wantLedger) {
    if (fetchMode) {
      try {
        const fetchPages = (endpoint) => {
          const pages = JSON.parse(execFileSync('gh', [
            'api', '--paginate', '--slurp', endpoint,
          ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
          return pages.flat();
        };
        const readLedger = () => {
          const checkPages = fetchPages(`/repos/${process.env.REPO}/commits/${process.env.CHECKS_SHA}/check-runs?per_page=100`);
          const runPages = fetchPages(`/repos/${process.env.REPO}/actions/runs?head_sha=${process.env.CHECKS_SHA}&per_page=100`);
          return {
            checkRuns: checkPages.flatMap((p) => p.check_runs ?? []),
            workflowRuns: runPages.flatMap((p) => p.workflow_runs ?? []),
          };
        };
        readLedgerRef = readLedger;
        const { checkRuns, workflowRuns } = readLedger();
        ledger = attributeChecks(checkRuns, workflowRuns);
      } catch (error) {
        apiError = String(error?.stderr?.toString?.() ?? error?.message ?? error);
      }
    } else {
      let checks;
      try { checks = JSON.parse(checksJson); } catch { process.stderr.write('ci-gate: --checks-json is not JSON\n'); return 2; }
      ledger = Array.isArray(checks)
        ? attributeChecks(checks, workflowRunsJson ? JSON.parse(workflowRunsJson) : [])
        : (checks.byName ? checks : ledgerFromFlat(checks));
    }
    if (ledger === null) {
      process.stdout.write(`\nverdict: FAIL\n  delegated-api-error: the check-run API could not be read for this commit; no delegated suite can be judged\n  ${String(apiError).split('\n')[0]}\n`);
      return 1;
    }
  }

  // The budget has to fit inside the job, or the job is killed mid-wait and
  // reports `cancelled` - a worse failure than a timeout, because it names no
  // suite. The relationship is stated in `ci.yml`'s timeout comment; this is the
  // code that enforces it, so editing either number alone fails here.
  //
  // 2700 s is `timeout-minutes: 45` in `ci.yml`; the slack covers checkout and
  // the ledger reads. Both are asserted by the selftest, which is why they are
  // exported rather than local.
  if (budgetMs > GATE_JOB_TIMEOUT_MS - GATE_TIMEOUT_SLACK_MS) {
    process.stderr.write(
      `ci-gate: --budget-ms ${budgetMs} does not fit inside the job timeout.\n` +
      `  the gate job is ${GATE_JOB_TIMEOUT_MS / 1000}s (timeout-minutes: 45 in ci.yml); the wait budget\n` +
      `  must leave at least ${GATE_TIMEOUT_SLACK_MS / 1000}s for checkout and the ledger reads, so it cannot\n` +
      `  exceed ${(GATE_JOB_TIMEOUT_MS - GATE_TIMEOUT_SLACK_MS) / 1000}s. A job killed by its own timeout reports\n` +
      '  `cancelled`, which names no suite - that is why this is refused rather than clamped.\n',
    );
    return 2;
  }
  const result = gate(needs, impact, ledger);
  let verdict = result.verdict;

  // The delegated suites: `gate()` can only say "another workflow owns this".
  // With the check-run results for THIS commit it can say whether they passed.
  // Without them it still reports each one, but as unverified - it never claims
  // a suite it did not read.
  let del = null;
  let timedOut = [];
  if (ledger !== null) {
    const requiredDelegated = result.delegated
      .map((line) => line.split(' ')[0])
      .filter((s) => s in DELEGATED_CHECK_OWNERS);

    del = delegatedVerdict(ledger, requiredDelegated);

    // WAIT for the suites that are running, then judge. Without this, "pending"
    // was reported and the gate passed - and because these suites are not in the
    // branch ruleset, a suite that started, was called "pending", and then FAILED
    // left a green gate behind it and a merge nothing objected to.
    if (!noWait && del.pending.length > 0) {
      const wanted = [];
      for (const suite of requiredDelegated) {
        const owners = DELEGATED_CHECK_OWNERS[suite];
        if (!owners) continue;
        for (const [name, workflow] of Object.entries(owners)) wanted.push({ name, workflow, suite });
      }
      // Only `--fetch` can re-read: `--checks-json` is a snapshot the caller took,
      // and polling a snapshot would loop forever on the same stale answer.
      if (readLedgerRef !== null) {
        const outcome = await awaitDelegated({
          read: () => {
            const { checkRuns, workflowRuns } = readLedgerRef();
            return { ledger: attributeChecks(checkRuns, workflowRuns), workflowRuns };
          },
          wanted,
          budgetMs,
          log: (line) => process.stdout.write(`  wait: ${line}\n`),
        });
        timedOut = outcome.timedOut;
        // Judge from a fresh read rather than the loop's last snapshot: a suite can
        // settle between the final poll and this line, and the verdict printed
        // below must come from the same data as the judgement.
        const { checkRuns, workflowRuns } = readLedgerRef();
        del = delegatedVerdict(attributeChecks(checkRuns, workflowRuns), requiredDelegated);
      } else {
        process.stdout.write('  wait: not waiting - --checks-json is a fixed snapshot; pass --fetch to wait for running suites\n');
      }
    }

    // A suite still running after the budget is a TIMEOUT, and a timeout is a
    // FAIL. "It did not finish in the time its own p95 says it needs" is not
    // "probably fine"; it is a result that does not exist, and this gate does not
    // merge on those. `--no-wait` is the only way to read without judging, and it
    // says so in the summary.
    // ONE rule, shared with the selftest below. `waited` is `!noWait`: the gate
    // was told to wait, so a suite that never answered is a failure, not an
    // unfinished read.
    if (delegatedOutcomeVerdict(del, { waited: !noWait }) === 'FAIL') verdict = 'FAIL';
  }

  const out = { ...result, verdict };
  if (del) out.delegatedResults = del;
  if (timedOut.length) out.timedOut = timedOut;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`\nverdict: ${verdict}\n`);
  if (del) {
    for (const v of del.verified) process.stdout.write(`  delegated-verified: ${v}\n`);
    for (const f of del.failed) process.stdout.write(`  delegated-failed: ${f}\n`);
    for (const s of del.skipped) process.stdout.write(`  delegated-skipped: ${s}\n`);
    for (const i of del.impostor) process.stdout.write(`  delegated-impostor: ${i}\n`);
    for (const a of del.ambiguous) process.stdout.write(`  delegated-ambiguous: ${a}\n`);
    for (const a of del.absent) process.stdout.write(`  delegated-absent: ${a}\n`);
    for (const u of del.unverifiable) process.stdout.write(`  delegated-unverifiable: ${u}\n`);
    if (del.pending.length) {
      for (const p of del.pending) process.stdout.write(`  delegated-pending: ${p}\n`);
      if (noWait) {
        process.stdout.write('  WARNING: --no-wait was set. The suites above had no result when this gate ran.\n');
        process.stdout.write('  WARNING: this is NOT a pass for them. The CLI returned PASS only because it was told not to wait.\n');
      } else {
        process.stdout.write(`  delegated-timeout: ${del.pending.length} suite(s) still running after ${Math.round(budgetMs / 1000)}s\n`);
      }
    }
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
  // `main` is async because the delegated wait is: the gate now blocks on a
  // bounded poll rather than reading whatever happened to exist at start.
  process.exit(await main(process.argv.slice(2)));
}
