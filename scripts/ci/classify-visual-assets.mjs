#!/usr/bin/env node
/**
 * Classify every tracked PNG by how it is USED, and say so precisely.
 * TASK-04.
 *
 * THE FIRST VERSION OF THIS TOOL HAD THE CLASSES WRONG, AND MEASURING CORRECTED IT
 *
 * It labelled any PNG named by a test file as a "baseline an assertion compares
 * against". That is false in this repository: `tests/ui/g14-css-fix-evidence.spec.ts:12`
 * states it outright - "this repository has no pixel baseline (0
 * `toHaveScreenshot`). The screenshots are the human-reviewable half; the
 * assertions are the part that fails a build."
 *
 * So a PNG named in a spec is an OUTPUT that spec WRITES (`page.screenshot({
 * path: ... })`), not a baseline it compares against. Deleting it breaks no
 * assertion; it removes evidence a reviewer was meant to look at. The two are
 * different in exactly the way that matters before a deletion, so the classes
 * below name the difference instead of collapsing it.
 *
 * THE CLASSES
 *
 *   A  emitted-by-test   a spec or checker WRITES this path. It is produced
 *                        output: deleting the file breaks nothing, but the
 *                        path is load-bearing for whoever runs the suite.
 *   B  cited-by-doc      a document links to it as evidence. Deleting it turns
 *                        that document into a lie.
 *   C  orphan            neither written nor cited. Tracked, consuming budget
 *                        headroom, pointing at nothing.
 *
 * A file can be both A and B. C is the only class that is a deletion candidate,
 * and even then the decision belongs to a human: an orphan may be the only
 * record of a state that cannot be re-captured, and re-capturing it needs the
 * exact console version and environment it was taken in.
 *
 * WHAT THIS TOOL DOES NOT DO
 *
 * It does not delete, move or edit. It prints. A tool that both classifies and
 * acts has no moment at which a person can disagree with it.
 *
 * Usage:
 *   node scripts/ci/classify-visual-assets.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Every tracked PNG, from the index (not the working tree). */
export function trackedPngs() {
  return execFileSync('git', ['ls-files', '*.png'], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter(Boolean);
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (['node_modules', 'target', 'dist', '.git', '.blueprint', 'test-results'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Which PNG basenames appear in which kind of file.
 *
 * Matching is on the FILE NAME, not the full path, because that is how the
 * documents and specs cite them (`![x](.../r1440-light-en__overview.png)` and
 * `"audit/.../r1440-light-en__overview.png"` both appear).
 */
export function referencesByKind() {
  const evidence = new Map(); // basename -> [doc]
  const assertion = new Map(); // basename -> [spec/checker]
  const all = walk(ROOT);
  for (const file of all) {
    // `artifacts/` is the subject, not a reference source; script output and
    // the Playwright failure dumps cite screenshots they just wrote.
    const rel = relative(ROOT, file);
    if (rel.startsWith('artifacts/') || rel.startsWith('test-results/')) continue;
    if (!/\.(md|ts|tsx|mjs|cjs|js|py|json|ya?ml|sh)$/.test(rel)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // Only files that could plausibly assert against an image.
    const isAssertionSource = /(^|\/)(tests|scripts)\//.test(rel) || /\.spec\.ts$/.test(rel)
      || /check-tracked-png-budget/.test(rel);
    const isDoc = rel.endsWith('.md');
    if (!isAssertionSource && !isDoc) continue;
    for (const m of text.matchAll(/([A-Za-z0-9_.@-]+\.png)/g)) {
      const target = isAssertionSource ? assertion : evidence;
      if (!target.has(m[1])) target.set(m[1], []);
      const list = target.get(m[1]);
      if (!list.includes(rel)) list.push(rel);
    }
  }
  return { evidence, assertion };
}

/**
 * @returns {{path: string, class: string, citedBy: string[], assertedBy: string[]}[]}
 */
export function classify(pngs, refs) {
  return pngs.map((path) => {
    const base = path.split('/').pop();
    const citedBy = refs.evidence.get(base) ?? [];
    const assertedBy = refs.assertion.get(base) ?? [];
    let cls;
    if (assertedBy.length > 0) cls = 'A';
    else if (citedBy.length > 0) cls = 'B';
    else cls = 'C';
    return { path, class: cls, citedBy, assertedBy };
  });
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const pngs = trackedPngs();
  if (pngs.length === 0) {
    process.stderr.write('no tracked PNGs; the tool is not reading the index\n');
    process.exit(1);
  }
  const refs = referencesByKind();
  const rows = classify(pngs, refs);

  const byDir = new Map();
  for (const row of rows) {
    const dir = row.path.split('/').slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, { A: 0, B: 0, C: 0, total: 0, bytes: 0 });
    const bucket = byDir.get(dir);
    bucket[row.class] += 1;
    bucket.total += 1;
    try { bucket.bytes += statSync(join(ROOT, row.path)).size; } catch { /* index entry without a file */ }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ rows, byDir: Object.fromEntries(byDir) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${'directory'.padEnd(42)}${'A'.padStart(5)}${'B'.padStart(5)}${'C'.padStart(5)}${'total'.padStart(7)}${'MB'.padStart(9)}\n`);
    for (const [dir, b] of [...byDir.entries()].sort((a, b2) => b2[1].bytes - a[1].bytes)) {
      process.stdout.write(`${dir.padEnd(42)}${String(b.A).padStart(5)}${String(b.B).padStart(5)}`
        + `${String(b.C).padStart(5)}${String(b.total).padStart(7)}${(b.bytes / 1048576).toFixed(2).padStart(9)}\n`);
    }
    const totals = { A: 0, B: 0, C: 0, bytes: 0 };
    for (const b of byDir.values()) {
      totals.A += b.A; totals.B += b.B; totals.C += b.C; totals.bytes += b.bytes;
    }
    process.stdout.write(`${'TOTAL'.padEnd(42)}${String(totals.A).padStart(5)}${String(totals.B).padStart(5)}`
      + `${String(totals.C).padStart(5)}${String(totals.A + totals.B + totals.C).padStart(7)}`
      + `${(totals.bytes / 1048576).toFixed(2).padStart(9)}\n`);
    process.stdout.write('\nA = written by a spec/checker, B = cited by a document, C = neither\n');
    process.stdout.write('(no file here is a pixel baseline: this repository has 0 toHaveScreenshot)\n');
  }
}
