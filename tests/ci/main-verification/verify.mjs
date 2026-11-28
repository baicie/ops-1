#!/usr/bin/env node
/**
 * Post-merge verification of one commit on `main`.
 *
 * WHY THIS IS ITS OWN WORKFLOW
 *
 * It used to be a job inside `ci.yml`. Two consequences, both measured:
 *
 *   1. IT COULD NOT WAIT FOR `ci.yml`. A job cannot need its own workflow, so it
 *      ran four seconds after the push and read a check state in which nothing
 *      had settled. On 4375c988 it started at 06:25:56, read at 06:26:12 and
 *      finished at 06:26:23 — while the five push workflows it judges settled
 *      between 06:30:20 and 07:16:30. It printed INCOMPLETE, which was right for
 *      that moment and wrong about the commit.
 *
 *   2. THE DIFFERENCE BETWEEN `FAILED` AND `INCOMPLETE` WAS RUNNER QUEUE DELAY.
 *      On 63ef2451 the same job happened to start ten minutes late, after a
 *      fast-failing staging-preview had landed, so it reported FAILED. Same tool,
 *      same code, different answer, decided by how busy the runners were.
 *
 * A separate workflow can wait for all of them. The wait is `awaitPush`, which
 * shares `awaitDelegated`'s budget, backoff and deadline rather than copying
 * them.
 *
 * WHAT IT IS NOT
 *
 * It is not a merge gate. It observes `main` after a merge, and the brief is
 * explicit that it must not be registered as a PR Required Check. Its verdict is
 * `codeVerdict` in this push's terms; a release decision is a third question.
 *
 * FINAL MODE vs SNAPSHOT MODE
 *
 *   --snapshot  (default when no --wait)   read once and report. Exit codes are
 *               the historical ones, because existing callers parse them.
 *   --wait                                 bounded wait, then a FINAL verdict.
 *               Exit codes come from FINAL_EXIT: VERIFIED 0, FAILED 1,
 *               INCOMPLETE_TIMEOUT 1, UNAVAILABLE 2, SUPERSEDED 3.
 *
 * The two modes exist because the historical CLI is consumed by scripts that
 * treat "nothing to read" as 2; changing that under them would be a silent
 * break. `--wait` is what the workflow uses.
 *
 * THE EXIT CODE IS THE VERDICT
 *
 * The defect this replaces was a shell wrapper that computed the answer and then
 * exited 0. The rule here: the process status is derived from the state by ONE
 * expression, at the end, after every artifact has been written — and the
 * artifact writes are allowed to fail without changing it. (An upload that fails
 * must not turn FAILED into something else, and must not turn VERIFIED into
 * FAILED either; it is reported in the summary.)
 *
 * Usage:
 *   node tests/ci/main-verification/verify.mjs --sha <40-char sha>
 *   node tests/ci/main-verification/verify.mjs --sha <sha> --wait
 *   node tests/ci/main-verification/verify.mjs --sha <sha> --wait --json
 *   node tests/ci/main-verification/verify.mjs --from-json <fixture> [--wait]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMainRuns, FINAL_EXIT, SNAPSHOT_EXIT, isFinal } from './classify.mjs';
import { expectedPushWorkflows, APPLICABILITY } from './expected-workflows.mjs';
import { fetchCommitRuns, fetchPushFiles } from './github.mjs';
import { awaitPush, DEFAULT_BUDGET_MS } from './await-push.mjs';

export const SELF_WORKFLOW = 'main-verification.yml';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const has = (n) => argv.includes(n);

/**
 * Build the verdict from one snapshot. The CLI and the tests both call this, so
 * a test cannot pass against a reimplementation of the decision.
 *
 * @param {object} opts
 * @param {object[]} opts.runs
 * @param {{expected: object[], selfReference: string[], unparsed: object[]}} opts.workflows
 * @param {string|null} opts.filesError why the file list is unavailable, if it is
 * @param {boolean} opts.waiting true while collecting
 * @param {string} opts.sha
 * @param {string} opts.source
 * @returns {object} the result, with `state` and `exitCode`
 */
export function decide({ runs, workflows, filesError = null, waiting = false, sha, source }) {
  const classified = classifyMainRuns(runs, workflows, { selfWorkflow: SELF_WORKFLOW, waiting });

  // The three-level verdict the brief asks for. Only the first is decided here;
  // the other two belong to workflows that do not exist in this form yet, and
  // saying so is better than inventing them. `null` means "not decided by this
  // observer", not "unknown" and not "passed".
  const verdict = {
    codeVerdict: classified.state,
    stagingVerdict: null,
    releaseVerdict: null,
  };

  const blockers = [];
  if (classified.failed.length) blockers.push(`${classified.failed.length} workflow(s) failed`);
  if (classified.unavailable.length) blockers.push(`${classified.unavailable.length} workflow(s) could not be observed`);
  if (classified.pending.length) blockers.push(`${classified.pending.length} workflow(s) have no result`);
  if (workflows.unparsed.length) blockers.push(`${workflows.unparsed.length} workflow file(s) could not be parsed`);
  if (filesError) blockers.push(`the changed-file list was unavailable: ${filesError}`);

  // A workflow file the parser refuses is an obligation nobody can enumerate. It
  // cannot be VERIFIED, because "every workflow that runs on push succeeded" is a
  // claim about a set that is not fully known.
  const state = workflows.unparsed.length && isFinal(classified.state) && classified.state === 'VERIFIED'
    ? 'UNAVAILABLE'
    : classified.state;

  return {
    ...verdict,
    state,
    sha,
    source,
    subjectSha: sha,
    completeness: {
      waiting: !isFinal(state),
      required: classified.required.length,
      notApplicable: classified.notApplicable.length,
      unknown: classified.unknown.length,
      succeeded: classified.succeeded.length,
      failed: classified.failed.length,
      pending: classified.pending.length,
      unparsedWorkflowFiles: workflows.unparsed.length,
      fileListAvailable: filesError === null,
    },
    reason: classified.reason,
    blockers,
    observations: classified.records.map((r) => ({
      workflow: r.workflow,
      applicability: r.applicability,
      applicabilityReason: r.expectedReason,
      observation: r.observation,
      observationDetail: r.observationDetail,
      runId: r.observedRunId,
      attempt: r.observedAttempt,
    })),
    succeeded: classified.succeeded,
    failed: classified.failed,
    cancelled: classified.cancelled,
    pending: classified.pending,
    unavailable: classified.unavailable,
    notApplicable: classified.notApplicable,
    unknown: classified.unknown,
    selfReference: workflows.selfReference,
    unparsedWorkflowFiles: workflows.unparsed,
    note: 'This describes the PUSH runs for this commit. A green pull request on the '
      + 'same content is a different execution and does not substitute for it.',
  };
}

/** Read one snapshot from the API. Injected into the wait so production and tests agree. */
export function makeReader({ sha, repo = undefined, exec = null, fromJson = null }) {
  if (fromJson) {
    const fixture = JSON.parse(readFileSync(fromJson, 'utf8'));
    return async () => ({
      runs: (fixture.runs ?? fixture.workflow_runs ?? []).map(normaliseFixtureRun),
      workflows: fixture.workflows
        ? { expected: fixture.workflows, selfReference: fixture.selfReference ?? [], unparsed: fixture.unparsed ?? [] }
        : expectedPushWorkflows({ files: fixture.files ?? null, exclude: SELF_WORKFLOW }),
      filesError: fixture.filesError ?? null,
      error: fixture.error ?? null,
    });
  }
  return async () => {
    const runsResult = fetchCommitRuns({ sha, event: 'push', repo, exec });
    if (!runsResult.ok) {
      return { runs: [], workflows: expectedPushWorkflows({ files: null, exclude: SELF_WORKFLOW }), filesError: null, error: runsResult.error };
    }
    // The file list is only needed when a workflow has a paths filter, and it is
    // fetched after the runs so a busy commit's runs are not delayed by it. Its
    // absence makes applicability UNKNOWN, which is reported rather than guessed.
    const filesResult = fetchPushFiles({ sha, repo, exec });
    const files = filesResult.ok ? filesResult.files : null;
    return {
      runs: runsResult.runs,
      workflows: expectedPushWorkflows({ files, exclude: SELF_WORKFLOW }),
      filesError: filesResult.ok ? null : filesResult.error,
      error: null,
    };
  };
}

/** `--from-json` fixtures carry the old flat shape; normalise it the same way the API path does. */
function normaliseFixtureRun(run) {
  return {
    workflow: run.workflow ?? run.name ?? '',
    runId: run.runId ?? run.databaseId ?? run.id ?? null,
    attempt: run.attempt ?? run.run_attempt ?? 1,
    status: run.status ?? '',
    conclusion: run.conclusion ?? null,
    createdAt: run.createdAt ?? null,
  };
}

function renderText(result) {
  const out = [];
  out.push(`${result.state}  ${result.sha}`);
  out.push(`  ${result.reason}`);
  out.push(`  codeVerdict: ${result.codeVerdict}   stagingVerdict: (not decided here)   releaseVerdict: (not decided here)`);
  out.push(`  required ${result.completeness.required}, not applicable ${result.completeness.notApplicable}, unknown ${result.completeness.unknown}`);
  if (result.succeeded.length) out.push(`  verified:  ${result.succeeded.join(', ')}`);
  if (result.failed.length) out.push(`  FAILED:    ${result.failed.join(', ')}`);
  if (result.unavailable.length) out.push(`  UNAVAILABLE: ${result.unavailable.join(', ')}`);
  if (result.pending.length) out.push(`  pending:   ${result.pending.join(', ')}`);
  if (result.cancelled.length) out.push(`  SUPERSEDED:${result.cancelled.join(', ')}`);
  if (result.notApplicable.length) out.push(`  did not apply: ${result.notApplicable.join(', ')}`);
  if (result.blockers.length) out.push(`  blockers:  ${result.blockers.join('; ')}`);
  out.push('');
  out.push(`  ${result.note}`);
  return `${out.join('\n')}\n`;
}

function renderSummary(result) {
  const lines = [
    '## Main verification',
    '',
    `\`${result.state}\` for \`${result.sha}\``,
    '',
    result.reason,
    '',
    '| workflow | applicability | observation | attempt |',
    '|---|---|---|---|',
    ...result.observations.map((o) => `| ${o.workflow} | ${o.applicability} | ${o.observation} | ${o.attempt ?? '-'} |`),
    '',
  ];
  if (result.blockers.length) lines.push(`**Blockers:** ${result.blockers.join('; ')}`, '');
  lines.push(`_${result.note}_`, '');
  return lines.join('\n');
}

async function main() {
  const sha = arg('--sha');
  const fromJson = arg('--from-json');
  const asJson = has('--json');
  const doWait = has('--wait');
  const budgetMs = arg('--budget-ms') ? Number(arg('--budget-ms')) : DEFAULT_BUDGET_MS;
  const outDir = arg('--out-dir');

  if (!sha && !fromJson) {
    process.stderr.write('usage: verify.mjs --sha <40-char sha> | --from-json <fixture> [--wait] [--json]\n');
    process.exit(2);
  }
  // `--sha` must be exact. The old CLI accepted a 7-character prefix and then
  // matched runs by `startsWith`, which answers a different question: a prefix
  // can name more than one commit, and "some run whose head starts with these
  // seven characters" is not "this commit's runs".
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) {
    process.stderr.write(`--sha must be a full 40-character SHA, got ${JSON.stringify(sha)}\n`);
    process.exit(2);
  }

  const read = makeReader({ sha, fromJson });

  let result;
  let waitInfo = null;
  if (doWait) {
    const wait = await awaitPush({
      read,
      budgetMs,
      log: (line) => process.stderr.write(`  wait: ${line}\n`),
    });
    if (wait.error) {
      // The API failed. That is its own verdict and it does not depend on the
      // budget; reporting INCOMPLETE_TIMEOUT would blame the suites.
      const snapshot = wait.last ?? { runs: [], workflows: { expected: [], selfReference: [], unparsed: [] }, filesError: null };
      result = decide({ runs: [], workflows: snapshot.workflows, filesError: snapshot.filesError, waiting: false, sha: sha ?? 'unknown', source: 'api' });
      result.state = 'UNAVAILABLE';
      result.codeVerdict = 'UNAVAILABLE';
      result.reason = wait.error;
      result.blockers = [wait.error];
    } else {
      const snapshot = wait.last;
      // After the wait, the state is FINAL. `INCOMPLETE` (a progress state) is
      // mapped to INCOMPLETE_TIMEOUT by classifyMainRuns with waiting=false.
      result = decide({ runs: snapshot.runs ?? [], workflows: snapshot.workflows, filesError: snapshot.filesError, waiting: false, sha, source: 'api+wait' });
    }
    waitInfo = { attempts: wait.attempts, elapsedMs: wait.elapsedMs, timedOut: wait.timedOut };
    result.wait = waitInfo;
  } else {
    const snapshot = await read(1);
    if (snapshot.error) {
      result = decide({ runs: [], workflows: snapshot.workflows, filesError: snapshot.filesError, waiting: false, sha: sha ?? 'unknown', source: 'api' });
      result.state = 'UNAVAILABLE';
      result.codeVerdict = 'UNAVAILABLE';
      result.reason = snapshot.error;
      result.blockers = [snapshot.error];
    } else {
      result = decide({ runs: snapshot.runs, workflows: snapshot.workflows, filesError: snapshot.filesError, waiting: false, sha: sha ?? 'unknown', source: fromJson ? `fixture:${fromJson}` : 'api' });
    }
  }

  result.mode = doWait ? 'final' : 'snapshot';
  const table = doWait ? FINAL_EXIT : SNAPSHOT_EXIT;
  // The ONE place the process status is decided from the state. Everything before
  // this is report writing; the artifact writes below cannot change it.
  result.exitCode = table[result.state] ?? 1;

  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(renderText(result));

  // Artifacts are best-effort and their failure is reported, never fatal. An
  // upload that failed must not turn FAILED into VERIFIED or VERIFIED into
  // FAILED - the verdict was decided above and does not depend on storage.
  if (outDir) {
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(`${outDir}/main-verification.json`, `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(`${outDir}/summary.md`, renderSummary(result));
    } catch (error) {
      process.stderr.write(`warning: could not write artifacts to ${outDir}: ${error.message} (the verdict stands)\n`);
    }
  }

  process.exit(result.exitCode);
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) {
  main().catch((error) => {
    // An uncaught failure is UNAVAILABLE, not a crash with a green status. The
    // old wrapper's last command was an `echo`, so anything that threw here still
    // produced exit 0.
    process.stderr.write(`main-verification: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}

export { dirname };
