#!/usr/bin/env node
/**
 * CI cost measurement, from real Actions history.
 *
 * WHY THIS EXISTS AS A TOOL AND NOT A ONE-OFF SCRIPT
 *
 * Every performance claim in this repository has to be reproducible by someone
 * who does not trust the person who made it. A number pasted into a document
 * cannot be re-derived or challenged; a command can.
 *
 * WHAT THE FIRST VERSION GOT WRONG, AND WHY THIS ONE IS DIFFERENT
 *
 * Version 1 grouped runs into a "fanout" by `createdAt.slice(0, 16)` - the
 * minute a run was created. That key is not an identity:
 *
 *   - two PRs pushed in the same minute collapse into one group;
 *   - one PR pushed twice in a minute collapses into one group, so the second
 *     push's workflows are measured against the first push's start time;
 *   - a `workflow_dispatch` started at the same moment joins the group and its
 *     duration is charged to the PR;
 *   - a rerun (`run_attempt > 1`) shares the original's `createdAt` and is
 *     measured as though it were part of the original execution.
 *
 * A wrong grouping produces a wrong critical path, and the critical path is the
 * thing every speed-up decision was based on. So the group key is now the push
 * itself: repository + head SHA + event. Runs whose identity is missing are
 * reported as UNGROUPABLE rather than being quietly merged into whatever group
 * has a matching minute.
 *
 * THREE MEASUREMENTS THAT ARE OFTEN CONFLATED
 *
 *   workflow span      created_at -> updated_at of one run. This is what the
 *                      developer waits for on that workflow.
 *   queue delay        for one job: started_at - created_at. Not the same as
 *                      "the runner is busy": a job with `needs:` waits for its
 *                      dependencies first, and GitHub reports both as the same
 *                      interval. The two are separated below only when the job
 *                      data distinguishes them, which it does for `needs`
 *                      jobs (they start after their dependencies complete).
 *   fanout span        earliest created_at -> latest updated_at across every
 *                      run for one push.
 *
 * `queueDelay` is REPORTED, never asserted to be zero. The earlier claim that
 * "queue overhead is zero" was derived from `fanout span - longest workflow`,
 * which cannot see a queue at all: if every workflow's first job queues for 90
 * seconds, the difference is still zero.
 *
 * STATISTICS
 *
 * Percentiles use the NEAREST-RANK method: for n sorted samples, index
 * `ceil(p * n) - 1`, clamped. It is defined here so a reader can recompute a
 * published number by hand. Every summary prints n, min, max, and the window,
 * because a P50 without a sample size is not a measurement.
 *
 * Samples come from runs whose `conclusion` is `success`; the count of runs
 * that were examined and excluded is printed too, so "n=9" cannot hide that
 * forty were skipped.
 *
 * USAGE
 *
 *   node scripts/ci/ci-cost.mjs jobs --workflow ci.yml --limit 25 [--json]
 *   node scripts/ci/ci-cost.mjs e2e  --limit 60 [--json]
 *   node scripts/ci/ci-cost.mjs queue --limit 40 [--json]
 *
 * Exits non-zero when `gh` is unavailable or no samples are found, because a
 * measurement tool that silently reports nothing on failure is worse than none.
 */
import { execFileSync } from 'node:child_process';

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

const FIELDS = 'databaseId,workflowName,conclusion,status,createdAt,updatedAt,headSha,event,headBranch,attempt,url';

/** Successful runs of one workflow, newest first, with how many were excluded. */
export function successfulRuns(workflow, limit) {
  const all = gh(['run', 'list', '--workflow', workflow, '--limit', String(limit),
    '--json', `${FIELDS},headBranch`]);
  const ok = all.filter((r) => r.conclusion === 'success');
  return { runs: ok.map((r) => r.databaseId), examined: all.length, excluded: all.length - ok.length };
}

/**
 * Completed job durations for one run: `[{name, seconds, queueSeconds}]`.
 *
 * REST, not `gh run view --json jobs`: that command's job objects have no
 * `createdAt`, so a queue measurement built on it silently produced an empty
 * table (measured - the first `queue` run printed a header and no rows).
 * `/actions/runs/{id}/jobs` does carry `created_at`.
 */
export function jobDurations(runId) {
  const run = gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`]);
  return (run.jobs ?? [])
    .filter((j) => j.conclusion === 'success' && j.started_at && j.completed_at)
    .map((j) => ({
      name: j.name,
      seconds: (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000,
      // created_at for a job is when it entered the queue; started_at is when a
      // runner picked it up. The difference includes any `needs:` wait.
      queueSeconds: j.created_at
        ? (Date.parse(j.started_at) - Date.parse(j.created_at)) / 1000
        : null,
    }));
}

/**
 * Nearest-rank percentile over a SORTED array.
 *
 * `index = ceil(p * n) - 1`, clamped to [0, n-1]. Defined rather than borrowed
 * so a published number can be recomputed by hand: for n=10, P50 is the 5th
 * value (index 4), P90 the 9th, P95 the 10th.
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** Aggregate `[seconds]` into a summary that cannot hide its own sample size. */
export function summarise(samples) {
  if (samples.length === 0) return { n: 0, p50: null, p90: null, p95: null, min: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Group runs into a fanout by the PUSH that caused them.
 *
 * The key is `headSha + event`, not a timestamp. Two PRs pushed in the same
 * minute are two groups; one PR pushed twice is two groups; a
 * `workflow_dispatch` is never merged with a `push`.
 *
 * A run with no `headSha` cannot be attributed and is returned separately as
 * UNGROUPABLE - it is not silently dropped, because a tool that loses samples
 * without saying so is worse than one that refuses them.
 *
 * @returns {{groups: {key: string, sha: string, event: string, runs: object[]}[],
 *            ungroupable: object[]}}
 */
export function groupByPush(runs) {
  const groups = new Map();
  const ungroupable = [];
  for (const run of runs) {
    if (!run.headSha || !run.event) { ungroupable.push(run); continue; }
    // `pull_request` runs are keyed by the merge commit GitHub creates; keeping
    // the event in the key stops a push and a PR for the same SHA merging.
    const key = `${run.headSha}:${run.event}`;
    if (!groups.has(key)) {
      groups.set(key, { key, sha: run.headSha, event: run.event, headBranch: run.headBranch, runs: [] });
    }
    groups.get(key).runs.push(run);
  }
  const out = [...groups.values()].map((g) => {
    const starts = g.runs.map((r) => Date.parse(r.createdAt)).filter(Number.isFinite);
    const ends = g.runs.map((r) => Date.parse(r.updatedAt)).filter(Number.isFinite);
    const longest = g.runs
      .map((r) => (Date.parse(r.updatedAt) - Date.parse(r.createdAt)) / 1000)
      .filter(Number.isFinite);
    const attempts = g.runs.map((r) => Number(r.attempt ?? 1));
    return {
      ...g,
      workflows: g.runs.length,
      // A rerun is a SEPARATE execution of the same push. It does not create a
      // second row in `run list` - `attempt` is an attribute of one run - so it
      // cannot split a group. What it does do is make the group's duration
      // describe the last attempt plus every retry, which is why the count is
      // carried out: a sample full of reruns is a sample of slow pushes.
      retriedWorkflows: attempts.filter((a) => a > 1).length,
      // The span of the fanout. NOT the queue, and NOT a per-job measurement.
      spanSeconds: starts.length && ends.length ? (Math.max(...ends) - Math.min(...starts)) / 1000 : null,
      longestWorkflowSeconds: longest.length ? Math.max(...longest) : null,
      // Everything that is not the longest workflow: setup skew between the
      // workflows in this push. This is NOT queueing - see the header.
      startSkewSeconds: starts.length ? (Math.max(...starts) - Math.min(...starts)) / 1000 : null,
    };
  });
  out.sort((a, b) => String(b.key).localeCompare(String(a.key)));
  return { groups: out, ungroupable };
}

// ---------------------------------------------------------------------------

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(0));

// Only run the CLI when this file IS the program. Without this guard, importing
// it for its exported functions executes the argument parser - measured: the
// new test file failed with "usage: ci-cost.mjs jobs|e2e|queue" before running
// a single case.
const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

const argv = RUN_AS_PROGRAM ? process.argv.slice(2) : [];
const mode = argv[0];
const asJson = argv.includes('--json');

if (!RUN_AS_PROGRAM) {
  // imported: export only, no side effects
} else if (mode === 'jobs') {
  const workflow = arg(argv, 'workflow');
  const limit = Number(arg(argv, 'limit', '25'));
  if (!workflow) {
    process.stderr.write('usage: ci-cost.mjs jobs --workflow <file> [--limit N] [--json]\n');
    process.exit(2);
  }
  const { runs, examined, excluded } = successfulRuns(workflow, limit);
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
    .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ workflow, examined, excluded, runs: runs.length, jobs: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`${workflow}  ${runs.length} successful runs`
      + ` (examined ${examined}, excluded ${excluded})\n`);
    process.stdout.write(`${'job'.padEnd(38)}${'n'.padStart(4)}${'min'.padStart(7)}${'p50'.padStart(7)}`
      + `${'p90'.padStart(7)}${'p95'.padStart(7)}${'max'.padStart(7)}\n`);
    for (const r of rows) {
      process.stdout.write(`${r.name.slice(0, 37).padEnd(38)}${String(r.n).padStart(4)}`
        + `${fmt(r.min).padStart(7)}${fmt(r.p50).padStart(7)}${fmt(r.p90).padStart(7)}`
        + `${fmt(r.p95).padStart(7)}${fmt(r.max).padStart(7)}\n`);
    }
  }
} else if (mode === 'e2e') {
  const limit = Number(arg(argv, 'limit', '60'));
  const runs = gh(['run', 'list', '--limit', String(limit), '--json', FIELDS]);
  const finished = runs.filter((r) => r.status === 'completed');
  const { groups, ungroupable } = groupByPush(finished);
  if (groups.length === 0) {
    process.stderr.write('no attributable fanouts in the sample\n');
    process.exit(1);
  }
  const spans = groups.map((g) => g.spanSeconds).filter((v) => v !== null);
  const summary = summarise(spans);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ groups, ungroupable: ungroupable.length, summary }, null, 2)}\n`);
  } else {
    if (ungroupable.length) {
      process.stdout.write(`UNGROUPABLE: ${ungroupable.length} run(s) had no headSha or event and were`
        + ' excluded rather than merged into a neighbouring group\n');
    }
    for (const g of groups.slice(0, 10)) {
      process.stdout.write(`${g.sha.slice(0, 7)} ${g.event.padEnd(16)} workflows=${String(g.workflows).padStart(2)}`
        + ` span=${fmt(g.spanSeconds).padStart(5)}s longest=${fmt(g.longestWorkflowSeconds).padStart(5)}s`
        + ` startSkew=${fmt(g.startSkewSeconds).padStart(4)}s\n`);
    }
    process.stdout.write(`fanout span: n=${summary.n} min=${fmt(summary.min)}s p50=${fmt(summary.p50)}s`
      + ` p90=${fmt(summary.p90)}s p95=${fmt(summary.p95)}s max=${fmt(summary.max)}s\n`);
    process.stdout.write('startSkew is the spread of workflow creation times within one push.'
      + ' It is NOT runner queueing: a queued job still has a workflow that started.\n');
  }
} else if (mode === 'queue') {
  // Per-job queue delay, the measurement that `fanout span - longest` cannot see.
  const limit = Number(arg(argv, 'limit', '40'));
  const runs = gh(['run', 'list', '--limit', String(limit), '--json', FIELDS])
    .filter((r) => r.status === 'completed')
    .map((r) => r.databaseId);
  if (runs.length === 0) {
    process.stderr.write('no completed runs in the sample\n');
    process.exit(1);
  }
  const byJob = new Map();
  for (const id of runs) {
    for (const { name, queueSeconds } of jobDurations(id)) {
      if (queueSeconds === null) continue;
      if (!byJob.has(name)) byJob.set(name, []);
      byJob.get(name).push(queueSeconds);
    }
  }
  const rows = [...byJob.entries()]
    .map(([name, samples]) => ({ name, ...summarise(samples) }))
    .sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ runs: runs.length, jobs: rows }, null, 2)}\n`);
  } else {
    process.stdout.write(`job queue delay (started_at - created_at), ${runs.length} completed runs\n`);
    process.stdout.write('this interval INCLUDES any `needs:` wait; it is not purely runner queueing\n');
    process.stdout.write(`${'job'.padEnd(38)}${'n'.padStart(4)}${'min'.padStart(7)}${'p50'.padStart(7)}`
      + `${'p90'.padStart(7)}${'max'.padStart(7)}\n`);
    for (const r of rows) {
      process.stdout.write(`${r.name.slice(0, 37).padEnd(38)}${String(r.n).padStart(4)}`
        + `${fmt(r.min).padStart(7)}${fmt(r.p50).padStart(7)}${fmt(r.p90).padStart(7)}`
        + `${fmt(r.max).padStart(7)}\n`);
    }
  }
} else {
  process.stderr.write('usage: ci-cost.mjs jobs|e2e|queue\n');
  process.exit(2);
}
