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

test('two root lockfiles for the same ecosystem are reported', () => {
  // npm and yarn are both "a node resolution". Having both at the root means one
  // of them is stale, and nobody can tell which by looking.
  const { problems } = inspectRoot(['Cargo.lock', 'pnpm-lock.yaml', 'yarn.lock',
    'package.json', 'pnpm-workspace.yaml', 'apps/a']);
  assert.ok(problems.some((p) => /two root lockfiles for node/.test(p)),
    `expected the conflicting node lockfiles to be named, got ${JSON.stringify(problems)}`);
});

test('Cargo.lock plus pnpm-lock.yaml alone is NOT a duplicate', () => {
  // Different ecosystems, one lockfile each: the normal monorepo shape.
  const { problems } = inspectRoot(['Cargo.lock', 'pnpm-lock.yaml', 'Cargo.toml',
    'package.json', 'pnpm-workspace.yaml', 'apps/a']);
  assert.ok(!problems.some((p) => /lockfile/.test(p)), JSON.stringify(problems));
});

test('a plugin with its own package.json and package-lock.json is legitimate', () => {
  // `plugins/*/backend` are three separate npm projects, each built by its own
  // Dockerfile. Calling them "duplicate lockfiles" would be a false finding on
  // correct structure.
  const { problems } = inspectRoot([
    'Cargo.lock', 'pnpm-lock.yaml', 'Cargo.toml', 'package.json', 'pnpm-workspace.yaml',
    'apps/a',
    'plugins/x/backend/package.json', 'plugins/x/backend/package-lock.json',
  ]);
  assert.ok(!problems.some((p) => /lockfile/.test(p)), JSON.stringify(problems));
});

test('a nested lockfile with no package.json beside it is reported', () => {
  const { problems } = inspectRoot([
    'Cargo.lock', 'pnpm-lock.yaml', 'Cargo.toml', 'package.json', 'pnpm-workspace.yaml',
    'apps/a', 'plugins/x/backend/package-lock.json',
  ]);
  assert.ok(problems.some((p) => /no package.json beside it/.test(p)),
    `expected the stray lockfile to be named, got ${JSON.stringify(problems)}`);
});

test('a directory with both npm and pnpm lockfiles is reported', () => {
  const { problems } = inspectRoot([
    'Cargo.lock', 'pnpm-lock.yaml', 'Cargo.toml', 'package.json', 'pnpm-workspace.yaml',
    'apps/a', 'plugins/x/backend/package.json',
    'plugins/x/backend/package-lock.json', 'plugins/x/backend/pnpm-lock.yaml',
  ]);
  assert.ok(problems.some((p) => /one resolution per directory/.test(p)),
    `expected the double resolution to be named, got ${JSON.stringify(problems)}`);
});

test('the real repository satisfies it', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(tracked.length > 100, 'the scan must be reading the real index');
  assert.deepEqual(inspectRoot(tracked).problems, []);
});
