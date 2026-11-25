#!/usr/bin/env node
/**
 * Phase 8 TASK-23: a performance baseline you can actually compare against.
 *
 * THE PROBLEM WITH THE PREVIOUS ONE
 *
 * `docs/ci/golden-path-timing.md` compares two runs of one commit and reports a
 * 139-second difference. That number is real, and it is not usable as a baseline,
 * because a single pair cannot tell you whether 139 s is the noise floor or a
 * one-off. It also compares runs taken at different times under different load.
 *
 * The rule the brief sets is the standard one: SAME SHA, MULTIPLE SAMPLES, and a
 * spread you quote instead of a point you compare. This tool produces that from
 * the instrumentation `tests/ci/run_step.sh` already emits - 41 `STEP result=`
 * lines per run - so nothing new is measured, only aggregated honestly.
 *
 * WHAT IT REPORTS PER STEP
 *
 *   n      how many runs contributed a sample
 *   min/median/max   seconds, over those runs
 *   spread max - min, which is the resolution any future claim must exceed
 *
 * And it separates two kinds of time that a naive total conflates:
 *
 *   FIXED_WAIT   a step whose duration is mostly the step's own sleep/TTL. The
 *                golden path contains a 15 s drain and a 60 s readiness bound by
 *                design; those are not slowness and cannot be optimized away
 *                without changing behaviour. Named explicitly so a report cannot
 *                present them as headroom.
 *   FIXTURE      time spent waiting for something external (an image build, a
 *                container pull). Real, but attributable to the environment.
 *
 * The classification is by step NAME, listed in one table below, because inferring
 * "this is a TTL wait" from a duration would be exactly the guess this file exists
 * to avoid.
 *
 * Usage:
 *   node tests/ci/golden-path-baseline.mjs --sha <sha> [--samples N]
 *   node tests/ci/golden-path-baseline.mjs --runs <id,id,...>   # explicit samples
 *   node tests/ci/golden-path-baseline.mjs --from-dir <dir>     # saved STEP logs
 *   node tests/ci/golden-path-baseline.mjs --json
 *
 * Requires `gh` for the live mode. Exits 0 whenever it produced a baseline; a
 * baseline is a measurement, not a gate.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const SHA = arg('--sha');
const SAMPLE_LIMIT = Number(arg('--samples') ?? 8);
const EXPLICIT_RUNS = arg('--runs')?.split(',').filter(Boolean) ?? null;
const FROM_DIR = arg('--from-dir');
const AS_JSON = argv.includes('--json');

// ---------------------------------------------------------------------------
// The two kinds of time that are not slowness, named rather than inferred.
//
// `FIXED_WAIT` - the step's own designed wait (a drain window, a readiness poll
//   bound). Removing it changes behaviour, so it is not optimization headroom.
// `FIXTURE` - waiting on an external build or pull. Real time, environment's.
// `JOB_RUN` - a step that POLLS FOR A WORKLOAD TO FINISH under a bounded timeout.
//   Its duration is how long the workload ran, which is the thing under test, not
//   overhead around it. A wide spread here is a fact about the workload, and
//   optimizing the poll would change nothing.
// Everything else is `WORK`.
//
// Kept as a table because a heuristic over durations ("anything over 30 s is a
// wait") would misclassify both a slow build and a fast TTL.
// ---------------------------------------------------------------------------
const CLASS_OF = {
  // A 15-second drain is part of the deployment contract.
  deploy_wait: 'FIXED_WAIT',
  drain: 'FIXED_WAIT',
  // Image builds and container pulls depend on the registry and the daemon.
  build_plugins: 'FIXTURE',
  build_images: 'FIXTURE',
  image_build: 'FIXTURE',
  pull: 'FIXTURE',
  // Measured: `pipeline_long_heartbeat` took 166 s in run 45106622557 and 15 s in
  // 45110138967 - the entire 139 s difference the previous baseline reported as
  // noise. Both logs are identical up to "the lease stayed ACTIVE across the
  // outage"; the divergence is a single poll, `until_state "the job to reach a
  // terminal state" 180`, waiting for the pipeline JOB to finish. That is the
  // workload running, and it is what this step exists to measure.
  pipeline_long_heartbeat: 'JOB_RUN',
  kernel_restart_takeover: 'JOB_RUN',
  pipeline_orphan_worker: 'JOB_RUN',
  pipeline_node_runtime_sigkill: 'JOB_RUN',
};
const classOf = (name) => CLASS_OF[name] ?? 'WORK';

function parseStepLines(text) {
  // `STEP result=PASS name=supervisor_lifecycle start=… end=… secs=96 pid=… rc=0`
  const steps = [];
  for (const line of text.split('\n')) {
    const m = /STEP result=(\S+) name=(\S+) .*?secs=(\d+)/.exec(line);
    if (m) steps.push({ result: m[1], name: m[2], secs: Number(m[3]) });
  }
  return steps;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// Gather samples. Each sample is one run's list of steps.
// ---------------------------------------------------------------------------
const samples = [];   // { run, steps: [{name, secs}] }
const skipped = [];

if (FROM_DIR) {
  for (const file of readdirSync(FROM_DIR).filter((f) => f.endsWith('.log'))) {
    const steps = parseStepLines(readFileSync(join(FROM_DIR, file), 'utf8'));
    if (steps.length) samples.push({ run: file, steps });
  }
} else {
  let runIds = EXPLICIT_RUNS;
  if (!runIds) {
    if (!SHA) {
      process.stderr.write('need --sha, --runs or --from-dir\n');
      process.exit(2);
    }
    // EVERY run of this SHA, newest first. Filtering to successful ones because a
    // cancelled run stops mid-way and its missing steps would read as zeros.
    const list = JSON.parse(sh('gh', [
      'run', 'list', '--repo', 'baicie/ops-1', '--workflow', 'data-foundation.yml',
      '--limit', '60', '--json', 'databaseId,headSha,conclusion',
    ]));
    runIds = list
      .filter((r) => r.headSha.startsWith(SHA) && r.conclusion === 'success')
      .slice(0, SAMPLE_LIMIT)
      .map((r) => String(r.databaseId));
    if (runIds.length === 0) {
      process.stderr.write(
        `no successful data-foundation run for ${SHA}. A baseline needs at least one;\n` +
        `run the workflow, or pass --runs with explicit ids.\n`,
      );
      process.exit(2);
    }
  }
  for (const id of runIds) {
    try {
      const log = sh('gh', ['run', 'view', id, '--repo', 'baicie/ops-1', '--log']);
      const steps = parseStepLines(log);
      if (steps.length) samples.push({ run: id, steps });
      else skipped.push({ run: id, why: 'no STEP lines in its log' });
    } catch (error) {
      skipped.push({ run: id, why: String(error.message).split('\n')[0] });
    }
  }
}

if (samples.length === 0) {
  process.stderr.write('no samples could be read; nothing to report\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Aggregate per step.
// ---------------------------------------------------------------------------
const byStep = new Map();
for (const { run, steps } of samples) {
  for (const s of steps) {
    if (!byStep.has(s.name)) byStep.set(s.name, []);
    byStep.get(s.name).push({ run, secs: s.secs, result: s.result });
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [...byStep.entries()].map(([name, obs]) => {
  const secs = obs.map((o) => o.secs);
  return {
    name,
    klass: classOf(name),
    n: obs.length,
    min: Math.min(...secs),
    median: median(secs),
    max: Math.max(...secs),
    spread: Math.max(...secs) - Math.min(...secs),
    failed: obs.filter((o) => o.result !== 'PASS').length,
  };
}).sort((a, b) => b.median - a.median);

const totals = samples.map(({ run, steps }) => ({
  run, total: steps.reduce((n, s) => n + s.secs, 0), steps: steps.length,
}));
const totalsSecs = totals.map((t) => t.total);

const byClass = {};
for (const r of rows) {
  byClass[r.klass] = byClass[r.klass] ?? { steps: 0, medianSum: 0 };
  byClass[r.klass].steps += 1;
  byClass[r.klass].medianSum += r.median;
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    samples: samples.length,
    runs: samples.map((s) => s.run),
    skipped,
    totals,
    totalSpread: Math.max(...totalsSecs) - Math.min(...totalsSecs),
    rows,
    byClass,
  }, null, 2) + '\n');
} else {
  process.stdout.write(
    `golden path baseline from ${samples.length} sample(s)\n` +
    `  runs: ${samples.map((s) => s.run).join(', ')}\n\n`,
  );
  if (skipped.length) {
    process.stdout.write(`  skipped: ${skipped.map((s) => `${s.run} (${s.why})`).join('; ')}\n\n`);
  }
  process.stdout.write('  total per sample: ' + totals.map((t) => `${t.run}=${t.total}s`).join('  ') + '\n');
  process.stdout.write(
    `  spread across samples: ${Math.max(...totalsSecs) - Math.min(...totalsSecs)}s` +
    `   <-- a claim smaller than this is inside the noise\n\n`,
  );
  process.stdout.write(
    `${'secs'.padStart(6)} ${'min'.padStart(6)} ${'max'.padStart(6)} ${'spread'.padStart(7)}  ${'n'.padStart(2)}  class        step\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${String(r.median).padStart(6)} ${String(r.min).padStart(6)} ${String(r.max).padStart(6)} ` +
      `${String(r.spread).padStart(7)}  ${String(r.n).padStart(2)}  ${r.klass.padEnd(12)} ${r.name}` +
      `${r.failed ? `  (${r.failed} non-PASS)` : ''}\n`,
    );
  }
  process.stdout.write('\n  by class (sum of medians): ');
  for (const [k, v] of Object.entries(byClass)) {
    process.stdout.write(`${k}=${v.medianSum}s over ${v.steps} step(s)  `);
  }
  process.stdout.write('\n');
}

/*
 * WHAT THIS DOES NOT DO
 *
 * It does not claim any step is "slow" or "improvable". A large FIXED_WAIT is the
 * contract; a large FIXTURE is the environment. A large WORK step with a small
 * spread is where a real optimization would have to show up, and it would have to
 * beat the spread above to be measurable at all.
 *
 * It also does not record cache state. The brief asks for cold/warm to be kept
 * apart, and this tool cannot see it: the workflow uses a cargo cache but does not
 * report whether it hit, so a cold/warm split would be a guess. Recorded as a gap
 * rather than filled with an assumption - the fix is to make the workflow publish
 * `cache-hit`, which is a change to the workflow rather than to this report.
 */
