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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (['node_modules', 'target', 'dist', '.git', '.blueprint', 'test-results', 'artifacts'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = walk(ROOT).map((f) => relative(ROOT, f));

/** Does a filter pattern match at least one path in the tree? */
export function matchesAnything(pattern, files) {
  const negated = pattern.startsWith('!');
  const p = negated ? pattern.slice(1) : pattern;

  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3);
    // The PREFIX ITSELF must exist: `scripts/gone/**` matches nothing when
    // `scripts/gone/` was moved, even though the glob is syntactically fine.
    if (files.some((f) => f.startsWith(prefix + '/'))) return true;
    // A directory may exist and be empty of tracked files; accept it then.
    return existsSync(join(ROOT, prefix));
  }
  if (p.includes('*')) {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`);
    return files.some((f) => re.test(f));
  }
  return files.includes(p) || existsSync(join(ROOT, p));
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
