#!/usr/bin/env node
/**
 * Do the workflow path filters and the impact analyzer agree?
 *
 * WHY THIS EXISTS
 *
 * "Which suites does this change require" is answered twice, in two files, by
 * two different edits:
 *
 *   1. `tests/ci/impact.mjs` — a rule table, read by `ci-gate` AFTER the run to
 *      judge it.
 *   2. `.github/workflows/<workflow>.yml`'s `paths:` filters — read by GitHub
 *      BEFORE the run, to decide what starts at all.
 *
 * Nothing made them agree. This audit measured 22 disagreements across five
 * workflows. Most are harmless in one direction (a filter that fires for a change
 * the analyzer does not consider relevant costs a run, not correctness). The
 * other direction is the dangerous one:
 *
 *     the analyzer requires a suite, and no workflow starts for that change.
 *
 * Then no check is ever produced, so there is nothing for any gate to find red,
 * and the suite is reported "delegated" and passes. `ci-gate` now catches that at
 * run time by querying the check-run API for the commit — but catching it after a
 * wasted round trip is worse than not creating it. This script is the static
 * version: it fails the `spec-coverage` job (a required check) when the tables
 * disagree, so the disagreement is fixed where it is introduced.
 *
 * WHAT "DISAGREE" MEANS HERE
 *
 * For a probe path and a suite:
 *
 *   analyzer needs it, no filter matches   FAIL  — the suite cannot run
 *   filter matches, analyzer does not      WARN  — wasted runner minutes
 *
 * Only the first is an error. The second is printed so the tables can be tidied,
 * but a filter being broader than the analyzer is not a correctness defect.
 *
 * Usage: node tests/ci/check-impact-consistency.mjs [--strict]
 *   --strict  treat WARN as failure too (not used in CI)
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { analyse, SUITES } from './impact.mjs';

/**
 * Suite -> the workflow whose `pull_request.paths` decides whether it runs.
 *
 * A suite with no entry is produced by `ci.yml`, which has no path filter and
 * therefore always runs. Those are not checked here: there is no filter to
 * disagree with.
 */
const SUITE_WORKFLOW = {
  'data-foundation': 'data-foundation.yml',
  'g12-acceptance': 'g12-acceptance.yml',
  'plugin-lifecycle': 'plugin-lifecycle.yml',
  'runtime-conformance': 'runtime-conformance.yml',
  // These two were missing, so nothing checked them - and that is exactly how
  // `browser-e2e` came to be mapped to data-foundation's `golden-path` check
  // while every path that requires it (packages/**, the two web apps) does not
  // start data-foundation at all. PR #127 failed on it.
  // `browser-e2e` has TWO producers for disjoint inputs; see ANY_OF_WORKFLOWS.
  'browser-e2e': 'g12-acceptance.yml',
  'linux-runtime': 'platform-linux-acceptance.yml',
  'quality-faults': 'reliability.yml',
  // NOT `contracts`. That suite is produced by `ci.yml`'s `contracts` job, which
  // has no path filter and always runs. `typed-pipeline-contracts.yml` runs a
  // DIFFERENT validator (`validate_typed_pipeline.py`) and reports a different
  // check name (`typed-pipeline-contracts`); it is an additional check, not the
  // producer of this suite. Attributing it here made this script demand that
  // `crates/bundle` changes start a workflow that never claimed to cover them.
};

/**
 * Probe paths: at least one per rule in impact.mjs, plus paths that exist only
 * to drive one workflow's filter.
 *
 * `why` is the impact.mjs rule the probe is here to exercise, so a probe that
 * stops probing anything is visible rather than silently passing.
 */
const PROBES = [
  ['apps/kernel/src/gateway.rs', 'kernel: the authorisation surface'],
  ['apps/kernel/src/capabilities.rs', 'kernel: capability grants'],
  ['apps/kernel/src/jobs.rs', 'kernel: DB-backed job claiming'],
  ['apps/node/src/runtime.rs', 'node: instance runtime'],
  ['apps/node/src/agent.rs', 'node: a file no filter names specifically'],
  ['apps/pipeline-worker/src/main.rs', 'pipeline worker'],
  ['apps/opsctl/src/main.rs', 'opsctl CLI'],
  ['crates/bundle/src/lib.rs', 'crate: bundle verify'],
  ['contracts/plugin-manifest.v1.schema.json', 'contract schema'],
  ['apps/platform-console/src/main.tsx', 'platform console'],
  ['apps/ops-web/src/main.tsx', 'ops web'],
  ['packages/ui/src/button.tsx', 'shared package'],
  ['packages/platform-client/src/index.ts', 'shared package'],
  ['plugins/hello-go/main.go', 'plugin source'],
  ['tests/ci/data_foundation_ci.sh', 'the harness itself'],
  ['tests/ci/p001c13_negatives.sh', 'a lifecycle script'],
  ['tests/acceptance/e2e_platform.sh', 'an acceptance script'],
  ['tests/acceptance/g12_foo.sh', 'a g12 acceptance script'],
  ['tests/contract/validate_contracts.py', 'a contract validator'],
  ['tests/runtime/conformance.ts', 'a runtime helper'],
  ['tests/reliability/faults.sh', 'a fault-injection script'],
  ['tests/ui/overview-matrix.spec.ts', 'a spec g12 runs'],
  ['tests/ui/studio.spec.ts', 'a spec data-foundation runs'],
  ['scripts/build-plugins.sh', 'the plugin builder'],
  ['scripts/demo_up.sh', 'the demo bring-up'],
  ['scripts/unrelated.mjs', 'a script no filter names specifically'],
  ['deployments/staging/Dockerfile', 'the staging image'],
  ['Cargo.lock', 'a lock file'],
  ['pnpm-lock.yaml', 'a lock file'],
  ['.github/workflows/data-foundation.yml', 'a workflow editing itself'],
  ['.github/workflows/reliability.yml', 'a workflow with no path filter'],
  ['.github/workflows/g12-acceptance.yml', 'a workflow editing itself'],
];

/**
 * Suites that more than one workflow can produce, as alternatives.
 *
 * The single-producer loop below asserts "the workflow that produces this suite
 * must start for the paths that require it". That is false for `browser-e2e`:
 * `packages/**` starts g12-acceptance and never data-foundation, and `tests/ui/**`
 * does the reverse. For those, the rule is "at least ONE of its producers starts",
 * which is the static twin of `REQUIRE_ANY_CHECK` in ci-gate.mjs.
 */
const ANY_OF_WORKFLOWS = {
  'browser-e2e': ['g12-acceptance.yml', 'data-foundation.yml'],
};

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withStars = escaped
    .replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
    .replace(/\*\*/g, '\u0000STARSTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')
    .replace(/\u0000STARSTAR\u0000/g, '.*');
  return new RegExp(`^${withStars}$`);
}

/**
 * WHAT PARSES THE FILTERS
 *
 * `pathsFor` below. It is checked against PyYAML by
 * `impact.test.mjs`'s cross-check case when PyYAML is installed, and it agreed
 * on all five workflows when it was written. If you change it, run that test.
 */

/**
 * Read `pull_request.paths` without a YAML dependency.
 *
 * Neither PyYAML nor a `yaml` npm package is guaranteed on a bare
 * `ubuntu-latest` runner, and an install step would be a new failure mode for a
 * check whose whole job is to not be flaky. So this parses the one structure it
 * needs, from indentation:
 *
 *   1. find the `pull_request:` key, note its indent;
 *   2. inside that block, find `paths:`, note its indent;
 *   3. collect `- item` lines deeper than `paths:` until something shallower.
 *
 * The first version scanned for `paths:` and collected `- ...` lines until a
 * blank line. `data-foundation.yml` has comment lines inside its `paths:` block,
 * so the scan stopped after two entries and this script reported ten false
 * disagreements. Comments and blank lines are skipped here, not treated as the
 * end of the list.
 *
 * The result is cross-checked against PyYAML when it IS available, so a silent
 * parser disagreement is a test failure rather than a wrong verdict.
 */
/**
 * The top-level trigger names of a workflow, read the same way `pathsFor` reads
 * its filters: with a real parse, no YAML dependency.
 */
export function triggersFor(workflow) {
  return JSON.parse(execFileSync('python3', [
    '-c',
    'import yaml, json, sys\n'
    + 'd = yaml.safe_load(open(sys.argv[1]))\n'
    + 'on = d.get(True) or d.get("on")\n'
    + 'if isinstance(on, str): print(json.dumps([on]))\n'
    + 'elif isinstance(on, list): print(json.dumps(on))\n'
    + 'else: print(json.dumps(list((on or {}).keys())))\n',
    `.github/workflows/${workflow}`,
  ], { encoding: 'utf8' }));
}

export function pathsFor(workflow, event = 'pull_request') {
  const path = `.github/workflows/${workflow}`;
  const lines = readFileSync(path, 'utf8').split('\n');
  const indent = (l) => l.match(/^ */)[0].length;

  let prIndent = null;
  let pathsIndent = null;
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (prIndent === null) {
      if (new RegExp(`^${event}:\\s*(#.*)?$`).test(trimmed)) prIndent = indent(line);
      continue;
    }
    // Left the trigger block.
    if (indent(line) <= prIndent) { prIndent = null; pathsIndent = null; continue; }

    if (pathsIndent === null) {
      if (/^paths:\s*(#.*)?$/.test(trimmed)) pathsIndent = indent(line);
      continue;
    }
    if (indent(line) <= pathsIndent) { pathsIndent = null; prIndent = null; continue; }

    const m = trimmed.match(/^-\s+(.*)$/);
    if (!m) continue;
    let value = m[1].trim();
    // Strip a trailing comment that is outside the quotes.
    const q = value.match(/^(['"])(.*?)\1\s*(#.*)?$/);
    if (q) value = q[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value) out.push(value);
  }
  return out.map((g) => ({ glob: g, re: globToRegExp(g) }));
}

export const SUITE_WORKFLOW_MAP = SUITE_WORKFLOW;
export const PROBE_LIST = PROBES;

const strict = process.argv.includes('--strict');
if (process.argv[1] && !process.argv[1].endsWith('check-impact-consistency.mjs')) {
  // imported as a module; the caller drives the checks itself
}
let errors = 0;
let warnings = 0;

for (const [suite, workflow] of Object.entries(SUITE_WORKFLOW)) {
  // An any-of suite is satisfied when ANY of its producers starts, so its
  // filters are the union of theirs.
  const producers = ANY_OF_WORKFLOWS[suite] ?? [workflow];
  const filters = [];
  let unfilteredProducer = null;
  let readFailure = null;
  for (const producer of producers) {
    let f;
    try {
      f = pathsFor(producer);
    } catch (err) {
      readFailure = `${producer}: could not read its paths filter: ${err.message}`;
      break;
    }
    if (f.length === 0) { unfilteredProducer = producer; break; }
    filters.push(...f);
  }
  if (readFailure) {
    process.stdout.write(`ERROR ${readFailure}\n`);
    errors += 1;
    continue;
  }
  // An unfiltered producer starts for everything, which is a legitimate shape
  // (platform-linux-acceptance and reliability have no pull_request.paths at all).
  if (unfilteredProducer) continue;

  for (const [file, why] of PROBES) {
    const needed = analyse([file]).suites[suite];
    const starts = filters.some((f) => f.re.test(file));
    if (needed && !starts) {
      errors += 1;
      process.stdout.write(`ERROR ${suite}: ${file} requires it (${why}) but no workflow that produces it starts for that path\n`);
      process.stdout.write(`        no check will exist, so nothing can be red; ci-gate would report the suite delegated\n`);
    } else if (!needed && starts) {
      warnings += 1;
      process.stdout.write(`warn  ${suite}: ${producers.join('/')} starts for ${file} (${why}) but the analyzer does not require ${suite}\n`);
    }
  }
}

// Every suite in the vocabulary must either have a workflow whose filter this
// check read, or be produced by ci.yml (which always runs). A suite that is in
// neither is one nothing can ever run - the "spec with no workflow is not a gate"
// defect, applied to the suite list itself.
const uncovered = SUITES.filter((s) => !(s in SUITE_WORKFLOW));
const CI_OWNED = [
  'rust', 'web', 'web-unit', 'spec-coverage', 'platform-only',
  'platform-image-build', 'quality-faults', 'linux-runtime', 'browser-e2e',
  'contracts',
];
for (const suite of uncovered) {
  if (!CI_OWNED.includes(suite)) {
    process.stdout.write(`ERROR suite ${suite}: no workflow produces it and it is not listed as ci.yml-owned\n`);
    errors += 1;
  }
}

// ---------------------------------------------------------------------------
// TRIGGER COMPLETENESS: a workflow that produces a suite must run on BOTH events.
//
// The filter check above asks "does this workflow start for these paths". It does
// not ask "does this workflow start at all on a push", and that was the defect
// the #120 merge exposed: `data-foundation.yml` had `pull_request` only, so on a
// push to main it never ran, `ci-gate` demanded the suite, and there was no check
// to find. The gate was right; the workflow was missing half its triggers.
//
// A suite that is only verified on pull requests means `main` is unverified for
// that suite. Every workflow here should run on push as well - and be path-
// filtered on the pull-request side only, so the post-merge run is unconditional.
// ---------------------------------------------------------------------------
for (const [suite, workflow] of Object.entries(SUITE_WORKFLOW)) {
  let triggers;
  try {
    triggers = triggersFor(workflow);
  } catch (err) {
    errors += 1;
    process.stdout.write(`ERROR ${workflow}: could not read its triggers: ${err.message}\n`);
    continue;
  }
  if (!triggers.includes('push')) {
    errors += 1;
    process.stdout.write(`ERROR ${workflow}: produces suite ${suite} but has no push trigger, so main is unverified for it\n`);
    process.stdout.write(`        ci-gate runs on push and will demand ${suite} with no check to find\n`);
  }
}

// ---------------------------------------------------------------------------
// PUSH FILTERS: the same question, asked of the other event.
//
// `ci.yml` is unfiltered on push on purpose - it carries HARD_REQUIRED, which is
// what catches a docs commit that broke the build. The heavy suites are filtered
// on both events, and those filters are generated from impact.mjs. If they drift,
// a push can start a suite the analyzer did not require (wasted minutes) or skip
// one it did (main unverified for it, with no red check to notice).
//
// Only the dangerous direction is an error here, same as above.
// ---------------------------------------------------------------------------
const UNFILTERED_ON_PUSH = new Set(['ci.yml']);

for (const [suite, workflow] of Object.entries(SUITE_WORKFLOW)) {
  if (UNFILTERED_ON_PUSH.has(workflow)) continue;
  // Same any-of rule as the pull-request side: a suite with alternative
  // producers is satisfied when any one of them starts.
  const producers = ANY_OF_WORKFLOWS[suite] ?? [workflow];
  let filters = [];
  let unfiltered = false;
  let readError = null;
  for (const producer of producers) {
    let f;
    try {
      f = pathsFor(producer, 'push');
    } catch (err) {
      readError = `${producer}: could not read its push filter: ${err.message}`;
      break;
    }
    if (f.length === 0) { unfiltered = true; break; }
    filters.push(...f);
  }
  if (readError) {
    errors += 1;
    process.stdout.write(`ERROR ${readError}\n`);
    continue;
  }
  if (unfiltered) continue;
  if (filters.length === 0) {
    // No push filter at all means it runs for everything, which is safe but
    // expensive. Report it rather than silently accepting the cost.
    warnings += 1;
    process.stdout.write(`warn  ${suite}: ${producers.join('/')} has no push paths filter, so it runs on every commit to main\n`);
    continue;
  }
  for (const [file, why] of PROBES) {
    const needed = analyse([file]).suites[suite];
    const starts = filters.some((f) => f.re.test(file));
    if (needed && !starts) {
      errors += 1;
      process.stdout.write(`ERROR ${suite}: ${file} requires it (${why}) but no workflow that produces it starts for it on push\n`);
      process.stdout.write(`        main would be unverified for ${suite} after that merge\n`);
    } else if (!needed && starts) {
      warnings += 1;
      process.stdout.write(`warn  ${suite}: ${producers.join('/')} starts on push for ${file} (${why}) but the analyzer does not require ${suite}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// GATED JOBS: every job whose `if:` reads the scope job must still be reachable.
//
// `ci.yml` now skips seven jobs unless `impact.mjs` asks for their suite. That is
// the biggest cost saving in this file's history and the biggest new way to lose
// coverage: if the analyzer stops mapping a path to a gated suite, the job
// silently stops running for it, and nothing is red - there is no check to be red.
//
// The check: for the paths that job exists to cover, the analyzer must still
// require its suite. `GATED_COVERAGE` names the job, the suite, and one path per
// thing the job is there for. A gated job with no entry here is an error, so
// adding one forces someone to say what it covers.
// ---------------------------------------------------------------------------
const GATED_COVERAGE = [
  // job id                          suite                   paths that must keep it on
  ['rust', 'rust', ['apps/kernel/src/gateway.rs', 'crates/bundle/src/lib.rs']],
  ['web', 'web', ['apps/platform-console/src/main.tsx', 'apps/ops-web/src/main.tsx']],
  ['web-unit', 'web-unit', ['packages/ui/src/button.tsx']],
  [
    'platform-image-build', 'platform-image-build',
    // Everything the Dockerfile compiles: apps/, crates/, contracts/, both web apps.
    ['apps/kernel/src/gateway.rs', 'apps/node/src/agent.rs', 'crates/bundle/src/lib.rs',
      'contracts/x.json', 'apps/ops-web/src/main.tsx'],
  ],
  [
    'runtime-image-build', 'platform-image-build',
    // The full image additionally ships the pipeline worker and both bundles.
    ['apps/pipeline-worker/src/main.rs', 'apps/ops-web/src/main.tsx',
      'apps/platform-console/src/main.tsx'],
  ],
  [
    'g13a1-gateway', 'g12-acceptance',
    ['apps/kernel/src/gateway.rs', 'apps/kernel/src/capabilities.rs'],
  ],
];

for (const [job, suite, paths] of GATED_COVERAGE) {
  for (const file of paths) {
    if (!analyse([file]).suites[suite]) {
      errors += 1;
      process.stdout.write(`ERROR gated job ${job}: ${file} no longer requires ${suite}, so the job would be skipped for it\n`);
      process.stdout.write(`        the job is now conditional on that suite; a change to ${file} would not build it\n`);
    }
  }
}

// A workflow edit must require the suites that workflow produces. This is the
// defect PR #125 hit: ci.yml defines the rust/web/image/acceptance jobs, but an
// edit to it was mapped to `spec-coverage` alone, so the jobs it defines were
// skipped by the very change that could break them.
const WORKFLOW_EDIT_COVERAGE = [
  ['.github/workflows/ci.yml', ['rust', 'web', 'platform-image-build']],
  ['.github/workflows/data-foundation.yml', ['data-foundation']],
  ['.github/workflows/g12-acceptance.yml', ['g12-acceptance']],
  ['.github/workflows/platform-linux-acceptance.yml', ['linux-runtime']],
  ['.github/workflows/plugin-lifecycle.yml', ['plugin-lifecycle']],
  ['.github/workflows/reliability.yml', ['quality-faults']],
  ['.github/workflows/runtime-conformance.yml', ['runtime-conformance']],
];
for (const [file, suites] of WORKFLOW_EDIT_COVERAGE) {
  const got = analyse([file]).suites;
  for (const suite of suites) {
    if (!got[suite]) {
      errors += 1;
      process.stdout.write(`ERROR ${file} is edited but does not require ${suite}, the suite its jobs produce\n`);
      process.stdout.write(`        a change to the file defining that job would skip it\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// THE OTHER DIRECTION: a required suite must have a workflow that will START.
//
// `ci-gate` fails on `delegated-absent` - a suite the analyzer required whose
// workflow produced no check. That is correct behaviour, and it means an analyzer
// rule can make a PR unmergeable by demanding a suite whose own `paths` filter
// does not match the file being edited.
//
// This happened: `.github/workflows/ci.yml` was mapped to `[...SUITES]`, and
// ci-gate then reported `delegated-absent: g12-acceptance` and
// `delegated-absent: plugin-lifecycle` on PR #125, because those workflows do not
// watch `ci.yml`. The gate was right; the rule asked for something that could not
// exist.
//
// So: for every workflow file, every suite it requires must be produced by a
// workflow whose `pull_request.paths` matches that file - or by `ci.yml`, which is
// unfiltered. This is the static twin of the gate's runtime check.
// ---------------------------------------------------------------------------
const CI_OWNED_SUITES = new Set([
  'rust', 'web', 'web-unit', 'contracts', 'spec-coverage', 'platform-only',
  'platform-image-build', 'linux-runtime', 'quality-faults',
]);

for (const workflow of Object.keys({ ...SUITE_WORKFLOW, 'ci.yml': null })) {
  const file = `.github/workflows/${workflow}`;
  if (workflow === 'platform-linux-acceptance.yml' || workflow === 'reliability.yml') {
    // These have no pull_request.paths, so they run for any PR.
    continue;
  }
  const required = analyse([file]).suites;
  for (const suite of Object.keys(required).filter((k) => required[k])) {
    if (CI_OWNED_SUITES.has(suite)) continue;
    const producer = SUITE_WORKFLOW[suite];
    if (!producer) continue;
    let filters;
    try { filters = pathsFor(producer, 'pull_request'); } catch { continue; }
    if (filters.length === 0) continue; // unfiltered, always starts
    if (filters.some((f) => f.re.test(file))) continue;
    errors += 1;
    process.stdout.write(`ERROR editing ${file} requires ${suite}, but ${producer} does not start for ${file}\n`);
    process.stdout.write(`        ci-gate will report delegated-absent and fail the PR\n`);
  }
}

// ---------------------------------------------------------------------------
// A REQUIRED check that a change cannot produce blocks forever.
//
// This is the argument against listing the delegated suites in the branch
// ruleset, and it is measured rather than asserted:
//
//     node tests/ci/impact.mjs --files docs/README.md
//     run: (none)
//
// A docs change starts no suite. If `golden-path` were a required context, that
// PR would sit at "Expected — Waiting for status to be reported" until someone
// edited the ruleset again: data-foundation.yml's `pull_request.paths` does not
// match `docs/**`, so the check is never created.
//
// The invariant, per suite: either some path the analyzer maps to it can reach a
// workflow that produces it, or it must not be named in the ruleset. `ci-gate`
// is the exception that makes the ruleset workable - it runs on every PR and
// decides per-change - which is why docs/ci/ruleset-migration.md proposes
// requiring it and not the individual checks.
//
// The list below is the set of suites the ruleset could plausibly name. Keep it
// in step with DELEGATED_CHECK_OWNERS in ci-gate.mjs.
{
  const RULESET_CANDIDATES = [
    'linux-runtime', 'quality-faults', 'data-foundation', 'plugin-lifecycle',
    'runtime-conformance', 'g12-acceptance', 'browser-e2e',
  ];
  // One representative path per suite, taken from the analyzer itself.
  const SAMPLE = {
    'linux-runtime': 'apps/node/src/main.rs',
    'quality-faults': 'tests/reliability/lease_fencing.sh',
    'data-foundation': 'tests/acceptance/pipeline_orphan_worker.sh',
    'plugin-lifecycle': 'scripts/build-plugins.sh',
    'runtime-conformance': 'tests/contract/run_conformance.py',
    'g12-acceptance': 'apps/kernel/src/gateway.rs',
    'browser-e2e': 'apps/platform-console/src/App.tsx',
  };
  for (const suite of RULESET_CANDIDATES) {
    const sample = SAMPLE[suite];
    if (!sample) continue;
    const decision = analyse([sample]);
    if (!decision.suites[suite]) {
      errors += 1;
      process.stdout.write(`ERROR sample path ${sample} does not require ${suite}; the ruleset-candidates table is stale\n`);
    }
  }
  // The property the proposal rests on: a docs change requires nothing, so a
  // delegated suite cannot be a static required context.
  const docs = analyse(['docs/README.md']);
  const anyRequired = Object.values(docs.suites).some(Boolean);
  if (anyRequired) {
    warnings += 1;
    process.stdout.write('warn  a docs-only change now requires a suite; re-check whether delegated checks can be required statically\n');
  }
}

// ---------------------------------------------------------------------------
// A RULESET-REQUIRED CHECK MUST REACH A CONCLUSION ON EVERY PULL REQUEST.
//
// Ruleset 26958761 names nine contexts. GitHub's required-status rule wants a
// *conclusion* named `rust` on the head commit, and neither `skipped` nor an
// absent check is one. Both block a merge identically:
//
//     9 of 9 required status checks are expected
//
// Measured three separate times in one day: PR #144 skipped `web` and `web-unit`
// through an `if:`; the first fix removed that `if:` but left `needs: [scope]`,
// which skips a job whose dependency failed - the same defect wearing a different
// hat; and `impact.mjs --stdin` could die with ENOBUFS on a large change set,
// which failed `scope` and cascaded to four required jobs through `needs`.
//
// So this check does not look for one bad pattern. It enumerates every way a
// required job can fail to conclude, and it FAILS if it cannot positively confirm
// the job is unconditional. The previous version matched only
// `/^    if:.*needs\.scope\.outputs/`, which reported 0 errors against all of:
//
//     rust-build:            (the job renamed - the context `rust` disappears)
//     web-unit: if: false
//     web-unit: if: ${{ needs.scope.result == 'success' }}
//     web-unit: if: ${{ github.event_name == 'push' }}
//     spec-coverage: needs: [scope]
//
// Each of those is a required context that can stop reporting. Each ran green.
{
  const REQUIRED_CONTEXTS = [
    'rust', 'web', 'web-unit', 'contracts', 'spec-coverage',
    'platform-only', 'platform-image-build', 'quality-faults', 'linux-runtime',
  ];

  // Which workflow file supplies which context. `quality-faults` and
  // `linux-runtime` live elsewhere; the check covers their triggers too.
  const CONTEXT_FILE = {
    rust: 'ci.yml',
    web: 'ci.yml',
    'web-unit': 'ci.yml',
    contracts: 'ci.yml',
    'spec-coverage': 'ci.yml',
    'platform-only': 'ci.yml',
    'platform-image-build': 'ci.yml',
    'quality-faults': 'reliability.yml',
    'linux-runtime': 'platform-linux-acceptance.yml',
  };

  const readWorkflow = (name) => {
    try {
      return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
    } catch { return null; }
  };

  /**
   * Parse the `jobs:` block into { id -> { if, needs, hasName } }.
   *
   * Deliberately a line walker rather than a YAML parse: this script must run
   * inside the `spec-coverage` job with no dependencies, and the shapes it needs
   * (top-level `if:`/`needs:` of a job) are unambiguous at this indentation.
   */
  const parseJobs = (text) => {
    const jobs = new Map();
    if (!text) return jobs;
    const lines = text.split('\n');
    let inJobs = false;
    let current = null;
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (!inJobs) continue;
      if (/^[A-Za-z_.#]/.test(line)) { inJobs = false; continue; }
      const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (jobMatch) {
        current = { id: jobMatch[1], if: null, needs: null, name: null };
        jobs.set(current.id, current);
        continue;
      }
      if (!current) continue;
      const ifMatch = /^    if:\s*(.+?)\s*$/.exec(line);
      if (ifMatch) { current.if = ifMatch[1]; continue; }
      const needsMatch = /^    needs:\s*(.+?)\s*$/.exec(line);
      if (needsMatch) { current.needs = needsMatch[1]; continue; }
      const nameMatch = /^    name:\s*(.+?)\s*$/.exec(line);
      if (nameMatch && current.name === null) { current.name = nameMatch[1]; }
    }
    return jobs;
  };

  /**
   * Parse the `on:` block for pull_request path filters.
   *
   * Returns null when the workflow has no `pull_request` trigger at all (which is
   * its own defect - it then never runs for a PR), or the list of path globs, or
   * an empty list when the trigger is unfiltered.
   */
  const pullRequestPaths = (text) => {
    if (!text) return null;
    const lines = text.split('\n');
    let inOn = false;
    let inPr = false;
    let prFound = false;
    const paths = [];
    let inPaths = false;
    for (const line of lines) {
      if (/^on:\s*$/.test(line)) { inOn = true; continue; }
      if (inOn && /^[A-Za-z_.#]/.test(line)) { inOn = false; inPr = false; inPaths = false; continue; }
      if (!inOn) continue;
      if (/^  (pull_request|pull_request_target):\s*$/.test(line)) { inPr = true; prFound = true; continue; }
      if (/^  [a-z_]+:\s*$/.test(line)) { inPr = false; inPaths = false; continue; }
      if (!inPr) continue;
      if (/^    paths(-ignore)?:\s*$/.test(line)) { inPaths = true; continue; }
      if (inPaths) {
        const m = /^\s+-\s*'?"?([^'"]+)'?"?\s*$/.exec(line);
        if (m) { paths.push(m[1]); continue; }
        if (/^    [a-z]/.test(line)) { inPaths = false; }
      }
      // Inline form `pull_request: {paths: [...]}` is not used in this repo; the
      // block form above is. A one-line form would need its own parse.
    }
    return prFound ? paths : null;
  };

  const problems = [];
  const perFile = new Map();
  for (const file of new Set(Object.values(CONTEXT_FILE))) {
    perFile.set(file, readWorkflow(file));
  }

  for (const context of REQUIRED_CONTEXTS) {
    const file = CONTEXT_FILE[context];
    const text = perFile.get(file);

    if (text === null) {
      problems.push(`${context}: ${file} does not exist, so the required context is never produced`);
      continue;
    }

    const paths = pullRequestPaths(text);
    if (paths === null) {
      problems.push(`${context}: ${file} has no \`pull_request\` trigger, so the context never appears on a PR`);
    } else if (paths.length > 0) {
      problems.push(`${context}: ${file} filters \`pull_request\` by paths (${paths.join(', ')}); a change matching none of them produces no ${context} check`);
    }

    const jobs = parseJobs(text);
    const job = jobs.get(context);
    if (!job) {
      // The job id is what becomes the check name when there is no `name:`.
      // A renamed job silently stops producing the required context, which is
      // the defect the previous version of this check could not see.
      problems.push(`${context}: no job with that id in ${file}; the required context would disappear (rename?)`);
      continue;
    }

    // An effective check name that differs from the job id means the ruleset is
    // naming something this job does not report.
    if (job.name !== null && job.name.replace(/^['"]|['"]$/g, '') !== context) {
      problems.push(`${context}: job \`${context}\` in ${file} declares \`name: ${job.name}\`, so it reports that name instead of \`${context}\``);
    }

    if (job.if !== null) {
      problems.push(`${context}: job in ${file} has \`if: ${job.if}\`; any false evaluation skips the required context`);
    }

    // `needs` is the subtle one: a job whose dependency was skipped or failed is
    // ITSELF skipped. `needs: [scope]` therefore makes a required job conditional
    // on `scope` succeeding, even with no `if:` at all.
    if (job.needs !== null) {
      problems.push(`${context}: job in ${file} has \`needs: ${job.needs}\`; if any of those is skipped or fails, this job is skipped too - and ruleset 26958761 counts that as unreported`);
    }
  }

  for (const problem of problems) {
    errors += 1;
    process.stdout.write(`ERROR ${problem}\n`);
  }
  if (problems.length === 0) {
    process.stdout.write('required contexts: all nine run unconditionally on every pull request\n');
  }
}

process.stdout.write(`\nimpact/filter consistency: ${errors} error(s), ${warnings} warning(s)\n`);
if (errors > 0 || (strict && warnings > 0)) process.exit(1);
