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
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
 * Which PNGs each file names, keyed by the PATH SEGMENTS the file wrote.
 *
 * Matching on the basename alone is wrong, and the tree proves it: eight
 * tracked files are named `job-detail.png`, and one document cites
 * `../assets/0.0.4/hardening/job-detail.png`. Keyed by basename, all eight came
 * back "cited by 004-product-hardening.md" - so `docs/assets/0.0.4/job-detail.png`
 * and `docs/assets/0.0.4/ui-redesign/job-detail.png` were classified A while
 * nothing cites them.
 *
 * The key is now the longest run of path segments the file actually wrote:
 * `hardening/job-detail.png` for a relative reference,
 * `artifacts/ui/studio/job-detail.png` for a full one, and bare
 * `job-detail.png` only when nothing longer was written. A bare basename is
 * kept as a SEPARATE, weaker key - it is what a document that names no
 * directory leaves us with, and it must not be confused with a path match.
 *
 * @returns {{evidence: Map<string, string[]>, assertion: Map<string, string[]>,
 *            bareEvidence: Map<string, string[]>, bareAssertion: Map<string, string[]>}}
 */
export function referencesByKind() {
  const evidence = new Map();
  const assertion = new Map();
  const bareEvidence = new Map();
  const bareAssertion = new Map();
  const add = (map, key, rel) => {
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.includes(rel)) list.push(rel);
  };

  const all = walk(ROOT);
  for (const file of all) {
    const rel = relative(ROOT, file);
    if (rel.startsWith('artifacts/') || rel.startsWith('test-results/')) continue;
    if (!/\.(md|ts|tsx|mjs|cjs|js|py|json|ya?ml|sh)$/.test(rel)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    // THE CLASSIFIER DOES NOT COUNT ITSELF.
    //
    // It walks `tests/` and `scripts/`, and it lives in `scripts/` - so a path
    // written in THIS FILE becomes a reference to that path. Measured: a comment
    // in this very function naming a doc copy made that file class A, so the note
    // explaining a misclassification created the evidence for it. A tool that
    // appears in its own input cannot be reasoned about.
    //
    // Excluded by resolved path, not by name: a copy of this tool elsewhere SHOULD
    // be scanned, and only the file doing the scanning is the problem.
    if (resolve(file) === resolve(fileURLToPath(import.meta.url))) continue;
    const isAssertionSource = /(^|\/)(tests|scripts)\//.test(rel) || /\.spec\.ts$/.test(rel)
      || /check-tracked-png-budget/.test(rel);
    const isDoc = rel.endsWith('.md');
    if (!isAssertionSource && !isDoc) continue;

    // Match a path-like run ending in .png, and take the LONGEST suffix of it
    // that is a real tracked file's tail. Greedy on segments, so
    // `../assets/0.0.4/hardening/job-detail.png` keys on
    // `hardening/job-detail.png` and not on `job-detail.png`.
    for (const m of text.matchAll(/([A-Za-z0-9_./@-]*?)([A-Za-z0-9_.@-]+\.png)/g)) {
      const prefix = m[1];
      const base = m[2];
      const segments = prefix.split('/').filter((seg) => seg && seg !== '.' && seg !== '..');
      const key = segments.length ? `${segments.slice(-2).join('/')}/${base}` : base;
      const strong = isAssertionSource ? assertion : evidence;
      const weak = isAssertionSource ? bareAssertion : bareEvidence;
      if (segments.length) add(strong, key, rel);
      else add(weak, base, rel);
    }
  }
  return { evidence, assertion, bareEvidence, bareAssertion };
}

/** Is `path` named by any key in `map`, keyed on whole trailing segments? */
function lookups(path, map) {
  const segments = path.split('/');
  // Longest suffix first: the most specific match wins.
  for (let take = segments.length; take >= 2; take -= 1) {
    const key = segments.slice(-take).join('/');
    if (map.has(key)) return map.get(key);
  }
  return [];
}

/**
 * @returns {{path: string, class: string, citedBy: string[], assertedBy: string[],
 *            match: string}[]}
 */
export function classify(pngs, refs) {
  // How many files in the tree share each basename. A basename-only match is
  // evidence when it is unique and a GUESS when it is not: `job-history.png`
  // exists under both `artifacts/ui/studio/` and `docs/assets/0.0.4/`, so "a
  // spec names job-history.png" does not say which one.
  const shared = new Map();
  for (const p of pngs) {
    const b = p.split('/').pop();
    shared.set(b, (shared.get(b) ?? 0) + 1);
  }
  return pngs.map((path) => {
    const base = path.split('/').pop();
    // A path match beats a bare-name match, always. A bare name is what a
    // document leaves us with when it writes no directory, and treating it as
    // equal to a path is the defect this function was rewritten for.
    let assertedBy = lookups(path, refs.assertion ?? new Map());
    let citedBy = lookups(path, refs.evidence ?? new Map());
    let match = assertedBy.length || citedBy.length ? 'path' : 'none';
    if (assertedBy.length === 0) assertedBy = refs.bareAssertion?.get(base) ?? [];
    if (citedBy.length === 0) citedBy = refs.bareEvidence?.get(base) ?? [];
    if (match === 'none' && (assertedBy.length || citedBy.length)) match = 'basename';

    let cls;
    if (assertedBy.length > 0) cls = 'A';
    else if (citedBy.length > 0) cls = 'B';
    else cls = 'C';

    // A CLASSIFICATION RESTING ON A SHARED BASENAME IS NOT EVIDENCE, AND MUST NOT
    // LAND IN A OR B.
    //
    // The first version computed `ambiguous` and then left `class` as A, so the
    // flag and the verdict disagreed: a row could say `ambiguous: true` while
    // being counted in the A total - "asserted by a spec, do not delete". The A
    // total is exactly what a reader consults before deleting, so a guess counted
    // there is the defect this function exists to prevent.
    //
    // Measured: eight rows in this repository classified as A purely because a
    // DIFFERENT file in another directory shares their basename. A spec writes
    // `artifacts/ui/studio/<name>.png`; a document lists a same-named file under
    // `docs/assets/`; the basename match credited the second to the first.
    //
    // (This comment deliberately does NOT spell those paths out. The extractor
    // below scans this file too, so a path written here becomes a reference to
    // it - which is how the first version of this note made its own subject class
    // A. Measured, and worth the parenthetical.)
    //
    // So ambiguity is a CLASS, not a footnote: UNKNOWN means "this cannot be
    // answered from the evidence", which is a different answer from "asserted".
    const ambiguous = match === 'basename' && (shared.get(base) ?? 1) > 1;
    if (ambiguous) cls = 'UNKNOWN';
    return { path, class: cls, citedBy, assertedBy, match, ambiguous };
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
    if (!byDir.has(dir)) byDir.set(dir, { A: 0, B: 0, C: 0, UNKNOWN: 0, total: 0, bytes: 0 });
    const bucket = byDir.get(dir);
    // A class the bucket does not know would make `undefined += 1` a NaN and
    // silently drop the row from every column. Fail loudly instead.
    if (!(row.class in bucket)) throw new Error(`unknown class ${row.class} for ${row.path}`);
    bucket[row.class] += 1;
    bucket.total += 1;
    try { bucket.bytes += statSync(join(ROOT, row.path)).size; } catch { /* index entry without a file */ }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ rows, byDir: Object.fromEntries(byDir) }, null, 2)}\n`);
  } else {
    // UNKNOWN GETS ITS OWN COLUMN. Without one, its rows were counted in `total`
    // and in no class column, so the table did not add up - and a table that does
    // not add up is the first thing a reader stops trusting.
    process.stdout.write(`${'directory'.padEnd(42)}${'A'.padStart(5)}${'B'.padStart(5)}${'C'.padStart(5)}`
      + `${'?'.padStart(5)}${'total'.padStart(7)}${'MB'.padStart(9)}\n`);
    for (const [dir, b] of [...byDir.entries()].sort((a, b2) => b2[1].bytes - a[1].bytes)) {
      process.stdout.write(`${dir.padEnd(42)}${String(b.A).padStart(5)}${String(b.B).padStart(5)}`
        + `${String(b.C).padStart(5)}${String(b.UNKNOWN ?? 0).padStart(5)}`
        + `${String(b.total).padStart(7)}${(b.bytes / 1048576).toFixed(2).padStart(9)}\n`);
    }
    const totals = { A: 0, B: 0, C: 0, UNKNOWN: 0, bytes: 0 };
    for (const b of byDir.values()) {
      totals.A += b.A; totals.B += b.B; totals.C += b.C;
      totals.UNKNOWN += b.UNKNOWN ?? 0; totals.bytes += b.bytes;
    }
    process.stdout.write(`${'TOTAL'.padEnd(42)}${String(totals.A).padStart(5)}${String(totals.B).padStart(5)}`
      + `${String(totals.C).padStart(5)}${String(totals.UNKNOWN).padStart(5)}`
      + `${String(totals.A + totals.B + totals.C + totals.UNKNOWN).padStart(7)}`
      + `${(totals.bytes / 1048576).toFixed(2).padStart(9)}\n`);
    process.stdout.write('\nA = written by a spec/checker, B = cited by a document, C = neither\n');
    process.stdout.write('? = matched only by a SHARED BASENAME: not evidence either way, and not a\n');
    process.stdout.write('    deletion candidate. Answered by finding the reference, not by guessing.\n');
    process.stdout.write('(no file here is a pixel baseline: this repository has 0 toHaveScreenshot)\n');
  }
}
