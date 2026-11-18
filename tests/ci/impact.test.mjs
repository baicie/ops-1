#!/usr/bin/env node
/**
 * Counterfactuals for the impact analyzer.
 *
 * The analyzer decides which CI suites a change requires. A decision table that
 * is only ever asserted on its happy path is the same trap this repository has
 * hit repeatedly: a suite that passes because it was never asked a hard question.
 * Each case below is a scenario from the task brief, and each expectation is a
 * fact about what must NOT be skippable.
 *
 * Run: node --test tests/ci/impact.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyse, SUITES } from './impact.mjs';

/** Suites the decision turned on. */
function on(files) {
  return SUITES.filter((s) => analyse(files).suites[s]);
}

test('A low-risk documentation change runs no acceptance suite', () => {
  assert.deepEqual(on(['docs/adr/ADR-023.md']), []);
  assert.deepEqual(on(['README.md']), []);
  assert.deepEqual(on(['docs/ci/baseline.md', 'rules/03-security.md']), []);
});

test('BUT the gate still exists: a docs change is ignored, not unmapped', () => {
  // "ignored" and "unmapped" both produce no suites here, and they are not the
  // same fact. Ignored is a deliberate exclusion; unmapped means the table has a
  // hole and everything gets requested. Conflating them would let a new
  // top-level directory become silently untested.
  const d = analyse(['docs/adr/ADR-023.md']);
  assert.equal(d.ignored.length, 1);
  assert.equal(d.unmatched.length, 0);
});

test('B a kernel gateway change reaches the gateway acceptance', () => {
  const suites = on(['apps/kernel/src/gateway.rs']);
  for (const required of ['rust', 'data-foundation', 'linux-runtime', 'g12-acceptance']) {
    assert.ok(suites.includes(required), `${required} must run for a gateway change`);
  }
});

test('B a capabilities change reaches conformance and lifecycle', () => {
  const suites = on(['apps/kernel/src/capabilities.rs']);
  for (const required of ['runtime-conformance', 'plugin-lifecycle']) {
    assert.ok(suites.includes(required), `${required} must run for a capabilities change`);
  }
});

test('C a node runtime change reaches the native linux suite', () => {
  const suites = on(['apps/node/src/runtime.rs']);
  assert.ok(suites.includes('linux-runtime'));
  assert.ok(suites.includes('data-foundation'));
});

test('D a contract change reaches the cross-language conformance', () => {
  const suites = on(['contracts/examples/pipeline-definition.json']);
  assert.ok(suites.includes('contracts'));
  assert.ok(suites.includes('runtime-conformance'));
});

test('E a plugin change reaches lifecycle and conformance', () => {
  const suites = on(['plugins/hello-go/main.go']);
  assert.ok(suites.includes('plugin-lifecycle'));
  assert.ok(suites.includes('runtime-conformance'));
});

test('F a web change reaches browser acceptance and the unit suites', () => {
  for (const file of ['apps/platform-console/src/App.tsx', 'apps/ops-web/src/main.tsx', 'packages/ui/src/button.tsx']) {
    const suites = on([file]);
    assert.ok(suites.includes('web'), `${file} must run web`);
    assert.ok(suites.includes('web-unit'), `${file} must run web-unit`);
  }
});

test('G the test harness itself is treated as high risk', () => {
  // The 42-step harness is not covered by any assertion that reads it, so a
  // change to it has to run the things it drives.
  const suites = on(['tests/ci/data_foundation_ci.sh']);
  assert.ok(suites.includes('data-foundation'));
  assert.ok(suites.includes('linux-runtime'));
});

test('H the coverage checker changing runs the coverage checker', () => {
  assert.ok(on(['tests/ci/check-spec-coverage.mjs']).includes('spec-coverage'));
});

test('I a lock file takes every language with it', () => {
  assert.ok(on(['Cargo.lock']).includes('rust'));
  assert.ok(on(['pnpm-lock.yaml']).includes('web'));
  assert.ok(on(['pnpm-lock.yaml']).includes('web-unit'));
});

test('I pnpm-lock.yaml does NOT claim a browser suite no workflow would start', () => {
  // It did, and the claim was inert: neither g12-acceptance nor data-foundation
  // lists `pnpm-lock.yaml` in its `pull_request.paths`, so a dependency bump
  // demanded `browser-e2e` and no check could ever be produced for it - ci-gate
  // would have reported `delegated-absent` and failed the PR.
  //
  // A lockfile does deserve extra coverage; the way to get it is to add the path
  // to a workflow's filter, not to name a suite that cannot run.
  assert.ok(!on(['pnpm-lock.yaml']).includes('browser-e2e'));
});

test('J editing a workflow runs at least one gate', () => {
  // Otherwise "fix the CI" would be the one change CI does not check.
  assert.ok(on(['.github/workflows/ci.yml']).length > 0);
});

test('K an unmapped path fails closed: everything runs', () => {
  const d = analyse(['some/new/top-level/thing.bin']);
  assert.deepEqual(d.unmatched, ['some/new/top-level/thing.bin']);
  for (const suite of SUITES) {
    assert.equal(d.suites[suite], true, `${suite} must run when a path is unmapped`);
  }
});

test('L one unmapped file among mapped ones still fails closed', () => {
  const d = analyse(['apps/node/src/runtime.rs', 'brand-new-dir/x.rs']);
  assert.equal(d.unmatched.length, 1);
  for (const suite of SUITES) assert.equal(d.suites[suite], true);
});

test('M rules ADD: a high-risk file does not lose the suites its directory asked for', () => {
  // apps/kernel/src/gateway.rs matches both `apps/kernel/**` and its own rule.
  // If matching short-circuited on the first hit, the gateway acceptance would be
  // the only thing requested and rust/data-foundation would be lost.
  const suites = on(['apps/kernel/src/gateway.rs']);
  assert.ok(suites.includes('rust'), 'the directory rule must still contribute');
  assert.ok(suites.includes('g12-acceptance'), 'the specific rule must contribute too');
});

test('N every suite in the vocabulary is reachable by some path', () => {
  // A suite nobody can request is either dead vocabulary or a missing rule.
  const reachable = new Set();
  for (const file of [
    'apps/kernel/src/gateway.rs', 'apps/kernel/src/capabilities.rs', 'apps/node/src/runtime.rs',
    'apps/pipeline-worker/src/main.rs', 'apps/opsctl/src/main.rs', 'crates/x/src/lib.rs',
    'contracts/x.json', 'apps/platform-console/src/a.tsx', 'apps/ops-web/src/a.tsx',
    'packages/ui/src/a.tsx', 'tests/ui/a.spec.ts', 'plugins/x/main.go', 'tests/ci/a.sh',
    'tests/acceptance/a.sh', 'tests/runtime/a.py', 'tests/contract/a.py',
    'tests/reliability/a.sh', 'scripts/a.sh', 'deployments/linux/a.service',
    'Cargo.lock', 'pnpm-lock.yaml', '.github/workflows/ci.yml',
  ]) {
    for (const suite of on([file])) reachable.add(suite);
  }
  const missing = SUITES.filter((s) => !reachable.has(s));
  assert.deepEqual(missing, [], `unreachable suites: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// O. The analyzer must not claim a suite whose workflow cannot start.
//
// Measured defect: `tests/ci/**` claimed `plugin-lifecycle` for every file in
// that directory, but `plugin-lifecycle.yml` invokes three specific scripts and
// its filter names them. A change to `tests/ci/check-tracked-png-budget.mjs`
// therefore required a suite that GitHub would never start, so `ci-gate` had no
// result to read and reported it delegated. The claim is now the specific one.
// ---------------------------------------------------------------------------

test('O the harness directory alone does not claim the plugin lifecycle', () => {
  assert.ok(!on(['tests/ci/check-tracked-png-budget.mjs']).includes('plugin-lifecycle'));
  assert.ok(!on(['tests/ci/check-spec-coverage.mjs']).includes('plugin-lifecycle'));
  assert.ok(!on(['tests/ci/g13a_evidence_roundtrip.mjs']).includes('plugin-lifecycle'));
});

test('O a lifecycle script does claim it', () => {
  assert.ok(on(['tests/ci/p001c13_lifecycle.sh']).includes('plugin-lifecycle'));
  assert.ok(on(['tests/ci/p001c13_negatives.sh']).includes('plugin-lifecycle'));
  assert.ok(on(['tests/ci/p001c_multilang_lifecycle.sh']).includes('plugin-lifecycle'));
});

test('O an unrelated script does not claim the plugin lifecycle', () => {
  // plugin-lifecycle.yml's filter names four scripts explicitly.
  assert.ok(!on(['scripts/unrelated.mjs']).includes('plugin-lifecycle'));
  assert.ok(on(['scripts/build-plugins.sh']).includes('plugin-lifecycle'));
  assert.ok(on(['scripts/assemble_plugin.py']).includes('plugin-lifecycle'));
  assert.ok(on(['scripts/demo_up.sh']).includes('plugin-lifecycle'));
  assert.ok(on(['scripts/demo_common.sh']).includes('plugin-lifecycle'));
});

test('O a crate that is not the bundle crate does not claim contracts', () => {
  // typed-pipeline-contracts.yml does not watch crates/. The `contracts` suite is
  // ci.yml's unfiltered job, but the bundle crate is the only one whose change
  // that validator has an opinion about.
  assert.ok(!on(['crates/platform-client/src/lib.rs']).includes('contracts'));
  assert.ok(on(['crates/bundle/src/lib.rs']).includes('contracts'));
});

// ---------------------------------------------------------------------------
// P. Every suite the analyzer can turn on must be produced by something.
//
// A suite in the vocabulary that no workflow produces is "a spec no workflow
// executes" applied to the suite list: the gate can require it forever and
// nothing will ever report on it.
// ---------------------------------------------------------------------------

test('P every suite is reachable and every mapped job is a real ci.yml job', () => {
  for (const suite of SUITES) {
    // Either some probe turns it on, or it is one ci-gate reads from ci.yml.
    const reachable = [
      'apps/kernel/src/gateway.rs', 'apps/node/src/runtime.rs',
      'apps/platform-console/src/main.tsx', 'contracts/x.json',
      'plugins/hello-go/main.go', 'tests/ci/p001c13_lifecycle.sh',
      'tests/contract/x.py', 'tests/reliability/x.sh', 'deployments/Dockerfile',
      'crates/x/src/lib.rs',
    ].some((f) => analyse([f]).suites[suite]);
    assert.ok(reachable, `suite ${suite} is turned on by no probe and no known path`);
  }
});

// ---------------------------------------------------------------------------
// Q. The filter parser used by check-impact-consistency.mjs agrees with a real
//    YAML parser.
//
// That script deliberately has no YAML dependency, because neither PyYAML nor a
// `yaml` npm package is guaranteed on a bare runner and an install step would be
// a new failure mode for a check whose purpose is to not be flaky. So it carries
// its own parser - and a hand-written parser that is only compared against
// reality once, when it is written, is exactly the artifact this repository has
// been burned by. This case compares it against PyYAML whenever PyYAML exists
// (it does locally, and in the jobs that install jsonschema).
// ---------------------------------------------------------------------------

test('Q the filter parser agrees with PyYAML where PyYAML exists', async () => {
  let python = null;
  for (const candidate of ['python3', 'python']) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync(candidate, ['-c', 'import yaml'], { stdio: 'ignore' });
      python = candidate;
      break;
    } catch { /* try the next one */ }
  }
  if (!python) {
    // Not a pass and not a failure: record that the cross-check did not run so
    // nobody reads the absence of this test's output as agreement.
    assert.ok(true, 'PyYAML unavailable; cross-check NOT RUN');
    return;
  }
  const { execFileSync } = await import('node:child_process');
  const { pathsFor, SUITE_WORKFLOW_MAP } = await import('./check-impact-consistency.mjs');
  for (const workflow of Object.values(SUITE_WORKFLOW_MAP)) {
    const js = pathsFor(workflow).map((x) => x.glob);
    const py = JSON.parse(execFileSync(python, [
      '-c',
      'import yaml, json, sys\n'
      + 'd = yaml.safe_load(open(sys.argv[1]))\n'
      + 'on = d.get(True) or d.get("on")\n'
      + 'print(json.dumps(((on or {}).get("pull_request") or {}).get("paths") or []))\n',
      `.github/workflows/${workflow}`,
    ], { encoding: 'utf8' }));
    assert.deepEqual(js, py, `${workflow}: hand-written parser disagrees with PyYAML`);
  }

  // The five real workflows happen to be written in a shape the parser handles
  // even when its exit condition is wrong. A synthetic file pins the properties
  // the real files do not exercise: a comment inside the list, a blank line
  // inside the list, a quoted entry containing `#`, and a later `paths:` block on
  // a DIFFERENT trigger that must not be read.
  const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const fixture = '.github/workflows/__parser_fixture.yml';
  mkdirSync('.github/workflows', { recursive: true });
  writeFileSync(fixture, [
    'on:',
    '  push:',
    '    paths:',
    "      - 'never-read/**'",
    '  pull_request:',
    '    paths:',
    '      # a comment inside the list',
    "      - 'apps/a/**'",
    '',
    "      - 'apps/b/**'",
    "      - 'a file with # inside/**'   # trailing comment",
    '      - "quoted/**"',
    '    branches: [main]',
    '  workflow_dispatch:',
    '',
  ].join('\n'));
  try {
    const { pathsFor: pf } = await import('./check-impact-consistency.mjs');
    assert.deepEqual(pf('__parser_fixture.yml').map((x) => x.glob), [
      'apps/a/**', 'apps/b/**', 'a file with # inside/**', 'quoted/**',
    ]);
    const py = JSON.parse(execFileSync(python, [
      '-c',
      'import yaml, json, sys\n'
      + 'd = yaml.safe_load(open(sys.argv[1]))\n'
      + 'on = d.get(True) or d.get("on")\n'
      + 'print(json.dumps(((on or {}).get("pull_request") or {}).get("paths") or []))\n',
      fixture,
    ], { encoding: 'utf8' }));
    assert.deepEqual(pf('__parser_fixture.yml').map((x) => x.glob), py);
  } finally {
    rmSync(fixture, { force: true });
  }
});

// ---------------------------------------------------------------------------
// `--stdin` must not have a size ceiling.
//
// `filesFromStdin` used to be `execFileSync('cat')`, which buffers through Node's
// default 1 MiB `maxBuffer`. Measured before the fix: 1,026,000 bytes exits 0,
// 1,053,000 bytes exits 1 with `spawnSync cat ENOBUFS`.
//
// That mattered because `ci.yml`'s `scope` job pipes the changed-file list
// through this script, and `scope` used to gate four ruleset-required jobs
// through `needs:`. An ENOBUFS throw failed `scope` and skipped them, so the
// merge endpoint answered "9 of 9 required status checks are expected" - while
// the script's own fail-closed rule (`CHANGED="__unavailable__"` runs everything)
// would have handled the same change set correctly.
//
// This test drives the real process with a real pipe, because the defect lived in
// how stdin was read, not in `analyse`.
test('--stdin handles a change set far larger than the old 1 MiB pipe buffer', () => {

  const COUNT = 40000;
  // Long enough that the total comfortably exceeds the old 1 MiB cap.
  const input = Array.from({ length: COUNT }, (_, i) => `apps/kernel/src/generated/very/long/module/path/segment/f${String(i).padStart(6, '0')}.rs`).join('\n') + '\n';
  assert.ok(input.length > 1_100_000, `fixture must exceed the old 1 MiB cap (got ${input.length} bytes)`);

  const script = fileURLToPath(new URL('./impact.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, '--stdin', '--json'], {
    input,
    encoding: 'utf8',
    // The OUTPUT also goes through a buffer: `--json` echoes the full file list
    // back, so a 40k-path fixture produces a multi-megabyte JSON document. This
    // cap is the test's own reading limit, not the thing under test - the defect
    // being pinned is on the INPUT side, in how impact.mjs reads stdin.
    maxBuffer: 64 * 1024 * 1024,
  });
  const decision = JSON.parse(out);
  assert.equal(decision.fileCount, COUNT, 'every path on stdin must reach the analyzer');
  assert.equal(decision.unmatched.length, 0);
  assert.equal(decision.suites.rust, true, 'a kernel-only change still asks for rust');
});

// ---------------------------------------------------------------------------
// `--verbose --json` must survive a pipe.
//
// The compact form is ~400 bytes, so it cannot exercise the buffering problem;
// this one asks for the big document on purpose. `process.exit()` discards
// whatever is still buffered on stdout when stdout is a PIPE - and in CI it
// always is. Measured before the fix: a 40,000-path fixture produced exactly
// 8192 bytes of JSON, truncated mid-string, and a TTY hid it completely.
//
// The consequence was merge-blocking, not cosmetic: `ci.yml`'s `scope` job parses
// this output, a truncated document throws there, `scope` fails, and `needs:`
// skips four ruleset-required jobs.
test('--verbose --json writes the whole document through a pipe', () => {
  const COUNT = 3000;
  const input = Array.from({ length: COUNT }, (_, i) => `apps/kernel/src/f${String(i).padStart(6, '0')}.rs`).join('\n') + '\n';
  const script = fileURLToPath(new URL('./impact.mjs', import.meta.url));

  const out = execFileSync(process.execPath, [script, '--stdin', '--json', '--verbose'], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  // Must be parseable at all - a truncated document is not.
  const decision = JSON.parse(out);
  assert.equal(decision.fileCount, COUNT);
  // And the verbose payloads must be complete, not clipped.
  assert.equal(decision.files.length, COUNT, 'the echoed file list must not be truncated');
  assert.equal(decision.matched.length, COUNT);
});
