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
import { percentile, summarise, groupByPush } from './ci-cost.mjs';

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
