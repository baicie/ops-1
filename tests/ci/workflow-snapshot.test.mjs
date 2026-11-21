#!/usr/bin/env node
/**
 * Self-test for the workflow compatibility snapshot. TASK-32.
 *
 * The tool exists so a workflow refactor can be checked against the surface it
 * must not change. A tool that silently missed a dropped `needs` would be worse
 * than none: it would license the refactor it was meant to gate.
 *
 * Usage: node --test tests/ci/workflow-snapshot.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriggers, parseConcurrency, parsePermissions, parseJobs,
  snapshotWorkflow, compare } from './workflow-snapshot.mjs';

const WF = `name: x
on:
  pull_request:
    paths:
      - 'apps/**'
      - 'docs/*.md'
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: read
jobs:
  a:
    needs: [b]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - run: node x.mjs
  b:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;

test('triggers are parsed with their path filters', () => {
  const t = parseTriggers(WF);
  assert.deepEqual(Object.keys(t), ['pull_request']);
  assert.deepEqual(t.pull_request.paths, ['apps/**', 'docs/*.md']);
});

test('an inline trigger list is understood', () => {
  const t = parseTriggers('on: [push, pull_request]\n');
  assert.deepEqual(Object.keys(t).sort(), ['pull_request', 'push']);
});

test('concurrency is parsed', () => {
  const c = parseConcurrency(WF);
  assert.match(c.group, /github\.ref/);
  assert.equal(c.cancelInProgress, 'true');
});

test('permissions are parsed as a set', () => {
  assert.deepEqual(parsePermissions(WF), ['contents: read', 'pull-requests: read']);
});

test('jobs carry needs, timeout, and their steps', () => {
  const jobs = parseJobs(WF);
  assert.deepEqual(jobs.a.needs, ['b']);
  assert.equal(jobs.a.timeout, 10);
  assert.equal(jobs.a.steps.length, 2);
  assert.deepEqual(jobs.b.needs, []);
});

test('an identical snapshot compares clean', () => {
  const s = snapshotWorkflow(WF);
  assert.deepEqual(compare({ 'x.yml': s }, { 'x.yml': snapshotWorkflow(WF) }), []);
});

test('a dropped need is reported', () => {
  // The exact mistake a refactor makes when a `needs` list is rewritten by hand.
  const a = snapshotWorkflow(WF);
  const b = snapshotWorkflow(WF.replace('    needs: [b]\n', ''));
  const diffs = compare({ 'x.yml': a }, { 'x.yml': b });
  assert.ok(diffs.some((d) => /needs changed/.test(d)), JSON.stringify(diffs));
});

test('a removed timeout is reported', () => {
  // Deleting `timeout-minutes` does not fail anything; it restores the 360-minute
  // default. That is exactly the kind of silent change this tool is for.
  const a = snapshotWorkflow(WF);
  const b = snapshotWorkflow(WF.replace('    timeout-minutes: 5\n', ''));
  const diffs = compare({ 'x.yml': a }, { 'x.yml': b });
  assert.ok(diffs.some((d) => /timeout changed/.test(d)), JSON.stringify(diffs));
});

test('a narrowed permission is reported', () => {
  const a = snapshotWorkflow(WF);
  const b = snapshotWorkflow(WF.replace('  contents: read', '  contents: none'));
  const diffs = compare({ 'x.yml': a }, { 'x.yml': b });
  assert.ok(diffs.some((d) => /permissions changed/.test(d)), JSON.stringify(diffs));
});

test('a changed trigger filter is reported', () => {
  const a = snapshotWorkflow(WF);
  const b = snapshotWorkflow(WF.replace("      - 'docs/*.md'\n", ''));
  const diffs = compare({ 'x.yml': a }, { 'x.yml': b });
  assert.ok(diffs.some((d) => /triggers changed/.test(d)), JSON.stringify(diffs));
});

test('a removed job is reported', () => {
  const a = snapshotWorkflow(WF);
  const b = snapshotWorkflow(WF.split('  b:\n')[0]);
  const diffs = compare({ 'x.yml': a }, { 'x.yml': b });
  assert.ok(diffs.some((d) => /job REMOVED/.test(d)), JSON.stringify(diffs));
});

test('a changed step command is reported, a comment is not', () => {
  const a = snapshotWorkflow(WF);
  const changedRun = snapshotWorkflow(WF.replace('- run: node x.mjs', '- run: node y.mjs'));
  assert.ok(compare({ 'x.yml': a }, { 'x.yml': changedRun }).some((d) => /steps changed/.test(d)));
  const addedComment = snapshotWorkflow(WF.replace('jobs:', '# a note\njobs:'));
  assert.deepEqual(compare({ 'x.yml': a }, { 'x.yml': addedComment }), [],
    'a comment is formatting, not surface');
});


test('a step that starts with a name is not invisible', () => {
  // Measured: folding a step into `spec-coverage` left the parser reporting the
  // original three steps, because it only recognised `- run:` and `- uses:` at
  // the start of an item. A step written as `- name: ...` followed by `run:`
  // disappeared, so the change the snapshot exists to gate went unreported.
  const wf = `name: x
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: a named step
        run: node a.mjs
      - name: another
        run: node b.mjs
`;
  const s = snapshotWorkflow(wf);
  assert.equal(s.jobs.a.steps.length, 3, JSON.stringify(s.jobs.a.steps));
  assert.equal(s.jobs.a.steps[1].run, 'node a.mjs', 'the run inside a named step must be captured');
});

test('adding a named step changes the surface', () => {
  const before = `name: x
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
`;
  const after = before + `      - name: two
        run: echo two
`;
  const diffs = compare({ 'x.yml': snapshotWorkflow(before) }, { 'x.yml': snapshotWorkflow(after) });
  assert.ok(diffs.some((d) => /steps changed/.test(d)), JSON.stringify(diffs));
});
