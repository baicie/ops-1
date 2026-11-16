#!/usr/bin/env node
/**
 * Impact analysis: which CI suites must run for a given change set?
 *
 * Why this exists. Today every suite that can run, runs. A one-line change to
 * `apps/kernel/src/gateway.rs` fires `data-foundation` (1051 s) AND
 * `typed-pipeline-runtime` (1502 s), which between them execute the same 42-step
 * harness twice. Nothing decides "what does this change actually require"; the
 * path filters are per-workflow and were written independently, so their union
 * is whatever happened to accumulate.
 *
 * This module answers the question once, from a single table, so the answer can
 * be tested counterfactually: give it a file list, get the suites.
 *
 * WHAT IT IS NOT
 *
 * It is not a replacement for the path filters or for `ci-gate`. It produces the
 * decision; the gate enforces it and refuses to pass when a suite that should
 * have run did not.
 *
 * FAIL-CLOSED
 *
 * Every rule below can only ADD a suite. The default for an unrecognised path is
 * "run everything", not "run nothing": a new top-level directory that nobody
 * mapped must not silently become untested. `unmatched` in the JSON output is
 * what made the caller take the strict branch, and it is reported, not hidden.
 *
 * Usage:
 *   node tests/ci/impact.mjs --files a.rs b.ts
 *   git diff --name-only base...head | node tests/ci/impact.mjs --stdin
 *   node tests/ci/impact.mjs --files ... --json
 *
 * Exit codes: 0 decision produced, 2 bad usage. A decision is always produced;
 * this script does not fail because a change is large.
 */

import { execFileSync } from 'node:child_process';

/**
 * The suites this repository can run. These names are the vocabulary the
 * workflows and `ci-gate` use; adding one here without wiring it is caught by
 * `tests/ci/impact.test.mjs`.
 */
export const SUITES = [
  'rust',              // cargo fmt/clippy/test, workspace
  'web',               // typecheck + build, both apps and the shared packages
  'web-unit',          // vitest
  'contracts',         // contracts/ schema validation, both validators
  'spec-coverage',     // tests/ui specs are wired to a workflow
  'platform-only',     // kernel builds with no plugin/default features
  'platform-image-build',
  'quality-faults',    // tests/reliability
  'linux-runtime',     // container ownership, migration, node runtime on Linux
  'plugin-lifecycle',  // OCI build -> sign -> deploy -> upgrade -> rollback -> uninstall
  'runtime-conformance', // TS/Go/Java protocol conformance
  'data-foundation',   // the 42-step harness: Pipeline API, jobs, leases, tokens
  'browser-e2e',       // Playwright against a live platform
  'g12-acceptance',    // platform console / ops-web acceptance flows
];

/**
 * Path glob -> suites that change requires.
 *
 * Ordered most-specific first only for readability; every match contributes.
 * Globs are the small subset this repository's filters already use: a literal
 * prefix, `/**` for "everything below", and `*` for one segment.
 */
const RULES = [
  // --- Rust source -----------------------------------------------------------
  { glob: 'apps/kernel/**', suites: ['rust', 'platform-only', 'data-foundation', 'linux-runtime'] },
  // The gateway and capability code is the authorisation surface. A change here
  // must be measured against the security negatives and the gateway acceptance,
  // not only against `cargo test`.
  { glob: 'apps/kernel/src/gateway.rs', suites: ['g12-acceptance'] },
  { glob: 'apps/kernel/src/capabilities.rs', suites: ['runtime-conformance', 'plugin-lifecycle'] },
  { glob: 'apps/node/**', suites: ['rust', 'linux-runtime', 'data-foundation', 'plugin-lifecycle'] },
  { glob: 'apps/pipeline-worker/**', suites: ['rust', 'data-foundation'] },
  { glob: 'apps/opsctl/**', suites: ['rust', 'plugin-lifecycle'] },
  // `crates/**` used to require `contracts` as well. Only `crates/bundle` has any
  // relationship to the contract validators (it is what signs and verifies the
  // bundles `validate_contracts.py` was written to inspect), and
  // `typed-pipeline-contracts.yml` does not watch `crates/` at all - so the
  // requirement produced a suite that could not run for that change.
  { glob: 'crates/**', suites: ['rust'] },
  { glob: 'crates/bundle/**', suites: ['contracts'] },

  // --- Contracts -------------------------------------------------------------
  { glob: 'contracts/**', suites: ['contracts', 'runtime-conformance', 'data-foundation'] },

  // --- Web -------------------------------------------------------------------
  { glob: 'apps/platform-console/**', suites: ['web', 'web-unit', 'browser-e2e'] },
  { glob: 'apps/ops-web/**', suites: ['web', 'web-unit', 'browser-e2e'] },
  { glob: 'packages/**', suites: ['web', 'web-unit', 'browser-e2e'] },
  // `data-foundation` belongs here: the 42-step harness runs four Playwright
  // specs from this directory (data_foundation_ci.sh:333 - data-foundation,
  // data-foundation-flows, studio, visual-layout). Without it, the push filter
  // generated from this table omitted `tests/ui/**` and
  // `check-spec-coverage.mjs` caught the inconsistency: a spec the workflow runs
  // on a pull request but not on a push.
  { glob: 'tests/ui/**', suites: ['spec-coverage', 'browser-e2e', 'data-foundation'] },

  // --- Plugins ---------------------------------------------------------------
  { glob: 'plugins/**', suites: ['runtime-conformance', 'plugin-lifecycle', 'data-foundation'] },

  // --- Test infrastructure ---------------------------------------------------
  // A change to the harness can break any suite that uses it, and the harness
  // itself is not covered by any assertion that reads it. Run the things it
  // drives.
  //
  // The plugin-lifecycle claim here used to be `tests/ci/**` wholesale, which
  // said "any change under tests/ci requires the lifecycle suite". Measured
  // against what that workflow actually runs, it is false: `plugin-lifecycle.yml`
  // invokes exactly three scripts — p001c13_lifecycle.sh, p001c13_negatives.sh,
  // p001c_multilang_lifecycle.sh — and none of them calls the 42-step harness.
  // The rule was an over-broad guess, and the cost of the guess was that
  // `ci-gate` demanded a lifecycle result for a change to, say,
  // `tests/ci/check-tracked-png-budget.mjs`; the lifecycle filter does not match
  // that path, so the suite never ran and the gate had nothing to read. Now the
  // claim is the specific one.
  { glob: 'tests/ci/**', suites: ['spec-coverage', 'data-foundation', 'linux-runtime'] },
  { glob: 'tests/ci/p001c13_*.sh', suites: ['plugin-lifecycle'] },
  { glob: 'tests/ci/p001c_multilang_lifecycle.sh', suites: ['plugin-lifecycle', 'runtime-conformance'] },
  { glob: 'tests/acceptance/**', suites: ['data-foundation', 'browser-e2e'] },
  { glob: 'tests/runtime/**', suites: ['data-foundation', 'linux-runtime'] },
  { glob: 'tests/contract/**', suites: ['contracts', 'runtime-conformance'] },
  { glob: 'tests/reliability/**', suites: ['quality-faults'] },

  // --- Scripts and deployments ----------------------------------------------
  // `scripts/**` used to claim plugin-lifecycle for the same reason and with the
  // same defect: `plugin-lifecycle.yml`'s filter names four scripts explicitly
  // (build-plugins.sh, assemble_plugin.py, demo_up.sh, demo_common.sh). A change
  // to an unrelated script in that directory does not start the workflow, so the
  // analyzer must not say it does.
  { glob: 'scripts/**', suites: ['data-foundation'] },
  { glob: 'scripts/build-plugins.sh', suites: ['plugin-lifecycle'] },
  { glob: 'scripts/assemble_plugin.py', suites: ['plugin-lifecycle'] },
  { glob: 'scripts/demo_up.sh', suites: ['plugin-lifecycle'] },
  { glob: 'scripts/demo_common.sh', suites: ['plugin-lifecycle'] },
  { glob: 'deployments/**', suites: ['platform-image-build', 'linux-runtime'] },

  // --- Dependencies ----------------------------------------------------------
  // A lock file decides what every build compiles. It cannot be attributed to
  // one language, so it takes the whole set.
  { glob: 'Cargo.toml', suites: ['rust', 'platform-only', 'platform-image-build'] },
  { glob: 'Cargo.lock', suites: ['rust', 'platform-only', 'platform-image-build'] },
  { glob: 'package.json', suites: ['web', 'web-unit'] },
  { glob: 'pnpm-lock.yaml', suites: ['web', 'web-unit', 'browser-e2e'] },
  { glob: 'pnpm-workspace.yaml', suites: ['web', 'web-unit'] },

  // --- The CI definitions themselves ----------------------------------------
  // Editing a workflow must not be the one change that runs nothing.
  { glob: '.github/workflows/**', suites: ['spec-coverage'] },
  { glob: 'tests/ci/check-spec-coverage.mjs', suites: ['spec-coverage'] },
];

/** Paths that cannot affect any suite's outcome. Everything else is matched. */
const IGNORED = [
  /^docs\//,
  /^README\.md$/,
  /^AGENTS\.md$/,
  /^CONTRIBUTING\.md$/,
  /^SECURITY\.md$/,
  /^LICENSE/,
  /^\.gitignore$/,
  /^rules\//,
  /\.md$/,
];

function globToRegExp(glob) {
  // Escape regexp metacharacters, then re-open the two wildcards we support.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withStars = escaped
    .replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
    .replace(/\*\*/g, '\u0000STARSTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')
    .replace(/\u0000STARSTAR\u0000/g, '.*');
  return new RegExp(`^${withStars}$`);
}

const COMPILED = RULES.map((rule) => ({ ...rule, re: globToRegExp(rule.glob) }));

/**
 * @param {string[]} files repository-relative paths
 * @returns {{suites: Record<string, boolean>, matched: string[], ignored: string[],
 *            unmatched: string[], reason: Record<string, string[]>}}
 */
export function analyse(files) {
  const suites = Object.fromEntries(SUITES.map((s) => [s, false]));
  const matched = [];
  const ignored = [];
  const unmatched = [];
  /** suite -> the globs that asked for it, so the decision can be explained */
  const reason = {};

  for (const file of files) {
    if (!file) continue;
    if (IGNORED.some((re) => re.test(file))) {
      ignored.push(file);
      continue;
    }
    let hit = false;
    for (const rule of COMPILED) {
      if (!rule.re.test(file)) continue;
      hit = true;
      for (const suite of rule.suites) {
        suites[suite] = true;
        (reason[suite] ??= []).push(`${rule.glob} <- ${file}`);
      }
    }
    if (hit) matched.push(file);
    else unmatched.push(file);
  }

  // FAIL-CLOSED: an unmapped path turns everything on.
  //
  // This is the branch that decides whether a new directory is tested or not, and
  // the only safe default is "tested". `unmatched` is reported so the table above
  // can be fixed rather than the behaviour silently tolerated.
  if (unmatched.length > 0) {
    for (const suite of SUITES) {
      suites[suite] = true;
      (reason[suite] ??= []).push(`unmapped path -> ${unmatched.join(', ')}`);
    }
  }

  return { suites, matched, ignored, unmatched, reason };
}

function filesFromStdin() {
  const data = execFileSync('cat', [], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  return data.split('\n').map((l) => l.trim()).filter(Boolean);
}

function main(argv) {
  let files = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--stdin') files = files.concat(filesFromStdin());
    else if (arg === '--files') {
      // Everything up to the next flag.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        files.push(argv[i + 1]);
        i += 1;
      }
    } else {
      process.stderr.write(`impact: unknown argument ${arg}\n`);
      return 2;
    }
  }

  const decision = analyse(files);

  if (json) {
    process.stdout.write(`${JSON.stringify({ files, ...decision }, null, 2)}\n`);
    return 0;
  }

  const on = SUITES.filter((s) => decision.suites[s]);
  const off = SUITES.filter((s) => !decision.suites[s]);
  process.stdout.write(`files=${files.length} matched=${decision.matched.length} `
    + `ignored=${decision.ignored.length} unmatched=${decision.unmatched.length}\n`);
  process.stdout.write(`run:  ${on.length ? on.join(' ') : '(none)'}\n`);
  if (off.length) process.stdout.write(`skip: ${off.join(' ')}\n`);
  for (const suite of on) {
    for (const why of decision.reason[suite] ?? []) {
      process.stdout.write(`  ${suite}: ${why}\n`);
    }
  }
  if (decision.unmatched.length) {
    process.stdout.write('UNMAPPED PATHS (everything was requested as a result):\n');
    for (const f of decision.unmatched) process.stdout.write(`  ${f}\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
