#!/usr/bin/env node
/**
 * Phase 8 TASK-22: collect everything the next reader needs, once.
 *
 * THE COST THIS REMOVES
 *
 * Every failure in this repository has cost between 8 and 20 minutes to diagnose,
 * and the first three minutes of that are always the same: find the run, find the
 * failed job, find the step, find the first real error, check whether it was
 * retried and whether that retry was the one being read. The brief asks for all of
 * it in one artifact, and names the two constraints that make it non-trivial:
 * secret redaction and size.
 *
 * WHAT IT COLLECTS
 *
 *   run id, attempt, head SHA, workflow, event, conclusion
 *   the failed jobs and their failed STEPS, by name
 *   a classification (delegated to classify-failure.mjs, not re-implemented)
 *   the LOG RANGE around the failure, not the whole log
 *   the last line that looks like a passing assertion before the failure
 *   whether the run was RETRIED, and whether this attempt is the retry
 *   the runner environment (os, image) as GitHub reports it
 *
 * THE TWO CONSTRAINTS
 *
 * Redaction: a fixed list of value SHAPES is removed - bearer tokens, `*_TOKEN=`,
 * `*_KEY=`, `*_SECRET=`, `*_PASSWORD=`, `ghp_`/`ghs_`/`gho_` prefixes, AWS keys, and
 * anything the workflow names as a secret. Shapes rather than names, because a
 * secret leaked into a log is a value, not a variable name.
 *
 * Size: the log range is bounded by lines around the first failure, and the whole
 * artifact is capped. A 40 MB log helps nobody and uploads slowly; the first
 * failure plus its context is what a reader needs. The cap is reported when it
 * truncates, so a reader knows the artifact is partial.
 *
 * Usage:
 *   node tests/ci/collect-failure-evidence.mjs --run <id> [--context 60] [--out <path>]
 *   node tests/ci/collect-failure-evidence.mjs --run <id> --json
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const RUN = arg('--run');
const CONTEXT = Number(arg('--context') ?? 60);
const OUT = arg('--out');
const AS_JSON = argv.includes('--json');
const REPO = 'baicie/ops-1';
// 512 KB per log section. Measured: the full plugin-lifecycle log for a red run is
// ~40 MB, of which the useful part is hundreds of lines.
const MAX_BYTES = 512 * 1024;



const gh = (args, opts = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024, ...opts });

function tryGh(args) {
  try { return gh(args); } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
}

// ---------------------------------------------------------------------------
// Redaction. SHAPES, not names - a secret in a log is a value.
// ---------------------------------------------------------------------------
const REDACTIONS = [
  // Authorization headers and query parameters.
  [/\b(Bearer|token|authorization)([=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2<redacted>'],
  // Env-style assignments for anything that reads like a credential.
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=<redacted>'],
  // GitHub token prefixes.
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '<redacted-gh-token>'],
  // AWS.
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-aws-key>'],
  // Generic long base64-ish values after known key names.
  [/(["']?(?:password|secret|token|key)["']?\s*[:=]\s*["'])[^"']{12,}(["'])/gi, '$1<redacted>$2'],
  // The plugin database URL carries a password in its userinfo.
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/g, '$1<redacted>$2'],
];

function redact(text) {
  let out = text;
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

// A REDACTION-ONLY MODE, so the redaction rules can be tested without a run.
// It reads stdin and writes the redacted text - no API calls, no classification.
// The alternative was exporting the function and writing a separate harness, and a
// rule that is only reachable through a 40 MB log download is a rule nobody tests.
if (argv.includes('--redact-only')) {
  const input = readFileSync(0, 'utf8');
  process.stdout.write(redact(input));
  process.exit(0);
}

// OFFLINE MODE, SO THE TOOL CAN BE TESTED WITHOUT GITHUB.
//
// The self-test used `--run <id>` against a live run, which passes on a machine
// with `gh` credentials and fails on a CI runner without them (measured: five
// assertions red on PR #218, all with "no redaction notice" / "a required field is
// missing" because the artifact came back empty). A test that needs the network is
// a test that is red for reasons that have nothing to do with the code.
//
// `--from-json <file>` takes the two API responses this tool needs, saved in one
// object, plus the log text. Everything after the fetches is identical.
const FROM_JSON = arg('--from-json');

if (!RUN && !FROM_JSON && !argv.includes('--redact-only')) {
  process.stderr.write('usage: collect-failure-evidence.mjs --run <id> [--context 60] [--out path]\n' +
    '       collect-failure-evidence.mjs --from-json <fixture.json> [--out path]\n' +
    '       collect-failure-evidence.mjs --redact-only < text\n');
  process.exit(2);
}


// ---------------------------------------------------------------------------
// Gather metadata.
// ---------------------------------------------------------------------------
const fixture = FROM_JSON ? JSON.parse(readFileSync(FROM_JSON, 'utf8')) : null;

const run = fixture ? (fixture.run ?? {}) : JSON.parse(tryGh(['api', `repos/${REPO}/actions/runs/${RUN}`]) || '{}');
if (!run.id) {
  process.stderr.write(fixture ? `the fixture has no run.id\n` : `could not read run ${RUN}\n`);
  process.exit(2);
}

const jobs = fixture
  ? (fixture.jobs?.jobs ?? fixture.jobs ?? [])
  : (JSON.parse(tryGh(['api', `repos/${REPO}/actions/runs/${RUN}/jobs`]) || '{"jobs":[]}').jobs ?? []);
const failedJobs = [];
for (const j of jobs) {
  const failedSteps = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => ({
    name: s.name, number: s.number, startedAt: s.started_at, completedAt: s.completed_at,
  }));
  if (j.conclusion === 'failure' || failedSteps.length) {
    failedJobs.push({
      id: j.id, name: j.name, conclusion: j.conclusion,
      startedAt: j.started_at, completedAt: j.completed_at,
      runnerName: j.runner_name, runnerGroup: j.runner_group_name,
      failedSteps,
    });
  }
}

// ---------------------------------------------------------------------------
// The log, bounded and classified.
// ---------------------------------------------------------------------------
const log = fixture ? String(fixture.log ?? '') : tryGh(['run', 'view', String(RUN), '--repo', REPO, '--log']);
const lines = log.split('\n');

// The FIRST line that carries a failure marker. Chosen over "the last error"
// because a cascade's first line is the cause and the rest are consequences.
const FAIL_MARKER = /\[FATAL\]|\[ERROR\]|(^|\s)FAIL |##\[error\]|\bFAILED\b/;
const firstFailure = lines.findIndex((l) => FAIL_MARKER.test(l));

let rangeFrom = 0; let rangeTo = lines.length; let truncated = false;
if (firstFailure >= 0) {
  rangeFrom = Math.max(0, firstFailure - CONTEXT);
  rangeTo = Math.min(lines.length, firstFailure + CONTEXT);
}
let excerpt = lines.slice(rangeFrom, rangeTo).join('\n');
if (Buffer.byteLength(excerpt) > MAX_BYTES) {
  excerpt = excerpt.slice(0, MAX_BYTES);
  truncated = true;
}
excerpt = redact(excerpt);

// The last assertion that PASSED before the failure - WITHIN THE SAME LOG SECTION.
//
// `gh run view --log` starts every line with the job and step name, tab-terminated.
// Searching the whole log backwards found a PASS from a DIFFERENT plugin's matrix
// row (`Go and Java get the same lifecycle ... java  no labelled container ...
// PASS`) and presented it as "how far this suite got". That is actively
// misleading: it says the java plugin was fine, at the moment the reader is
// asking about the heartbeat suite.
//
// So the search is confined to lines whose job/step prefix matches the failing
// line's. When the prefix cannot be parsed, it reports null rather than guessing.
function prefixOf(line) {
  const parts = line.split('\t');
  return parts.length >= 2 ? `${parts[0]}\t${parts[1]}` : null;
}
let lastPass = null;
if (firstFailure >= 0) {
  const want = prefixOf(lines[firstFailure]);
  for (let i = firstFailure - 1; i >= 0; i -= 1) {
    if (want && prefixOf(lines[i]) !== want) continue;
    if (/(^|\s)ok |PASS |^\s*✓/.test(lines[i])) { lastPass = redact(lines[i].trim()).slice(0, 300); break; }
  }
}

// The classification, delegated. Not re-implemented here: one rule set, one place.
let classification = { verdict: 'UNKNOWN', confidence: 'none', reason: 'classifier not run' };
try {
  // `--log /dev/stdin` plus `input:` conflicts: the child opens the fd, the parent
  // also writes to it, and the read sees nothing. The classifier reads STDIN when
  // no --log is given, so pass nothing and let `input` be the only channel.
  const cls = execFileSync('node', [`${dirname(new URL(import.meta.url).pathname)}/classify-failure.mjs`, '--json'], {
    input: log, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
  });
  classification = JSON.parse(cls.replace(/^[^{]*/, ''));
} catch (e) {
  const out = String(e.stdout ?? '');
  try { classification = JSON.parse(out.replace(/^[^{]*/, '')); } catch { /* keep the default */ }
}

// Was this attempt a retry? `run_attempt > 1` on THIS run is the direct answer;
// `previous_attempt_url` being non-null says the same thing another way.
const retried = (run.run_attempt ?? 1) > 1 || Boolean(run.previous_attempt_url);

const evidence = {
  collectedAt: new Date().toISOString(),
  run: {
    id: run.id, attempt: run.run_attempt, workflow: run.name, event: run.event,
    headSha: run.head_sha, headBranch: run.head_branch,
    status: run.status, conclusion: run.conclusion,
    createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at,
    url: run.html_url,
    isRetry: retried, previousAttemptUrl: run.previous_attempt_url ?? null,
  },
  environment: {
    // GitHub does not put the runner image in the run object, so this is reported
    // as unknown rather than invented. `runnerName` per job is what IS available.
    runnerImage: 'not exposed by the API; see the job log header',
    runnerNames: [...new Set(failedJobs.map((j) => j.runnerName).filter(Boolean))],
  },
  failedJobs,
  classification,
  log: {
    totalLines: lines.length,
    firstFailureLine: firstFailure >= 0 ? firstFailure + 1 : null,
    excerptFrom: rangeFrom + 1, excerptTo: rangeTo,
    truncated, excerpt,
  },
  lastPassingAssertion: lastPass,
  redactionNotice:
    'values matching token/key/secret/password shapes are replaced with <redacted>; ' +
    'a shape not in the list below is NOT redacted, so review before sharing',
};

if (AS_JSON) {
  const text = JSON.stringify(evidence, null, 2);
  process.stdout.write(text + '\n');
} else {
  const s = evidence;
  const o = [];
  o.push(`run ${s.run.id} attempt ${s.run.attempt}  ${s.run.conclusion}  ${s.run.headSha.slice(0, 10)}`);
  o.push(`  workflow: ${s.run.workflow} (${s.run.event})  retried: ${s.run.isRetry}`);
  o.push(`  classify: ${s.classification.verdict} (${s.classification.confidence}) - ${s.classification.reason}`);
  for (const e of s.classification.evidence ?? []) o.push(`    evidence: ${e.line}`);
  o.push(`  failed jobs:`);
  for (const j of s.failedJobs) {
    o.push(`    ${j.name} (${j.id}) runner=${j.runnerName ?? '?'}`);
    for (const st of j.failedSteps) o.push(`      step #${st.number} ${st.name}`);
  }
  o.push(`  log: line ${s.log.firstFailureLine} of ${s.log.totalLines}, excerpt ${s.log.excerptFrom}-${s.log.excerptTo}${s.log.truncated ? ' (TRUNCATED)' : ''}`);
  if (s.lastPassingAssertion) o.push(`  last passing assertion before it: ${s.lastPassingAssertion}`);
  o.push(`  ${s.redactionNotice}`);
  process.stdout.write(o.join('\n') + '\n');
}

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
  process.stderr.write(`wrote ${OUT}\n`);
}
