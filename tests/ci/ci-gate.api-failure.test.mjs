#!/usr/bin/env node
/**
 * The gate's behaviour when the check-run API is unavailable.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT A SELFTEST CASE
 *
 * Every other counterfactual drives `gate()` or `delegatedVerdict()` with a
 * fixture. This one has to drive the PROCESS, because what it asserts is the
 * exit code of `main()` - and that is the only thing CI reads. A helper-level
 * assertion that "an API error produces FAIL" would pass even if `main()`
 * returned 0.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * The original read ended in `2>/dev/null || echo '{}'`. A transport error
 * silently became "this commit has no checks", every delegated suite reported
 * `absent`, and the gate went red for a reason that had nothing to do with the
 * commit - or, worse, an operator would learn to ignore `delegated-absent`
 * because it fired on network weather. Either way the signal was destroyed.
 *
 * The rule: an unreadable API is `delegated-api-error`, the verdict is FAIL, and
 * the exit code is 1. Never "assume success".
 *
 * HOW IT IS TRIGGERED WITHOUT MOCKING
 *
 * `--fetch` reads a real repository through `gh`. Pointing it at a repository
 * that does not exist makes `gh` fail exactly as a transport error would (404
 * instead of a timeout, but the code path is the same: `execFileSync` throws, the
 * catch sets `apiError`, `main` returns 1). No network mock, no injected seam.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ci-gate.mjs', import.meta.url));

/** Run the CLI and return {code, out} without a shell pipe (which would lie about $?). */
function runGate(env, args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('an unreadable check-run API is a FAIL with exit code 1', () => {
  const { code, out } = runGate(
    { REPO: 'baicie/does-not-exist-zzz', CHECKS_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    ['--needs-json', '{"rust":"success"}', '--files', 'docs/a.md', '--fetch', '--budget-ms', '5000'],
  );
  assert.equal(code, 1, `exit code must be 1, got ${code}; output:\n${out}`);
  assert.match(out, /verdict: FAIL/, 'the verdict line must say FAIL');
  assert.match(out, /delegated-api-error/, 'and must name the API error, not blame the commit');
  // The inverse assertion that matters: it must NOT report the suites as absent,
  // which is what the old `|| echo '{}'` produced.
  assert.doesNotMatch(out, /delegated-absent: data-foundation/,
    'an API failure is not evidence that a suite did not run');
});

test('a green run is not affected by the failure path', async () => {
  // Same invocation minus --fetch: no API is read, so nothing can fail there. This
  // is the control - without it, the first test could pass because EVERY
  // invocation exits 1.
  //
  // The needs object must be COMPLETE, because PART 0 fails the gate when a mapped
  // job is missing from `needs`. The first version of this control passed only
  // `{rust: success}` and got FAIL for that reason - a correct verdict from a
  // wrong fixture, which is exactly the class of mistake the counterfactuals in
  // this directory exist to catch.
  const { JOB_TO_SUITE } = await import('./ci-gate.mjs');
  const needs = Object.fromEntries(Object.keys(JOB_TO_SUITE).map((j) => [j, 'success']));
  const { code, out } = runGate({}, ['--needs-json', JSON.stringify(needs), '--files', 'docs/a.md']);
  assert.equal(code, 0, `control run must exit 0, got ${code}; output:\n${out}`);
  assert.match(out, /verdict: PASS/);
});


// L. The SHA the gate reads must be the PR HEAD, not the merge commit.
//
// Other workflows' check runs are attached to the head commit. GitHub also
// creates a synthetic merge commit for `pull_request` events, and `github.sha`
// IS that merge commit - so reading `github.sha` on a PR would query a commit no
// other workflow ever ran on. Every delegated suite would report `absent`, and
// the gate would fail every PR with "the workflow did not run".
//
// The measured mistake this guards against is the mirror image: reading a MERGE
// COMMIT after the fact and concluding a PR bypassed its checks (docs/ci,
// #159). Both come from not distinguishing the two SHAs.
test('ci.yml reads check runs for the PR head, not the merge commit', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');

  const lines = ci.split('\n');
  const assignment = lines.find((l) => /CHECKS_SHA=/.test(l) && !/^\s*#/.test(l));
  assert.ok(assignment, 'the gate step must assign CHECKS_SHA');
  assert.match(assignment, /\$\{HEAD_SHA:-\$GITHUB_SHA\}/,
    `CHECKS_SHA must prefer HEAD_SHA; got: ${assignment.trim()}`);

  // And HEAD_SHA must be the pull request head.
  const headLine = lines.find((l) => /^\s+HEAD_SHA:/.test(l));
  assert.ok(headLine, 'the step env must define HEAD_SHA');
  assert.match(headLine, /github\.event\.pull_request\.head\.sha/,
    `HEAD_SHA must come from pull_request.head.sha; got: ${headLine.trim()}`);
});
