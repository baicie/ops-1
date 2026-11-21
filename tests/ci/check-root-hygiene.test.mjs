#!/usr/bin/env node
/**
 * Self-test for the root hygiene guard. Part of TASK-12.
 *
 * Each case breaks one rule in memory and asserts the guard reports it. A guard
 * whose counterfactuals pass is decoration - and this one is the easiest to
 * leave vacuous, because `inspectRoot` takes an array and a mistake in the
 * argument shape makes every case pass.
 *
 * The final case runs the real tree: the rules are only worth having if the
 * repository they ship with satisfies them.
 *
 * Usage: node tests/ci/check-root-hygiene.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRoot } from './check-root-hygiene.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('a clean tree passes', () => {
  const { problems } = inspectRoot(['apps/a', 'docs/b', '.gitignore']);
  assert.deepEqual(problems, []);
});

test('an unapproved top-level directory is reported with what to do', () => {
  const { problems } = inspectRoot(['apps/a', 'newthing/b']);
  assert.ok(problems.some((p) => /unapproved top-level dir: newthing/.test(p)),
    `expected newthing to be named, got ${JSON.stringify(problems)}`);
  // The message has to say HOW to approve it, or the next person deletes the
  // directory instead of deciding whether it belongs.
  assert.ok(problems.some((p) => /add it to APPROVED_DIRS/.test(p)),
    'the finding must name the mechanism, not just the fault');
});

test('an unapproved root file is reported', () => {
  const { problems } = inspectRoot(['apps/a', 'notes.txt']);
  assert.ok(problems.some((p) => /unapproved top-level file: notes\.txt/.test(p)));
});

test('tracked build output is reported, with the rule that covers it', () => {
  const { problems } = inspectRoot(['apps/a', 'plugins/hello-go/hello-go']);
  assert.ok(problems.some((p) => /build output is tracked/.test(p)));
  assert.ok(problems.some((p) => /\.gitignore line 22/.test(p)),
    'the finding should say which ignore rule should have caught it');
});

test('an editor leftover is reported', () => {
  const { problems } = inspectRoot(['apps/a', 'src/x.ts.bak']);
  assert.ok(problems.some((p) => /leftover is tracked/.test(p)));
});

test('a second top-level lockfile is reported', () => {
  const { problems } = inspectRoot(['Cargo.lock', 'package-lock.json', 'pnpm-lock.yaml', 'apps/a']);
  assert.ok(problems.some((p) => /more than one lockfile/.test(p)));
});

test('the real repository satisfies it', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(tracked.length > 100, 'the scan must be reading the real index');
  assert.deepEqual(inspectRoot(tracked).problems, []);
});
