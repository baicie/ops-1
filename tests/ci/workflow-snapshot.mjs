#!/usr/bin/env node
/**
 * Workflow compatibility snapshot, on a real parse.
 *
 * WHAT THE FIRST VERSION GOT WRONG
 *
 * It parsed with line regexes. Two defects followed, both measured:
 *
 *   1. `parseTriggers` stopped at the first comment inside a `paths:` list.
 *      `g12-acceptance.yml` reported 6 trigger paths; it has 28. Twenty-two
 *      filters - including `.github/workflows/g12-acceptance.yml` itself - were
 *      invisible to every comparison this tool ever made.
 *   2. A step written `- name: ...` then `run:` was dropped entirely, so folding
 *      a step into a job that already had one did not change the snapshot.
 *
 * Both came from the same cause: guessing at structure with regexes. This
 * version parses the file (`lib/workflow-yaml.mjs`) and REFUSES when a
 * construct is outside the subset it understands. A refusal is reported as
 * UNPARSED, never as "no findings" - a checker that quietly returns a partial
 * tree is how the twenty-two paths disappeared.
 *
 * WHAT IS COMPARED
 *
 *   triggers      events with paths / paths-ignore / branches / branches-ignore
 *   concurrency   group and cancel-in-progress
 *   permissions   workflow-level, and per job
 *   jobs          needs, timeout, if, runs-on, environment, strategy.matrix,
 *                 services, container, continue-on-error, uses (reusable),
 *                 with, secrets, outputs
 *   steps         `uses`, or a DIGEST of the whole `run:` body
 *
 * Why a digest and not the text: the point is to notice that a multi-line shell
 * block changed, including a deleted `set -euo pipefail`, an added `|| true`, or
 * a changed SSH target. Storing the command text would put it next to secrets in
 * a committed file; a SHA-256 notices every change and reveals nothing. The
 * step's `name` and first line are kept so the diff stays readable.
 *
 * USAGE
 *
 *   node tests/ci/workflow-snapshot.mjs snapshot --out before.json
 *   node tests/ci/workflow-snapshot.mjs compare --base f.json
 *   node tests/ci/workflow-snapshot.mjs compare --base-ref refs/remotes/origin/main
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './lib/workflow-yaml.mjs';

const ROOT = process.cwd();
const WF_DIR = '.github/workflows';

/** Normalise an `on:` block into `{event: {paths, paths-ignore, branches, ...}}`. */
export function normaliseTriggers(onBlock) {
  if (onBlock === null || onBlock === undefined) return null;
  if (typeof onBlock === 'string') return { [onBlock]: {} };
  if (Array.isArray(onBlock)) return Object.fromEntries(onBlock.map((e) => [String(e), {}]));
  if (typeof onBlock !== 'object') return null;
  const out = {};
  for (const [event, config] of Object.entries(onBlock)) {
    const entry = {};
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      for (const key of ['paths', 'paths-ignore', 'branches', 'branches-ignore', 'types']) {
        if (Array.isArray(config[key])) entry[key] = [...config[key]].map(String).sort();
        else if (config[key] !== undefined) entry[key] = config[key];
      }
      if (event === 'schedule' && Array.isArray(config)) entry.cron = config.length;
    }
    if (event === 'schedule' && Array.isArray(config)) entry.cron = config.length;
    out[event] = entry;
  }
  return out;
}

/** Normalise a permissions block (workflow- or job-level) into a sorted list. */
export function normalisePermissions(block) {
  if (block === undefined) return null;
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    return Object.entries(block).map(([k, v]) => `${k}: ${v}`).sort();
  }
  return null;
}

/**
 * A digest of a step's whole body.
 *
 * NO COMMAND TEXT IS STORED, not even the first line. The snapshot is a
 * committed file, and a `run:` body routinely carries an `echo "$TOKEN"`, an
 * `ssh user@host` or an inline connection string. The first version kept the
 * first line "for a readable diff"; measured, that put the command into the
 * snapshot, and the test asserting otherwise failed. Readability comes from the
 * step's own `name`, which the author writes for humans.
 *
 * What replaces it: the line count and a shape fingerprint - how many lines,
 * and whether the body contains the constructs whose removal is a security
 * change. A diff then reads "SHELL BODY changed, 4 -> 4 lines, digest X -> Y"
 * plus the shape delta, which is enough to know whether to look.
 */
export function stepDigest(run) {
  const text = String(run ?? '');
  const lines = text.split('\n');
  const has = (re) => lines.some((l) => re.test(l));
  return {
    runDigest: createHash('sha256').update(text).digest('hex').slice(0, 16),
    runLines: lines.length,
    shape: {
      errexit: has(/set -[a-z]*e/),
      pipefail: has(/set -[a-z]*o pipefail|\|\| true|\|\| :/),
      exitNonZero: has(/exit [1-9]/),
      sudo: has(/\bsudo\b/),
      ssh: has(/\bssh\b|scp /),
      dockerPush: has(/docker push/),
      curl: has(/\bcurl\b/),
    },
  };
}

/** One step, normalised. */
export function normaliseStep(step) {
  if (typeof step !== 'object' || step === null) return { malformed: String(step) };
  const out = {};
  if (step.name) out.name = String(step.name);
  if (step.id) out.id = String(step.id);
  if (step.uses) out.uses = String(step.uses);
  if (step.run !== undefined) Object.assign(out, stepDigest(step.run));
  if (step.with) out.with = step.with;
  for (const flag of ['continue-on-error', 'if', 'timeout-minutes', 'working-directory', 'shell']) {
    if (step[flag] === undefined) continue;
    out[flag] = flag === 'if'
      ? String(step[flag]).trim().replace(/\s+/g, ' ')
      : step[flag];
  }
  return out;
}

/** One job, normalised to the fields that decide whether and how it runs. */
export function normaliseJob(job) {
  if (typeof job !== 'object' || job === null) return { malformed: String(job) };
  const out = {};
  for (const key of ['name', 'runs-on', 'environment', 'container', 'services',
    'strategy', 'defaults', 'env', 'outputs', 'uses', 'with', 'secrets',
    'concurrency', 'continue-on-error']) {
    if (job[key] !== undefined) out[key] = job[key];
  }
  if (job.needs !== undefined) {
    out.needs = Array.isArray(job.needs) ? [...job.needs].map(String).sort() : [String(job.needs)];
  }
  if (job['timeout-minutes'] !== undefined) out.timeout = Number(job['timeout-minutes']);
  if (job.if !== undefined) out.if = String(job.if).trim().replace(/\s+/g, ' ');
  const perms = normalisePermissions(job.permissions);
  if (perms !== null) out.permissions = perms;
  out.steps = (Array.isArray(job.steps) ? job.steps : []).map(normaliseStep);
  return out;
}

/** The semantic surface of one workflow file. */
export function snapshotWorkflow(text) {
  const parsed = parse(text);
  if (!parsed.ok) {
    return { unparsed: { error: parsed.error, line: parsed.line } };
  }
  const doc = parsed.value ?? {};
  const jobs = {};
  for (const [id, job] of Object.entries(doc.jobs ?? {})) jobs[id] = normaliseJob(job);
  return {
    triggers: normaliseTriggers(doc.on),
    concurrency: doc.concurrency ?? null,
    permissions: normalisePermissions(doc.permissions),
    jobs,
  };
}

/** Snapshot every workflow in the working tree, from the index. */
export function snapshotAll() {
  const names = execFileSync('git', ['ls-files', WF_DIR], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter((p) => /\.ya?ml$/.test(p)).sort();
  const out = {};
  for (const path of names) {
    out[path.split('/').pop()] = snapshotWorkflow(readFileSync(join(ROOT, path), 'utf8'));
  }
  return out;
}

/** Snapshot every workflow as it exists in a git ref. */
export function snapshotAtRef(ref) {
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, WF_DIR], { encoding: 'utf8', cwd: ROOT })
    .split('\n').filter((p) => /\.ya?ml$/.test(p)).sort();
  const out = {};
  for (const path of names) {
    const text = execFileSync('git', ['show', `${ref}:${path}`],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
    out[path.split('/').pop()] = snapshotWorkflow(text);
  }
  return out;
}

/** Field-level differences for one job. */
function jobDiff(file, id, a, b) {
  const diffs = [];
  for (const field of ['needs', 'timeout', 'runs-on', 'if', 'environment', 'permissions',
    'concurrency', 'continue-on-error', 'strategy', 'services', 'container',
    'uses', 'with', 'secrets', 'outputs', 'defaults', 'env']) {
    if (JSON.stringify(a[field]) === JSON.stringify(b[field])) continue;
    diffs.push(`${file}:${id}: ${field} changed  ${JSON.stringify(a[field])} -> ${JSON.stringify(b[field])}`);
  }
  const sa = a.steps ?? [];
  const sb = b.steps ?? [];
  if (sa.length !== sb.length) diffs.push(`${file}:${id}: step count ${sa.length} -> ${sb.length}`);

  // STEPS ARE ALIGNED BY IDENTITY, NOT BY POSITION.
  //
  // Comparing index i to index i means inserting one step reports every step
  // after it as changed - measured: adding a single step to `web` produced 17
  // findings, 16 of them "SHELL BODY changed" against a different neighbour.
  // That is noise, and noise is how a checker gets ignored.
  //
  // The identity is the step's `name` when it has one, else its `uses`, else a
  // digest of its body. Two steps with the same identity are the same step that
  // changed; one that appears on only one side was added or removed.
  const label = (s) => s?.name ?? s?.uses ?? (s?.runDigest ? `run ${s.runDigest}` : '?');
  // The key must be stable under an edit to the step ITSELF. `uses` alone would
  // rename a step whose `with:` changed, and `runDigest` would rename one whose
  // shell body changed - both turn "this step changed" into "a step was removed
  // and another added". A `uses` step is therefore keyed by its action, not by
  // its whole object.
  const key = (s) => {
    if (s?.name) return `name:${s.name}`;
    if (s?.uses) return `uses:${s.uses}`;
    if (s?.runDigest) return `run:${s.runDigest}`;
    return `step:${JSON.stringify(s)}`;
  };
  const byKeyA = new Map(sa.map((s) => [key(s), s]));
  const byKeyB = new Map(sb.map((s) => [key(s), s]));

  for (const [k, x] of byKeyA) {
    const y = byKeyB.get(k);
    if (!y) { diffs.push(`${file}:${id}: step REMOVED (${label(x)})`); continue; }
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const strip = (s) => JSON.stringify({ ...s, runDigest: 0, runLines: 0, shape: 0 });
    if (x.runDigest && y.runDigest && x.runDigest !== y.runDigest && strip(x) === strip(y)) {
      const delta = Object.keys(x.shape ?? {})
        .filter((f) => Boolean(x.shape?.[f]) !== Boolean(y.shape?.[f]))
        .map((f) => `${f} ${x.shape?.[f]} -> ${y.shape?.[f]}`);
      diffs.push(`${file}:${id}: step (${label(x)}) SHELL BODY changed`
        + `  ${x.runLines} -> ${y.runLines} lines, digest ${x.runDigest} -> ${y.runDigest}`
        + (delta.length ? `, flags: ${delta.join(', ')}` : ''));
    } else {
      diffs.push(`${file}:${id}: step (${label(x)}) changed  ${JSON.stringify(x).slice(0, 120)} -> ${JSON.stringify(y).slice(0, 120)}`);
    }
  }
  for (const [k, y] of byKeyB) {
    if (!byKeyA.has(k)) diffs.push(`${file}:${id}: step ADDED (${label(y)})`);
  }
  return diffs;
}

/**
 * Differences between two snapshots.
 *
 * @returns {string[]} one line per difference; empty means the surface is equal
 */
export function compare(base, next) {
  const diffs = [];
  const files = new Set([...Object.keys(base), ...Object.keys(next)]);
  for (const file of [...files].sort()) {
    const a = base[file];
    const b = next[file];
    if (!a) { diffs.push(`${file}: workflow ADDED`); continue; }
    if (!b) { diffs.push(`${file}: workflow REMOVED`); continue; }
    if (a.unparsed || b.unparsed) {
      const side = a.unparsed ? `base: ${a.unparsed.error}` : `current: ${b.unparsed.error}`;
      diffs.push(`${file}: UNPARSED (${side}) - the surface cannot be compared`);
      continue;
    }
    if (JSON.stringify(a.triggers) !== JSON.stringify(b.triggers)) {
      diffs.push(`${file}: triggers changed  ${JSON.stringify(a.triggers)} -> ${JSON.stringify(b.triggers)}`);
    }
    if (JSON.stringify(a.concurrency) !== JSON.stringify(b.concurrency)) {
      diffs.push(`${file}: concurrency changed`);
    }
    if (JSON.stringify(a.permissions) !== JSON.stringify(b.permissions)) {
      diffs.push(`${file}: workflow permissions changed  ${JSON.stringify(a.permissions)} -> ${JSON.stringify(b.permissions)}`);
    }
    for (const id of [...new Set([...Object.keys(a.jobs ?? {}), ...Object.keys(b.jobs ?? {})])].sort()) {
      const ja = a.jobs?.[id];
      const jb = b.jobs?.[id];
      if (!ja) { diffs.push(`${file}:${id}: job ADDED`); continue; }
      if (!jb) { diffs.push(`${file}:${id}: job REMOVED`); continue; }
      diffs.push(...jobDiff(file, id, ja, jb));
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
    const unparsed = Object.entries(snap).filter(([, v]) => v.unparsed);
    for (const [name, v] of unparsed) {
      process.stderr.write(`UNPARSED ${name}: ${v.unparsed.error} (line ${v.unparsed.line})\n`);
    }
    const json = `${JSON.stringify(snap, null, 2)}\n`;
    if (out) {
      writeFileSync(out, json);
      process.stdout.write(`snapshot written to ${out} (${Object.keys(snap).length} workflows)\n`);
    } else process.stdout.write(json);
    // A snapshot containing an unparsed file is a baseline with blind spots;
    // writing it would make every later comparison inherit them.
    process.exit(unparsed.length ? 1 : 0);
  } else if (mode === 'compare') {
    const baseRef = arg('base-ref');
    const basePath = arg('base');
    let baseSnap;
    if (baseRef) baseSnap = snapshotAtRef(baseRef);
    else if (basePath) baseSnap = JSON.parse(readFileSync(basePath, 'utf8'));
    else {
      process.stderr.write('usage: workflow-snapshot.mjs compare --base <f> | --base-ref <ref>\n');
      process.exit(2);
    }
    const diffs = compare(baseSnap, snapshotAll());
    for (const d of diffs) process.stdout.write(`CHANGED ${d}\n`);
    const unparsed = diffs.filter((d) => /UNPARSED/.test(d));
    for (const u of unparsed) process.stdout.write(`REFUSED ${u}\n`);
    process.stdout.write(`workflow surface: ${diffs.length} change(s)`
      + `${unparsed.length ? `, ${unparsed.length} UNPARSED` : ''}\n`);
    // `--advisory` prints every difference and exits 0. The CI step prints the
    // report for the reviewer and then decides, by name, which classes block:
    // a routine timeout edit and a deleted job are both "a change", and only one
    // of them should stop a merge. Keeping that decision in the workflow means
    // the tool stays a reporter and the policy stays visible in one place.
    const advisory = argv.includes('--advisory');
    process.exit(advisory ? 0 : (diffs.length ? 1 : 0));
  } else {
    process.stderr.write('usage: workflow-snapshot.mjs snapshot [--out f] | compare --base f | --base-ref r\n');
    process.exit(2);
  }
}
