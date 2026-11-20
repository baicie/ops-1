#!/usr/bin/env node
/**
 * The staging host must not have two transactions touching it at once, and a
 * certification must fail loudly if the host changes under it.
 *
 * THE THREE PROPERTIES
 *
 *   1. SERIALISATION. Every job that mutates or certifies the host - `deploy`,
 *      `smoke`, the three seeded suites - must share ONE job-level concurrency
 *      group, and that group must be repository-scoped. A workflow-level group
 *      cannot do this: it is evaluated per run, so two runs are in different
 *      groups and neither waits for the other.
 *
 *   2. NO CANCELLING A DEPLOYMENT. That group must use `cancel-in-progress:
 *      false`. A deployment killed mid-rollback is worse than a queued one,
 *      because the host state is exactly what the rollback exists to repair.
 *
 *   3. FAIL-CLOSED IDENTITY. Ordering does not save you. `deploy` releases the
 *      group when the job ends; `smoke` then acquires it. A second run's `deploy`
 *      can win that gap, so a suite can still start against a host that has
 *      moved on. What makes that safe is the served-commit assertion: every
 *      certifying job must carry an expected SHA, and the suite must fail rather
 *      than report green for a commit it did not build.
 *
 * PROPERTY 3 IS THE ONE THAT IS EASY TO LOSE. It is not a concurrency feature;
 * it is a test fixture that happens to be the last line of defence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../../.github/workflows/staging-preview.yml', import.meta.url));

/** Job ids in this file that touch the host, and must be serialised. */
export const HOST_JOBS = ['deploy', 'smoke', 'seeded_studio', 'seeded_visual_layout', 'seeded_visual'];

/** Split a workflow's text into top-level job blocks, keyed by job id. */
export function jobBlocks(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt === -1) throw new Error('no top-level jobs: section');
  const blocks = new Map();
  let current = null;
  let buf = [];
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) blocks.set(current, buf.join('\n'));
      current = header[1];
      buf = [];
      continue;
    }
    if (/^\S/.test(line) && !/^#/.test(line)) {
      if (current) blocks.set(current, buf.join('\n'));
      current = null;
      break;
    }
    buf.push(line);
  }
  if (current) blocks.set(current, buf.join('\n'));
  return blocks;
}

/** The job-level concurrency of one job block, or null. */
export function jobConcurrency(block) {
  const m = /^ {4}concurrency:\s*\n((?: {6,}.*\n?)*)/m.exec(block);
  if (!m) return null;
  const group = /^ {6}group:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  const cip = /^ {6}cancel-in-progress:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
  return { group, cancelInProgress: cip };
}

/** @returns {string[]} problems */
export function inspect(text) {
  const blocks = jobBlocks(text);
  const problems = [];

  const groups = new Map();
  for (const job of HOST_JOBS) {
    const block = blocks.get(job);
    if (!block) { problems.push(`job "${job}" not found; the host-job list is stale`); continue; }
    const conc = jobConcurrency(block);
    if (!conc) {
      problems.push(`${job}: no job-level concurrency; it can run against the host at the same time as another job`);
      continue;
    }
    if (!conc.group) { problems.push(`${job}: job concurrency has no group`); continue; }
    // The group must NOT be keyed on anything run-specific: that would put two
    // runs in different groups and serialise nothing.
    if (/github\.(run_id|sha)\b/.test(conc.group)) {
      problems.push(`${job}: job group "${conc.group}" is keyed on a run-specific value, so two runs would never share it`);
    }
    if (!/^false$/i.test(conc.cancelInProgress ?? '')) {
      problems.push(`${job}: cancel-in-progress must be false; a deployment killed mid-rollback leaves the host in the state the rollback was repairing`);
    }
    groups.set(job, conc.group);
  }

  const distinct = new Set(groups.values());
  if (distinct.size > 1) {
    problems.push(`host jobs use ${distinct.size} different groups (${[...distinct].join(' | ')}); they must share one or they do not serialise`);
  }

  // Property 3: every certifying job must carry an expected SHA.
  for (const job of HOST_JOBS.filter((j) => j !== 'deploy')) {
    const block = blocks.get(job) ?? '';
    if (!/OPSWEAVE_EXPECTED_SHA:/.test(block)) {
      problems.push(`${job}: no OPSWEAVE_EXPECTED_SHA; it cannot tell that the host changed under it, so a stale host would certify green`);
    }
  }

  // And the workflow-level block must still exist and still separate the buckets -
  // the job locks serialise, but the bucket split is what keeps a nightly from
  // being cancelled by a push.
  if (!/^concurrency:/m.test(text)) {
    problems.push('no workflow-level concurrency; a push would cancel the nightly certification');
  }
  return problems;
}

// ---------------------------------------------------------------------------

const GOOD_JOB = (id) => `  ${id}:
    runs-on: ubuntu-latest
    env:
      OPSWEAVE_EXPECTED_SHA: \${{ github.sha }}
    concurrency:
      group: \${{ format('staging-host-{0}', vars.H || 'default') }}
      cancel-in-progress: false
    steps:
      - run: echo
`;

const GOOD = `name: x
on: [push]
concurrency:
  group: "staging-preview-\${{ (github.event_name == 'schedule' && 'nightly') || 'deploy' }}"
  cancel-in-progress: true
jobs:
${['deploy', 'smoke', 'seeded_studio', 'seeded_visual_layout', 'seeded_visual'].map(GOOD_JOB).join('')}`;

function selftest() {
  const cases = [
    ['a correct file passes', GOOD, []],
    ['a host job without a job lock fails',
      GOOD.replace(/  smoke:\n(?:.*\n)*?    steps:/, '  smoke:\n    runs-on: ubuntu-latest\n    env:\n      OPSWEAVE_EXPECTED_SHA: x\n    steps:'),
      ['smoke: no job-level concurrency']],
    ['cancel-in-progress: true on a host job fails',
      GOOD.replace("cancel-in-progress: false", 'cancel-in-progress: true'),
      ['cancel-in-progress must be false']],
    ['a run-specific group fails',
      GOOD.replaceAll("group: \${{ format('staging-host-{0}', vars.H || 'default') }}", 'group: staging-\${{ github.run_id }}'),
      ['keyed on a run-specific value']],
    ['a certifying job without an expected SHA fails',
      GOOD.replace(/  smoke:\n    runs-on: ubuntu-latest\n    env:\n      OPSWEAVE_EXPECTED_SHA: [^\n]*/, '  smoke:\n    runs-on: ubuntu-latest\n    env:'),
      ['no OPSWEAVE_EXPECTED_SHA']],
    ['different groups across host jobs fails',
      GOOD.replace(/  seeded_visual:\n    runs-on: ubuntu-latest\n    env:\n      OPSWEAVE_EXPECTED_SHA: [^\n]*\n    concurrency:\n      group: [^\n]*/,
        "  seeded_visual:\n    runs-on: ubuntu-latest\n    env:\n      OPSWEAVE_EXPECTED_SHA: x\n    concurrency:\n      group: other-group"),
      ['must share one']],
  ];
  let bad = 0;
  for (const [label, text, want] of cases) {
    let got = [];
    try { got = inspect(text); } catch (e) { got = [`threw: ${e.message}`]; }
    const ok = want.length === 0 ? got.length === 0 : want.every((w) => got.join(' ').includes(w));
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}\n`);
  }
  process.stdout.write(`staging concurrency selftest: ${cases.length - bad}/${cases.length}\n`);
  return bad === 0;
}

if (process.argv[2] === '--selftest') process.exit(selftest() ? 0 : 1);

const problems = inspect(readFileSync(FILE, 'utf8'));
for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
process.stdout.write(`staging concurrency: ${problems.length} error(s)\n`);
process.exit(problems.length === 0 ? 0 : 1);
