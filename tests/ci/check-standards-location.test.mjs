#!/usr/bin/env node
/**
 * Self-test for the standards-location guard. Part of TASK-03.
 *
 * WHY THIS EXISTS SEPARATELY FROM check-path-integrity.mjs
 *
 * That checker answers "does every referenced path exist". It cannot see the
 * thing this migration most needs to prevent: a rule file whose index entry
 * says one thing while the file's own content still describes the OLD layout.
 * After moving `rules/` to `docs/standards/`, three failure modes are possible
 * and none of them fails a build:
 *
 *   1. a rule file is missing from `docs/standards/README.md`, so an agent
 *      reading the index never learns the rule exists;
 *   2. `AGENTS.md` and `CONTRIBUTING.md` still point at `rules/`, so the two
 *      documents a contributor reads FIRST are wrong;
 *   3. a stale `rules/` directory is left behind with a copy, and the two
 *      copies drift - exactly the outcome TASK-03 forbids.
 *
 * Each case below breaks one of them in a temp tree and asserts the check
 * goes red. A guard whose counterfactual passes is not a guard.
 *
 * Usage: node tests/ci/check-standards-location.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectStandards } from './check-standards-location.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A minimal tree that `inspectStandards` accepts. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'standards-location-'));
  mkdirSync(join(root, 'docs/standards'), { recursive: true });
  const rules = ['01-architecture.md', '02-plugin-runtime.md', '03-security.md'];
  for (const name of rules) {
    writeFileSync(join(root, 'docs/standards', name), `# ${name}\n`);
  }
  writeFileSync(join(root, 'docs/standards/README.md'),
    `# Standards\n\n${rules.map((n) => `- \`${n}\``).join('\n')}\n`);
  writeFileSync(join(root, 'AGENTS.md'), 'Read `docs/standards/` first.\n');
  writeFileSync(join(root, 'CONTRIBUTING.md'), 'Read `docs/standards/` first.\n');
  return root;
}

test('a complete, consistent tree passes', () => {
  const root = fixture();
  try {
    assert.deepEqual(inspectStandards(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rule file missing from the index is reported', () => {
  // Counterfactual for mode 1: a rule nobody can find is not a rule.
  const root = fixture();
  try {
    writeFileSync(join(root, 'docs/standards/README.md'), '# Standards\n\n- `01-architecture.md`\n');
    const problems = inspectStandards(root);
    assert.ok(problems.some((p) => p.includes('02-plugin-runtime.md')),
      `expected the unindexed rule to be named, got ${JSON.stringify(problems)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AGENTS.md pointing at the old location is reported', () => {
  // Counterfactual for mode 2.
  const root = fixture();
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'Read `rules/` first.\n');
    const problems = inspectStandards(root);
    assert.ok(problems.some((p) => p.includes('AGENTS.md')),
      `expected AGENTS.md to be named, got ${JSON.stringify(problems)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a leftover rules/ directory with copies is reported', () => {
  // Counterfactual for mode 3: the forbidden outcome.
  const root = fixture();
  try {
    mkdirSync(join(root, 'rules'));
    writeFileSync(join(root, 'rules/01-architecture.md'), '# copy\n');
    const problems = inspectStandards(root);
    assert.ok(problems.some((p) => p.includes('rules/')),
      `expected the leftover directory to be named, got ${JSON.stringify(problems)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real repository satisfies it', () => {
  // The check is only worth having if the tree it ships with passes.
  assert.deepEqual(inspectStandards(ROOT), []);
});
