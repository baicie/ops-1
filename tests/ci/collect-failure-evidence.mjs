#!/usr/bin/env node
/**
 * Phase 8A TASK-28: evidence attributed to a job, a step and an attempt - not to a run.
 *
 * THE DEFECT THIS REPLACES
 *
 * V1 found "the first failure line in the whole log" and hung the entire artifact
 * off it. A run with four failed jobs got one cause, taken from whichever job
 * logged a marker first. Three consequences, all measured:
 *
 *   - a matrix job that failed for a capacity refusal and a job that failed for an
 *     assertion produced ONE classification, and it was the capacity one;
 *   - `run_attempt` was recorded but never fixed, so a re-run landing mid-collection
 *     could mix two attempts' jobs and logs into one artifact that looks coherent;
 *   - an API error was swallowed (`tryGh` returns the error text as if it were the
 *     response body) and the artifact was still written, complete-looking, with no
 *     jobs and no log. A 403 became "this run had no failures".
 *
 * THE MODEL
 *
 *   Run -> Attempt -> Job -> Step -> Log Range
 *
 * Every failed job is collected on its own, with its own failed steps, its own log
 * range (scoped by the job/step prefix `gh run view --log` writes), its own
 * classification, and its own `sourceStatus`. The attempt is pinned from the run
 * object before anything else is fetched and is asserted on every subsequent call.
 *
 * COMPLETENESS IS A FIELD, NOT AN IMPLICATION
 *
 *   COMPLETE     every failed job's steps and log ranges were read
 *   PARTIAL      something could not be read, and `omissions` says what
 *   UNAVAILABLE  the run itself could not be read; the artifact says so and exits 2
 *
 * An API error never becomes an empty list. That is the whole point: an empty
 * `failedJobs` is a claim, and this tool may only make it after reading the API.
 *
 * OFFLINE AND ONLINE SHARE ONE PATH
 *
 * `--from-json` replaces only the FETCH. Everything after it - scoping, attribution,
 * classification, redaction, budget, schema - is the same code, which is why the
 * fixture tests exercise the real logic rather than a parallel one.
 *
 * Usage:
 *   node tests/ci/collect-failure-evidence.mjs --run <id> [--out path] [--json]
 *   node tests/ci/collect-failure-evidence.mjs --from-json <fixture.json> [--out path]
 *   node tests/ci/collect-failure-evidence.mjs --redact-only < text
 */
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeText, sanitizeArtifact, findLeaks, NOTICE } from './lib/evidence-sanitize.mjs';
import { fitBudget, byteLength } from './lib/evidence-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const AS_JSON = argv.includes('--json');
const OUT = arg('--out');
const REPO = 'baicie/ops-1';
const SCHEMA_VERSION = 2;

// 512 KiB per log section, MEASURED IN BYTES. V1 measured bytes and cut characters,
// so a section of CJK or emoji log text could serialise to 1.5 MB.
const MAX_LOG_BYTES = 512 * 1024;
// The whole serialised artifact. Structure survives this cap; detail does not.
const MAX_ARTIFACT_BYTES = Number(arg('--max-bytes') ?? 512 * 1024);
// A log larger than this is not read at all into one string by an unbounded fetch.
const MAX_LOG_READ_BYTES = Number(arg('--max-log-bytes') ?? 64 * 1024 * 1024);
const FETCH_TIMEOUT_MS = Number(arg('--timeout-ms') ?? 120_000);

// ---------------------------------------------------------------------------
// Redaction-only mode: no API, no classification.
// It reads stdin and writes the redacted text. A rule that is only reachable
// through a 40 MB log download is a rule nobody tests.
// ---------------------------------------------------------------------------
if (argv.includes('--redact-only')) {
  // The known-secret channel applies here too. A value the caller HOLDS is the one
  // case shape rules cannot cover, and the redaction-only mode is exactly where a
  // caller tests that before trusting the collector.
  const known = (process.env.OPSWEAVE_EVIDENCE_SENTINELS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  process.stdout.write(sanitizeText(readFileSync(0, 'utf8'), { extraSecrets: known }));
  process.exit(0);
}

const RUN = arg('--run');
const FROM_JSON = arg('--from-json');
if (!RUN && !FROM_JSON) {
  process.stderr.write('usage: collect-failure-evidence.mjs --run <id> [--context 60] [--out path] [--json]\n'
    + '       collect-failure-evidence.mjs --from-json <fixture.json> [--out path]\n'
    + '       collect-failure-evidence.mjs --redact-only < text\n');
  process.exit(2);
}

const omit = [];
const note = (what, why) => omit.push({ what, why });

// ---------------------------------------------------------------------------
// Fetch. Every failure is a RECORDED status, never an empty list.
//
// V1's `tryGh` returned `stdout + stderr` as though it were the response, so a 403
// produced `JSON.parse('gh: Resource not accessible') || '{}'` -> `{}` -> "no jobs".
// The artifact then said `failedJobs: []` in the same voice it uses for a run that
// genuinely had none.
// ---------------------------------------------------------------------------
function ghJson(path) {
  try {
    const out = execFileSync('gh', ['api', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS,
    });
    return { ok: true, value: JSON.parse(out) };
  } catch (e) {
    const stderr = String(e.stderr ?? '').trim();
    const status = Number((stderr.match(/\(HTTP (\d{3})\)/) ?? [])[1] ?? 0) || null;
    return { ok: false, status, error: stderr.split('\n')[0]?.slice(0, 300) ?? String(e.message).slice(0, 300) };
  }
}

function ghLog(runId, attempt) {
  try {
    const out = execFileSync('gh', ['run', 'view', String(runId), '--repo', REPO, '--log', ...(attempt > 1 ? ['--attempt', String(attempt)] : [])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_LOG_READ_BYTES, timeout: FETCH_TIMEOUT_MS,
    });
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: String(e.stderr ?? e.message ?? '').trim().split('\n')[0]?.slice(0, 300) ?? 'unknown' };
  }
}

let fixture = null;
let run = null;
let jobs = null;
let rawLog = '';
let runStatus = 'UNAVAILABLE';

if (FROM_JSON) {
  fixture = JSON.parse(readFileSync(FROM_JSON, 'utf8'));
  run = fixture.run ?? null;
  const j = fixture.jobs;
  jobs = Array.isArray(j) ? j : (j?.jobs ?? null);
  rawLog = String(fixture.log ?? '');
  runStatus = run?.id ? 'COMPLETE' : 'UNAVAILABLE';
  if (!run?.id) note('run', 'the fixture has no run.id, so there is no artifact to build');
} else {
  const r = ghJson(`repos/${REPO}/actions/runs/${RUN}`);
  if (!r.ok) {
    runStatus = 'UNAVAILABLE';
    note('run', `the run could not be read: ${r.status ? `HTTP ${r.status}: ` : ''}${r.error}`);
  } else {
    run = r.value;
    // PIN THE ATTEMPT before anything else. A re-run during collection would
    // otherwise mix two attempts' jobs into one artifact.
    const pinnedAttempt = run.run_attempt ?? 1;
    const j = ghJson(`repos/${REPO}/actions/runs/${RUN}/attempts/${pinnedAttempt}/jobs`);
    if (j.ok) {
      jobs = j.value.jobs ?? [];
      runStatus = 'COMPLETE';
    } else {
      // FALL BACK to the un-attempted endpoint, and say so. The fallback is what
      // V1 did SILENTLY; here it is recorded, because the two endpoints can return
      // different attempts' jobs when a re-run is in flight.
      const j2 = ghJson(`repos/${REPO}/actions/runs/${RUN}/jobs`);
      if (j2.ok) {
        jobs = j2.value.jobs ?? [];
        runStatus = 'PARTIAL';
        note('jobs', `the attempt-pinned endpoint failed (${j.status ? `HTTP ${j.status}: ` : ''}${j.error}); `
          + 'jobs were read from the unpinned endpoint, so they may belong to a different attempt');
      } else {
        runStatus = 'PARTIAL';
        note('jobs', `jobs could not be read: ${j2.status ? `HTTP ${j2.status}: ` : ''}${j2.error}`);
      }
    }
    const l = ghLog(RUN, pinnedAttempt);
    if (l.ok) rawLog = l.value;
    else {
      if (runStatus === 'COMPLETE') runStatus = 'PARTIAL';
      note('log', `the log could not be read: ${l.error}`);
    }
    if (byteLength(rawLog) >= MAX_LOG_READ_BYTES) {
      if (runStatus === 'COMPLETE') runStatus = 'PARTIAL';
      note('log', `the log was truncated at the ${MAX_LOG_READ_BYTES}-byte read limit; only its first ${MAX_LOG_READ_BYTES} bytes were examined`);
    }
  }
}

if (runStatus === 'UNAVAILABLE') {
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    source: FROM_JSON ? { kind: 'fixture', path: FROM_JSON } : { kind: 'github', repo: REPO, runId: Number(RUN) || RUN },
    completeness: { status: 'UNAVAILABLE', reason: omit[0]?.why ?? 'the run could not be read' },
    omissions: omit,
    run: null,
    failedJobs: [],
    redaction: NOTICE,
  };
  const text = JSON.stringify(artifact, null, 2);
  if (AS_JSON) process.stdout.write(`${text}\n`);
  else process.stderr.write(`UNAVAILABLE: ${artifact.completeness.reason}\n`);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, `${text}\n`); }
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The log, sanitised on the way in and split into per-(job, step) sections.
//
// Sanitising before splitting means a secret cannot reach a child process (the
// classifier) or a crash dump. It does not change the structure the classifier
// reads: no rule touches digits, HTTP statuses, or the word FAIL. That claim is
// asserted in the test rather than trusted here.
// ---------------------------------------------------------------------------
const log = sanitizeText(rawLog);
const allLines = log.split('\n');

/**
 * `gh run view --log` writes `<job>\t<step>\t<timestamp> <message>`.
 *
 * A line with fewer than two tabs has no parsable prefix. Those lines are kept in
 * the run-level `unattributedLines` rather than being assigned to whichever job was
 * seen last - assigning them is how a global error becomes a specific job's fault.
 */
function splitLines(text) {
  const sections = new Map();
  const unattributed = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) { if (line.trim()) unattributed.push(line); continue; }
    const key = `${parts[0]}\t${parts[1]}`;
    if (!sections.has(key)) sections.set(key, { job: parts[0], step: parts[1], lines: [] });
    sections.get(key).lines.push(line);
  }
  return { sections, unattributed };
}
const { sections, unattributed } = splitLines(log);

// ---------------------------------------------------------------------------
// Per-job collection.
// ---------------------------------------------------------------------------
const classificationCache = new Map();

/**
 * Classify one job through the shared classifier, not a private rule set.
 *
 * The classifier is given the job's lines AND that job's API step conclusions, via
 * the `--from-json` path it already supports. Passing only lines would force it into
 * degraded mode - it would have to infer step boundaries and would not know which
 * step the API says failed - and the collector is holding exactly that information.
 * Reusing the fixture entry point rather than adding a flag keeps ONE input path for
 * offline and online.
 */
const scratch = mkdtempSync(join(tmpdir(), 'osw-evidence-'));
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

function classify(job, jobLines) {
  const key = String(job.id ?? job.name);
  if (classificationCache.has(key)) return classificationCache.get(key);
  let result;
  try {
    const perJob = join(scratch, `job-${key}.json`);
    writeFileSync(perJob, JSON.stringify({
      run: { id: run.id, run_attempt: run.run_attempt ?? null, conclusion: run.conclusion ?? null },
      jobs: { jobs: [{ id: job.id, name: job.name, conclusion: job.conclusion, steps: job.steps ?? [] }] },
      log: jobLines.join('\n'),
    }));
    const out = execFileSync('node', [join(HERE, 'classify-failure.mjs'), '--from-json', perJob, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    result = JSON.parse(out.replace(/^[^{\[]*/, ''));
  } catch (e) {
    const out = String(e.stdout ?? '');
    try { result = JSON.parse(out.replace(/^[^{\[]*/, '')); } catch {
      // A classifier crash must not take the evidence with it, and must not be
      // reported as a classification either. It is UNAVAILABLE for that job.
      result = {
        verdict: 'UNKNOWN', confidence: 'none',
        reason: `the classifier could not be run on this job: ${String(e.message).split('\n')[0].slice(0, 200)}`,
        findings: [], unavailable: true,
      };
    }
  }
  classificationCache.set(key, result);
  return result;
}

const failedJobs = [];
for (const j of jobs ?? []) {
  const stepRecords = j.steps ?? [];
  const failedSteps = stepRecords
    .filter((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out' || s.conclusion === 'cancelled')
    .map((s) => ({
      name: s.name, number: s.number, conclusion: s.conclusion,
      startedAt: s.started_at, completedAt: s.completed_at,
    }));
  if (j.conclusion !== 'failure' && j.conclusion !== 'timed_out' && j.conclusion !== 'cancelled' && failedSteps.length === 0) continue;

  // This job's lines: every section whose job name matches. A matrix row's name is
  // its own (`lifecycle (go)`), so this does not bleed across rows.
  const jobSections = [...sections.values()].filter((s) => s.job === j.name);
  const jobLines = jobSections.flatMap((s) => s.lines);

  // Per-STEP ranges: the first and last line of each failed step, by prefix.
  const stepEvidence = [];
  for (const st of failedSteps) {
    const sec = sections.get(`${j.name}\t${st.name}`);
    if (!sec) {
      stepEvidence.push({
        ...st,
        sourceStatus: 'UNAVAILABLE',
        reason: 'the API reports this step failed and no log section carries its prefix '
          + '(the step produced no output, or the log format changed)',
      });
      if (runStatus === 'COMPLETE') runStatus = 'PARTIAL';
      note(`log:${j.name}/${st.name}`, 'failed step has no log section');
      continue;
    }
    // The range: the first failure marker, plus context either side. If there is no
    // marker, the whole step (bounded) - a failed step whose output carries no
    // marker is itself worth reading.
    const ctx = Number(arg('--context') ?? 60);
    let first = sec.lines.findIndex((l) => /\[(FATAL|ERROR)\]|(^|\s)FAIL\s|##\[error\]|panicked at/.test(l));
    if (first < 0) first = 0;
    const from = Math.max(0, first - ctx);
    const to = Math.min(sec.lines.length, first + ctx);
    const slice = sec.lines.slice(from, to).join('\n');
    const bounded = slice.length > MAX_LOG_BYTES ? slice.slice(0, MAX_LOG_BYTES) : slice;
    stepEvidence.push({
      ...st,
      sourceStatus: 'AVAILABLE',
      excerptFrom: from + 1,
      excerptTo: to,
      excerptLines: sec.lines.length,
      excerpt: bounded,
      excerptBytes: byteLength(bounded),
    });
  }

  const classification = classify(j, jobLines);
  failedJobs.push({
    runId: run.id,
    attempt: run.run_attempt ?? null,
    jobId: j.id,
    jobName: j.name,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    runnerName: j.runner_name ?? null,
    runnerGroup: j.runner_group_name ?? null,
    failedSteps: stepEvidence,
    // The job-level classification, kept alongside the step evidence so a reader
    // can see which failure the classifier attributed to what.
    classification,
    sourceStatus: stepEvidence.every((s) => s.sourceStatus === 'AVAILABLE') ? 'COMPLETE' : 'PARTIAL',
  });
}

// ---------------------------------------------------------------------------
// The last passing assertion, confined to the FAILING STEP.
//
// V1 searched backwards through the whole log and returned a PASS from a different
// plugin's matrix row. That reads as "that plugin was fine" at the moment the
// reader is asking about this one. Scoping to the section is the fix; reporting
// null when the section has none is the honest alternative to finding one elsewhere.
// ---------------------------------------------------------------------------
for (const fj of failedJobs) {
  for (const st of fj.failedSteps) {
    if (st.sourceStatus !== 'AVAILABLE' || !st.excerpt) { st.lastPassingAssertion = null; continue; }
    const lines = st.excerpt.split('\n');
    const failIdx = lines.findIndex((l) => /(^|\s)FAIL\s|panicked at/.test(l));
    let found = null;
    for (let i = (failIdx >= 0 ? failIdx - 1 : lines.length - 1); i >= 0; i -= 1) {
      if (/(^|\s)(ok|PASS|✓)\s/.test(lines[i])) { found = lines[i].trim().slice(0, 300); break; }
    }
    st.lastPassingAssertion = found;
  }
}

// ---------------------------------------------------------------------------
// Attempt pinning is a claim the artifact has to be able to support.
// ---------------------------------------------------------------------------
const attempts = new Set(failedJobs.map((j) => j.attempt));
if (attempts.size > 1) {
  if (runStatus === 'COMPLETE') runStatus = 'PARTIAL';
  note('attempt', `jobs from more than one attempt were returned (${[...attempts].join(', ')}); `
    + 'the artifact does not mix them into one cause, but the set is not from a single attempt');
}

const collected = {
  schemaVersion: SCHEMA_VERSION,
  collectedAt: new Date().toISOString(),
  source: FROM_JSON
    ? { kind: 'fixture', path: FROM_JSON }
    : { kind: 'github', repo: REPO, runId: run.id },
  run: {
    id: run.id,
    attempt: run.run_attempt ?? null,
    workflow: run.name ?? null,
    event: run.event ?? null,
    headSha: run.head_sha ?? null,
    headBranch: run.head_branch ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at ?? null,
    startedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at ?? null,
    url: run.html_url ?? null,
    isRetry: (run.run_attempt ?? 1) > 1 || Boolean(run.previous_attempt_url),
    previousAttemptUrl: run.previous_attempt_url ?? null,
  },
  completeness: { status: runStatus, reason: omit.length ? omit.map((o) => o.why).join('; ') : null },
  failedJobs,
  unattributedLines: unattributed.slice(0, 50),
  omissions: omit,
  integrity: {
    logBytes: byteLength(rawLog),
    logLines: allLines.length,
    failedJobCount: failedJobs.length,
    failedStepCount: failedJobs.reduce((n, j) => n + j.failedSteps.length, 0),
  },
  redaction: NOTICE,
};

// ---------------------------------------------------------------------------
// SANITIZE -> BUDGET -> VALIDATE -> SERIALISE.
//
// The artifact is sanitised as a WHOLE, after it is built. That ordering is what
// makes this a boundary: `classification.evidence[].line` is redacted because every
// byte of the artifact is, not because someone remembered that field. Measured
// before the change: the same physical line appeared as `<redacted-gh-token>` in
// `log.excerpt` and as the live token in `classification.evidence`.
// ---------------------------------------------------------------------------
const sanitized = sanitizeArtifact(collected);
const budgeted = fitBudget(sanitized, MAX_ARTIFACT_BYTES);
const finalArtifact = budgeted.artifact;
for (const o of budgeted.omissions) note('budget', o);
finalArtifact.omissions = omit;
finalArtifact.truncation = {
  truncated: budgeted.truncated,
  bytes: budgeted.bytes,
  maxBytes: MAX_ARTIFACT_BYTES,
  // The bytes dropped from the collected form, so "how much was lost" is a number
  // in the artifact rather than a reader's guess.
  droppedBytes: Math.max(0, byteLength(JSON.stringify(sanitized)) - budgeted.bytes),
};

// VALIDATE: fail closed if any known secret survived. A caller can pass the values
// it holds; without any, this asserts the structural invariants that must hold.
const knownSecrets = (process.env.OPSWEAVE_EVIDENCE_SENTINELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const serialised = JSON.stringify(finalArtifact, null, 2);
const leaks = findLeaks(serialised, knownSecrets);
if (leaks.length) {
  process.stderr.write(`refusing to emit: ${leaks.length} known secret value(s) survived sanitisation\n`);
  process.exit(3);
}

if (AS_JSON) process.stdout.write(`${serialised}\n`);
else {
  const a = finalArtifact;
  const o = [];
  o.push(`run ${a.run.id} attempt ${a.run.attempt}  ${a.run.conclusion}  ${String(a.run.headSha).slice(0, 10)}`);
  o.push(`  workflow: ${a.run.workflow} (${a.run.event})  retried: ${a.run.isRetry}`);
  o.push(`  completeness: ${a.completeness.status}${a.completeness.reason ? ` - ${a.completeness.reason}` : ''}`);
  for (const j of a.failedJobs) {
    o.push(`  JOB ${j.jobName} (${j.jobId}) ${j.conclusion}  classify=${j.classification.verdict}`);
    for (const f of j.classification.findings ?? []) o.push(`    [${f.category}] ${f.ruleId} - ${f.reason}`);
    for (const st of j.failedSteps) {
      o.push(`    step #${st.number} ${st.name}  ${st.sourceStatus}${st.excerpt ? `  lines ${st.excerptFrom}-${st.excerptTo} of ${st.excerptLines}` : ''}`);
      if (st.lastPassingAssertion) o.push(`      last passing: ${st.lastPassingAssertion}`);
      if (st.reason) o.push(`      ${st.reason}`);
    }
  }
  if (a.truncation.truncated) o.push(`  TRUNCATED to ${a.truncation.bytes} bytes (budget ${a.truncation.maxBytes}, ${a.truncation.droppedBytes} dropped)`);
  for (const om of a.omissions) o.push(`  omission: ${om.what} - ${om.why}`);
  o.push(`  ${a.redaction}`);
  process.stdout.write(`${sanitizeText(o.join('\n'))}\n`);
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${serialised}\n`);
  process.stderr.write(`wrote ${OUT} (${byteLength(serialised)} bytes)\n`);
}

process.exit(finalArtifact.completeness.status === 'COMPLETE' ? 0 : 1);
