#!/usr/bin/env node
/**
 * A test file that asserts nothing is not a passing test file.
 *
 * THE DEFECT
 *
 * `node --test` exits 0 for all of these, measured on Node 22.12.0:
 *
 *     an empty file             rc 0
 *     a file of only comments   rc 0
 *     a file whose only test is `{skip: true}`   rc 0
 *
 * So "delete the assertions" is a way to make a red suite green, and nothing in
 * this repository would notice. The brief names this directly: 空测试集不能
 * PASS / 关键断言被删除时 CI 能检测 / 测试注释不能冒充执行入口. This file is the
 * detector for all three.
 *
 * WHAT IT CHECKS, per file on the command line
 *
 *   1. it defines at least one test                      (not a stub)
 *   2. at least one of those tests is not skipped        (not all-skipped)
 *   3. the file contains at least one assertion call     (not assertion-free)
 *
 * Line 3 is deliberately a floor, not a proof: a test can be meaningful without
 * `assert` (it can await a rejected promise and let the throw fail the test). It
 * is here to catch the specific shape where somebody keeps the `test()` call and
 * strips its body, which is the failure mode that reads as green.
 *
 * WHAT IT IS NOT
 *
 * It does not run the tests - `node --test` does. It is a static gate run BESIDE
 * the suite, so the count it reports is the file's own, not a second execution.
 *
 * ACKNOWLEDGEMENT
 *
 * A file legitimately asserting nothing (a probe, a generator) goes in
 * `ALLOWED_WITHOUT_ASSERTIONS` with a reason. That list is the only way to
 * silence this, and it is visible in review.
 *
 * Usage:
 *   node tests/ci/check-test-substance.mjs tests/ci/foo.test.mjs ...
 *   node tests/ci/check-test-substance.mjs --selftest
 *   node tests/ci/check-test-substance.mjs --all      # every *.test.mjs we gate
 *
 * Exit: 0 all files have substance, 1 one does not, 2 bad usage.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';

/**
 * Files that may legitimately assert nothing, with the reason.
 *
 * None today. This is where a probe or a fixture generator would go, and the
 * reason is required so the next reader knows it was a decision and not an
 * oversight.
 */
export const ALLOWED_WITHOUT_ASSERTIONS = {
  // e.g. 'tests/ui/b5-probe.spec.ts': 'prints measurements; asserts nothing by design',
};

/** How a test is opened in this repository: `test(`, `it(`, or `describe(`. */
const TEST_CALL = /(^|[^.\w])(?:test|it)\s*\(/m;
/** A skip marker, inline or via options. */
const SKIP_CALL = /(^|[^.\w])(?:test|it)\s*\(\s*[^)]*\{[^}]*\bskip\s*:\s*true/m;
const SKIP_WHOLE = /(^|[^.\w])test\.skip\s*\(/m;
/** Any assertion, from node:assert or from a hand-rolled helper. */
const ASSERT_CALL = /(^|[^.\w])(?:assert|expect)\s*[.(]/m;
/** A thrown Error inside a test body counts: `if (!x) throw new Error(...)`. */
const THROW_CALL = /(^|[^.\w])throw\s+new\s+Error\s*\(/m;

/**
 * @param {string} source file contents
 * @param {string} [path] for the message
 * @returns {{ok: boolean, tests: number, skipped: number, assertions: number, problems: string[]}}
 */
export function inspect(source, path = '<source>') {
  const problems = [];
  const lines = source.split('\n');

  // Count test declarations by their opening lines, so a `test(` mentioned in a
  // comment or a string is not counted. Comments are stripped first - the brief's
  // "测试注释不能冒充执行入口".
  let code = 0;
  let inBlock = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Strip a block comment that opens and does not close on this line.
    const open = line.indexOf('/*');
    if (open !== -1) {
      const close = line.indexOf('*/', open + 2);
      if (close === -1) { inBlock = true; line = line.slice(0, open); }
      else line = line.slice(0, open) + line.slice(close + 2);
    }
    const slash = line.indexOf('//');
    if (slash !== -1) line = line.slice(0, slash);
    code += `${line}\n`.length === 1 ? 0 : 1;
  }

  const stripped = lines.map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const body = stripBlockComments(stripped);

  const tests = (body.match(/(^|[^.\w])(?:test|it)\s*\(/gm) ?? []).length;
  const skipped = (body.match(/(^|[^.\w])(?:test|it)\s*\(\s*[^)]*\{[^}]*\bskip\s*:\s*true/gm) ?? []).length
    + (body.match(/(^|[^.\w])test\.skip\s*\(/gm) ?? []).length;

  const assertions = (body.match(ASSERT_CALL) ?? []).length
    + (body.match(THROW_CALL) ?? []).length;

  if (code === 0) problems.push('the file has no executable line at all');
  if (tests === 0) problems.push('no test is declared');
  if (tests > 0 && skipped >= tests) problems.push(`all ${tests} test(s) are skipped, so nothing runs`);
  if (assertions === 0) problems.push('no assertion is reachable');
  // A FLOOR WITH PROPORTION is the part that catches "most assertions deleted".
  //
  // `assertions === 0` alone let the first version of this file pass a suite with
  // 48 assertions stripped to 47: one surviving `assert` satisfied the check. The
  // counterfactual that found it rewrote every `assert.x(` to `noop(` and one call
  // remained in a comment. A file with many tests and one assertion is not a file
  // whose assertions were kept; it is the shape of one that lost them.
  //
  // The threshold is deliberately loose - one assertion per FIVE tests - because a
  // legitimate suite can share a helper that asserts on the caller's behalf, and a
  // false red here would be worked around rather than fixed.
  if (tests >= 5 && assertions * 5 < tests) {
    problems.push(`${tests} tests share only ${assertions} assertion(s); most test bodies are empty`);
  }

  return { ok: problems.length === 0, tests, skipped, assertions, problems };
}

function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// Self-test. These are the exact shapes that made `node --test` exit 0.
// ---------------------------------------------------------------------------
const SELFTEST = [
  {
    name: 'an empty file has no substance',
    source: '',
    want: false,
    because: /no test is declared/,
  },
  {
    name: 'a comment-only file has no substance',
    source: '// TODO: write tests here\n/* nothing yet */\n',
    want: false,
    because: /no test is declared/,
  },
  {
    name: 'a test whose body was emptied has no assertion',
    source: "import test from 'node:test';\ntest('x', () => {});\n",
    want: false,
    because: /no assertion is reachable/,
  },
  {
    name: 'a test that is only skipped runs nothing',
    source: "import test from 'node:test';\ntest('x', { skip: true }, () => { assert.equal(1, 1); });\n",
    want: false,
    because: /all 1 test\(s\) are skipped/,
  },
  {
    name: 'a real test passes',
    source: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('x', () => { assert.equal(1, 1); });\n",
    want: true,
  },
  {
    name: 'a test that only throws on failure passes',
    source: "import test from 'node:test';\ntest('x', () => { if (1 !== 1) throw new Error('nope'); });\n",
    want: true,
  },
  {
    name: 'a test named in a comment does NOT count as a test',
    source: "// test('x', () => { assert.ok(true) });\nconst nothing = 1;\n",
    want: false,
    because: /no test is declared/,
  },
  {
    name: 'a test() inside a block comment does not count',
    source: "/*\ntest('x', () => { assert.ok(true) });\n*/\nconst nothing = 1;\n",
    want: false,
    because: /no test is declared/,
  },
  {
    name: 'the skipped count and the test count are independent',
    source: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', { skip: true }, () => { assert.ok(1); });\ntest('b', () => { assert.ok(1); });\n",
    want: true,
  },
];

function selftest() {
  let bad = 0;
  for (const c of SELFTEST) {
    const got = inspect(c.source);
    let ok = got.ok === c.want;
    if (ok && c.because) ok = c.because.test(got.problems.join('; '));
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: want ok=${c.want}, got ok=${got.ok} (${got.problems.join('; ') || 'no problems'})\n`);
  }
  const total = SELFTEST.length;
  process.stdout.write(bad === 0 ? `test-substance selftest: ${total}/${total} pass\n` : `test-substance selftest: ${bad} of ${total} FAILED\n`);
  return bad === 0 ? 0 : 1;
}

/**
 * Every `*.test.mjs` that a workflow runs, discovered from the workflows.
 *
 * Read from the workflow files rather than hard-coded so the two cannot drift:
 * the list is exactly "the files CI claims to run", which is the set that must
 * have substance.
 */
export function gatedTestFiles(root = process.cwd()) {
  const wfDir = `${root}/.github/workflows`;
  const found = new Set();
  for (const name of readdirSync(wfDir)) {
    if (!name.endsWith('.yml')) continue;
    const text = readFileSync(`${wfDir}/${name}`, 'utf8');
    for (const m of text.matchAll(/((?:tests|scripts)\/[A-Za-z0-9_./-]+\.test\.mjs)/g)) found.add(m[1]);
  }
  return [...found].sort();
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  let files = [];
  if (argv.includes('--all')) {
    files = gatedTestFiles();
    if (files.length === 0) {
      process.stderr.write('test-substance: --all found no test files in any workflow; the discovery is broken\n');
      return 2;
    }
  } else {
    files = argv.filter((a) => !a.startsWith('--'));
  }
  if (files.length === 0) {
    process.stderr.write('test-substance: no files given (pass paths, or --all)\n');
    return 2;
  }

  let bad = 0;
  for (const file of files) {
    if (!existsSync(file)) {
      // A path in a workflow that does not exist is a worse defect than a thin
      // test: CI would fail on the missing file, but only when that job runs.
      process.stdout.write(`FAIL ${file}: named by a workflow but not present\n`);
      bad += 1;
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const allowed = ALLOWED_WITHOUT_ASSERTIONS[file];
    const got = inspect(source, file);
    const ok = got.ok || Boolean(allowed);
    if (!ok) bad += 1;
    const detail = allowed ? `allowed: ${allowed}` : (got.problems.join('; ') || 'ok');
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${file}: tests=${got.tests} skipped=${got.skipped} assertions=${got.assertions} - ${detail}\n`);
  }
  process.stdout.write(bad === 0 ? `test-substance: ${files.length}/${files.length} have substance\n` : `test-substance: ${bad} FAILED\n`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
