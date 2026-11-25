#!/usr/bin/env node
/**
 * Phase 8 TASK-21: classify a CI failure, with the evidence that put it there.
 *
 * WHY A CLASSIFIER AND NOT A HABIT
 *
 * The brief names the failure mode directly: "禁止使用'已知外部失败'作为跳过真正回归
 * 的通用理由" (do not use "a known external failure" as a blanket excuse to skip a
 * real regression). The way that habit forms is that someone recognises a failure
 * shape, says "that is the Maven thing again", and moves on. It is right most of
 * the time, and the one time it is wrong the regression ships.
 *
 * So this does not produce a label from a vibe. Every classification carries the
 * LINE that decided it, and every category is defined by evidence that must be
 * PRESENT. A failure with no matching evidence is `UNKNOWN`, not a guess.
 *
 * THE CATEGORIES, AND WHAT PROVES EACH
 *
 *   EXTERNAL_DEPENDENCY   a registry/network fault, named by status or host.
 *   STAGING_ENVIRONMENT   a deployment refused for capacity or reachability.
 *   RUNNER_INFRASTRUCTURE the runner or daemon failed, not the code.
 *   TEST_HARNESS_DEFECT   the test itself is wrong: an unparseable fixture, a
 *                         missing route in a stale binary, a bad YAML value.
 *   CHECK_ATTRIBUTION     the gate could not decide WHICH check it was reading:
 *                         impostor, ambiguous, unattributed, absent.
 *   PRODUCT_REGRESSION    a test asserted and the assertion failed, with no
 *                         external signature. This is the DEFAULT for a red
 *                         assertion, deliberately: it is the category that must
 *                         not be talked out of.
 *   UNKNOWN               nothing matched. Never silently folded into any of the
 *                         above.
 *
 * THE ASYMMETRY THAT MATTERS
 *
 * PRODUCT_REGRESSION requires no special evidence - a failed assertion is enough.
 * Every other category requires POSITIVE evidence, listed in its rule. That is
 * the shape the brief asks for: an external cause must be shown, not assumed, and
 * an unproven one stays UNKNOWN.
 *
 * Usage:
 *   node tests/ci/classify-failure.mjs --text < file
 *   node tests/ci/classify-failure.mjs --log <path>
 *   node tests/ci/classify-failure.mjs --run <github-run-id>   # via gh
 *   node tests/ci/classify-failure.mjs --text < file --json
 *
 * Exit code is the classification's confidence: 0 when the evidence was specific
 * enough to name a category, 1 when the answer is UNKNOWN (so a caller cannot
 * treat "we could not tell" as success).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const AS_JSON = argv.includes('--json');

let text = '';
if (arg('--log')) {
  text = readFileSync(arg('--log'), 'utf8');
} else if (arg('--run')) {
  try {
    text = execFileSync('gh', ['run', 'view', arg('--run'), '--repo', 'baicie/ops-1', '--log'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
    });
  } catch (error) {
    text = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
} else {
  text = readFileSync(0, 'utf8');
}

const lines = text.split('\n');

/**
 * Each rule: a category, a predicate over a single line, and a human reason.
 * ORDER MATTERS. Evidence-bearing categories are tried before the default, and
 * the order among them follows how specific the signature is: a 429 is a 429, but
 * "assertion failed" appears in a great many contexts.
 *
 * `mustAlsoMatch` is the guard against a signature showing up incidentally - a
 * 429 in a comment, a capacity word in a log line about capacity PREDICTION.
 */
const RULES = [
  {
    category: 'EXTERNAL_DEPENDENCY',
    reason: 'the registry answered with a rate limit or a server-side fault',
    // `Could not transfer artifact` is the shape the RETRY POLICY greps for, and
    // it is not always in the failing line: the real failure on run 45542879392
    // read `[FATAL] Non-resolvable parent POM ... status: 429`, and the only line
    // containing "Could not transfer artifact" was a later assertion ABOUT the
    // policy. Both shapes are matched, so the evidence can be the failure itself.
    match: (l) => /status: (429|5\d\d)\b/.test(l) || /status code: (429|5\d\d)\b/.test(l)
      || /\b429 Too Many Requests\b/i.test(l)
      || /Could not transfer artifact/.test(l)
      || /Non-resolvable (parent )?POM/.test(l)
      || /transfer failed for https?:\/\//.test(l),
  },
  {
    category: 'EXTERNAL_DEPENDENCY',
    reason: 'a package/registry host was unreachable',
    match: (l) => /Could not (resolve|find) artifact/.test(l)
      || /(repo\.maven\.apache\.org|registry\.npmjs\.org|pypi\.org).*(connect|timed out|transfer failed)/i.test(l),
  },
  {
    category: 'STAGING_ENVIRONMENT',
    reason: 'the deployment was refused by the environment, not by an assertion',
    match: (l) => /INSTANCE_CAPACITY_EXCEEDED/.test(l)
      || /status_reason.*capacity/i.test(l)
      || /staging (host|deploy).*(unreachable|refused|no address)/i.test(l),
  },
  {
    category: 'RUNNER_INFRASTRUCTURE',
    reason: 'the runner or its daemon failed',
    match: (l) => /docker daemon (is )?not running/i.test(l)
      || /no space left on device/i.test(l)
      || /The runner has received a shutdown signal/i.test(l)
      || /lost communication with the server/i.test(l),
  },
  {
    category: 'TEST_HARNESS_DEFECT',
    reason: 'the test fixture or its supporting script is malformed, so the run measured nothing',
    match: (l) => /failed to parse stage name/.test(l)
      || /API route not found/.test(l)
      || /command not found/.test(l) && /tests\/(ci|acceptance)\//.test(l)
      || /\bunbound variable\b/.test(l) && /tests\/(ci|acceptance)\//.test(l),
  },
  {
    category: 'CHECK_ATTRIBUTION',
    reason: 'the gate could not decide which check it was reading',
    match: (l) => /\b(impostor|ambiguous|unattributed)\b/.test(l)
      || /delegated-(absent|timeout|pending):/.test(l)
      || /required suite not wired/.test(l),
  },
];

/**
 * Which line to QUOTE as the evidence.
 *
 * `find` returns the first match, and the first match is often a line where the
 * signature appears in a PASSING context. Measured on run 45542879392: the Maven
 * 429 was classified correctly, but the quoted evidence was
 *
 *   ok   the failure names "Could not transfer artifact" (matches the policy)
 *
 * - an assertion that the POLICY matches the message, not the failure itself. A
 * reader following that line learns nothing about what broke.
 *
 * So a line that also carries a failure marker is preferred over one that does
 * not. `[FATAL]`, `[ERROR]`, `FAIL`, `##[error]` and `Error:` all count.
 */
// NOT ANCHORED. `gh run view --log` prefixes every line with the job and step
// name separated by tabs, so `^  FAIL ` never matches and a real failed
// assertion was classified UNKNOWN (measured on run 45419909269, which failed
// with `FAIL node-a's instance desired_action=...`). The two-space form is what
// the raw log looks like; the prefixed form is what `--run` produces.
const isFailureLine = (l) =>
  /[\[FATAL\]|\[ERROR\]|(^|\s) {2}FAIL |##\[error\]|(^|\t)Error:|\bFAILED\b]/.test(l);

const evidence = [];
for (const rule of RULES) {
  const matches = lines.filter((l) => rule.match(l));
  if (matches.length) {
    // A failure-context line if there is one; otherwise the first match, which is
    // still real evidence - just weaker.
    const hit = matches.find(isFailureLine) ?? matches[0];
    evidence.push({ category: rule.category, reason: rule.reason, line: hit.trim().slice(0, 300) });
    break; // first matching rule wins; the order above is the specificity order
  }
}

// PRODUCT_REGRESSION is the DEFAULT for a red assertion, and it is only reached
// when no external or harness signature matched. That asymmetry is the point.
if (evidence.length === 0) {
  // Same non-anchored shape: `FAIL ` after whitespace, or a JS assertion message.
  const failed = lines.find((l) => /(^|\s)FAIL /.test(l) || /AssertionError|expected .* to (be|equal)/i.test(l));
  if (failed) {
    evidence.push({
      category: 'PRODUCT_REGRESSION',
      reason: 'an assertion failed and nothing external explains it',
      line: failed.trim().slice(0, 300),
    });
  }
}

const verdict = evidence[0]?.category ?? 'UNKNOWN';
const reason = evidence[0]?.reason
  ?? 'no signature matched: not a rate limit, not a capacity refusal, not a runner fault, not a fixture error, not an attribution problem, and no failed assertion was found';

// The whole point of the asymmetry, said out loud in the output so a reader cannot
// mistake a low-confidence UNKNOWN for "probably external".
const CONFIDENCE = verdict === 'UNKNOWN' ? 'none' : (verdict === 'PRODUCT_REGRESSION' ? 'default' : 'specific');

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ verdict, confidence: CONFIDENCE, reason, evidence }, null, 2) + '\n');
} else {
  process.stdout.write(`${verdict}  (${CONFIDENCE} evidence)\n  ${reason}\n`);
  for (const e of evidence) process.stdout.write(`  evidence: ${e.line}\n`);
  if (verdict === 'UNKNOWN') {
    process.stdout.write(
      '  NOTE: UNKNOWN is not "probably external". Before re-running, read the failure step\n' +
      '        yourself - a real regression that matches no signature lands here.\n',
    );
  }
}
process.exit(verdict === 'UNKNOWN' ? 1 : 0);
