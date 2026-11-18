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

import { readSync } from 'node:fs';

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
  // The image builds belong on anything the Dockerfile compiles. Its
  // `rustbuild` stage copies `apps/`, `crates/` and `contracts/`, and its
  // `webbuild` stage builds both Vite apps (- deployments/staging/Dockerfile:59-62,
  // :126-127). Without these, gating the image jobs on the analyzer would stop
  // building an image for a kernel change - the gap only invisible today because
  // both jobs currently run unconditionally.
  { glob: 'apps/kernel/**', suites: ['rust', 'platform-only', 'data-foundation', 'linux-runtime', 'platform-image-build'] },
  // The gateway and capability code is the authorisation surface. A change here
  // must be measured against the security negatives and the gateway acceptance,
  // not only against `cargo test`.
  { glob: 'apps/kernel/src/gateway.rs', suites: ['g12-acceptance'] },
  // `g12-acceptance` is here because `g13a1-gateway` - one of its jobs - is the
  // end-to-end test of capability grants: it mints a workload token against a
  // live Gateway and drives it to a plugin container. Without this entry that job
  // would be skipped for the one file it exists to cover, since this branch made
  // it conditional on the suite.
  { glob: 'apps/kernel/src/capabilities.rs', suites: ['runtime-conformance', 'plugin-lifecycle', 'g12-acceptance'] },
  { glob: 'apps/node/**', suites: ['rust', 'linux-runtime', 'data-foundation', 'plugin-lifecycle', 'platform-image-build'] },
  { glob: 'apps/pipeline-worker/**', suites: ['rust', 'data-foundation', 'platform-image-build'] },
  { glob: 'apps/opsctl/**', suites: ['rust', 'plugin-lifecycle', 'platform-image-build'] },
  // `crates/**` used to require `contracts` as well. Only `crates/bundle` has any
  // relationship to the contract validators (it is what signs and verifies the
  // bundles `validate_contracts.py` was written to inspect), and
  // `typed-pipeline-contracts.yml` does not watch `crates/` at all - so the
  // requirement produced a suite that could not run for that change.
  { glob: 'crates/**', suites: ['rust', 'platform-image-build'] },
  { glob: 'crates/bundle/**', suites: ['contracts'] },

  // --- Contracts -------------------------------------------------------------
  { glob: 'contracts/**', suites: ['contracts', 'runtime-conformance', 'data-foundation', 'platform-image-build'] },

  // --- Web -------------------------------------------------------------------
  { glob: 'apps/platform-console/**', suites: ['web', 'web-unit', 'browser-e2e', 'platform-image-build'] },
  { glob: 'apps/ops-web/**', suites: ['web', 'web-unit', 'browser-e2e', 'platform-image-build'] },
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
  // `browser-e2e` was claimed here and is wrong: neither g12-acceptance nor
  // data-foundation has `pnpm-lock.yaml` in its `pull_request.paths`, so a
  // dependency bump demanded a browser suite no workflow would start. The
  // consistency checker found it the moment browser-e2e gained producers it
  // could actually check against.
  //
  // A lockfile IS a whole-estate change, so `web` and `web-unit` stay - both run
  // from ci.yml, which has no filter.
  { glob: 'pnpm-lock.yaml', suites: ['web', 'web-unit'] },
  { glob: 'pnpm-workspace.yaml', suites: ['web', 'web-unit'] },

  // --- The CI definitions themselves ----------------------------------------
  // Editing a workflow must not be the one change that runs nothing.
  // Editing a workflow must run every suite THAT WORKFLOW produces, plus the
  // coverage check. Not every suite in the repository.
  //
  // The rule said only `spec-coverage`, which was invisible while every ci.yml job
  // ran unconditionally. This branch made the heavy jobs conditional, and the hole
  // became real: PR #125 edits ci.yml - the file that defines the `rust` job - and
  // `rust` was skipped.
  //
  // The first fix was `[...SUITES]`, and `check-impact-consistency.mjs` rejected
  // it immediately: a workflow's push filter is its own paths, so demanding all
  // fourteen suites for every workflow edit says "editing g12-acceptance.yml
  // requires runtime-conformance", which that workflow never starts for. Broad was
  // as wrong as narrow, in the other direction.
  //
  // Per-file is the accurate statement: each entry names one workflow and the
  // suites its jobs produce. A workflow not listed here produces no suite a gate
  // reads, so `spec-coverage` is the whole answer for it.
  // `ci.yml` defines ten suites, but only six are produced ENTIRELY here. The
  // other four (data-foundation, g12-acceptance, plugin-lifecycle,
  // runtime-conformance) have the rest of their coverage in workflows whose
  // `pull_request.paths` do not match `ci.yml` - so demanding them would make the
  // gate require a check no workflow will produce. Measured on PR #125: ci-gate
  // reported `delegated-absent: g12-acceptance` and `delegated-absent:
  // plugin-lifecycle` for exactly this reason.
  //
  // The six below are fully determined by ci.yml's own jobs (its `JOB_TO_SUITE`
  // in tests/ci/ci-gate.mjs), so a change to ci.yml genuinely can break them.
  { glob: '.github/workflows/ci.yml', suites: ['rust', 'web', 'web-unit', 'contracts', 'spec-coverage', 'platform-only', 'platform-image-build'] },
  { glob: '.github/workflows/data-foundation.yml', suites: ['data-foundation', 'browser-e2e'] },
  { glob: '.github/workflows/g12-acceptance.yml', suites: ['g12-acceptance'] },
  { glob: '.github/workflows/platform-linux-acceptance.yml', suites: ['linux-runtime'] },
  { glob: '.github/workflows/plugin-lifecycle.yml', suites: ['plugin-lifecycle'] },
  { glob: '.github/workflows/reliability.yml', suites: ['quality-faults'] },
  { glob: '.github/workflows/runtime-conformance.yml', suites: ['runtime-conformance'] },
  { glob: '.github/workflows/typed-pipeline-contracts.yml', suites: ['contracts'] },
  // Any OTHER workflow file: the coverage check is the thing that reads it.
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
  // Read fd 0 directly. This used to be `execFileSync('cat')`, which buffers the
  // child's output through Node's default 1 MiB `maxBuffer` and dies with
  // `spawnSync cat ENOBUFS` past that. Measured: 1,026,000 bytes is fine,
  // 1,053,000 bytes throws. At this repository's average of 46.4 bytes per path
  // that is about 22,700 changed files - reachable by a mass rename, a vendored
  // import or a formatting sweep.
  //
  // The failure mattered because of where it landed. `ci.yml`'s `scope` job pipes
  // the changed-file list through this script, and `scope` gates the four
  // required jobs' `needs`. An ENOBUFS throw fails `scope`, which skips them, and
  // the merge endpoint reports "9 of 9 required status checks are expected" - for
  // a change set the script's own fail-closed rule would have handled correctly
  // (`CHANGED="__unavailable__"` runs everything). The design was right; the read
  // was the defect.
  //
  // `readFileSync(0)` has no such cap and no child process. It throws on a closed
  // stdin, which the caller already treats as an empty change set.
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    let bytes;
    try {
      bytes = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      // EAGAIN on a non-blocking pipe: nothing written yet, try again.
      if (error && error.code === 'EAGAIN') continue;
      // EOF on some platforms surfaces as EIO/EOF rather than 0 bytes.
      if (error && (error.code === 'EOF' || error.code === 'EIO')) break;
      throw error;
    }
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

function main(argv) {
  let files = [];
  let json = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--verbose') verbose = true;
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
    // THE MACHINE-READABLE FORM IS TINY ON PURPOSE.
    //
    // Measured on a 40,000-path change set before this change: the document was
    // 24.7 MB, of which `files` was 24.7 MB and `reason` (one "glob <- file"
    // string per matched suite per file) was another several MB. Both callers -
    // `ci.yml`'s `scope` job and `ci-gate` - read `suites` and `unmatched` and
    // nothing else; they already have the file list, they produced it.
    //
    // The size was not cosmetic. `scope` pipes this through a shell pipeline and
    // JSON.parses it, and every megabyte is another way for that to fail on a
    // path that gates four ruleset-required jobs. The diagnosis a human wants
    // (`reason`: which glob asked for which suite, and for what file) is still
    // available - as the human-readable output, and under `--verbose` here.
    const out = {
      suites: decision.suites,
      unmatched: decision.unmatched,
      fileCount: files.length,
      matchedCount: decision.matched.length,
      ignoredCount: decision.ignored.length,
    };
    if (verbose) {
      out.reason = decision.reason;
      out.files = files;
      out.matched = decision.matched;
      out.ignored = decision.ignored;
    }
    process.stdout.write(`${JSON.stringify(out, verbose ? 2 : 0)}\n`);
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
  // NOT `process.exit(main(...))`.
  //
  // `process.exit` discards anything still buffered on stdout when stdout is a
  // PIPE rather than a TTY - and in CI it always is. Measured: a 40,000-path
  // fixture produced exactly 8192 bytes of JSON, truncated mid-string, because
  // the process exited before the pipe was drained. A TTY hides this completely,
  // which is why it survived every local run.
  //
  // The consequence was worse than a bad report. `ci.yml`'s `scope` job parses
  // this script's `--json` output, and a truncated document throws there. That
  // failed `scope`, which skipped four ruleset-required jobs through `needs` -
  // the same merge-blocking shape as the `maxBuffer` defect fixed above, reached
  // through the output side instead of the input side.
  //
  // Setting `process.exitCode` and letting the event loop drain is the supported
  // way to exit with a status from a stream-writing CLI.
  process.exitCode = main(process.argv.slice(2));
}
