#!/usr/bin/env node
/**
 * The gate's tables name jobs and workflows. This checks they still exist.
 *
 * WHY THIS IS A STATIC CHECK AND NOT A RUNTIME ONE
 *
 * `ci-gate` reads one commit. It is handed `needs` from `ci.yml` and a check-run
 * ledger from the API, and it answers "was every suite this change required green".
 * That is the right question for a commit and the wrong one for a TREE: from inside
 * a run, a producer whose paths did not match and a producer that was DELETED look
 * identical - both simply do not appear.
 *
 * Measured, on this repository's own tables, before this file existed:
 *
 *   deleting the `acceptance` job from g12-acceptance.yml,
 *   while `golden-path` stays green
 *     -> `browser-e2e` PASSED, because `REQUIRE_ANY_CHECK` excused the absence
 *
 *   renaming the `golden-path` job's check name
 *     -> every static checker passed; only the next real run went red
 *
 * `delegatedVerdict` has since been fixed to judge a red check before it looks at
 * the green ones, which closes the first case when the job still RUNS and fails.
 * It does nothing for a deleted job, and it cannot: absence is a property of the
 * repository, not of a commit. So it is checked here, against the tree.
 *
 * WHAT IS CHECKED
 *
 *   1. every check name in `DELEGATED_CHECK_OWNERS` exists as a job `name:` (or
 *      job id) in the workflow that owns it
 *   2. every job id in `JOB_TO_SUITE` exists in `ci.yml`, and appears in
 *      `ci-gate`'s `needs:` there - the gate cannot decide a job it was not handed
 *   3. every workflow named in `DELEGATED`, `GATE_OWNERSHIP` or
 *      `NON_GATE_WORKFLOWS` exists, and every workflow that exists is named in one
 *      of them (the completeness assertion `--selftest` also makes, repeated here
 *      so a `ci-gate --selftest` that stops running cannot take it with it)
 *   4. `check-impact-consistency.mjs`'s suite->workflow table and `ci-gate`'s
 *      `DELEGATED` table describe the SAME producers for every suite they share
 *
 * (4) is the one that needs explaining. Two files answer "which workflow produces
 * this suite", maintained by hand in two places. They are load-bearing in opposite
 * directions: `check-impact-consistency` decides statically whether a filter can
 * start the producer, `ci-gate` decides at run time which check names to read. If
 * they disagree, each can be individually correct and the pair still wrong - a
 * filter is validated against one producer and the check is read from another.
 *
 * They disagreed when this file was written: `browser-e2e` had ONE producer in the
 * consistency table and TWO in the gate's. The gate was right (the suite really is
 * produced by either workflow) and the consistency script only reached the same
 * answer through a separate `ANY_OF_WORKFLOWS` table. Two corrections of the same
 * fact, one of them incidental - so the tables are compared, and the comparison is
 * what a reader can rely on.
 *
 * Usage: node tests/ci/check-gate-contract.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from './lib/workflow-yaml.mjs';
import {
  JOB_TO_SUITE, DELEGATED, DELEGATED_CHECK_OWNERS, GATE_OWNERSHIP, NON_GATE_WORKFLOWS,
  UNFILTERED_ON_PR,
} from './ci-gate.mjs';
import { SUITE_WORKFLOW_MAP } from './check-impact-consistency.mjs';

const WF_DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/** Workflow file -> parsed document, or `{unparsed}`. Parsed once. */
export function readWorkflows(dir = WF_DIR) {
  const out = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.yml')).sort()) {
    const parsed = parse(readFileSync(dir + name, 'utf8'));
    out.set(name, parsed.ok ? parsed.value : { unparsed: parsed.error });
  }
  return out;
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/**
 * The names a job reports to the check-run API.
 *
 * GitHub uses the job's `name:` when it has one, and the job ID otherwise - NOT
 * both. Matching either one would miss the exact mutation this checker exists for:
 * adding `name: acceptance-renamed` to a job whose id is `acceptance` leaves the
 * id in place, so an "id or name" match keeps passing while the check the gate
 * reads has stopped being produced. A test caught that in the first version.
 *
 * A job with a matrix reports `name (value, value)`, which this does not model -
 * no delegated producer in this repository uses a matrix, and inventing a matcher
 * would hide a future `acceptance (ubuntu, 22)` rather than surface it. Such a job
 * is reported as UNMODELLED instead of silently matching.
 */
export function checkNamesOf(jobs) {
  const names = new Map();
  for (const [id, job] of Object.entries(jobs ?? {})) {
    if (job?.strategy?.matrix) {
      names.set(id, { id, matrix: true, name: job?.name ? String(job.name) : undefined });
      continue;
    }
    names.set(id, { id, matrix: false, name: job?.name ? String(job.name) : undefined });
  }
  return names;
}

/** The check-run name a parsed job would report: its `name:`, else its id. */
export function reportedNameOf(id, job) {
  return job?.name ? String(job.name) : String(id);
}

/**
 * Every way the gate's tables disagree with the tree.
 *
 * The tables are a PARAMETER, defaulting to the real ones. Not for convenience:
 * a checker whose own counterfactuals can only be written against the real
 * repository is not testable at all - every fixture would have to be a full copy
 * of `.github/workflows/`, and a test that mutates the real tree is the kind of
 * thing that passes locally and fails in CI. Passing `tables` lets a test mutate
 * ONE entry and see it refused.
 *
 * @param {{workflows: Map<string, object>, ciYml: object, tables?: object}} ctx
 * @returns {string[]} problems; empty means the tables describe the repository
 */
export function inspectContract(ctx) {
  const problems = [];
  const { workflows, ciYml } = ctx;
  const T = {
    jobToSuite: JOB_TO_SUITE,
    delegated: DELEGATED,
    delegatedCheckOwners: DELEGATED_CHECK_OWNERS,
    gateOwnership: GATE_OWNERSHIP,
    nonGateWorkflows: NON_GATE_WORKFLOWS,
    unfilteredOnPr: UNFILTERED_ON_PR,
    suiteWorkflow: SUITE_WORKFLOW_MAP,
    ...(ctx.tables ?? {}),
  };

  // (1) delegated check names -> real jobs
  for (const [suite, owners] of Object.entries(T.delegatedCheckOwners)) {
    for (const [checkName, workflow] of Object.entries(owners)) {
      const doc = workflows.get(workflow);
      if (!doc) { problems.push(`${suite}: check "${checkName}" names workflow ${workflow}, which does not exist`); continue; }
      if (doc.unparsed) { problems.push(`${suite}: ${workflow} could not be parsed: ${doc.unparsed}`); continue; }
      const jobs = checkNamesOf(doc.jobs);
      const hit = [...jobs.values()].filter((j) => reportedNameOf(j.id, doc.jobs[j.id]) === checkName);
      if (hit.length === 0) {
        const available = [...jobs.values()].map((j) => reportedNameOf(j.id, doc.jobs[j.id])).join(', ');
        problems.push(`${suite}: check "${checkName}" is not a job in ${workflow}. The gate would read a check that`
          + ` nothing produces. Jobs there report: ${available}`);
      } else if (hit.every((j) => j.matrix)) {
        problems.push(`${suite}: check "${checkName}" in ${workflow} is a matrix job; its check name carries the`
          + ' matrix values and this checker does not model that, so it cannot confirm the name the gate reads');
      }
    }
  }

  // (2) JOB_TO_SUITE -> ci.yml jobs, and -> ci-gate's needs
  if (ciYml.unparsed) {
    problems.push(`ci.yml could not be parsed: ${ciYml.unparsed}`);
  } else {
    const jobs = ciYml.jobs ?? {};
    const gateJob = jobs['ci-gate'];
    const needs = asList(gateJob?.needs).map(String);
    for (const jobId of Object.keys(T.jobToSuite)) {
      if (!(jobId in jobs)) {
        problems.push(`JOB_TO_SUITE names job "${jobId}", which is not a job in ci.yml.`
          + ' The mapping outlived the job it maps');
        continue;
      }
      if (!needs.includes(jobId)) {
        problems.push(`JOB_TO_SUITE names job "${jobId}", but ci-gate's needs: does not include it, so the gate`
          + ' is never handed its result and cannot decide it');
      }
    }
    // The reverse direction is already load-bearing at run time (an unmapped job
    // is a note when green and a FAIL when red), so it is not repeated as an error
    // here - naming `scope` as a failure would be wrong, it is a control job.
    //
    // `verify-main` is the same shape and deliberately outside JOB_TO_SUITE: it
    // runs only on a push to main, answers "what did main ACTUALLY run", and is a
    // report rather than a merge criterion. Putting it in `needs:` would make the
    // gate wait on a job that itself reports on the gate's outcome.
  }

  // (3) workflows named vs workflows present
  const present = [...workflows.keys()];
  const named = new Set([...Object.keys(T.gateOwnership), ...Object.keys(T.nonGateWorkflows)]);
  for (const wf of named) {
    if (!present.includes(wf)) problems.push(`GATE_OWNERSHIP/NON_GATE_WORKFLOWS names ${wf}, which does not exist`);
  }
  for (const wf of present) {
    if (!named.has(wf)) {
      problems.push(`${wf} is not registered in GATE_OWNERSHIP or NON_GATE_WORKFLOWS. An unregistered workflow`
        + ' producing a red check is a merge failure the gate cannot attribute');
    }
  }
  for (const [suite, producers] of Object.entries(T.delegated)) {
    for (const wf of asList(producers)) {
      if (!present.includes(wf)) problems.push(`DELEGATED names ${wf} as a producer of ${suite}; it does not exist`);
    }
  }

  // (4) the two producer tables must agree
  for (const suite of new Set([...Object.keys(T.suiteWorkflow), ...Object.keys(T.delegated)])) {
    const fromImpact = asList(T.suiteWorkflow[suite]).slice().sort();
    const fromGate = asList(T.delegated[suite]).slice().sort();
    if (fromImpact.length === 0 && fromGate.length === 0) continue;
    if (fromImpact.join('|') !== fromGate.join('|')) {
      problems.push(`${suite}: check-impact-consistency says the producer is`
        + ` ${fromImpact.join(', ') || '(none)'} and ci-gate says ${fromGate.join(', ') || '(none)'}.`
        + ' One of the two is validating a different workflow from the one the gate reads');
    }
  }

  // (5) UNFILTERED_ON_PR must match the files
  //
  // PART 3 stops re-attributing the checks of a workflow in this list, on the
  // grounds that it runs for every PR so its result already appears in `ci-gate`'s
  // own accounting of what the analyzer required. Both halves of that premise are
  // about the FILE: an entry that has grown a `pull_request.paths` filter is no
  // longer reported for every change, so its red checks would go unattributed; and
  // a file that LOST its filter without being added here has the reverse effect -
  // PART 3 would make it a merge criterion for documentation edits.
  // A workflow that has a `pull_request:` trigger at all, and whether that trigger
  // carries a `paths:` filter. A workflow with NO pull_request trigger
  // (`staging-preview.yml` is push-only, `release-certification.yml` is tags and
  // dispatch) never produces a PR check, so it is neither "unfiltered on PR" nor a
  // filtered producer - it is absent from the question entirely.
  const hasPrTrigger = [];
  const withPrFilter = [];
  for (const [name, doc] of workflows) {
    const pr = doc?.on?.pull_request;
    if (pr === undefined) continue;
    hasPrTrigger.push(name);
    const has = pr && typeof pr === 'object' && Array.isArray(pr.paths) && pr.paths.length > 0;
    if (has) withPrFilter.push(name);
  }
  for (const wf of T.unfilteredOnPr) {
    if (!present.includes(wf)) { problems.push(`UNFILTERED_ON_PR names ${wf}, which does not exist`); continue; }
    if (!hasPrTrigger.includes(wf)) {
      problems.push(`UNFILTERED_ON_PR says ${wf} runs on every pull request, but it has no pull_request trigger at all`);
      continue;
    }
    if (withPrFilter.includes(wf)) {
      problems.push(`UNFILTERED_ON_PR says ${wf} runs on every pull request, but it has a pull_request.paths filter.`
        + ' PART 3 would stop attributing its red checks, and for a filtered workflow that is a silent hole');
    }
  }
  for (const wf of hasPrTrigger) {
    if (wf === 'ci.yml' || T.unfilteredOnPr.includes(wf)) continue;
    if (!withPrFilter.includes(wf)) {
      problems.push(`${wf} has a pull_request trigger with no paths filter, so it runs on every PR, but it is not in`
        + ' UNFILTERED_ON_PR. PART 3 would then treat its red checks as a merge criterion for every change');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const workflows = readWorkflows();
  const ciYml = workflows.get('ci.yml') ?? { unparsed: 'ci.yml is missing' };
  const problems = inspectContract({ workflows, ciYml });

  // A checker that read nothing must not report a clean bill of health.
  const checkedChecks = Object.values(DELEGATED_CHECK_OWNERS).reduce((n, o) => n + Object.keys(o).length, 0);
  const checkedJobs = Object.keys(JOB_TO_SUITE).length;
  if (checkedChecks === 0 || checkedJobs === 0 || workflows.size === 0) {
    process.stderr.write('nothing was checked; the tables or the workflow directory did not load\n');
    process.exit(2);
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ problems, checkedChecks, checkedJobs, workflows: workflows.size }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    process.stdout.write(`gate contract: ${problems.length} problem(s); ${checkedChecks} check name(s),`
      + ` ${checkedJobs} ci.yml job(s), ${workflows.size} workflow(s)\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
