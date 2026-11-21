#!/usr/bin/env node
/**
 * Root hygiene: the top level stays legible. TASK-12.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE HAS FAILED SOMEWHERE BEFORE
 *
 *   1. Every tracked top-level entry is on the approved list. `rules/` was an
 *      approved entry until 2026-11-21 and moved to `docs/standards/`; the list
 *      below is the current answer, and adding to it is a deliberate edit that
 *      shows up in review.
 *   2. No build output is tracked. `plugins/hello-go/hello-go` (a 10 MB host
 *      binary) reached the index once through `git add -A`; `.gitignore` has
 *      carried a rule for it since.
 *   3. No second lockfile. Two lockfiles in one workspace means one of them is
 *      stale, and nobody can tell which by looking.
 *   4. No editor or OS droppings, no `.bak`/`.orig`/`.rej` files.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not refuse new directories. A project that cannot add a top-level
 * directory is a project that will put the new thing somewhere worse. Instead
 * an unapproved entry is reported with what to do about it - add it here with a
 * one-line reason, and that edit is the review moment.
 *
 * Usage: node tests/ci/check-root-hygiene.mjs [--json]
 */
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();

/**
 * The approved top level, with the reason each one exists.
 *
 * A directory earns its place by owning something no other directory can: the
 * application entry points (`apps`), the shared library surface (`crates`,
 * `packages`), the plugin implementations (`plugins`), the contracts, the
 * tooling, the tests, and the documentation that describes all of it.
 */
export const APPROVED_DIRS = new Map([
  ['.claude', 'agent configuration; artifacts/ under it is ignored'],
  ['.github', 'workflows and Actions configuration'],
  ['apps', 'deployable entry points: kernel, node, opsctl, pipeline-worker, web apps'],
  ['artifacts', 'tracked visual evidence, budget-guarded by check-tracked-png-budget'],
  ['contracts', 'the source of truth for every cross-boundary protocol'],
  ['crates', 'shared Rust libraries'],
  ['deployments', 'compose files and the staging Dockerfile'],
  ['docs', 'documentation, ADRs, standards, and the blueprint package'],
  ['packages', 'shared TypeScript packages'],
  ['plugins', 'plugin implementations, one directory each'],
  ['scripts', 'operator and CI tooling; see scripts/README.md for the grouping'],
  ['tests', 'acceptance, ci, ui, contract, reliability and script tests'],
]);

/** Root files that are allowed, by name. */
export const APPROVED_FILES = new Set([
  '.dockerignore', '.env.example', '.gitignore',
  'AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'Cargo.toml', 'Cargo.lock', 'Makefile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
]);

/** Suffixes that are never a source file. */
const DROPPINGS = /\.(bak|orig|rej|swp|swo)$|^\.DS_Store$|~$/;

/**
 * @param {string[]} tracked `git ls-files` output
 * @returns {{problems: string[], topLevel: {name: string, kind: string}[]}}
 */
export function inspectRoot(tracked) {
  const problems = [];
  const topLevel = new Map();
  for (const path of tracked) {
    if (!path) continue;
    const first = path.split('/')[0];
    const isDir = path.includes('/');
    if (!topLevel.has(first)) topLevel.set(first, isDir ? 'dir' : 'file');
  }

  for (const [name, kind] of topLevel) {
    const approved = kind === 'dir' ? APPROVED_DIRS.has(name) : APPROVED_FILES.has(name);
    if (!approved) {
      problems.push(`unapproved top-level ${kind}: ${name} - add it to APPROVED_${kind === 'dir' ? 'DIRS' : 'FILES'} in tests/ci/check-root-hygiene.mjs with a one-line reason for why it owns something no other directory can`);
    }
  }

  // Build output that reached the index. The known offenders are named so the
  // message can say what happened rather than only that something is wrong.
  const BUILD_OUTPUT = [
    [/^plugins\/hello-go\/hello-go$/, 'host-native Go binary; .gitignore line 22 covers it'],
    [/^plugins\/hello-go\/hello-go-linux$/, 'Linux Go binary; .gitignore line 18 covers it'],
    [/^plugins\/hello-java\/target\//, 'Maven output; .gitignore line 23 covers it'],
    [/^plugins\/hello-java\/jre\//, 'jlink output; .gitignore line 17 covers it'],
    [/^target\//, 'cargo output'],
    [/^node_modules\//, 'installed dependencies'],
    [/^dist\//, 'build output'],
  ];
  for (const path of tracked) {
    for (const [re, why] of BUILD_OUTPUT) {
      if (re.test(path)) problems.push(`build output is tracked: ${path} (${why})`);
    }
    if (DROPPINGS.test(path.split('/').pop())) {
      problems.push(`editor or OS leftover is tracked: ${path}`);
    }
  }

  // One lockfile per ecosystem.
  const locks = tracked.filter((p) => !p.includes('/') && /lock/i.test(p.split('/').pop()));
  if (locks.length > 2) {
    problems.push(`more than one lockfile per ecosystem: ${locks.join(', ')}`);
  }

  return {
    problems,
    topLevel: [...topLevel].map(([name, kind]) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (tracked.length === 0) {
    process.stderr.write('git ls-files returned nothing; not a repository, or an empty index\n');
    process.exit(2);
  }
  const { problems, topLevel } = inspectRoot(tracked);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ problems, topLevel }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    const dirs = topLevel.filter((e) => e.kind === 'dir').length;
    process.stdout.write(`root hygiene: ${problems.length} problem(s); ${topLevel.length} top-level entries`
      + ` (${dirs} directories) across ${tracked.length} tracked files\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
