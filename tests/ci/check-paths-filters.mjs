#!/usr/bin/env node
/**
 * Every `pull_request.paths` entry must name something that exists. TASK-23/32.
 *
 * WHY THIS IS NEEDED BEFORE ANY DIRECTORY MOVE
 *
 * A paths filter that names a deleted file fails SILENTLY. GitHub does not warn
 * about a filter matching nothing - the workflow simply never runs, no check is
 * produced, and `ci-gate` reports `delegated-absent` far from the cause. The
 * inverse is worse: move a file and forget its filter entry, and the workflow
 * stops running for the change it exists to cover, with nothing red anywhere.
 *
 * `check-path-integrity.mjs` reads `run:` lines. It does not read `paths:` -
 * a filter entry is not an invocation, so it never appeared there. This checks
 * the other half.
 *
 * WHAT IT ACCEPTS
 *
 * A literal path, a `dir/**` prefix, and `*` within one segment. GitHub also
 * supports `!` negations; those are checked for their positive part only,
 * because a negated non-existent path is a no-op rather than a fault.
 *
 * Usage: node tests/ci/check-paths-filters.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * THE AUTHORITY IS THE GIT INDEX, NOT THE WORKING TREE.
 *
 * The first version walked the filesystem. That is wrong in both directions:
 *
 *   - a stale local file (an untracked screenshot, a build output) matches a
 *     filter whose file was deleted from the repository, so a DEAD filter looks
 *     alive on the machine where it is being checked;
 *   - a directory that exists but holds no tracked file satisfies `dir/**`, so
 *     moving every file out of a directory leaves the filter passing.
 *
 * `git ls-files` answers the question the filter actually asks: "will this
 * change be part of a push". It is also stable under a fresh clone, which is
 * where CI runs.
 *
 * Directories that contain at least one tracked file are derived from the file
 * list; a directory with no tracked file does not exist for this purpose.
 */
const FILES = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const DIRS = new Set();
for (const f of FILES) {
  const parts = f.split('/');
  for (let i = 1; i < parts.length; i += 1) DIRS.add(parts.slice(0, i).join('/'));
}

/** Does a filter pattern match at least one path in the tree? */
export function matchesAnything(pattern, files) {
  const negated = pattern.startsWith('!');
  const p = negated ? pattern.slice(1) : pattern;

  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3);
    // The PREFIX ITSELF must exist: `scripts/gone/**` matches nothing when
    // `scripts/gone/` was moved, even though the glob is syntactically fine.
    // A directory counts only if it holds tracked files. `existsSync` accepted
    // an empty leftover directory, which is exactly the state after a move.
    return files.some((f) => f.startsWith(prefix + '/'));
  }
  if (p.includes('*')) {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`);
    return files.some((f) => re.test(f));
  }
  // A literal path counts only if it is a tracked file or a directory that
  // holds tracked files. An untracked leftover on this machine must not make a
  // dead filter look alive.
  return files.includes(p) || DIRS.has(p);
}

/** Every `paths:` entry in a workflow file. */
export function pathsEntries(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*paths:\s*$/.test(lines[i])) continue;
    // The block is the following lines indented deeper than `paths:`.
    const indent = lines[i].match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) continue;
      const thisIndent = line.match(/^\s*/)[0].length;
      if (thisIndent <= indent) break;
      const m = /^\s*-\s*'?([^'#]+?)'?\s*(?:#.*)?$/.exec(line);
      if (m) out.push({ pattern: m[1].trim(), line: j + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const problems = [];
  let checked = 0;
  const wfDir = join(ROOT, '.github/workflows');
  for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(wfDir, name), 'utf8');
    for (const { pattern, line } of pathsEntries(text)) {
      checked += 1;
      const positive = pattern.startsWith('!') ? pattern.slice(1) : pattern;
      if (matchesAnything(pattern, FILES)) continue;
      problems.push(`${name}:${line}  paths entry matches nothing in the tree: ${positive}`);
    }
  }
  if (checked === 0) {
    // Fail closed: a parse that found nothing must not read as "all fine".
    process.stderr.write('no paths entries were parsed; the checker is not reading the workflows\n');
    process.exit(2);
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ problems, checked }, null, 2)}\n`);
  } else {
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    process.stdout.write(`paths filters: ${problems.length} problem(s) across ${checked} entries\n`);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}
