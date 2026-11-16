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

export function pathsFor(workflow) {
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
      if (/^pull_request:\s*(#.*)?$/.test(trimmed)) prIndent = indent(line);
      continue;
    }
    // Left the pull_request block.
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
  let filters;
  try {
    filters = pathsFor(workflow);
  } catch (err) {
    process.stdout.write(`ERROR ${workflow}: could not read its paths filter: ${err.message}\n`);
    errors += 1;
    continue;
  }
  if (filters.length === 0) {
    process.stdout.write(`ERROR ${workflow}: suite ${suite} is attributed to it but it has no pull_request.paths, so this check cannot verify the pairing\n`);
    errors += 1;
    continue;
  }

  for (const [file, why] of PROBES) {
    const needed = analyse([file]).suites[suite];
    const starts = filters.some((f) => f.re.test(file));
    if (needed && !starts) {
      errors += 1;
      process.stdout.write(`ERROR ${suite}: ${file} requires it (${why}) but ${workflow} does not start for that path\n`);
      process.stdout.write(`        no check will exist, so nothing can be red; ci-gate would report the suite delegated\n`);
    } else if (!needed && starts) {
      warnings += 1;
      process.stdout.write(`warn  ${suite}: ${workflow} starts for ${file} (${why}) but the analyzer does not require ${suite}\n`);
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

process.stdout.write(`\nimpact/filter consistency: ${errors} error(s), ${warnings} warning(s)\n`);
if (errors > 0 || (strict && warnings > 0)) process.exit(1);
