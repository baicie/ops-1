#!/usr/bin/env node
/**
 * Write and verify a release receipt. TASK-09.
 *
 * A receipt is the only thing in this repository that says "this exact SHA was
 * certified", and it is worth nothing unless it can be checked by someone who
 * does not trust the person who wrote it. So verification does not read the
 * receipt's own claims back to itself: it re-reads the workflow run the receipt
 * cites and compares.
 *
 * WHAT VERIFY REFUSES
 *
 *   - a run that did not succeed
 *   - a SHA that is not the run's head SHA
 *   - a receipt citing a run of a different repository
 *   - a suite the receipt claims as `success` that the run has no check for
 *   - a suite the run has as failed (the receipt is stale or forged)
 *   - a missing or unknown schema version
 *
 * WHAT IT CANNOT CHECK, STATED RATHER THAN IMPLIED
 *
 * The image digest recorded in `artifacts` is what the BUILD reported. Nothing
 * here asks the registry whether that digest exists or what it contains - that is
 * TASK-15, not done. `write` marks the field's provenance so a reader is not
 * misled into treating a build claim as registry truth.
 *
 * USAGE
 *
 *   node scripts/release-receipt.mjs write \
 *     --run 12345 --sha <40hex> --ref refs/tags/v0.0.1 \
 *     --image-digest sha256:... --bundle-digest sha256:... \
 *     --out receipt.json
 *
 *   node scripts/release-receipt.mjs verify --receipt receipt.json
 *
 * Both need `gh` with read access to the repository named in the receipt.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { attributeChecks, checkState } from '../tests/ci/check-run-ledger.mjs';

export const SCHEMA = 'opsweave.release-receipt/v1';

/** Suites a certification must have a result for, by check name. */
export const REQUIRED_SUITES = [
  'rust', 'web', 'web-unit', 'contracts', 'spec-coverage',
  'platform-only', 'platform-image-build', 'quality-faults', 'linux-runtime',
  'ci-gate',
];

/**
 * The certification states, in the order they can be reached.
 *
 * WHY ONE `CERTIFIED` WAS NOT ENOUGH
 *
 * The receipt used to carry a single verdict, and `write` hard-coded it to
 * `CERTIFIED`. That word was read by people as "this release is good", while it
 * actually meant "a commit's MERGE-GATE checks were green" - and nothing else.
 *
 * Measured on commit f06835cb, the ledger of that commit's own checks contains
 *
 *     deploy to staging host=failed
 *
 * alongside twenty-nine green ones. The receipt would still say CERTIFIED for it,
 * because staging is not in `REQUIRED_SUITES` - correctly, since a deployment is a
 * fact about a host and must never block a merge. But a reader who sees CERTIFIED
 * and then a red staging deploy has been told two things that sound contradictory
 * and is given nothing to reconcile them.
 *
 * So the states are separate and each says exactly what was checked:
 *
 *   CODE_CERTIFIED       every merge-gate suite green on the commit (this file)
 *   ARTIFACT_VERIFIED    the image digest was read back FROM THE REGISTRY and
 *                        matched (not implemented - see below)
 *   STAGING_ACCEPTED     the release actually served from the staging host
 *                        (staging-preview.yml; not this file's evidence)
 *   PRODUCTION_APPROVED  a human decision, recorded (never automatic)
 *
 * NOTHING HERE IMPLIES THE NEXT ONE. `CODE_CERTIFIED` says nothing about whether
 * the image exists in a registry, and neither says anything about staging. A
 * receipt carrying `CODE_CERTIFIED` must not be read as a release approval, and
 * the CLI prints the state rather than the word "CERTIFIED" for that reason.
 */
export const CERTIFICATION_STATES = [
  'CODE_CERTIFIED',
  'ARTIFACT_VERIFIED',
  'STAGING_ACCEPTED',
  'PRODUCTION_APPROVED',
];

/**
 * States this file can actually establish.
 *
 * `ARTIFACT_VERIFIED` needs a registry read (`scripts/verify-registry-digest.mjs`
 * exists and is not wired); `STAGING_ACCEPTED` needs the staging run. Listing them
 * as reachable here would be the same overclaim the single word was.
 */
export const STATES_THIS_FILE_PROVES = ['CODE_CERTIFIED'];

function gh(repo, path) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' }));
}

/**
 * Reduce a run's check runs to `{name: state}`.
 *
 * WHAT THIS USED TO DO, AND WHY IT CERTIFIED FAILURES
 *
 * The first version was four lines:
 *
 *     for (const run of checkRuns ?? []) {
 *       if (out[name] === 'success') continue;   // <- a success is STICKY
 *       out[name] = state;
 *     }
 *
 * Two defects, both measured against this function:
 *
 *   1. `verifyReceipt` only compared a suite when the RECEIPT claimed `success`.
 *      A receipt claiming `rust: "failure"` skipped the comparison entirely, so a
 *      receipt and a run that BOTH said failure came back CERTIFIED. A
 *      certification that passes when a required suite is red is not a
 *      certification.
 *
 *   2. The sticky-success rule is not attempt identity. Once `rust` was seen as
 *      `success`, any later `failure` was dropped - including a NEWER attempt.
 *      A re-run cannot clear it, and an old green masks a fresh red.
 *
 * The replacement is `checkState` from `tests/ci/check-run-ledger.mjs`, which is
 * where this repository's attempt-ordering rules already live and are already
 * tested (20 cases, wired into `lint`): latest completed attempt decides, an
 * unfinished attempt that started AFTER the latest completed one means the answer
 * is not settled, and a name claimed by more than one workflow is `ambiguous`
 * rather than guessed. Writing a second implementation here is exactly the
 * "two tables, one fact" defect this repository keeps removing.
 *
 * `expectedWorkflow` narrows the lookup to a named producer. Without it a check
 * name that two workflows both produce is reported `ambiguous`, never credited.
 *
 * @param {object[]} checkRuns raw `check_runs` entries from the API
 * @param {Record<string,string>} [expectedWorkflow] name -> workflow that must own it
 * @returns {{states: Record<string,string>, reasons: Record<string,string>,
 *            unattributed: string[], duplicates: string[]}}
 */
export function suiteStates(checkRuns, expectedWorkflow = {}, workflowRuns = []) {
  const ledger = attributeChecks(checkRuns, workflowRuns);
  const states = {};
  const reasons = {};
  const names = new Set([...Object.keys(ledger.byName), ...Object.keys(expectedWorkflow)]);
  for (const name of names) {
    const r = checkState(ledger.byName, name, { workflow: expectedWorkflow[name] ?? null });
    states[name] = r.state;
    if (r.reason) reasons[name] = r.reason;
  }
  return { states, reasons, unattributed: ledger.unattributed, duplicates: ledger.duplicates };
}

/**
 * Conclusions that are never a pass, spelled out so the default is visible.
 *
 * `checkState` already collapses these to `failed`, but this list is what a reader
 * checks against when adding a new status: anything not in `PASSING_STATES` is a
 * refusal, including a status nobody has seen before.
 */
export const PASSING_STATES = new Set(['success']);

/**
 * Verify a receipt against the run it cites AND against externally supplied
 * expectations.
 *
 * @param {object} receipt
 * @param {Function} fetchRun
 * @param {{repository: string, sha: string, ref?: string, workflow?: string,
 *          event?: string}|null} [expected] facts the CALLER knows independently
 * @returns {string[]} problems; empty means CERTIFIED
 */
export function verifyReceipt(receipt, fetchRun, expected = null) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object') return ['not a JSON object'];
  if (receipt.schema !== SCHEMA) problems.push(`unknown schema ${JSON.stringify(receipt.schema)}`);

  const subject = receipt.subject ?? {};
  const trigger = receipt.trigger ?? {};
  if (!/^[0-9a-f]{40}$/.test(subject.sha ?? '')) problems.push('subject.sha is not a 40-hex commit');
  if (!subject.repository) problems.push('subject.repository is missing');
  if (!trigger.runId) problems.push('trigger.runId is missing');

  // THE EXPECTATION MUST COME FROM OUTSIDE THE RECEIPT.
  //
  // Comparing a receipt to fields the receipt itself supplies proves nothing: a
  // forged receipt says repo X, run Y, SHA Z and agrees with itself perfectly. A
  // certifier that was asked to certify a particular SHA, in a particular
  // repository, has to be told that separately, and the receipt has to match.
  //
  // Without `expected`, this function still checks the receipt against the RUN -
  // which is the strongest thing it can do with no outside input - and the CLI
  // refuses to print CERTIFIED unless the caller supplied it.
  if (expected) {
    if (expected.repository && subject.repository !== expected.repository) {
      problems.push(`receipt repository is ${subject.repository}, expected ${expected.repository}`);
    }
    if (expected.sha && subject.sha !== expected.sha) {
      problems.push(`receipt sha is ${subject.sha}, expected ${expected.sha}`);
    }
    if (expected.ref && subject.ref !== expected.ref) {
      problems.push(`receipt ref is ${JSON.stringify(subject.ref)}, expected ${expected.ref}`);
    }
  }

  if (problems.length) return problems;

  let run;
  try {
    run = fetchRun(subject.repository, trigger.runId);
  } catch (error) {
    return [`cannot read run ${trigger.runId}: ${String(error).split('\n')[0]}`];
  }

  const headSha = run.headSha ?? run.head_sha;
  if (String(headSha) !== subject.sha) {
    // The REST field is `head_sha`; a caller-supplied fact object may use either
    // spelling. The message names the REST one so an operator searching the API
    // docs for it lands on the right field.
    problems.push(`the run's head_sha is ${headSha}, but the receipt claims ${subject.sha}`);
  }
  if (run.conclusion !== 'success') {
    problems.push(`run ${trigger.runId} concluded ${run.conclusion}, not success`);
  }
  if (expected?.workflow && run.workflow && run.workflow !== expected.workflow) {
    problems.push(`run ${trigger.runId} belongs to ${run.workflow}, expected ${expected.workflow}`);
  }
  if (expected?.event && run.event && run.event !== expected.event) {
    problems.push(`run ${trigger.runId} is a ${run.event} run, expected ${expected.event}`);
  }
  if (trigger.attempt != null && run.attempt != null && String(trigger.attempt) !== String(run.attempt)) {
    problems.push(`receipt cites attempt ${trigger.attempt}, but the run is attempt ${run.attempt}`);
  }
  // INCOMPLETE DATA IS NOT A PASS. `fetchRunFacts` marks a truncated check-run
  // page; a certification computed from part of the evidence must say so rather
  // than produce a receipt that looks whole.
  if (run.incomplete) {
    problems.push(`the run's check data is INCOMPLETE: ${run.incomplete}`);
  }

  const states = run.suites ?? {};
  const reasons = run.reasons ?? {};

  // A STATE THAT REQUIRES OTHER EVIDENCE IS NOT THIS FILE'S TO GRANT.
  //
  // `STAGING_ACCEPTED` is a statement about a deployment; `ARTIFACT_VERIFIED` is a
  // statement about a registry. Neither is derived from merge-gate checks, so a
  // receipt claiming them here would be asserting something no evidence in this
  // run supports. The check is an ALLOWLIST, so a state nobody has defined yet
  // also fails.
  const claimedState = receipt.state;
  if (claimedState !== undefined) {
    if (!CERTIFICATION_STATES.includes(claimedState)) {
      problems.push(`receipt.state is ${JSON.stringify(claimedState)}, which is not one of`
        + ` ${CERTIFICATION_STATES.join(', ')}`);
    } else if (!STATES_THIS_FILE_PROVES.includes(claimedState)) {
      problems.push(`receipt.state is ${claimedState}, which needs evidence this receipt does not`
        + ' contain. This file can establish only'
        + ` ${STATES_THIS_FILE_PROVES.join(', ')}`);
    }
  }

  // A RECEIPT CANNOT CLAIM A SUITE THE RUN DOES NOT HAVE, OR THAT FAILED.
  for (const [name, claimed] of Object.entries(receipt.suites ?? {})) {
    if (claimed !== 'success') continue;
    if (!(name in states)) {
      problems.push(`receipt claims "${name}" succeeded, but run ${trigger.runId} has no such check`);
    } else if (states[name] !== 'success') {
      problems.push(`receipt claims "${name}" succeeded, but the run has it as ${states[name]}`
        + `${reasons[name] ? ` (${reasons[name]})` : ''}`);
    }
  }

  // EVERY REQUIRED SUITE MUST BE PRESENT AND GREEN, ON BOTH SIDES.
  //
  // This is the defect the file exists to close. It used to check only that the
  // RECEIPT mentioned each required suite, so:
  //
  //     receipt.suites.rust = "failure"
  //     run.suites.rust     = "failure"
  //     run.conclusion      = "success"
  //       -> CERTIFIED
  //
  // The receipt and the run agreeing that a required suite is red is not
  // agreement about certification; it is two sources describing the same failure.
  // Anything that is not `success` on BOTH sides is a refusal, and an unknown
  // state fails closed because `PASSING_STATES` is an allowlist.
  for (const name of REQUIRED_SUITES) {
    const claimed = (receipt.suites ?? {})[name];
    const actual = states[name];
    if (claimed === undefined) {
      problems.push(`receipt does not mention the required suite "${name}"`);
      continue;
    }
    if (!PASSING_STATES.has(claimed)) {
      problems.push(`receipt records the required suite "${name}" as ${JSON.stringify(claimed)}; only success certifies`);
    }
    if (actual === undefined) {
      problems.push(`the run has no check named "${name}", which is required`);
      continue;
    }
    if (!PASSING_STATES.has(actual)) {
      problems.push(`the required suite "${name}" is ${actual} on the run${reasons[name] ? ` (${reasons[name]})` : ''}; only success certifies`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}

/**
 * Everything about a run that a receipt asserts. Injected in tests.
 *
 * PAGINATION IS A REFUSAL, NOT A SILENT TRUNCATION.
 *
 * Both endpoints are requested with `per_page=100` and only that page was read.
 * This repository's largest commit currently carries fewer than 100 check runs,
 * so nothing observed so far is wrong — but a receipt computed from the first
 * hundred rows of a longer list is CERTIFIED on partial evidence, which is the
 * one thing this file exists to prevent. Until paging is implemented, a response
 * whose `total_count` exceeds what arrived marks the facts INCOMPLETE, and
 * `verifyReceipt` refuses an incomplete run.
 *
 * Calling this PREVENTIVE rather than a live defect is deliberate: no run has
 * been observed to cross the page boundary.
 */
export function fetchRunFacts(repo, runId) {
  const run = gh(repo, `actions/runs/${runId}`);
  const jobs = gh(repo, `actions/runs/${runId}/jobs?per_page=100`);

  // SUITES COME FROM THE COMMIT, NOT FROM THIS RUN.
  //
  // The first version asked only this run's jobs, so a `ci.yml` run could never
  // satisfy a receipt: `quality-faults` lives in `reliability.yml`, `linux-runtime`
  // in `platform-linux-acceptance.yml`. The receipt was refused - correctly, and
  // the refusal is the point: a certification is about a COMMIT, and this
  // repository spreads its required checks across nine workflows.
  const checkRuns = gh(repo, `commits/${run.head_sha}/check-runs?per_page=100`);

  // The workflow runs are needed for ATTRIBUTION, not for status: the check-run
  // API carries `check_suite.id` and the workflow-run API carries the same value
  // plus the workflow path. Without this join every check is unattributable, and
  // a check name that two workflows both produce cannot be told apart.
  const workflowRuns = gh(repo, `actions/runs/${runId}/../../actions/runs?head_sha=${run.head_sha}&per_page=100`);

  const incomplete = [];
  const checkTotal = Number(checkRuns.total_count ?? (checkRuns.check_runs ?? []).length);
  const checkSeen = (checkRuns.check_runs ?? []).length;
  if (checkTotal > checkSeen) {
    incomplete.push(`check runs: ${checkSeen} of ${checkTotal} read (one page requested)`);
  }
  const jobTotal = Number(jobs.total_count ?? (jobs.jobs ?? []).length);
  const jobSeen = (jobs.jobs ?? []).length;
  if (jobTotal > jobSeen) {
    incomplete.push(`jobs: ${jobSeen} of ${jobTotal} read (one page requested)`);
  }
  const wfTotal = Number(workflowRuns.total_count ?? (workflowRuns.workflow_runs ?? []).length);
  const wfSeen = (workflowRuns.workflow_runs ?? []).length;
  if (wfTotal > wfSeen) {
    incomplete.push(`workflow runs: ${wfSeen} of ${wfTotal} read (one page requested)`);
  }

  const attributed = suiteStates(checkRuns.check_runs ?? [], {}, workflowRuns.workflow_runs ?? []);
  return {
    headSha: run.head_sha,
    workflow: run.path ? String(run.path).replace(/^\.github\/workflows\//, '') : null,
    conclusion: run.conclusion,
    attempt: run.run_attempt,
    event: run.event,
    suites: attributed.states,
    reasons: attributed.reasons,
    duplicates: attributed.duplicates,
    // An unattributed check is not automatically wrong - a check produced by an
    // app rather than a workflow has no workflow path. It is reported so a
    // certifier can see it, not silently dropped.
    unattributed: attributed.unattributed,
    incomplete: incomplete.length ? incomplete.join('; ') : null,
    jobs: (jobs.jobs ?? []).map((j) => ({ name: j.name, conclusion: j.conclusion })),
  };
}

function selftest() {
  const good = {
    schema: SCHEMA,
    subject: { repository: 'o/r', sha: 'a'.repeat(40), ref: 'refs/tags/v1', tag: 'v1' },
    trigger: { event: 'push', runId: 7, attempt: 1 },
    suites: Object.fromEntries(REQUIRED_SUITES.map((n) => [n, 'success'])),
    artifacts: { imageDigest: 'sha256:x', bundleDigest: 'sha256:y' },
    verdict: 'CERTIFIED',
  };
  const runFor = (over = {}) => () => ({
    headSha: 'a'.repeat(40), conclusion: 'success', attempt: 1, event: 'push',
    suites: Object.fromEntries(REQUIRED_SUITES.map((n) => [n, 'success'])),
    ...over,
  });
  const cases = [
    ['a matching receipt verifies', () => verifyReceipt(good, runFor()).length === 0],
    ['a different head SHA is refused',
      () => verifyReceipt(good, runFor({ headSha: 'b'.repeat(40) })).some((p) => /head_sha/.test(p))],
    ['a failed run is refused',
      () => verifyReceipt(good, runFor({ conclusion: 'failure' })).some((p) => /concluded failure/.test(p))],
    ['a claimed suite missing from the run is refused',
      () => { const s = { ...good.suites }; delete s.rust; return verifyReceipt(good, runFor({ suites: s })).some((p) => /no such check/.test(p)); }],
    ['a suite the run has as failed is refused',
      () => verifyReceipt(good, runFor({ suites: { ...good.suites, rust: 'failure' } })).some((p) => /has it as failure/.test(p))],
    ['an unreachable run is refused rather than passed',
      () => verifyReceipt(good, () => { throw new Error('boom'); }).some((p) => /cannot read run/.test(p))],
    ['a bad schema is refused',
      () => verifyReceipt({ ...good, schema: 'x' }, runFor()).some((p) => /unknown schema/.test(p))],
    ['a receipt omitting a required suite is refused',
      () => { const s = { ...good.suites }; delete s['ci-gate']; return verifyReceipt({ ...good, suites: s }, runFor()).some((p) => /does not mention.*ci-gate/.test(p)); }],
  ];
  let bad = 0;
  for (const [label, fn] of cases) {
    let ok = false;
    try { ok = fn(); } catch { ok = false; }
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  }
  process.stdout.write(`release receipt selftest: ${cases.length - bad}/${cases.length}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if (mode === '--selftest') selftest();
  else if (mode === 'write') {
    const runId = Number(arg(argv, 'run'));
    const repo = arg(argv, 'repo') || process.env.REPO || 'baicie/ops-1';
    const facts = fetchRunFacts(repo, runId);
    const receipt = {
      schema: SCHEMA,
      subject: {
        repository: repo,
        sha: arg(argv, 'sha') || facts.headSha,
        ref: arg(argv, 'ref'),
        tag: arg(argv, 'tag') || (arg(argv, 'ref') ?? '').replace(/^refs\/tags\//, '') || null,
      },
      trigger: { event: facts.event, runId, attempt: facts.attempt },
      suites: facts.suites,
      artifacts: {
        // PROVENANCE, stated so nobody reads this as registry truth: both digests
        // are what the caller reported. TASK-15 (registry-side verification) is
        // what would make them checked rather than claimed.
        imageDigest: arg(argv, 'image-digest'),
        bundleDigest: arg(argv, 'bundle-digest'),
        source: 'build-reported (not registry-verified; see TASK-15)',
      },
      certifiedAt: new Date().toISOString(),
      // THE STATE, NOT THE WORD. `verdict: 'CERTIFIED'` was read as a release
      // approval; what this file actually establishes is that a commit's
      // merge-gate checks were green. The other states need evidence this run does
      // not carry - see CERTIFICATION_STATES.
      state: 'CODE_CERTIFIED',
      // Kept alongside so a reader of an older receipt is not silently misled by a
      // field that changed meaning.
      verdict: 'CODE_CERTIFIED',
    };
    const problems = verifyReceipt(receipt, () => ({ ...facts, headSha: facts.headSha }));
    if (problems.length) {
      for (const p of problems) process.stderr.write(`refusing to write: ${p}\n`);
      process.exit(1);
    }
    writeFileSync(arg(argv, 'out') || 'release-receipt.json', `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`receipt written for ${receipt.subject.sha}\n`);
  } else if (mode === 'verify') {
    const receipt = JSON.parse(readFileSync(arg(argv, 'receipt'), 'utf8'));
    // THE CLI MUST HAND `verifyReceipt` EVERYTHING IT CAN SEE.
    //
    // This adapter used to forward three fields - head_sha, conclusion, suites -
    // and drop the rest. Every check added to `verifyReceipt` that reads any other
    // field was therefore dead on the CLI path while passing its unit tests: the
    // function was correct and the caller bypassed it. That is the same shape as
    // a checker whose counterfactuals exercise a copy.
    //
    // The expectations are REQUIRED, not optional. Without them, "the receipt
    // agrees with the run" is the strongest claim available, and a receipt can be
    // generated for any commit - including one the operator did not ask to
    // certify. `--expect-sha` and `--expect-repository` are what bind the answer
    // to the question that was asked.
    const expectSha = arg(argv, 'expect-sha');
    const expectRepo = arg(argv, 'expect-repository');
    const expectRef = arg(argv, 'expect-ref');
    if (!expectSha || !expectRepo) {
      process.stderr.write('REFUSED: verify needs --expect-sha and --expect-repository.\n'
        + '  A receipt that only agrees with the run it cites proves nothing about WHICH run you asked about;\n'
        + '  the expectation has to be supplied independently of the document being checked.\n');
      process.exit(2);
    }
    const problems = verifyReceipt(receipt, (repo, runId) => {
      const f = fetchRunFacts(repo, runId);
      return {
        head_sha: f.headSha,
        workflow: f.workflow,
        conclusion: f.conclusion,
        attempt: f.attempt,
        event: f.event,
        suites: f.suites,
        reasons: f.reasons,
        incomplete: f.incomplete,
      };
    }, { repository: expectRepo, sha: expectSha, ref: expectRef ?? undefined });
    for (const p of problems) process.stdout.write(`FAIL ${p}\n`);
    process.stdout.write(problems.length
      ? 'state: NOT_CERTIFIED\n'
      : 'state: CODE_CERTIFIED  (merge-gate checks only; staging and registry are separate claims)\n');
    process.exit(problems.length ? 1 : 0);
  } else {
    process.stderr.write('usage: release-receipt.mjs write|verify|--selftest\n');
    process.exit(2);
  }
}
