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

export const SCHEMA = 'opsweave.release-receipt/v1';

/** Suites a certification must have a result for, by check name. */
export const REQUIRED_SUITES = [
  'rust', 'web', 'web-unit', 'contracts', 'spec-coverage',
  'platform-only', 'platform-image-build', 'quality-faults', 'linux-runtime',
  'ci-gate',
];

function gh(repo, path) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8' }));
}

/** Reduce a run's check runs to `{name: conclusion}` for completed checks. */
export function suiteStates(checkRuns) {
  const out = {};
  for (const run of checkRuns ?? []) {
    const name = run.name;
    const state = run.conclusion ?? run.status;
    // A later attempt replaces an earlier one - the same rule the gate uses.
    if (out[name] === 'success') continue;
    out[name] = state;
  }
  return out;
}

/**
 * Verify a receipt against the run it cites.
 *
 * @returns {string[]} problems; empty means CERTIFIED.
 */
export function verifyReceipt(receipt, fetchRun) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object') return ['not a JSON object'];
  if (receipt.schema !== SCHEMA) problems.push(`unknown schema ${JSON.stringify(receipt.schema)}`);

  const subject = receipt.subject ?? {};
  const trigger = receipt.trigger ?? {};
  if (!/^[0-9a-f]{40}$/.test(subject.sha ?? '')) problems.push('subject.sha is not a 40-hex commit');
  if (!subject.repository) problems.push('subject.repository is missing');
  if (!trigger.runId) problems.push('trigger.runId is missing');

  if (problems.length) return problems;

  let run;
  try {
    run = fetchRun(subject.repository, trigger.runId);
  } catch (error) {
    return [`cannot read run ${trigger.runId}: ${String(error).split('\n')[0]}`];
  }

  // `head_sha` is what the REST API calls it; a caller-supplied fact object may
  // use either spelling. One canonical name at the boundary, both accepted here.
  const headSha = run.head_sha ?? run.headSha;
  if (String(headSha) !== subject.sha) {
    problems.push(`the run's head_sha is ${headSha}, but the receipt claims ${subject.sha}`);
  }
  if (run.conclusion !== 'success') {
    problems.push(`run ${trigger.runId} concluded ${run.conclusion}, not success`);
  }

  const states = run.suites ?? {};
  for (const [name, claimed] of Object.entries(receipt.suites ?? {})) {
    if (claimed !== 'success') continue;
    if (!(name in states)) {
      problems.push(`receipt claims "${name}" succeeded, but run ${trigger.runId} has no such check`);
    } else if (states[name] !== 'success') {
      problems.push(`receipt claims "${name}" succeeded, but the run has it as ${states[name]}`);
    }
  }
  for (const required of REQUIRED_SUITES) {
    if (!(required in (receipt.suites ?? {}))) {
      problems.push(`receipt does not mention the required suite "${required}"`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}

/** Everything about a run that a receipt asserts. Injected in tests. */
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
  //
  // Reading them from the commit's check runs also means a suite that never RAN
  // is reported as absent rather than silently omitted - `suiteStates` has no
  // entry for it and `verifyReceipt` refuses a receipt that does not mention a
  // required suite.
  const checkRuns = gh(repo, `commits/${run.head_sha}/check-runs?per_page=100`);
  return {
    headSha: run.head_sha,
    conclusion: run.conclusion,
    attempt: run.run_attempt,
    event: run.event,
    suites: suiteStates(checkRuns.check_runs),
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
      verdict: 'CERTIFIED',
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
    const problems = verifyReceipt(receipt, (repo, runId) => {
      const f = fetchRunFacts(repo, runId);
      return { head_sha: f.headSha, conclusion: f.conclusion, suites: f.suites };
    });
    for (const p of problems) process.stdout.write(`FAIL ${p}\n`);
    process.stdout.write(problems.length ? 'verdict: NOT_CERTIFIED\n' : 'verdict: CERTIFIED\n');
    process.exit(problems.length ? 1 : 0);
  } else {
    process.stderr.write('usage: release-receipt.mjs write|verify|--selftest\n');
    process.exit(2);
  }
}
