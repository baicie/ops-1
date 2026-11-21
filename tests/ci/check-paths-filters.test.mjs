#!/usr/bin/env node
/**
 * Self-test for the paths-filter guard. TASK-05.
 *
 * The first version walked the filesystem and used `existsSync`. Two failure
 * modes follow from that, and both are silent:
 *
 *   - a stale local file matches a filter whose file was deleted from the
 *     repository, so a DEAD filter looks alive on this machine;
 *   - a directory that exists but holds no tracked file satisfies `dir/**`, so
 *     moving every file out of it leaves the filter passing.
 *
 * These cases run `inspectTree` against synthetic file lists, so no git state
 * is involved and they cannot pass for the wrong reason.
 *
 * Usage: node --test tests/ci/check-paths-filters.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAnything, pathsEntries } from './check-paths-filters.mjs';

const TRACKED = ['scripts/a.sh', 'scripts/sub/b.sh', 'docs/x.md', 'tests/ci/c.mjs'];

test('a literal tracked path matches', () => {
  assert.equal(matchesAnything('docs/x.md', TRACKED), true);
});

test('a literal path that is NOT tracked does not match', () => {
  // Even if it exists on this machine. The filter asks about the push, not the
  // working tree.
  assert.equal(matchesAnything('docs/UNTRACKED.txt', TRACKED), false);
});

test('dir/** matches files below it', () => {
  assert.equal(matchesAnything('scripts/**', TRACKED), true);
  assert.equal(matchesAnything('scripts/sub/**', TRACKED), true);
});

test('dir/** does NOT match when the directory holds no tracked file', () => {
  // The state after every file in a directory was moved elsewhere.
  assert.equal(matchesAnything('scripts/emptied/**', TRACKED), false);
});

test('a single-segment glob matches within one level only', () => {
  assert.equal(matchesAnything('tests/ci/*.mjs', TRACKED), true);
  assert.equal(matchesAnything('tests/*.mjs', TRACKED), false, 'one level only');
});

test('a negation is checked for its positive part', () => {
  // `!docs/x.md` is a valid filter entry; it must not be reported as dead
  // merely because the string starts with `!`.
  assert.equal(matchesAnything('!docs/x.md', TRACKED), true);
});

test('a two-star glob spans directories', () => {
  assert.equal(matchesAnything('**/*.sh', TRACKED), true);
});

test('paths entries are parsed with their line numbers', () => {
  const yml = [
    'on:',
    '  pull_request:',
    '    paths:',
    "      - 'scripts/**'",
    "      - 'docs/x.md'  # a comment",
    'jobs:',
    '  a:',
  ].join('\n');
  const entries = pathsEntries(yml);
  assert.deepEqual(entries.map((e) => e.pattern), ['scripts/**', 'docs/x.md']);
  assert.deepEqual(entries.map((e) => e.line), [4, 5]);
});

test('a paths block stops at the next sibling key', () => {
  const yml = [
    '    paths:',
    "      - 'a/**'",
    '    branches:',
    "      - 'main'",
  ].join('\n');
  const entries = pathsEntries(yml);
  assert.deepEqual(entries.map((e) => e.pattern), ['a/**'],
    'the branches block must not be read as more paths');
});

test('a second paths block in the same file is found too', () => {
  // `pull_request.paths` and `push.paths` are separate blocks.
  const yml = [
    '    paths:',
    "      - 'a/**'",
    '  push:',
    '    paths:',
    "      - 'b/**'",
  ].join('\n');
  assert.deepEqual(pathsEntries(yml).map((e) => e.pattern), ['a/**', 'b/**']);
});
