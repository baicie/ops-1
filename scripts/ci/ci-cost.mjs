#!/usr/bin/env node
/**
 * CI cost measurement, from real Actions history. TASK-13.
 *
 * WHY THIS EXISTS AS A TOOL AND NOT A ONE-OFF SCRIPT
 *
 * Every performance claim in this repository has to be reproducible by someone
 * who does not trust the person who made it. A number pasted into a document
 * cannot be re-derived or challenged; a command can. So the measurement lives
 * here, the report cites the command, and anyone can run it again.
 *
 * WHAT IT MEASURES, AND WHAT IT REFUSES TO MEASURE
 *
 * Per-job wall time from `gh run view`, aggregated to P50/P90/max with the
 * sample size attached. Jobs are NOT summed into a PR duration - parallel jobs
 * overlap, and adding them produces a number larger than the wall clock
 * (measured: the sum of successful jobs on one fanout is ~4x the actual
 * end-to-end).
 *
 * PR end-to-end is measured as the span from the earliest workflow run created
 * for one push to the latest workflow finishing, because that is what a
 * developer actually waits for.
 *
 * Only successful runs are sampled for job durations: a failed run usually has
 * truncated jobs, and mixing them pulls every percentile down in a way that
 * looks like an improvement.
 *
 * USAGE
 *
 *   node scripts/ci/ci-cost.mjs jobs --workflow ci.yml --limit 25 [--json]
 *   node scripts/ci/ci-cost.mjs e2e  --limit 40 [--json]
 *
 * Exits non-zero when `gh` is unavailable or no samples are found, because a
 * measurement tool that silently reports nothing on failure is worse than none.
 */
import { execFileSync } from 'node:child_process';

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Successful runs of one workflow, newest first. */
export function successfulRuns(workflow, limit) {
  return gh(['run', 'list', '--workflow', workflow, '--limit', String(limit),
    '--json', 'databaseId,conclusion'])
    .filter((r) => r.conclusion === 'success')
    .map((r) => r.databaseId);
}

/** Completed job durations for one run: `[{name, seconds}]`. */
export function jobDurations(runId) {
  const run = gh(['run', 'view', String(runId), '--json', 'jobs']);
  return (run.jobs ?? [])
    .filter((j) => j.conclusion === 'success' && j.startedAt && j.completedAt)
    .map((j) => ({
      name: j.name,
      seconds: (Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 1000,
    }));
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/** Aggregate `[[seconds]]` into {n, p50, p90, max}. */
export function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

/**
 * PR end-to-end spans, grouped by the minute the fanout started.
 *
 * A push that triggers six workflows produces six runs with the same
 * `createdAt` to the second; grouping by minute is enough to reunite them and
 * loose enough to survive the one-second skew GitHub sometimes records.
 *
 * @returns {{start: string, seconds: number, workflows: number}[]}
 */
export function fanoutSpans(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (!run.createdAt || !run.updatedAt) continue;
    const key = run.createdAt.slice(0, 16);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const out = [];
  for (const [key, group] of groups) {
    const start = Math.min(...group.map((r) => Date.parse(r.createdAt)));
    const end = Math.max(...group.map((r) => Date.parse(r.updatedAt)));
    out.push({ start: key, seconds: (end - start) / 1000, workflows: group.length });
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

// ---------------------------------------------------------------------------

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const argv = process.argv.slice(2);
const mode = argv[0];
const asJson = argv.includes('--json');

if (mode === 'jobs') {
  const workflow = arg(argv, 'workflow');
  const limit = Number(arg(argv, 'limit', '25'));
  if (!workflow) {
    process.stderr.write('usage: ci-cost.mjs jobs --workflow <file> [--limit N] [--json]\n');
    process.exit(2);
  }
  const runs = successfulRuns(workflow, limit);
  if (runs.length === 0) {
    process.stderr.write(`no successful runs for ${workflow} in the last ${limit}; nothing to measure\n`);
    process.exit(1);
  }
  const byJob = new Map();
  for (const run of runs) {
    for (const { name, seconds } of jobDurations(run)) {
      if (!byJob.has(name)) byJob.set(name, []);
      byJob.get(name).push(seconds);
    }
  }
  const rows = [...byJob.entries()]
    .map(([name, samples]) => ({ name, ...summarise(samples) }))
    .sort((a, b) => b.p50 - a.p50);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ workflow, runs: runs.length, jobs: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`${workflow}  (${runs.length} successful runs)\n`);
    process.stdout.write(`${'job'.padEnd(40)}${'n'.padStart(4)}${'p50'.padStart(8)}${'p90'.padStart(8)}${'max'.padStart(8)}\n`);
    for (const r of rows) {
      process.stdout.write(`${r.name.slice(0, 39).padEnd(40)}${String(r.n).padStart(4)}`
        + `${r.p50.toFixed(0).padStart(8)}${r.p90.toFixed(0).padStart(8)}${r.max.toFixed(0).padStart(8)}\n`);
    }
  }
} else if (mode === 'e2e') {
  const limit = Number(arg(argv, 'limit', '40'));
  const runs = gh(['run', 'list', '--event', 'pull_request', '--limit', String(limit),
    '--json', 'databaseId,workflowName,conclusion,createdAt,updatedAt'])
    .filter((r) => r.conclusion === 'success' || r.conclusion === 'failure');
  const spans = fanoutSpans(runs).filter((s) => s.workflows > 1);
  if (spans.length === 0) {
    process.stderr.write('no multi-workflow fanouts in the sample\n');
    process.exit(1);
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ spans, summary: summarise(spans.map((s) => s.seconds)) }, null, 2)}\n`);
  } else {
    for (const s of spans.slice(0, 10)) {
      process.stdout.write(`${s.start}  end-to-end=${s.seconds.toFixed(0).padStart(5)}s  workflows=${s.workflows}\n`);
    }
    const sum = summarise(spans.map((s) => s.seconds));
    process.stdout.write(`PR end-to-end: n=${sum.n} p50=${sum.p50.toFixed(0)}s p90=${sum.p90.toFixed(0)}s max=${sum.max.toFixed(0)}s\n`);
  }
} else {
  process.stderr.write('usage: ci-cost.mjs jobs|e2e\n');
  process.exit(2);
}
