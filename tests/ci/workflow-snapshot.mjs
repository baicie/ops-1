#!/usr/bin/env node
/**
 * Workflow compatibility snapshot. TASK-32.
 *
 * WHY THIS EXISTS BEFORE ANY WORKFLOW REFACTOR
 *
 * The brief asks for `ci.yml` (1800 lines) and `staging-preview.yml` (2700
 * lines) to be broken up, with a hard requirement that job names, check
 * contexts, `needs`, concurrency, permissions and timeouts do not change.
 *
 * "Does not change" needs a baseline. Without one, a refactor's only defence is
 * that the diff looked small - and the properties that matter are exactly the
 * ones a diff hides: a `needs` entry dropped from a list, a permission narrowed,
 * a `timeout-minutes` deleted (which silently restores the 360-minute default).
 *
 * So this records the semantic surface of every workflow to JSON, and `compare`
 * reports any difference in that surface. It does NOT compare formatting,
 * comments or step order - those are what a refactor is allowed to change.
 *
 * WHAT IS IN THE SNAPSHOT
 *
 *   triggers       the events a workflow runs on, with their path filters
 *                `on:` is parsed textually rather than with a YAML library,
 *                because this repository has no runtime YAML dependency and a
 *                parser that only handles the shapes actually present is more
 *                honest about what it can see than a general one pretending to
 *                understand everything.
 *   jobs           name, needs, runs-on, timeout, if, outputs, environment
 *   concurrency    group and cancel-in-progress
 *   permissions    the `permissions:` block, verbatim
 *   steps          each step's `run:` first line (to catch a changed script)
 *
 * WHAT IT CANNOT SEE, STATED RATHER THAN IMPLIED
 *
 * It does not parse step bodies. A refactor that moves logic into a script and
 * calls it with the same command line is invisible here; that is the intended
 * use, and it means the snapshot is not a proof of behavioural equivalence -
 * only of the contract around the job graph.
 *
 * USAGE
 *
 *   node tests/ci/workflow-snapshot.mjs snapshot --out before.json
 *   node tests/ci/workflow-snapshot.mjs compare --base before.json
 *
 * `compare` exits non-zero when the semantic surface changed, and prints each
 * difference with the workflow and job it came from.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const WF_DIR = join(ROOT, '.github/workflows');

/**
 * The `on:` block, as events -> path filters.
 *
 * Handles the three shapes this repository uses:
 *   on: push
 *   on: [push, pull_request]
 *   on:
 *     push:
 *       paths: [...]
 */
export function parseTriggers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^on:\s*/.test(l));
  if (start === -1) return null;
  const inline = lines[start].replace(/^on:\s*/, '').trim();
  if (inline && !inline.startsWith('#')) {
    const list = inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    return Object.fromEntries(list.map((e) => [e, { paths: null }]));
  }
  const out = {};
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim()) break; // next top-level key
    const ev = /^  ([a-zA-Z_]+):\s*$/.exec(line);
    if (ev) { current = ev[1]; out[current] = { paths: null }; continue; }
    if (!current) continue;
    if (/^    paths:\s*$/.test(line)) {
      const paths = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const p = /^\s+-\s*'?([^'#]+?)'?\s*(?:#.*)?$/.exec(lines[j]);
        if (!p) break;
        paths.push(p[1].trim());
      }
      out[current] = { paths };
    }
  }
  return out;
}

/** The `concurrency:` block. */
export function parseConcurrency(text) {
  const m = /^concurrency:\s*\n((?:\s+.*\n)+)/m.exec(`${text}\n`);
  if (!m) return null;
  const group = /^\s+group:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? null;
  const cip = /^\s+cancel-in-progress:\s*(.+)$/m.exec(m[1])?.[1]?.trim() ?? null;
  return { group, cancelInProgress: cip };
}

/** Top-level `permissions:`. */
export function parsePermissions(text) {
  const m = /^permissions:\s*\n((?:\s+.*\n)+)/m.exec(`${text}\n`);
  if (!m) return /^permissions:\s*(\S+)/m.exec(text)?.[1] ?? null;
  return m[1].split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

/** Every job with the fields that decide whether it runs and what it may do. */
export function parseJobs(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) return {};
  const jobs = {};
  let current = null;
  let inSteps = false;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim()) break;
    const job = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      current = job[1];
      jobs[current] = { needs: [], timeout: null, if: null, runsOn: null, environment: null, steps: [] };
      inSteps = false;
      continue;
    }
    if (!current) continue;
    if (/^    steps:\s*$/.test(line)) { inSteps = true; continue; }
    if (inSteps) {
      // A step may begin with `- name:`, `- uses:`, `- run:`, or `- id:` and
      // carry `run:` on a LATER line inside the same item. Recognising only
      // `- run:` and `- uses:` made a step that starts with a name invisible -
      // measured: after folding a step into `spec-coverage`, the parser still
      // reported its original three steps, so the change it was supposed to
      // gate went unreported.
      const itemStart = /^\s+-\s+([a-zA-Z_-]+):\s*(.*)$/.exec(line);
      if (itemStart) {
        const [, field, value] = itemStart;
        if (field === 'run') jobs[current].steps.push({ run: value.trim().slice(0, 120) });
        else if (field === 'uses') jobs[current].steps.push({ uses: value.trim() });
        else jobs[current].steps.push({ [field]: value.trim().slice(0, 120) });
        continue;
      }
      // A `run:` (or `uses:`) on its own line continues the step above.
      const cont = /^\s+(run|uses):\s*(.*)$/.exec(line);
      if (cont && jobs[current].steps.length) {
        const last = jobs[current].steps[jobs[current].steps.length - 1];
        if (cont[1] === 'run' && !last.run) last.run = cont[2].trim().slice(0, 120);
        if (cont[1] === 'uses' && !last.uses) last.uses = cont[2].trim();
      }
      continue;
    }
    const needs = /^    needs:\s*(.+)$/.exec(line)?.[1];
    if (needs) {
      jobs[current].needs = needs.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean).sort();
    }
    const timeout = /^    timeout-minutes:\s*(\d+)/.exec(line)?.[1];
    if (timeout) jobs[current].timeout = Number(timeout);
    const cond = /^    if:\s*(.+)$/.exec(line)?.[1];
    if (cond) jobs[current].if = cond.trim().replace(/\s+/g, ' ');
    const runsOn = /^    runs-on:\s*(.+)$/.exec(line)?.[1];
    if (runsOn) jobs[current].runsOn = runsOn.trim();
    const env = /^    environment:\s*\n^\s+name:\s*(\S+)/m.exec(lines.slice(i, i + 4).join('\n'));
    if (env) jobs[current].environment = env[1];
  }
  return jobs;
}

/** The semantic surface of one workflow file. */
export function snapshotWorkflow(text) {
  return {
    triggers: parseTriggers(text),
    concurrency: parseConcurrency(text),
    permissions: parsePermissions(text),
    jobs: parseJobs(text),
  };
}

export function snapshotAll() {
  const out = {};
  for (const name of readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    out[name] = snapshotWorkflow(readFileSync(join(WF_DIR, name), 'utf8'));
  }
  return out;
}

/**
 * Differences between two snapshots, as readable lines.
 *
 * Only the surface is compared. Adding a step is reported because a changed
 * command line inside a job is a real change to what CI does; a comment or a
 * reordering of steps is not reported.
 */
export function compare(base, next) {
  const diffs = [];
  const files = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const file of [...files].sort()) {
    const a = base[file];
    const b = next[file];
    if (!a) { diffs.push(`${file}: workflow ADDED`); continue; }
    if (!b) { diffs.push(`${file}: workflow REMOVED`); continue; }
    if (JSON.stringify(a.triggers) !== JSON.stringify(b.triggers)) {
      diffs.push(`${file}: triggers changed`);
    }
    if (JSON.stringify(a.concurrency) !== JSON.stringify(b.concurrency)) {
      diffs.push(`${file}: concurrency changed  ${JSON.stringify(a.concurrency)} -> ${JSON.stringify(b.concurrency)}`);
    }
    if (JSON.stringify(a.permissions) !== JSON.stringify(b.permissions)) {
      diffs.push(`${file}: permissions changed`);
    }
    const jobs = new Set([...Object.keys(a.jobs ?? {}), ...Object.keys(b.jobs ?? {})]);
    for (const job of [...jobs].sort()) {
      const ja = a.jobs?.[job];
      const jb = b.jobs?.[job];
      if (!ja) { diffs.push(`${file}:${job}: job ADDED`); continue; }
      if (!jb) { diffs.push(`${file}:${job}: job REMOVED`); continue; }
      for (const field of ['needs', 'timeout', 'runsOn', 'if', 'environment']) {
        if (JSON.stringify(ja[field]) !== JSON.stringify(jb[field])) {
          diffs.push(`${file}:${job}: ${field} changed  ${JSON.stringify(ja[field])} -> ${JSON.stringify(jb[field])}`);
        }
      }
      const stepsA = ja.steps.map((s) => JSON.stringify(s));
      const stepsB = jb.steps.map((s) => JSON.stringify(s));
      if (JSON.stringify(stepsA) !== JSON.stringify(stepsB)) {
        diffs.push(`${file}:${job}: steps changed (${stepsA.length} -> ${stepsB.length})`);
      }
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
  if (mode === 'snapshot') {
    const out = arg('out');
    const snap = snapshotAll();
    const json = `${JSON.stringify(snap, null, 2)}\n`;
    if (out) { writeFileSync(out, json); process.stdout.write(`snapshot written to ${out} (${Object.keys(snap).length} workflows)\n`); }
    else process.stdout.write(json);
  } else if (mode === 'compare') {
    const basePath = arg('base');
    if (!basePath) { process.stderr.write('usage: workflow-snapshot.mjs compare --base <before.json>\n'); process.exit(2); }
    const diffs = compare(JSON.parse(readFileSync(basePath, 'utf8')), snapshotAll());
    for (const d of diffs) process.stdout.write(`CHANGED ${d}\n`);
    process.stdout.write(`workflow surface: ${diffs.length} change(s)\n`);
    process.exit(diffs.length ? 1 : 0);
  } else {
    process.stderr.write('usage: workflow-snapshot.mjs snapshot [--out f] | compare --base f\n');
    process.exit(2);
  }
}
