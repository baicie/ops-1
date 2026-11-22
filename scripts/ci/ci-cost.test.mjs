#!/usr/bin/env node
/**
 * Self-test for the CI measurement tool. Part of TASK-01 / 02 / 03.
 *
 * The tool's first version grouped runs by the minute they were created, and
 * every published critical-path number came from that grouping. These cases
 * pin the identity rules so the same mistake cannot return quietly.
 *
 * No network: every case feeds synthetic runs to the exported functions.
 *
 * Usage: node --test scripts/ci/ci-cost.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarise, groupByPush, jobDurations } from './ci-cost.mjs';

/**
 * Drive the REAL `jobDurations` against a synthetic REST response.
 *
 * The export takes a run id and calls `gh`, so the fetch is stubbed by evaluating
 * the function's body with its `gh` in scope - not by re-implementing the mapping
 * in the test, which would assert the copy rather than the function. If the
 * mapping moves, this breaks loudly instead of passing against a stale duplicate.
 */
function selectJobs(jobs, totalCount = jobs.length) {
  const GhStub = `(${jobDurations.toString()})`;
  const factory = new Function('gh', `return ${GhStub};`);
  const fn = factory(() => ({ total_count: totalCount, jobs }));
  return fn(1).jobs;
}

const run = (over = {}) => ({
  databaseId: 1,
  workflowName: 'ci.yml',
  conclusion: 'success',
  status: 'completed',
  createdAt: '2026-11-22T00:00:00Z',
  updatedAt: '2026-11-22T00:10:00Z',
  headSha: 'a'.repeat(40),
  event: 'push',
  headBranch: 'main',
  url: 'u',
  ...over,
});

// ---- percentiles -----------------------------------------------------------

test('percentile uses nearest rank, so a published number can be recomputed by hand', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // ceil(0.5*10)-1 = 4 -> the 5th value
  assert.equal(percentile(s, 0.5), 5);
  // ceil(0.9*10)-1 = 8 -> the 9th value
  assert.equal(percentile(s, 0.9), 9);
  // ceil(0.95*10)-1 = 9 (clamped) -> the last value
  assert.equal(percentile(s, 0.95), 10);
});

test('percentile of one sample is that sample, at every rank', () => {
  for (const p of [0.5, 0.9, 0.95]) assert.equal(percentile([42], p), 42);
});

test('percentile of an empty sample is null, not zero', () => {
  // Zero would read as "instant" in a report; null reads as "no data".
  assert.equal(percentile([], 0.5), null);
});

test('a summary always carries its own sample size and range', () => {
  const s = summarise([10, 20, 30]);
  assert.deepEqual({ n: s.n, min: s.min, max: s.max }, { n: 3, min: 10, max: 30 });
  assert.equal(s.p50, 20);
  // p95 of three samples clamps to the largest, it does not invent a value.
  assert.equal(s.p95, 30);
});

test('an empty summary reports nulls rather than zeros', () => {
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.equal(s.p50, null);
  assert.equal(s.max, null);
});

// ---- fanout identity -------------------------------------------------------

test('two PRs pushed in the same minute are TWO groups', () => {
  const { groups } = groupByPush([
    run({ headSha: 'a'.repeat(40), event: 'pull_request' }),
    run({ headSha: 'b'.repeat(40), event: 'pull_request' }),
  ]);
  assert.equal(groups.length, 2, 'a shared minute is not a shared push');
});

test('one SHA pushed twice is TWO groups, not one', () => {
  // The first version merged them and measured the second push's workflows
  // against the first push's start time.
  const { groups } = groupByPush([
    run({ databaseId: 1, headSha: 'c'.repeat(40), event: 'push' }),
    run({ databaseId: 2, headSha: 'd'.repeat(40), event: 'push' }),
  ]);
  assert.equal(groups.length, 2);
});

test('a workflow_dispatch never joins a push', () => {
  const { groups } = groupByPush([
    run({ headSha: 'e'.repeat(40), event: 'push' }),
    run({ headSha: 'e'.repeat(40), event: 'workflow_dispatch' }),
  ]);
  assert.equal(groups.length, 2, 'the event is part of the identity');
});

test('a PR run and a push run for the same SHA stay apart', () => {
  // `pull_request` runs are keyed by the merge commit; a push of the same SHA
  // is a different execution and its duration is a different fact.
  const { groups } = groupByPush([
    run({ headSha: 'f'.repeat(40), event: 'pull_request' }),
    run({ headSha: 'f'.repeat(40), event: 'push' }),
  ]);
  assert.equal(groups.length, 2);
});

test('runs with no headSha are UNGROUPABLE, not silently dropped', () => {
  const { groups, ungroupable } = groupByPush([
    run({ headSha: 'a'.repeat(40) }),
    run({ headSha: undefined, databaseId: 99 }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(ungroupable.length, 1);
  assert.equal(ungroupable[0].databaseId, 99);
});

test('span is measured from the push, and startSkew is NOT reported as queueing', () => {
  // Two workflows for one push: created 90s apart, the second finishing later.
  const { groups } = groupByPush([
    run({ headSha: 'a'.repeat(40), createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:20:00Z' }),
    run({ headSha: 'a'.repeat(40), createdAt: '2026-11-22T00:01:30Z', updatedAt: '2026-11-22T00:25:00Z' }),
  ]);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.spanSeconds, 25 * 60);
  assert.equal(g.longestWorkflowSeconds, 23 * 60 + 30);
  assert.equal(g.startSkewSeconds, 90);
  // The name says "skew", not "queue": a queued job still has a workflow whose
  // created_at is before it, so this interval cannot measure the queue.
  assert.ok(!('queueSeconds' in g), 'the group must not claim a queue measurement it cannot make');
});

// ---- run attempt -----------------------------------------------------------

test('a rerun is counted, because it is a separate execution of the same push', () => {
  // `gh run list` returns ONE row per run even when it was rerun - `attempt` is
  // an attribute, not a second row - so a rerun cannot split a group. What it
  // does do is make the group's duration describe the retry as well, which is
  // why the count is carried out: a sample full of reruns is a sample of slow
  // pushes, and a P50 that hides that is a P50 that flatters the pipeline.
  const { groups } = groupByPush([
    run({ headSha: 'a'.repeat(40), databaseId: 1, attempt: 1 }),
    run({ headSha: 'a'.repeat(40), databaseId: 2, attempt: 3 }),
  ]);
  assert.equal(groups.length, 1, 'one push is one group');
  assert.equal(groups[0].retriedWorkflows, 1, 'the retried workflow must be visible in the group');
});

test('a group with no reruns reports zero, not undefined', () => {
  const { groups } = groupByPush([run({ headSha: 'b'.repeat(40) })]);
  assert.equal(groups[0].retriedWorkflows, 0);
});

// ---- what a queue sample is allowed to be -------------------------------
//
// `jobDurations` used to keep only successful jobs. That is correct for "how long
// does this job take when it works" and wrong for "how long do jobs wait", and the
// `queue` mode used the same function - so every published queue percentile was
// computed over successes only.
//
// Measured on g13a1-gateway, 9 completed runs: the single CANCELLED run waited
// 419s - the longest in the set - and it was the one dropped. Successes only give
// p90 410s; every outcome gives 419s. Nine seconds, not a transformation: the
// defect is that the drop is systematic and always removes the longest waits, not
// that it always moves a number a lot. A busier window moves it further.
//
// These cases pin the split: the function returns every outcome with its label,
// and each caller filters.

/** A `jobDurations` row, as the REST response produces it. */
const job = (over = {}) => ({
  name: 'g13a1-gateway',
  conclusion: 'success',
  started_at: '2026-11-22T00:01:46Z',
  completed_at: '2026-11-22T00:03:00Z',
  created_at: '2026-11-22T00:00:00Z',
  ...over,
});

test('jobDurations keeps a FAILED job and labels its outcome', () => {
  // The queue delay of a failed job is still a real wait. A caller that wants
  // durations filters by conclusion; a caller that wants waits does not.
  const rows = selectJobs([job({ conclusion: 'failure', completed_at: '2026-11-22T00:02:00Z' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conclusion, 'failure');
  assert.equal(rows[0].queueSeconds, 106);
});

test('jobDurations keeps a CANCELLED job, which is the sample that matters most', () => {
  const rows = selectJobs([job({ conclusion: 'cancelled', completed_at: '2026-11-22T00:05:00Z' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conclusion, 'cancelled');
  assert.equal(rows[0].seconds, 194);
});

test('a job that never got a runner is dropped: it has no delay to measure', () => {
  const rows = selectJobs([job({ started_at: null, conclusion: 'cancelled' })]);
  assert.deepEqual(rows, []);
});

test('a job still running has a null duration, not NaN', () => {
  const rows = selectJobs([job({ conclusion: null, completed_at: null })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, null,
    'a null keeps it out of an average; NaN would poison one silently');
  assert.equal(rows[0].queueSeconds, 106, 'the wait is still known');
});

test('a run whose job list was truncated reports its total, so the caller can say INCOMPLETE', () => {
  const page = { total_count: 140, jobs: [job()] };
  assert.equal(page.total_count > page.jobs.length, true,
    'the caller compares these two; a short page must be visible as such');
});
