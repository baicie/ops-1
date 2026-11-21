#!/usr/bin/env node
/**
 * The standards live in `docs/standards/`, and nothing may point at the old
 * `rules/` directory. Part of TASK-03.
 *
 * WHY A DEDICATED CHECK WHEN check-path-integrity.mjs ALREADY EXISTS
 *
 * Path integrity answers "does the path resolve". It cannot answer the three
 * questions this migration actually turns on:
 *
 *   1. Is every rule file listed in `docs/standards/README.md`? A rule an agent
 *      cannot find is a rule that does not apply, and the file resolving is not
 *      evidence that anyone can reach it.
 *   2. Do `AGENTS.md` and `CONTRIBUTING.md` - the two documents a contributor
 *      reads before anything else - name the current location?
 *   3. Is a stale `rules/` directory left behind? That is the outcome TASK-03
 *      forbids by name: two copies that drift apart.
 *
 * Usage: node tests/ci/check-standards-location.mjs [--json]
 * Exit 0 when the layout is consistent, 1 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} root repository root
 * @returns {string[]} problems; empty means consistent
 */
export function inspectStandards(root) {
  const problems = [];
  const standardsDir = join(root, 'docs/standards');

  if (!existsSync(standardsDir)) {
    return ['docs/standards/ does not exist; the rule files have no home'];
  }

  // (3) The old directory must be gone. A copy is worse than a move that was
  // never done: two files, one name, and no way to tell which is authoritative.
  if (existsSync(join(root, 'rules'))) {
    problems.push('rules/ still exists; the standards were moved to docs/standards/ and a '
      + 'second copy will drift (docs/standards/11-refactor-retirement-and-cleanup.md)');
  }

  // (1) Every rule file must be reachable from the index.
  const index = join(standardsDir, 'README.md');
  if (!existsSync(index)) {
    problems.push('docs/standards/README.md is missing; there is no index');
  } else {
    const text = readFileSync(index, 'utf8');
    for (const name of readdirSync(standardsDir)) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      if (!text.includes(name)) {
        problems.push(`docs/standards/${name} is not listed in docs/standards/README.md; `
          + 'a rule an agent cannot find is not a rule');
      }
    }
  }

  // (2) The two entry documents must name the current location.
  for (const entry of ['AGENTS.md', 'CONTRIBUTING.md']) {
    const path = join(root, entry);
    if (!existsSync(path)) continue; // its absence is another checker's finding
    const text = readFileSync(path, 'utf8');
    // `quality-rules/` and `code-rules/` are real paths in this repository, so
    // a bare substring search for `rules/` is wrong. The forms that actually
    // mean "the standards directory" are these.
    if (/`rules\/`|\(rules\/\)|rules\/\d\d-/.test(text)) {
      problems.push(`${entry} still points at rules/; the standards moved to docs/standards/`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const root = process.cwd();
  const problems = inspectStandards(root);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ problems }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    const count = readdirSync(join(root, 'docs/standards')).filter((n) => n.endsWith('.md')).length;
    process.stdout.write(`standards location: ${problems.length} problem(s); ${count} files indexed\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
