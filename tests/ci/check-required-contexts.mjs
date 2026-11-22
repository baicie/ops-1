#!/usr/bin/env node
/**
 * Can the ten contexts the ruleset requires actually be produced on every PR?
 *
 * WHY THIS IS THE QUESTION
 *
 * `docs/ci/ruleset-candidate-ten.json` adds `required_status_checks` with ten
 * contexts. GitHub's behaviour for a required context that never appears is not a
 * warning - the pull request shows "Expected - Waiting for status to be reported"
 * and **cannot be merged at all**. There is no timeout, no override, and no red
 * check to look at. A migration that gets this wrong does not make the gate
 * stricter; it makes every merge impossible until someone edits the ruleset again.
 *
 * That makes "is this context produced for EVERY pull request" a precondition of
 * the migration, and it is checkable statically. The gate itself cannot check it:
 * `ci-gate` reads one commit, where "did not run because its paths did not match"
 * and "was deleted" are the same absence. This reads the workflows.
 *
 * THE THREE WAYS A CONTEXT CAN FAIL TO APPEAR
 *
 *   1. its workflow has a `pull_request.paths` filter that excludes the change;
 *   2. its job carries an `if:` that evaluates false;
 *   3. the job does not exist at all (renamed, moved, deleted).
 *
 * (3) is `check-gate-contract.mjs`'s job for the delegated names; this covers all
 * three for all ten, from the payload rather than from the gate's tables - because
 * the payload is what gets written to GitHub and the tables are what the gate
 * believes. A migration is the moment those two must be compared.
 *
 * `if: always()` is ACCEPTED, not refused. It is the correct condition for a
 * required check: it makes the job run even when its `needs:` failed, which is
 * exactly what keeps the context from disappearing. An `if:` that mentions
 * anything else is refused unless it is on the allowlist below.
 *
 * Usage: node tests/ci/check-required-contexts.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from './lib/workflow-yaml.mjs';
import { CANDIDATE_TEN_CONTEXTS } from './check-ruleset-payload.mjs';
import { JOB_TO_SUITE, DELEGATED_CHECK_OWNERS } from './ci-gate.mjs';

const WF_DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/**
 * Context -> the workflow file that must produce it, for contexts produced by a
 * workflow other than `ci.yml`.
 *
 * Derived from `DELEGATED_CHECK_OWNERS` rather than listed again: that table is
 * already the repository's statement of "which workflow owns this check name", and
 * a second copy would drift from it exactly the way the two producer tables did
 * before `check-gate-contract.mjs` compared them.
 */
export function producerWorkflowOf(context) {
  // `ci-gate` is NOT in `JOB_TO_SUITE`, and that is deliberate: the map says
  // "which impact suite does this job assert", and the gate asserts none - it is
  // the thing that reads the map. So it is named here rather than looked up.
  if (context === 'ci-gate') return 'ci.yml';
  if (context in JOB_TO_SUITE) return 'ci.yml';
  for (const owners of Object.values(DELEGATED_CHECK_OWNERS)) {
    if (context in owners) return owners[context];
  }
  return null;
}

/** `if:` values that cannot make a required context disappear. */
const SAFE_IF = [
  /^\s*always\(\)\s*$/,
  /^\s*\$\{\{\s*always\(\)\s*\}\}\s*$/,
];

const isSafeIf = (value) => SAFE_IF.some((re) => re.test(String(value ?? '')));

/**
 * @param {{workflows: Map<string, object>}} ctx
 * @returns {string[]} problems; empty means every required context is produced
 */
export function inspectRequiredContexts({ workflows }) {
  const problems = [];

  for (const context of CANDIDATE_TEN_CONTEXTS) {
    const workflow = producerWorkflowOf(context);
    if (workflow === null) {
      problems.push(`"${context}" is required by the ruleset, but no workflow is known to produce it`);
      continue;
    }
    const doc = workflows.get(workflow);
    if (!doc) { problems.push(`"${context}" is produced by ${workflow}, which does not exist`); continue; }
    if (doc.unparsed) { problems.push(`${workflow} could not be parsed: ${doc.unparsed}`); continue; }

    // (1) the pull_request trigger must exist and must not be path-filtered.
    const pr = doc.on?.pull_request;
    if (pr === undefined) {
      // A `push`-only workflow produces no PR check at all.
      problems.push(`${workflow} produces "${context}" but has no pull_request trigger,`
        + ' so the context never appears on a pull request and the ruleset would block every merge');
      continue;
    }
    const paths = pr && typeof pr === 'object' ? pr.paths : null;
    if (Array.isArray(paths) && paths.length > 0) {
      problems.push(`${workflow} produces "${context}" but filters pull_request.paths`
        + ` (${paths.length} entries). A required context whose workflow does not start for a`
        + ' change leaves the PR on "Expected - Waiting for status to be reported", which cannot be merged');
    }

    // (2)/(3) the job must exist and must not be conditionally skipped.
    const jobs = doc.jobs ?? {};
    const jobId = Object.keys(jobs).find((id) => id === context || jobs[id]?.name === context);
    if (!jobId) {
      problems.push(`${workflow} has no job that reports "${context}", so the required context`
        + ' has no producer');
      continue;
    }
    const job = jobs[jobId];
    if (job?.if !== undefined && !isSafeIf(job.if)) {
      problems.push(`"${context}" is reported by ${workflow}'s job "${jobId}", whose ` +
        `if: ${JSON.stringify(job.if)} can skip it. A required check that is skipped is not a pass`);
    }
    // A matrix job reports `name (a, b)`; the bare name is then never a context.
    if (job?.strategy?.matrix) {
      problems.push(`"${context}" is reported by a MATRIX job in ${workflow}; its check name carries`
        + ' the matrix values, so the bare context this ruleset requires would never appear');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const workflows = new Map();
  for (const name of readdirSync(WF_DIR).filter((n) => n.endsWith('.yml')).sort()) {
    const parsed = parse(readFileSync(WF_DIR + name, 'utf8'));
    workflows.set(name, parsed.ok ? parsed.value : { unparsed: parsed.error });
  }
  const problems = inspectRequiredContexts({ workflows });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ problems, contexts: CANDIDATE_TEN_CONTEXTS }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    process.stdout.write(`required contexts: ${problems.length} problem(s) across`
      + ` ${CANDIDATE_TEN_CONTEXTS.length} context(s)\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
