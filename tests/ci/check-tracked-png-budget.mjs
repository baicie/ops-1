#!/usr/bin/env node
/**
 * Guard: tracked PNGs may not grow without bound.
 *
 * V3 brief section 9: "截图不允许无上限提交 Git；仅保留精选基线，其余归档为 CI Artifact."
 *
 * The failure this exists for already happened. tests/ui/admin-polish.spec.ts names its 84
 * screenshots g08-<git rev-parse --short HEAD>-<page>-<viewport>-<theme>-<lang>.png, so every run
 * produced a fresh, never-colliding set instead of replacing the previous one. Nothing checked the
 * index, so nine runs accumulated 756 files (127.95 MB) of the same seven admin pages. This script
 * is the check that was missing. The budget lives in tests/ci/tracked-png-budget.json and covers:
 *
 *   A. a per-run artifact named by commit SHA must never be committed;
 *   B. every directory holding tracked PNGs must be listed in the manifest;
 *   C. each listed directory's file count must be within its cap, and its names must match an
 *      optional filename pattern;
 *   D. the global file-count and byte ceilings must hold;
 *   E. every *.png a markdown file points at must still be tracked by git - a screenshot a document
 *      cites is an evidence link, so deleting it silently breaks the document. "Tracked", not "present
 *      on disk": see the comment above the alive set for the run that made the two disagree.
 *
 * Usage:
 *   node tests/ci/check-tracked-png-budget.mjs                  # check, exit 1 on violation
 *   node tests/ci/check-tracked-png-budget.mjs --print-manifest # print fresh ceilings
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const MANIFEST = 'tests/ci/tracked-png-budget.json';
// A 7-character lowercase hex token on a name boundary is git's abbreviated-SHA shape. If a
// screenshot's own name carries one, that name identifies a single run, so committing it makes the
// next run write a second copy instead of replacing the first.
const PER_RUN_NAME = /(^|[-_.])[0-9a-f]{7}(?=[-_.]|$)/;
const PNG_REF = /[A-Za-z0-9._][A-Za-z0-9._/-]*\.png/g;
const MD_ROOTS = ['docs', 'rules', 'skills', 'plan', 'tests', 'apps'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '.venv', '__pycache__']);

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'));

const tracked = execFileSync('git', ['ls-files', '-z', '*.png'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 << 20,
})
  .split('\0')
  .filter(Boolean);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md') || e.name.endsWith('.png')) out.push(p);
  }
  return out;
}

// ---- collect ---------------------------------------------------------------------------------
const files = []; // index entries that still have bytes on disk
const indexOnly = []; // index entries whose working-tree file is gone (an uncommitted deletion)
for (const rel of tracked) {
  const abs = path.join(root, rel);
  if (existsSync(abs)) files.push({ rel, size: statSync(abs).size });
  else indexOnly.push(rel);
}

const violations = [];
const fail = (check, message) => violations.push({ check, message });

// ---- A: per-run artifacts --------------------------------------------------------------------
for (const f of files) {
  if (!f.rel.startsWith('artifacts/')) continue;
  if (PER_RUN_NAME.test(path.posix.basename(f.rel))) {
    fail(
      'A per-run artifact',
      f.rel +
        ' is named by a commit SHA, so the next run writes a second copy instead of replacing this one. ' +
        'Upload it as a workflow artifact (.github/workflows/staging-preview.yml, "Upload smoke evidence") ' +
        'and remove it from the index.',
    );
  }
}

// ---- B + C: directory allowlist and per-directory caps ---------------------------------------
const byDir = new Map();
for (const f of files) {
  const dir = path.posix.dirname(f.rel);
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(f);
}
for (const entry of [...byDir.entries()].sort()) {
  const dir = entry[0];
  const entries = entry[1];
  const rule = manifest.directories[dir];
  if (!rule) {
    fail(
      'B unknown directory',
      dir +
        ' holds ' +
        entries.length +
        ' tracked PNG but is not listed in ' +
        MANIFEST +
        '. Add it with an explicit maxFiles (plus a filename pattern if it holds one bucket of screenshots).',
    );
    continue;
  }
  if (entries.length > rule.maxFiles) {
    fail(
      'C directory over budget',
      dir +
        ' tracks ' +
        entries.length +
        ' PNG, cap is ' +
        rule.maxFiles +
        ' (over by ' +
        (entries.length - rule.maxFiles) +
        '). Archive the extra run output as a CI artifact instead of committing it, ' +
        'or raise the cap deliberately in ' +
        MANIFEST +
        '.',
    );
  }
  if (rule.filename) {
    const re = new RegExp(rule.filename);
    for (const f of entries) {
      if (!re.test(path.posix.basename(f.rel))) {
        fail('C filename outside pattern', f.rel + ' does not match the allowed pattern ' + rule.filename + ' for ' + dir + '.');
      }
    }
  }
}
for (const dir of Object.keys(manifest.directories)) {
  if (!byDir.has(dir)) {
    fail(
      'C empty bucket',
      dir + ' is listed in ' + MANIFEST + ' but tracks no PNG. Remove the entry when a bucket is deliberately dropped, so the manifest keeps describing the real tree.',
    );
  }
}

// ---- D: global ceilings ----------------------------------------------------------------------
const totalFiles = files.length;
const totalBytes = files.reduce((s, f) => s + f.size, 0);
if (totalFiles > manifest.totals.maxFiles) {
  fail(
    'D total over budget',
    totalFiles + ' tracked PNG, ceiling is ' + manifest.totals.maxFiles + ' (over by ' + (totalFiles - manifest.totals.maxFiles) + ').',
  );
}
if (totalBytes > manifest.totals.maxBytes) {
  fail(
    'D bytes over budget',
    (totalBytes / 1048576).toFixed(2) +
      ' MB of tracked PNG, ceiling is ' +
      (manifest.totals.maxBytes / 1048576).toFixed(2) +
      ' MB.',
  );
}

// ---- E: doc reference integrity ---------------------------------------------------------------
// Judged against the git index, never against the working tree. A fresh CI checkout contains exactly
// the tracked set, so "this file is on my disk" and "a reader can open this path" are different
// claims: 25 captures left untracked in artifacts/g11-d3 made this check pass locally while the same
// commit failed in CI. Judging the index also gets the uncommitted-deletion case right - git still
// has the file, so the checkout will too, so the reference still resolves.
const alive = new Set(tracked);
const aliveByBase = new Map();
for (const rel of alive) {
  const base = path.posix.basename(rel);
  if (!aliveByBase.has(base)) aliveByBase.set(base, []);
  aliveByBase.get(base).push(rel);
}
const knownMissing = new Set((manifest.knownMissingDocReferences || []).map((k) => k.ref));

const mdFiles = [];
for (const f of readdirSync(root)) if (f.endsWith('.md')) mdFiles.push(path.join(root, f));
for (const d of MD_ROOTS) walk(path.join(root, d), mdFiles);
const onlyMd = mdFiles.filter((p) => p.endsWith('.md'));

let refCount = 0;
const missingRefs = new Map();
for (const doc of onlyMd) {
  const relDoc = path.relative(root, doc);
  const text = readFileSync(doc, 'utf8');
  for (const ref of new Set(text.match(PNG_REF) || [])) {
    if (ref.includes('...')) continue; // "..." is a documentation placeholder, not a path
    refCount += 1;
    const asSibling = path.posix.normalize(path.posix.join(path.posix.dirname(relDoc), ref));
    const asRootRelative = path.posix.normalize(ref);
    const resolved =
      alive.has(asSibling) || alive.has(asRootRelative) || (aliveByBase.get(path.posix.basename(ref)) || []).length > 0;
    if (resolved || knownMissing.has(ref)) continue;
    if (!missingRefs.has(ref)) {
      // The exact failure worth naming: the capture is sitting in the author's working tree, so the
      // path looks fine while you read the doc, but git never received it and no reader has it.
      const onDisk =
        existsSync(path.join(root, asRootRelative)) || existsSync(path.join(root, asSibling));
      missingRefs.set(ref, { docs: new Set(), untracked: onDisk });
    }
    missingRefs.get(ref).docs.add(relDoc);
  }
}
for (const [ref, entry] of missingRefs) {
  fail(
    'E dangling doc reference',
    [...entry.docs].join(', ') +
      ' points at ' +
      ref +
      ', which git does not track.' +
      (entry.untracked
        ? ' The file is present in this working tree but untracked, so a fresh checkout has nothing at that path: ' +
          'a document that cites it is true only on this machine. Commit it within budget, or state what was verified instead of citing a path.'
        : ' Restore the screenshot or fix the reference; a cited screenshot is an evidence link.'),
  );
}

// ---- report ----------------------------------------------------------------------------------
if (process.argv.includes('--print-manifest')) {
  const dirs = {};
  for (const entry of [...byDir.entries()].sort()) {
    const existing = manifest.directories[entry[0]] || {};
    const rule = { maxFiles: entry[1].length };
    if (existing.filename) rule.filename = existing.filename;
    dirs[entry[0]] = rule;
  }
  console.log(JSON.stringify({ totals: { maxFiles: totalFiles, maxBytes: totalBytes }, directories: dirs }, null, 2));
  process.exit(0);
}

console.log(
  'tracked PNG: ' +
    totalFiles +
    ' files, ' +
    (totalBytes / 1048576).toFixed(2) +
    ' MB (ceiling ' +
    manifest.totals.maxFiles +
    ' files, ' +
    (manifest.totals.maxBytes / 1048576).toFixed(2) +
    ' MB)',
);
console.log('directories: ' + byDir.size + ' buckets, all listed in the manifest');
console.log('doc references checked: ' + refCount + ' across ' + onlyMd.length + ' markdown files');
if (indexOnly.length) {
  // A commit made with "git commit -a" records these as deletions, and a fresh CI checkout has
  // none of them, so they are reported instead of counted - but never silently dropped.
  console.log('note: ' + indexOnly.length + ' index entries have no working-tree file (pending deletions):');
  for (const rel of indexOnly.slice(0, 5)) console.log('  - ' + rel);
  if (indexOnly.length > 5) console.log('  ... and ' + (indexOnly.length - 5) + ' more');
}

if (violations.length === 0) {
  console.log('');
  console.log('OK: tracked PNGs are the curated baseline and within budget.');
  process.exit(0);
}

console.error('');
console.error('FAIL: ' + violations.length + ' violation(s)');
let lastCheck = null;
for (const v of violations) {
  if (v.check !== lastCheck) {
    console.error('');
    console.error('[' + v.check + ']');
    lastCheck = v.check;
  }
  console.error('  - ' + v.message);
}
console.error('');
console.error('Budget source: ' + MANIFEST + '. Regenerate ceilings with --print-manifest only after a deliberate re-capture.');
process.exit(1);
