#!/usr/bin/env node
/**
 * Retired paths: zero live references. See rules/11-refactor-retirement-and-cleanup.md.
 *
 * Why this exists. `apps/platform-web` was deleted in G14.2 and eight executables kept
 * naming it. None of them failed loudly:
 *
 *   - `pnpm --filter @opsweave/platform-web build` prints "No projects matched the
 *     filters" and exits 0, so four harnesses built zero bundles and went green.
 *   - `X="$(grep -rn ... apps/platform-web/src | wc -l)"` under `set -euo pipefail`
 *     kills the script AT THE ASSIGNMENT, so the assertion after it never ran and the
 *     step reported neither pass nor fail.
 *
 * A migration that leaves references behind does not break the build; it turns gates
 * off. This check is the cheap way to notice, and it fails closed: every scan root
 * must exist, and the number of files scanned is printed so "OK" cannot mean "I read
 * nothing".
 *
 * Historical records are excluded on purpose, not by accident: docs/design/**,
 * artifacts/** and docs/IMPLEMENTATION_STATUS.md are dated evidence of what was true
 * then. Rewriting them to the current path would be falsifying the record.
 *
 * Usage: node tests/ci/check-retired-paths.mjs [--json]
 * Exit 0 when no live file names a retired identifier, 1 otherwise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** Retired identifiers and, for a reader who finds a hit, what replaced them. */
const RETIRED = new Map([
  ['apps/platform-web', 'apps/platform-console + apps/ops-web (commit 461d4da / ADR-022)'],
  ['@opsweave/platform-web', '@opsweave/platform-console or @opsweave/ops-web'],
]);

/**
 * Where a live reference must not appear: everything that runs, plus the documents
 * that claim what the tree is TODAY.
 */
const LIVE_ROOTS = [
  'apps',
  'packages',
  'plugins',
  'tests',
  'scripts',
  '.github',
  'deployments',
  'contracts',
  'crates',
  'rules',
];
const LIVE_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'Makefile',
  'package.json',
  'pnpm-workspace.yaml',
  'docs/API.md',
  'docs/RUNBOOK.md',
];

/** Dated evidence and design records: a hit here is history, not drift. */
const HISTORICAL = [
  'docs/design',
  'docs/acceptance',
  'docs/IMPLEMENTATION_STATUS.md',
  'docs/adr',
  'artifacts',
  'node_modules',
  'target',
  'dist',
  '.git',
  '.blueprint',
  'test-results',
];

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.sh', '.yml', '.yaml',
  '.json', '.toml', '.md', '.rs', '.py', '.css',
]);

const isHistorical = (rel) =>
  HISTORICAL.some((prefix) => rel === prefix || rel.startsWith(prefix + sep));

/**
 * The gate and its counterfactual suite name the retired identifiers by
 * definition; they cannot also be violations of it. The sibling test file is
 * exempted by the same rule and for the same reason - it declares the identifier
 * once (`const RETIRED`) and builds every case around it. Missing it made the gate
 * fail on itself the first time its own tests were added to the tree.
 */
const SELF = new Set([
  'tests/ci/check-retired-paths.mjs',
  'tests/ci/check-retired-paths.test.mjs',
]);

/**
 * Files with no extension are the ones a deployment depends on most - a
 * `Dockerfile` IS the build - and a suffix allow-list skipped every one of them.
 * That is not hypothetical: `deployments/staging/Dockerfile` kept building the
 * deleted `apps/platform-web` through the whole G14.2 review, and this scanner
 * reported zero references the whole time. Named exceptions, not "read
 * everything": a binary with no suffix must not be pulled into a text scan.
 */
const EXTENSIONLESS = new Set(['Dockerfile', 'Makefile', 'Procfile', 'Jenkinsfile']);

const isText = (name) => {
  if (EXTENSIONLESS.has(name)) return true;
  if (name.startsWith('Dockerfile.')) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && EXTENSIONS.has(name.slice(dot));
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(ROOT, path);
    if (isHistorical(rel)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && isText(entry.name)) out.push(path);
  }
  return out;
}

// --- fail closed on a root that vanished -------------------------------------
const missing = [...LIVE_ROOTS, ...LIVE_FILES].filter((entry) => !statSync(join(ROOT, entry), { throwIfNoEntry: false }));
if (missing.length > 0) {
  console.error('check-retired-paths: these live roots/files are missing, so they were NOT scanned:');
  for (const entry of missing) console.error('  ' + entry);
  console.error('A missing scan root must fail: otherwise a rename silently removes it from the check.');
  process.exit(1);
}

// --- scan --------------------------------------------------------------------
const files = [
  ...LIVE_ROOTS.flatMap((root) => {
    const abs = join(ROOT, root);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  }),
  ...LIVE_FILES.map((file) => join(ROOT, file)),
];

const violations = [];
let scanned = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const rel = relative(ROOT, file).split(sep).join('/');
  if (SELF.has(rel)) continue;
  for (const [needle, replacement] of RETIRED) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes(needle)) return;
      violations.push({ file: rel, line: index + 1, needle, replacement, text: line.trim() });
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned, violations }, null, 2));
} else if (violations.length === 0) {
  console.log(`check-retired-paths: ${scanned} live files scanned, 0 references to ${RETIRED.size} retired identifiers`);
} else {
  console.error(`check-retired-paths: ${violations.length} live reference(s) to retired identifiers:`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.needle} -> ${v.replacement}`);
    console.error(`      ${v.text}`);
  }
  console.error('\nFix each reference, or - if it is a dated record - move it under docs/design, artifacts,');
  console.error('docs/acceptance or docs/adr, which this check treats as history (rules/11).');
}

// A scan that read nothing proves nothing: the same rule as a missing root.
if (scanned === 0) {
  console.error('check-retired-paths: scanned 0 files; a vacuous pass is a failure');
  process.exit(1);
}

process.exit(violations.length === 0 ? 0 : 1);
