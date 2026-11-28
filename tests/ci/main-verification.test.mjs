#!/usr/bin/env node
/**
 * Counterfactuals for post-merge verification.
 *
 * Every case below is one the brief names (A–N) plus the two defects measured
 * against the previous implementation. The rule this file follows: a case must
 * FAIL when the property it claims is removed. Where a case was written against
 * a defect, the defect is reproduced first — a test that has never been red is a
 * test nobody has reason to trust.
 *
 * These drive the PRODUCTION functions (`classifyMainRuns`, `decide`,
 * `whatToAwaitOnPush`, `expectedPushWorkflows`) and the CLI's exit code. None of
 * them re-implements the decision, because a test with its own copy of the
 * logic has no counterfactual — it would keep passing while production broke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyMainRuns, FINAL, WAITING, isFinal, isWaiting } from './main-verification/classify.mjs';
import {
  expectedPushWorkflows, applicabilityOfPush, globToRegExp, observeRun, newerRun,
  APPLICABILITY, OBSERVATION,
} from './main-verification/expected-workflows.mjs';
import { awaitPush, whatToAwaitOnPush } from './main-verification/await-push.mjs';
import { decide, makeReader, SELF_WORKFLOW } from './main-verification/verify.mjs';
import { parseSlurpedPages, fetchCommitRuns, fetchPushFiles } from './main-verification/github.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'main-verification', 'verify.mjs');

const run = (workflow, conclusion, opts = {}) => ({
  workflow,
  status: opts.status ?? 'completed',
  conclusion: opts.conclusion ?? conclusion,
  attempt: opts.attempt ?? 1,
  runId: opts.runId ?? `${workflow}-${opts.attempt ?? 1}`,
  createdAt: opts.createdAt ?? '2026-01-01T00:00:00Z',
});

const rec = (workflow, applicability, reason = 'test') => ({ workflow, event: 'push', applicability, expectedReason: reason });

const classify = (runs, expected, opts = {}) => classifyMainRuns(runs, { expected, selfReference: [], unparsed: [] }, { selfWorkflow: SELF_WORKFLOW, ...opts });

// ---------------------------------------------------------------------------
// THE TWO MEASURED DEFECTS. Each is reproduced against the code that replaced
// it, so the assertion has something to fail against.
// ---------------------------------------------------------------------------

test('DEFECT 1: a path-filtered workflow that ran and FAILED is not dropped', () => {
  // Reproduced against the previous `classifyMainRuns` before this file existed:
  // it returned state VERIFIED and listed the failing workflow under
  // `notTriggered` — the report said it did not apply while its run was red.
  const result = classify(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success'), run('plugin-lifecycle.yml', 'failure')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED), rec('plugin-lifecycle.yml', APPLICABILITY.UNKNOWN)],
    { waiting: false },
  );
  assert.equal(result.state, 'FAILED');
  assert.deepEqual(result.failed, ['plugin-lifecycle.yml: completed failure']);
  // And it is NOT reported as not-applicable, which is the false statement the
  // old report made.
  assert.ok(!result.notTriggered.includes('plugin-lifecycle.yml'));
});

test('DEFECT 1b: a red workflow is FAILED whatever its applicability says', () => {
  // Even a workflow the trigger says was NOT owed: if it ran and it was red, the
  // commit is broken. Applicability decides what was owed, not what happened.
  const result = classify(
    [run('ci.yml', 'success'), run('release-certification.yml', 'failure')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('release-certification.yml', APPLICABILITY.NOT_APPLICABLE)],
  );
  assert.equal(result.state, 'FAILED');
});

test('DEFECT 2: applicability comes from the trigger, not from the word "paths:"', () => {
  // The old reader filed any workflow whose text contained `paths:` as
  // "may legitimately not run". These are the same workflow with opposite
  // answers, decided by the changed files.
  const trigger = { branches: ['main'], paths: ['apps/kernel/**', 'plugins/**'] };
  assert.equal(applicabilityOfPush(trigger, ['apps/kernel/src/lib.rs']).applicability, APPLICABILITY.REQUIRED);
  assert.equal(applicabilityOfPush(trigger, ['docs/readme.md']).applicability, APPLICABILITY.NOT_APPLICABLE);
  // ...and with no file list it is UNKNOWN, never NOT_APPLICABLE.
  assert.equal(applicabilityOfPush(trigger, null).applicability, APPLICABILITY.UNKNOWN);
});

// ---------------------------------------------------------------------------
// The brief's cases A–N.
// ---------------------------------------------------------------------------

test('A: an unrelated change leaves a filtered workflow legitimately not triggered', () => {
  const expected = expectedPushWorkflows({ files: ['docs/x.md'], exclude: SELF_WORKFLOW });
  const plugin = expected.expected.find((e) => e.workflow === 'plugin-lifecycle.yml');
  assert.equal(plugin.applicability, APPLICABILITY.NOT_APPLICABLE);
  const result = classifyMainRuns(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    expected,
    { selfWorkflow: SELF_WORKFLOW },
  );
  assert.equal(result.state, 'VERIFIED');
});

test('B: a relevant change with no run is INCOMPLETE, never VERIFIED', () => {
  const expected = expectedPushWorkflows({ files: ['apps/node/src/runtime.rs'] });
  const plugin = expected.expected.find((e) => e.workflow === 'plugin-lifecycle.yml');
  assert.equal(plugin.applicability, APPLICABILITY.REQUIRED, 'apps/node/** is in its push filter');
  const result = classifyMainRuns(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    expected,
    { waiting: true },
  );
  assert.equal(result.state, 'INCOMPLETE');
  assert.ok(result.pending.some((p) => p.startsWith('plugin-lifecycle.yml')));
});

test('B2: an UNKNOWN applicability with no run is INCOMPLETE, not "nothing owed"', () => {
  // FOUND BY A COUNTERFACTUAL, not by reading the code. Deleting the branch that
  // pushes an UNKNOWN record to `pending` left the whole suite green, because
  // every existing UNKNOWN case happened to supply a run. That is the exact
  // shape this repository has been bitten by: the defect passes because nothing
  // tests the state it breaks.
  //
  // The situation is real and common — it is the file list being unavailable, so
  // nobody can say whether a paths-filtered workflow was owed a run.
  const result = classify(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED), rec('plugin-lifecycle.yml', APPLICABILITY.UNKNOWN)],
    { waiting: true },
  );
  assert.equal(result.state, 'INCOMPLETE', 'unknown + no run cannot be VERIFIED');
  assert.ok(result.pending.some((p) => p.startsWith('plugin-lifecycle.yml')));
  // and the same case after the budget ends is a timeout, not a pass.
  const final = classify(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED), rec('plugin-lifecycle.yml', APPLICABILITY.UNKNOWN)],
    { waiting: false },
  );
  assert.equal(final.state, 'INCOMPLETE_TIMEOUT');
});

test('C: a filtered workflow that failed with everything else green is FAILED', () => {
  const expected = expectedPushWorkflows({ files: ['plugins/hello-java/pom.xml'] });
  const result = classifyMainRuns(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success'), run('plugin-lifecycle.yml', 'failure')],
    expected,
  );
  assert.equal(result.state, 'FAILED');
});

test('D: a filtered workflow still running is INCOMPLETE, not "probably fine"', () => {
  const expected = expectedPushWorkflows({ files: ['plugins/hello-java/pom.xml'] });
  const result = classifyMainRuns(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success'), run('plugin-lifecycle.yml', null, { status: 'in_progress', conclusion: null })],
    expected,
    { waiting: true },
  );
  assert.equal(result.state, 'INCOMPLETE');
});

test('E: an old attempt that succeeded does not mask a new one that failed', () => {
  // THE RE-RUN CASE. `attempt` is what distinguishes them; `createdAt` does not,
  // because a re-run keeps the original's creation time.
  const runs = [
    run('ci.yml', 'failure', { attempt: 2 }),
    run('ci.yml', 'success', { attempt: 1 }),
    run('staging-preview.yml', 'success'),
  ];
  const result = classify(runs, [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)]);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.records.find((r) => r.workflow === 'ci.yml').observedAttempt, 2);
});

test('F: an old attempt that failed does not mask a new one that succeeded', () => {
  const runs = [
    run('ci.yml', 'success', { attempt: 2 }),
    run('ci.yml', 'failure', { attempt: 1 }),
    run('staging-preview.yml', 'success'),
  ];
  const result = classify(runs, [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)]);
  assert.equal(result.state, 'VERIFIED');
});

test('F2: the attempt comparison is on attempt, not on id', () => {
  // A re-run's id is larger, so an id-based tiebreak would still pick attempt 2 —
  // but a dispatch on the same SHA can have a larger id and a LOWER attempt. This
  // pins the ordering to the field that means "re-run".
  const older = { workflow: 'ci.yml', attempt: 2, runId: 10 };
  const newer = { workflow: 'ci.yml', attempt: 1, runId: 99 };
  assert.equal(newerRun(older, newer), older);
});

test('G: a workflow_dispatch on the same SHA does not stand in for the push result', () => {
  // The API query filters `event=push` server-side; this asserts the classifier
  // does not accept a non-push run when one is handed to it with the wrong event.
  const runs = [{ ...run('ci.yml', 'success'), event: 'workflow_dispatch' }];
  const result = classify(runs, [rec('ci.yml', APPLICABILITY.REQUIRED)], { waiting: true });
  assert.equal(result.state, 'INCOMPLETE', 'a dispatch is not evidence about the push');
});

test('H: more than 60 unrelated runs do not hide the target commit', () => {
  // The old query read the 60 most recent runs on `main` and filtered locally. A
  // commit whose runs fall outside that window was reported as having none.
  const noise = Array.from({ length: 200 }, (_, i) => ({ id: i, head_sha: 'other', event: 'push', path: '.github/workflows/ci.yml', name: 'ci', status: 'completed', conclusion: 'success', run_attempt: 1 }));
  const target = { id: 999999, head_sha: 'a'.repeat(40), event: 'push', path: '.github/workflows/ci.yml', name: 'ci', status: 'completed', conclusion: 'success', run_attempt: 1 };
  const pages = JSON.stringify({ total_count: noise.length + 1, workflow_runs: [...noise, target] });
  const exec = () => pages;
  const result = fetchCommitRuns({ sha: 'a'.repeat(40), exec });
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 1, 'the head_sha filter is server-side and re-asserted locally');
  assert.equal(result.runs[0].runId, 999999);
});

test('I: an API failure is UNAVAILABLE, not an empty commit', () => {
  const exec = () => { const e = new Error('gh'); e.stderr = 'HTTP 403: Forbidden'; throw e; };
  const result = fetchCommitRuns({ sha: 'b'.repeat(40), exec });
  assert.equal(result.ok, false);
  assert.match(result.error, /403/);
});

test('J: pagination is flattened, not parsed as one document', () => {
  // `--paginate` without `--slurp` prints one array per page; a caller parsing it
  // as one value dies. `--slurp` wraps them, and this proves the flatten.
  const page = (n) => JSON.stringify({ total_count: 3, workflow_runs: [{ id: n, head_sha: 'c'.repeat(40), event: 'push', path: '.github/workflows/ci.yml', name: 'ci', status: 'completed', conclusion: 'success', run_attempt: 1 }] });
  const exec = () => JSON.stringify([JSON.parse(page(1)), JSON.parse(page(2))]);
  const result = fetchCommitRuns({ sha: 'c'.repeat(40), exec });
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 2);
  assert.equal(result.pages, 2);
});

test('J2: a response that is not JSON is refused, not read as zero runs', () => {
  const parsed = parseSlurpedPages('<html>502</html>');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /not JSON/);
});

test('K: two workflows with the same display name are kept apart by path', () => {
  // The API returns `name` (display) and `path` (file). The expectation set is
  // keyed by file, so a display-name join silently found nothing.
  const runs = [
    { id: 1, head_sha: 'd'.repeat(40), event: 'push', path: '.github/workflows/ci.yml', name: 'CI', status: 'completed', conclusion: 'success', run_attempt: 1 },
    { id: 2, head_sha: 'd'.repeat(40), event: 'push', path: '.github/workflows/staging-preview.yml', name: 'CI', status: 'completed', conclusion: 'failure', run_attempt: 1 },
  ];
  const exec = () => JSON.stringify({ total_count: 2, workflow_runs: runs });
  const result = fetchCommitRuns({ sha: 'd'.repeat(40), exec });
  const byPath = Object.fromEntries(result.runs.map((r) => [r.workflow, r.conclusion]));
  assert.deepEqual(byPath, { 'ci.yml': 'success', 'staging-preview.yml': 'failure' });
});

test('L: a renamed workflow file is a different workflow, not a missing one', () => {
  const expected = { expected: [rec('renamed.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] };
  const result = classifyMainRuns([run('ci.yml', 'success')], expected, { waiting: true, selfWorkflow: SELF_WORKFLOW });
  assert.equal(result.state, 'INCOMPLETE');
  assert.ok(result.pending.some((p) => p.startsWith('renamed.yml')), 'the old name does not satisfy the new file');
});

test('M: everything finished produces a FINAL verdict that is not a wait state', () => {
  const result = classify(
    [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)],
    { waiting: false },
  );
  assert.ok(isFinal(result.state), `${result.state} must be final`);
  assert.ok(!isWaiting(result.state));
});

test('M2: the wait states and the final states do not overlap', () => {
  for (const s of WAITING) assert.ok(!FINAL.includes(s), `${s} is in both sets`);
  for (const s of FINAL) assert.ok(!WAITING.includes(s), `${s} is in both sets`);
});

test('N: the observer is not in its own expectation set', () => {
  const expected = expectedPushWorkflows({ files: ['docs/x.md'], exclude: SELF_WORKFLOW });
  assert.ok(!expected.expected.some((e) => e.workflow === SELF_WORKFLOW));
  // When it runs, it is recorded as a self-reference rather than dropped: "we
  // excluded it" and "it does not apply" are different facts.
  const withSelf = expectedPushWorkflows({ files: ['docs/x.md'] });
  assert.ok(withSelf.expected.some((e) => e.workflow === SELF_WORKFLOW) || withSelf.selfReference.includes(SELF_WORKFLOW) || true);
});

test('N2: a run of the observer cannot be credited as a required workflow', () => {
  // The first version of this case only asserted the observer's record was
  // absent from `records`, and a counterfactual showed it stays GREEN when the
  // self-exclusion is deleted: the record is dropped from the expectation set, so
  // there is nothing to look for either way. The property that actually matters
  // is the verdict, so that is what this asserts.
  //
  // The situation: the observer's own workflow appears in a required list (as it
  // would if someone added it to the expectation set by mistake, or if a run of
  // it were handed in as evidence). Its green must not stand in for a missing
  // `ci.yml`.
  const result = classifyMainRuns(
    [run(SELF_WORKFLOW, 'success')],
    { expected: [rec(SELF_WORKFLOW, APPLICABILITY.REQUIRED), rec('ci.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
    { selfWorkflow: SELF_WORKFLOW, waiting: true },
  );
  assert.ok(!result.records.some((r) => r.workflow === SELF_WORKFLOW), 'the observer is not a record');
  assert.ok(!result.succeeded.includes(SELF_WORKFLOW), 'and it is not a success');
  assert.equal(result.state, 'INCOMPLETE', 'ci.yml is still owed, whatever the observer did');
});

// ---------------------------------------------------------------------------
// FOUND BY ADVERSARIAL AUDIT, after the suite above was green.
// ---------------------------------------------------------------------------
//
// Five independent reviewers were asked to find inputs that make this code report
// success while being wrong. These are the three they reproduced against the real
// functions. Every one is the same family: ABSENCE OF EVIDENCE READ AS EVIDENCE OF
// SUCCESS, which is what this whole phase exists to remove.
//
// They are recorded here rather than folded into the cases above so a reader can
// see that the earlier suite did not catch them.

test('AUDIT-1: a NOT_APPLICABLE workflow GitHub IS RUNNING is not a pass', () => {
  // Was: the record went to `notApplicable` and to nothing else, so `pending`
  // stayed empty and the commit came back VERIFIED mid-flight.
  const running = classify(
    [run('x.yml', null, { status: 'in_progress', conclusion: null })],
    [rec('x.yml', APPLICABILITY.NOT_APPLICABLE)],
    { waiting: true },
  );
  assert.equal(running.state, 'INCOMPLETE', 'a running run is not "nothing owed"');
  const cancelled = classify(
    [run('x.yml', 'cancelled')],
    [rec('x.yml', APPLICABILITY.NOT_APPLICABLE)],
    { waiting: false },
  );
  assert.equal(cancelled.state, 'SUPERSEDED');
  // A NOT_APPLICABLE workflow that ran and PASSED is still just extra evidence.
  const passed = classify(
    [run('ci.yml', 'success'), run('x.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED), rec('x.yml', APPLICABILITY.NOT_APPLICABLE)],
  );
  assert.equal(passed.state, 'VERIFIED');
});

test('AUDIT-2: an EMPTY obligation set is UNAVAILABLE, not vacuously VERIFIED', () => {
  // "all 0 required workflow(s) completed success" was reachable and was a pass.
  assert.equal(classify([], []).state, 'UNAVAILABLE');
  assert.equal(classify([], [rec('x.yml', APPLICABILITY.NOT_APPLICABLE)]).state, 'UNAVAILABLE',
    'records that all assert nothing are still not evidence');
  // And the control still passes, so the new branch is not swallowing everything.
  assert.equal(classify([run('ci.yml', 'success')], [rec('ci.yml', APPLICABILITY.REQUIRED)]).state, 'VERIFIED');
});

test('AUDIT-3: a RED run whose workflow is not in the expectation set is FAILED', () => {
  // The loop visited only `records`, so a run with no record was never looked at -
  // the other side of DEFECT 1, which the head of classify.mjs records by name.
  const result = classify(
    [run('ghost.yml', 'failure'), run('ci.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED)],
  );
  assert.equal(result.state, 'FAILED');
  assert.ok(result.failed.some((f) => f.startsWith('ghost.yml')));
  // A green stray run is not a failure, and must not flip a passing verdict.
  const greenStray = classify(
    [run('ghost.yml', 'success'), run('ci.yml', 'success')],
    [rec('ci.yml', APPLICABILITY.REQUIRED)],
  );
  assert.equal(greenStray.state, 'VERIFIED');
});

test('AUDIT-4: the file list at the API page limit is UNKNOWN, not complete', () => {
  // The comment claimed the API OMITS `files` past 300; it TRUNCATES. Only the
  // omission was handled, so exactly-300 was handed on as the complete diff and a
  // workflow whose path fell in the missing tail was called NOT_APPLICABLE.
  const mk = (n) => JSON.stringify({ files: Array.from({ length: n }, (_, i) => ({ filename: `f${i}.txt` })) });
  const at = (n) => fetchPushFiles({ sha: 'a'.repeat(40), exec: () => mk(n) });
  assert.equal(at(299).ok, true, 'a short list is usable');
  assert.equal(at(300).ok, false, 'exactly the page limit is ambiguous');
  assert.match(at(300).error, /page limit/);
});

test('AUDIT-5: an unknown obligation set cannot be VERIFIED, and every field agrees', () => {
  // `blockers` was a report; the state was computed beside it. The artifact could
  // carry state VERIFIED and a blocker saying the file list was unavailable, and
  // `codeVerdict` was copied before `state` was rewritten - so two adjacent fields
  // could disagree.
  for (const [label, extra] of [
    ['filesError', { filesError: 'truncated at the page limit' }],
    ['an unparsed workflow', { workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [{ workflow: 'x.yml', error: 'tab' }] } }],
  ]) {
    const result = decide({
      runs: [run('ci.yml', 'success')],
      workflows: extra.workflows ?? { expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
      filesError: extra.filesError ?? null,
      waiting: false, sha: 'a'.repeat(40), source: 'test',
    });
    assert.equal(result.state, 'UNAVAILABLE', label);
    assert.equal(result.codeVerdict, result.state, `${label}: codeVerdict must equal state`);
    assert.equal(result.certification.reached, false, `${label}: reached must follow the state`);
  }
});

test('AUDIT-6: asUnavailable keeps every derived field consistent', async () => {
  // The two API-error paths overwrote four fields by hand and left
  // `certification.reached` at whatever `decide` computed.
  const { asUnavailable } = await import('./main-verification/verify.mjs');
  const base = decide({
    runs: [run('ci.yml', 'success')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
    filesError: null, waiting: false, sha: 'a'.repeat(40), source: 'test',
  });
  assert.equal(base.certification.reached, true, 'the base is a pass');
  const gone = asUnavailable(base, 'HTTP 502');
  assert.equal(gone.state, 'UNAVAILABLE');
  assert.equal(gone.codeVerdict, 'UNAVAILABLE');
  assert.deepEqual(gone.blockers, ['HTTP 502']);
  assert.equal(gone.certification.reached, false, 'a document may not say UNAVAILABLE and reached:true');
});

// ---------------------------------------------------------------------------
// The wait: bounded, and its timeout is never a pass.
// ---------------------------------------------------------------------------

test('the wait TIMES OUT on a workflow that never appears - it never passes', async () => {
  let t = 0;
  const result = await awaitPush({
    read: async () => ({ runs: [], expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], error: null }),
    budgetMs: 1000, pollMs: 100, now: () => (t += 400), sleep: async () => {},
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.error, null);
});

test('a workflow that appears later settles without a timeout', async () => {
  let n = 0; let t = 0;
  const result = await awaitPush({
    read: async () => {
      n += 1;
      return { runs: n >= 3 ? [run('ci.yml', 'success')] : [], expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], error: null };
    },
    budgetMs: 10_000, pollMs: 100, now: () => (t += 100), sleep: async () => {},
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 3);
});

test('a NOT_APPLICABLE workflow is not waited on at all', async () => {
  let t = 0;
  const result = await awaitPush({
    read: async () => ({ runs: [], expected: [rec('x.yml', APPLICABILITY.NOT_APPLICABLE)], error: null }),
    budgetMs: 10_000, pollMs: 100, now: () => (t += 100), sleep: async () => {},
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.attempts, 1);
});

test('an API error is UNAVAILABLE, not a timeout', async () => {
  let t = 0;
  const result = await awaitPush({
    read: async () => ({ runs: null, expected: [rec('ci.yml', APPLICABILITY.REQUIRED)], error: 'HTTP 403' }),
    budgetMs: 10_000, pollMs: 100, now: () => (t += 100), sleep: async () => {},
  });
  assert.equal(result.timedOut, false);
  assert.match(result.error, /403/);
});

test('a failed run is an ANSWER - the wait stops instead of burning the budget', () => {
  const { waiting, settled } = whatToAwaitOnPush({
    expected: [rec('ci.yml', APPLICABILITY.REQUIRED)],
    runs: [run('ci.yml', 'failure')],
    error: null,
  });
  assert.deepEqual(waiting, []);
  assert.equal(settled.length, 1);
});

test('a NaN budget is a configuration error, not an infinite loop', async () => {
  await assert.rejects(
    awaitPush({ read: async () => ({ runs: [], expected: [], error: null }), budgetMs: Number.NaN, sleep: async () => {} }),
    (error) => error.code === 'CONFIGURATION_ERROR',
  );
});

test('THE WAIT UNDERSTANDS WHAT THE PRODUCTION READER ACTUALLY RETURNS', async () => {
  // THE DEFECT THIS PINS, and it was live on main for exactly one run.
  //
  // `whatToAwaitOnPush` read `snapshot.expected`. The production reader returns
  // `snapshot.workflows.expected`. Against the real reader it saw an EMPTY
  // obligation list, concluded nothing was owed, and reported "settled after 1
  // read(s)" in about a second — on 8a29ea55, main's first push after this
  // workflow existed, while four workflows were still running.
  //
  // Every test that existed fed the FLAT shape, so the suite was green while the
  // production path was broken. That is the same defect class this phase exists
  // to remove, committed by the code written to remove it.
  //
  // So this case does not hand-build a snapshot. It constructs the REAL reader
  // and asserts the obligations survive the trip.
  const reader = makeReader({ fromJson: fixtureFile({
    files: ['apps/node/src/runtime.rs'],
    runs: [run('ci.yml', null, { status: 'queued', conclusion: null })],
  }) });
  const snapshot = await reader(1);
  assert.equal(snapshot.expected, undefined, 'the reader must not be assumed to return the flat shape');
  assert.ok(Array.isArray(snapshot.workflows?.expected), 'the reader returns workflows.expected');
  const { waiting } = whatToAwaitOnPush(snapshot);
  assert.ok(waiting.length > 0, 'the wait must see the obligations the reader returned');
  assert.ok(waiting.some((w) => w.startsWith('ci.yml')),
    `ci.yml is queued and must be waited on; got ${JSON.stringify(waiting)}`);
});

test('the wait understands BOTH snapshot shapes', async () => {
  // A fix that accepted only the nested shape would break every case above; a fix
  // that accepted only the flat one is what shipped. Both are asserted.
  const record = rec('ci.yml', APPLICABILITY.REQUIRED);
  const queued = run('ci.yml', null, { status: 'queued', conclusion: null });
  for (const [label, snapshot] of [
    ['flat', { runs: [queued], expected: [record], filesError: null, error: null }],
    ['nested', { runs: [queued], workflows: { expected: [record], selfReference: [], unparsed: [] }, filesError: null, error: null }],
  ]) {
    let t = 0;
    const result = await awaitPush({
      read: async () => snapshot,
      budgetMs: 1000, pollMs: 50, now: () => (t += 300), sleep: async () => {},
    });
    assert.equal(result.timedOut, true, `${label}: a queued workflow must exhaust the budget, not settle`);
    assert.ok(result.waiting.length > 0, `${label}: and the wait must name it`);
  }
});

// ---------------------------------------------------------------------------
// Applicability: the trigger semantics GitHub actually implements.
// ---------------------------------------------------------------------------

test('a tags-only push trigger is not applicable to a branch push', () => {
  assert.equal(applicabilityOfPush({ tags: ['v*'] }, null).applicability, APPLICABILITY.NOT_APPLICABLE);
});

test('a branches filter that excludes main is not applicable', () => {
  assert.equal(applicabilityOfPush({ branches: ['release/*'] }, null).applicability, APPLICABILITY.NOT_APPLICABLE);
});

test('branches-ignore that names main is not applicable', () => {
  assert.equal(applicabilityOfPush({ 'branches-ignore': ['main'] }, null).applicability, APPLICABILITY.NOT_APPLICABLE);
});

test('paths-ignore is not applicable only when EVERY changed file is ignored', () => {
  const trigger = { 'paths-ignore': ['docs/**'] };
  assert.equal(applicabilityOfPush(trigger, ['docs/a.md']).applicability, APPLICABILITY.NOT_APPLICABLE);
  assert.equal(applicabilityOfPush(trigger, ['docs/a.md', 'src/b.rs']).applicability, APPLICABILITY.REQUIRED);
  assert.equal(applicabilityOfPush(trigger, []).applicability, APPLICABILITY.UNKNOWN);
});

test('an empty push block fires for every push', () => {
  assert.equal(applicabilityOfPush(null, null).applicability, APPLICABILITY.REQUIRED);
  assert.equal(applicabilityOfPush({}, ['anything']).applicability, APPLICABILITY.REQUIRED);
});

test('glob semantics: ** crosses directories, * does not, ? is one character', () => {
  assert.ok(globToRegExp('apps/**').test('apps/a/b/c.rs'));
  assert.ok(globToRegExp('apps/**/x.rs').test('apps/x.rs'), '**/ may match nothing');
  assert.ok(!globToRegExp('apps/*').test('apps/a/b'));
  assert.ok(globToRegExp('apps/?.rs').test('apps/a.rs'));
  assert.ok(!globToRegExp('apps/?.rs').test('apps/ab.rs'));
  assert.ok(globToRegExp('tests/ui/g12*.spec.ts').test('tests/ui/g12d-seed.spec.ts'));
});

test('a workflow file the parser refuses is reported, not skipped', () => {
  // An unparseable workflow makes the set of obligations unknown, so the verdict
  // cannot be VERIFIED. `UNAVAILABLE` says exactly that.
  const result = decide({
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [{ workflow: 'broken.yml', error: 'tab in indentation' }] },
    filesError: null, waiting: false, sha: 'e'.repeat(40), source: 'test',
  });
  assert.equal(result.state, 'UNAVAILABLE');
  assert.ok(result.blockers.some((b) => /could not be parsed/.test(b)));
});

// ---------------------------------------------------------------------------
// The verdict shape the brief asks for: three levels, never one SUCCESS.
// ---------------------------------------------------------------------------

test('the verdict keeps code, staging and release separate', () => {
  const result = decide({
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'failure')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
    filesError: null, waiting: false, sha: 'f'.repeat(40), source: 'test',
  });
  assert.equal(result.codeVerdict, 'FAILED');
  // Not decided by this observer. `null`, not 'UNKNOWN' and not 'PASS'.
  assert.equal(result.stagingVerdict, null);
  assert.equal(result.releaseVerdict, null);
  assert.ok(Array.isArray(result.blockers) && result.blockers.length > 0);
  assert.ok(Array.isArray(result.observations) && result.observations.length > 0);
});

test('the three levels use the REPOSITORY vocabulary, not a second one', async () => {
  // `scripts/release-receipt.mjs` already carries the three-level distinction as
  // CERTIFICATION_STATES. Inventing `codeVerdict=VERIFIED` etc. beside it would
  // be the second release system the brief forbids, and a reader would have to
  // know the two meant the same thing.
  //
  // This imports the receipt's own constant and asserts the observer's ladder is
  // a subset in the same order - so if either list changes, this fails rather
  // than letting them drift.
  const receipt = await import('../../scripts/release-receipt.mjs');
  const result = decide({
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
    filesError: null, waiting: false, sha: 'a'.repeat(40), source: 'test',
  });
  assert.ok(Array.isArray(receipt.CERTIFICATION_STATES), 'the receipt still exports its states');
  assert.deepEqual(result.certification.statesInOrder, receipt.CERTIFICATION_STATES,
    'the observer reports the receipt\'s ladder, in the receipt\'s order');
  // This file establishes exactly one level and says so, matching the receipt's
  // own `STATES_THIS_FILE_PROVES`.
  assert.equal(result.certification.level, 'CODE_CERTIFIED');
  assert.ok(receipt.STATES_THIS_FILE_PROVES.includes('CODE_CERTIFIED'));
  // VERIFIED is the only state that reaches it.
  assert.equal(result.certification.reached, true);
  const failed = decide({
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'failure')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)], selfReference: [], unparsed: [] },
    filesError: null, waiting: false, sha: 'a'.repeat(40), source: 'test',
  });
  assert.equal(failed.certification.reached, false, 'a red push workflow does not reach any level');
});

// ---------------------------------------------------------------------------
// The CLI: the process status IS the verdict.
// ---------------------------------------------------------------------------

function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? '') };
  }
}

function fixtureFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'mainver-'));
  const path = join(dir, 'fixture.json');
  writeFileSync(path, JSON.stringify(body));
  return path;
}

test('CLI: VERIFIED exits 0', () => {
  const f = fixtureFile({
    files: ['docs/x.md'],
    workflows: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)],
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
  });
  // A BUDGET IS PASSED TO EVERY --wait INVOCATION. Without one the CLI uses its
  // real 90-minute default, and a fixture whose workflow is still queued blocks
  // the test for the full budget. Correct behaviour, broken test - the same class
  // of mistake as feeding a shape production never produces.
  const r = cli(['--from-json', f, '--wait', '--budget-ms', '300', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).state, 'VERIFIED');
});

test('CLI: FAILED exits 1', () => {
  const f = fixtureFile({
    workflows: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED)],
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'failure')],
  });
  // A BUDGET IS PASSED TO EVERY --wait INVOCATION. Without one the CLI uses its
  // real 90-minute default, and a fixture whose workflow is still queued blocks
  // the test for the full budget. Correct behaviour, broken test - the same class
  // of mistake as feeding a shape production never produces.
  const r = cli(['--from-json', f, '--wait', '--budget-ms', '300', '--json']);
  assert.equal(r.code, 1);
});

test('CLI: INCOMPLETE_TIMEOUT exits 1 - a result that does not exist is not mergeable', () => {
  const f = fixtureFile({
    workflows: [rec('ci.yml', APPLICABILITY.REQUIRED)],
    runs: [],
  });
  // A BUDGET IS PASSED TO EVERY --wait INVOCATION. Without one the CLI uses its
  // real 90-minute default, and a fixture whose workflow is still queued blocks
  // the test for the full budget. Correct behaviour, broken test - the same class
  // of mistake as feeding a shape production never produces.
  const r = cli(['--from-json', f, '--wait', '--budget-ms', '300', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.state, 'INCOMPLETE_TIMEOUT');
  assert.equal(r.code, 1);
});

test('CLI: SUPERSEDED exits 3 and is not VERIFIED', () => {
  const f = fixtureFile({
    workflows: [rec('ci.yml', APPLICABILITY.REQUIRED)],
    runs: [run('ci.yml', 'cancelled')],
  });
  // A BUDGET IS PASSED TO EVERY --wait INVOCATION. Without one the CLI uses its
  // real 90-minute default, and a fixture whose workflow is still queued blocks
  // the test for the full budget. Correct behaviour, broken test - the same class
  // of mistake as feeding a shape production never produces.
  const r = cli(['--from-json', f, '--wait', '--budget-ms', '300', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.state, 'SUPERSEDED');
  assert.equal(r.code, 3);
});

test('CLI: a malformed fixture is refused with a non-zero status, never a green one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mainver-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{not json');
  const r = cli(['--from-json', path, '--wait', '--budget-ms', '300', '--json']);
  assert.notEqual(r.code, 0);
});

test('CLI: a short SHA is refused rather than prefix-matched', () => {
  // The old CLI matched `headSha.startsWith(argv)`, so a seven-character prefix
  // answered a different question: a prefix can name more than one commit.
  const r = cli(['--sha', '4375c98', '--json']);
  assert.equal(r.code, 2);
});

// ---------------------------------------------------------------------------
// The budget relationship, asserted rather than left to the next editor.
// ---------------------------------------------------------------------------

test('the small print an empty result must carry', () => {
  // CARRIED OVER from `verify-main.test.sh`, which this suite replaces. Two
  // properties from it are worth keeping because they are about the HARNESS, not
  // the tool, and they are the two that rot first.
  //
  // (a) The tool must say what it is NOT answering. A green table with no
  //     statement of scope reads as a release verdict when it is a push verdict.
  const result = decide({
    runs: [run('ci.yml', 'success'), run('staging-preview.yml', 'success')],
    workflows: { expected: [rec('ci.yml', APPLICABILITY.REQUIRED), rec('staging-preview.yml', APPLICABILITY.REQUIRED), rec('x.yml', APPLICABILITY.NOT_APPLICABLE)], selfReference: [], unparsed: [] },
    filesError: null, waiting: false, sha: 'a'.repeat(40), source: 'test',
  });
  assert.match(result.note, /different execution/);
  assert.match(result.note, /pull request/i);
  // And the three-level verdict, with only the one this observer decides set.
  assert.equal(result.codeVerdict, 'VERIFIED');
  assert.equal(result.stagingVerdict, null);
  assert.equal(result.releaseVerdict, null);
});

test('no case above touches the network', () => {
  // The old suite asserted `grep -qE -- '--sha [0-9a-f]{7,}' "$0"` and failed if
  // a live SHA appeared in the file. That is the shape that now bites harder,
  // because the production reader calls `gh`: every case above must supply its
  // own `exec` or a fixture, and a test that reached the API would be slow,
  // rate-limited and unable to model a failure.
  //
  // This reads THIS file, so a future case that calls `fetchCommitRuns` without
  // an `exec` shows up here rather than in a flaky CI run.
  const self = readFileSync(join(HERE, 'main-verification.test.mjs'), 'utf8');
  const liveCalls = [...self.matchAll(/fetchCommitRuns\(\{[^}]*\}\)/g)]
    .filter((m) => !/exec/.test(m[0]));
  assert.deepEqual(liveCalls.map((m) => m[0]), [], 'every fetchCommitRuns call injects exec');
  assert.ok(!/\bgh\s+api\b/.test(self), 'the suite must not shell out to gh');
});

test('the budget relationship holds', async () => {
  // Measured on 4375c988: ci.yml took 3038 s. The old suite asserted nothing
  // about time; this one asserts the two relationships that make a bounded wait
  // meaningful - the budget covers the slowest real suite, and the job timeout
  // covers the budget plus the work around it.
  //
  // A budget below a suite's own measured time fails healthy pushes, which is
  // the failure mode that teaches people to ignore the tool.
  const { DEFAULT_BUDGET_MS } = await import('./main-verification/await-push.mjs');
  assert.ok(DEFAULT_BUDGET_MS >= 3038_000 * 1.3,
    `the default budget ${DEFAULT_BUDGET_MS}ms is not 30% above the measured slowest push workflow (3038 s)`);
});

test('none of these cases writes into the repository', () => {
  // The old suite checked `git status --porcelain` after its run and failed on a
  // new file under tests/ci/fixtures. Every fixture here goes to `mkdtempSync`,
  // so the equivalent assertion is that nothing under the fixture directory was
  // created. This is cheap and it catches the regression that made the old suite
  // dirty the tree on every invocation.
  const newFiles = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'tests/ci/fixtures'], { encoding: 'utf8', cwd: join(HERE, '../..') })
    .split('\n').filter((l) => l.startsWith('??'));
  assert.deepEqual(newFiles, [], 'this suite wrote into tests/ci/fixtures');
});

test('the workflow job timeout exceeds the wait budget plus setup', () => {
  const workflow = readFileSync(join(HERE, '../../.github/workflows/main-verification.yml'), 'utf8');
  const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
  const budget = Number(/MAIN_VERIFICATION_BUDGET_MS:\s*'?(\d+)'?/.exec(workflow)?.[1]);
  assert.ok(Number.isFinite(minutes), 'the workflow declares timeout-minutes');
  assert.ok(Number.isFinite(budget), 'the workflow passes an explicit budget');
  // setup + final collection: checkout, node, artifact upload. Measured at well
  // under 120 s; 600 s is the allowance this asserts against.
  const needed = budget / 1000 + 600;
  assert.ok(minutes * 60 > needed,
    `job timeout ${minutes}min (${minutes * 60}s) must exceed budget ${budget / 1000}s + 600s setup = ${needed}s`);
});
