#!/usr/bin/env node
/**
 * The merge gate: decide, from real job results, whether a pull request may merge.
 *
 * WHY THIS IS A SCRIPT AND NOT `needs:`
 *
 * GitHub's `needs` only orders jobs INSIDE one workflow. The suites this
 * repository needs live in seven workflows, and no `needs:` can wait for another
 * workflow's run. A gate that claims to aggregate across workflows while writing
 * `needs: [rust, web]` would silently pass on the three suites it cannot see.
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
 *      step into a successful job. The gate cannot see inside a job, so the
 *      workflows are checked separately (`tests/ci/check-workflow-hygiene.mjs`).
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
  'rust',
  'web',
  'web-unit',
  'contracts',
  'spec-coverage',
];

/**
 * Job id -> suite name. The workflow passes `needs` verbatim; this maps the
 * GitHub job ids onto the analyzer's vocabulary.
 *
 * A job listed here that is ABSENT from `needs` is an error, not a skip: it means
 * the gate was wired to fewer jobs than it claims to check.
 */
export const JOB_TO_SUITE = {
  rust: 'rust',
  web: 'web',
  'web-unit': 'web-unit',
  contracts: 'contracts',
  'spec-coverage': 'spec-coverage',
  'platform-only': 'platform-only',
  'platform-image-build': 'platform-image-build',
  'quality-faults': 'quality-faults',
  'linux-runtime': 'linux-runtime',
  'plugin-lifecycle': 'plugin-lifecycle',
  'runtime-conformance': 'runtime-conformance',
  'data-foundation': 'data-foundation',
  'browser-e2e': 'browser-e2e',
  'g12-acceptance': 'g12-acceptance',
};

/**
 * @param {Record<string,string>} needs job id -> result ('success'|'failure'|'cancelled'|'skipped')
 * @param {{suites: Record<string, boolean>, unmatched: string[]}} impact
 * @returns {{verdict: 'PASS'|'FAIL', required: string[], failed: string[],
 *            skippedRequired: string[], notWired: string[], notes: string[]}}
 */
export function gate(needs, impact) {
  const required = new Set(HARD_REQUIRED);
  for (const suite of SUITES) {
    if (impact.suites[suite]) required.add(suite);
  }

  const failed = [];
  const skippedRequired = [];
  const notWired = [];
  const notes = [];

  for (const suite of required) {
    const jobId = Object.keys(JOB_TO_SUITE).find((k) => JOB_TO_SUITE[k] === suite);
    if (!jobId || !(jobId in needs)) {
      // The gate is wired to fewer jobs than it requires. That is a defect in the
      // gate, and it must not read as "the suite was fine".
      notWired.push(suite);
      continue;
    }
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

  // Suites that ran and were not required are still worth reporting: a suite
  // failing when it was not asked for is information, not a merge blocker — but
  // silence about it is how "the impact table is wrong" goes unnoticed.
  for (const [jobId, result] of Object.entries(needs)) {
    const suite = JOB_TO_SUITE[jobId];
    if (!suite || required.has(suite)) continue;
    if (result === 'failure') notes.push(`${suite} ran and failed, but this change did not require it`);
    else if (result === 'skipped') notes.push(`${suite} skipped (not required for this change)`);
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
    notes,
  };
}

const SELFTEST = [
  {
    name: 'all required green',
    needs: { rust: 'success', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success', 'plugin-lifecycle': 'success', 'runtime-conformance': 'success', 'data-foundation': 'success', 'browser-e2e': 'success', 'g12-acceptance': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, true])), unmatched: [] },
    want: 'PASS',
  },
  {
    name: 'rust failed',
    because: 'failed',
    needs: { ...{}, ...{ rust: 'failure' }, web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] },
    want: 'FAIL',
  },
  // A required suite SKIPPED -> fail. This is the counterfactual that matters:
  // a gate written `result !== 'failure'` passes this one, which is exactly how
  // a path filter or an `if:` becomes a silent hole in the merge gate.
  {
    name: 'rust skipped',
    because: 'skipped',
    needs: { rust: 'skipped', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] },
    want: 'FAIL',
  },
  // A required suite CANCELLED -> fail, and classified as failed rather than
  // skipped: the job started and was interrupted, which is not the same as
  // never having been asked to run.
  {
    name: 'rust cancelled',
    because: 'failed',
    needs: { rust: 'cancelled', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] },
    want: 'FAIL',
  },
  {
    name: 'impact-required suite skipped',
    because: 'skipped',
    needs: { rust: 'success', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success', 'plugin-lifecycle': 'skipped' },
    impact: { suites: { ...Object.fromEntries(SUITES.map((s) => [s, false])), 'plugin-lifecycle': true }, unmatched: [] },
    want: 'FAIL',
  },
  {
    name: 'non-required suite skipped',
    needs: { rust: 'success', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success', 'plugin-lifecycle': 'skipped' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] },
    want: 'PASS',
  },
  {
    name: 'required suite not wired',
    because: 'notWired',
    needs: { web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, false])), unmatched: [] },
    want: 'FAIL',
  },
  {
    name: 'unmapped path with all wired green',
    needs: { rust: 'success', web: 'success', 'web-unit': 'success', contracts: 'success', 'spec-coverage': 'success', 'platform-only': 'success', 'platform-image-build': 'success', 'quality-faults': 'success', 'linux-runtime': 'success', 'plugin-lifecycle': 'success', 'runtime-conformance': 'success', 'data-foundation': 'success', 'browser-e2e': 'success', 'g12-acceptance': 'success' },
    impact: { suites: Object.fromEntries(SUITES.map((s) => [s, true])), unmatched: ['x/y.bin'] },
    want: 'PASS',
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
    const ok = okVerdict && okReason;
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ${c.want}${c.because ? ` because ${c.because}` : ''}, got ${got.verdict} (failed=${got.failed.length} skipped=${got.skippedRequired.length} notWired=${got.notWired.length})\n`);
  }
  process.stdout.write(bad === 0 ? `gate selftest: ${SELFTEST.length}/${SELFTEST.length} pass\n`
    : `gate selftest: ${bad} FAILED\n`);
  return bad === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();

  let needsJson = null;
  let impactJson = null;
  let files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--needs-json') { needsJson = argv[++i]; }
    else if (argv[i] === '--impact-json') { impactJson = argv[++i]; }
    else if (argv[i] === '--files') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) files.push(argv[++i]); }
    else { process.stderr.write(`ci-gate: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!needsJson) { process.stderr.write('ci-gate: --needs-json is required\n'); return 2; }

  let needs;
  try { needs = JSON.parse(needsJson); } catch { process.stderr.write('ci-gate: --needs-json is not JSON\n'); return 2; }
  const impact = impactJson ? JSON.parse(impactJson) : analyse(files);

  const result = gate(needs, impact);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`\nverdict: ${result.verdict}\n`);
  if (result.verdict === 'FAIL') {
    for (const f of result.failed) process.stdout.write(`  failed: ${f}\n`);
    for (const s of result.skippedRequired) process.stdout.write(`  skipped: ${s}\n`);
    for (const n of result.notWired) process.stdout.write(`  not wired: ${n}\n`);
    return 1;
  }
  for (const n of result.notes) process.stdout.write(`  note: ${n}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
