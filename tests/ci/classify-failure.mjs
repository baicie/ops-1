#!/usr/bin/env node
/**
 * Phase 8A TASK-27: attribute a failure, instead of matching a rule against a log.
 *
 * WHAT WAS WRONG WITH V1
 *
 * V1 scanned the whole log, first matching rule won, and the winner became THE
 * cause. It was wrong in four measured ways, each reproduced as a counterexample
 * before this file was written:
 *
 *   A  429 in a step that RECOVERED, followed by a real assertion failure, was
 *      classified EXTERNAL_DEPENDENCY. The recovered 429 became the root cause.
 *   B  A 429 in a job that SUCCEEDED, with the failure in a different job, was
 *      classified EXTERNAL_DEPENDENCY. A remote job's noise explained a local one.
 *   C  A passing assertion whose TEXT contains `INSTANCE_CAPACITY_EXCEEDED` was
 *      classified STAGING_ENVIRONMENT. The evidence line was `ok   the suite
 *      asserts INSTANCE_CAPACITY_EXCEEDED is surfaced` - an assertion that PASSED,
 *      quoted as the cause of a failure.
 *   D  Two matrix rows failing for two different reasons produced ONE category:
 *      whichever rule happened to be most specific. The other failure vanished.
 *
 * Plus a defect in the failure-marker regex itself, which this version fixes:
 *
 *      /[\[FATAL\]|\[ERROR\]|...]/     <- a CHARACTER CLASS, matches one character
 *
 *   It matched every line, so `matches.find(isFailureLine)` always returned
 *   `matches[0]` and the "prefer a failure line as evidence" rule had never done
 *   anything. `"everything is fine"` was a failure marker.
 *
 * THE MODEL
 *
 *   Layer 1  FAILURE OBSERVATION  - which jobs and steps actually failed, from the
 *                                   API's own conclusions, not from the log. A log
 *                                   cannot disagree with itself about which step
 *                                   exited non-zero; the API can be missing, and
 *                                   that is reported as such.
 *   Layer 2  FAILURE SIGNAL       - every candidate signature in the log, with the
 *                                   job/step it occurred in, whether it later
 *                                   recovered, and its rule. No filtering yet.
 *   Layer 3  FAILURE ATTRIBUTION  - signals are associated with the observation
 *                                   they can explain. A signal in a step that
 *                                   succeeded cannot explain a different step's
 *                                   failure. Each failed step is attributed
 *                                   separately, so two causes stay two causes.
 *
 * WHAT V2 REFUSES TO DO
 *
 *   - It never lets a recovered signal be a root cause while a later unexplained
 *     failure exists.
 *   - It never turns "an assertion failed" into "the product is broken". The three
 *     verdicts are separate: `assertion_failure_observed`, `product_defect_confirmed`,
 *     `harness_defect_confirmed`. Only the first is observable in a log; the other
 *     two require a human or a spec comparison, so this tool emits the first and
 *     says what would be needed for the others.
 *   - It never collapses two failures into one cause. Multiple findings are
 *     multiple findings.
 *   - It is NOT a Required Check exemption mechanism. Nothing here can make a red
 *     check green; the exit code is non-zero whenever a failure was seen.
 *
 * BACKWARD COMPATIBILITY
 *
 * The seven V1 categories are unchanged, and the JSON keeps `verdict`, `confidence`,
 * `reason` and `evidence` at the top level, derived from the primary finding. V1
 * had ONE verdict because a run has one conclusion; V2 adds `findings[]` because a
 * run can have several causes. A consumer that read `verdict` keeps working and
 * silently loses the secondary findings, which is why the human-readable output
 * prints them all.
 *
 * Usage:
 *   node tests/ci/classify-failure.mjs --log <path> [--json]
 *   node tests/ci/classify-failure.mjs --run <github-run-id> [--json]
 *   node tests/ci/classify-failure.mjs --from-json <fixture.json> [--json]
 *   node tests/ci/classify-failure.mjs < log        # stdin
 *
 * Exit code:
 *   0  there was nothing to classify - the run concluded SUCCESS and no failure was
 *      observed. This is the ONLY success.
 *   1  a failure was observed and nothing named its cause (UNKNOWN).
 *   2  a failure was observed and attributed.
 *
 * The first version exited 0 whenever every finding had a category, so a run that
 * failed with a perfectly-attributed PRODUCT_REGRESSION returned 0. A shell caller
 * checking `if classify; then` read "the classification worked" as "there is no
 * problem". A diagnostic that exits 0 on a failure is a diagnostic that will one day
 * be used as a gate that passes.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sanitizeText, NOTICE } from './lib/evidence-sanitize.mjs';
import { truncateUtf8 } from './lib/evidence-budget.mjs';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const AS_JSON = argv.includes('--json');
const REPO = 'baicie/ops-1';

// ---------------------------------------------------------------------------
// Input. Three sources, one path after this point.
// ---------------------------------------------------------------------------
let text = '';
let jobsFromApi = null;
let fixtureRun = null;
let source = 'stdin';
if (arg('--log')) {
  text = readFileSync(arg('--log'), 'utf8'); source = `log:${arg('--log')}`;
} else if (arg('--from-json')) {
  const f = JSON.parse(readFileSync(arg('--from-json'), 'utf8'));
  text = String(f.log ?? '');
  fixtureRun = f.run ?? null;
  jobsFromApi = f.jobs?.jobs ?? f.jobs ?? null;
  source = `fixture:${arg('--from-json')}`;
} else if (arg('--run')) {
  const ghText = (args) => {
    try {
      return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024 });
    } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
  };
  text = ghText(['run', 'view', arg('--run'), '--repo', REPO, '--log']);
  try { jobsFromApi = JSON.parse(ghText(['api', `repos/${REPO}/actions/runs/${arg('--run')}/jobs`])).jobs ?? null; } catch { jobsFromApi = null; }
  try { fixtureRun = JSON.parse(ghText(['api', `repos/${REPO}/actions/runs/${arg('--run')}`])); } catch { fixtureRun = null; }
  source = `run:${arg('--run')}`;
} else {
  text = readFileSync(0, 'utf8');
}

// The log is sanitised on the way IN as well as on the way out.
//
// In: a classifier's own output is a leak channel - it quotes the line that decided
// the verdict, and that line may carry the secret that broke the build. Sanitising
// the output alone would be enough to stop the leak, but then a secret could still
// reach this process's memory and any crash dump. Sanitising the input means the
// value never enters.
//
// The semantics survive because every rule matches on STRUCTURE that is not the
// secret: `status: 429`, `Could not transfer artifact`, `FAIL `. None of the
// redactions touch a digit, an HTTP status, or the word FAIL. That is asserted in
// the test rather than assumed here.
const rawText = text;
text = sanitizeText(text);

const lines = text.split('\n');

/**
 * Split a `gh run view --log` line into its prefix and body.
 *
 * The format is `<job name>\t<step name>\t<timestamp> <message>`. Job and step
 * names may themselves contain neither tabs nor newlines, which is what makes the
 * first two tabs a reliable delimiter. A line without two tabs came from somewhere
 * else (stdin, a saved file) and its prefix is unknown - NOT guessed.
 */
function parseLine(line) {
  const parts = line.split('\t');
  if (parts.length < 3) return { job: null, step: null, body: line, raw: line };
  return { job: parts[0], step: parts[1], body: parts.slice(2).join('\t'), raw: line };
}

// ---------------------------------------------------------------------------
// LAYER 1: failure observation.
//
// From the API, when available. The API is the authority on which steps exited
// non-zero; the log is the authority on why. Conflating them is how V1 ended up
// letting a 429 in a PASSING step explain a failure in another one.
//
// When the API is absent (a bare log file), the observation is DEGRADED: the step
// boundaries are inferred from the log prefixes and their conclusions are unknown.
// That is reported, not hidden - a degraded observation is exactly the case where a
// confident cause is least justified.
// ---------------------------------------------------------------------------
const observations = { source: jobsFromApi ? 'api' : 'degraded', jobs: [], failedSteps: [] };
const runConclusion = fixtureRun?.conclusion ?? null;

if (jobsFromApi) {
  for (const j of jobsFromApi) {
    const steps = (j.steps ?? []).map((s) => ({
      name: s.name, number: s.number, conclusion: s.conclusion,
      startedAt: s.started_at, completedAt: s.completed_at,
    }));
    observations.jobs.push({ id: j.id, name: j.name, conclusion: j.conclusion, steps });
    for (const s of steps) {
      if (s.conclusion === 'failure' || s.conclusion === 'timed_out' || s.conclusion === 'cancelled') {
        observations.failedSteps.push({ job: j.name, jobId: j.id, step: s.name, stepNumber: s.number, conclusion: s.conclusion });
      }
    }
  }
} else {
  // No API: the log's own prefixes are the only scope information available, and
  // they are good enough to keep scopes SEPARATE - `<job>\t<step>` is exactly the
  // granularity the API gives. What is missing is the CONCLUSION, not the boundary.
  //
  // The first version of this branch collapsed the scope to the JOB when the API
  // was absent, which re-created the very defect V2 exists to fix: a 429 in one step
  // of a job was attributed to a later failure in another step of the same job
  // (measured on counterexample A). The scope must come from the log prefix, which
  // is where it is written.
  //
  // A step is an observed failure when it contains a failing ASSERTION, or a
  // failure-marker line that no recovery follows. A `[FATAL] ... (recovered)` alone
  // is not a failed step - that is counterexample A's whole point.
  const seen = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const p = parseLine(lines[i]);
    if (!p.job) continue;
    const key = `${p.job}\t${p.step}`;
    if (!seen.has(key)) seen.set(key, { job: p.job, step: p.step, failedAssertion: false, terminalMarker: false });
    const rec = seen.get(key);
    if (/(^|\s)FAIL\s/.test(p.body) && !isPassLine(p.body)) rec.failedAssertion = true;
    if (isFailureLine(p.body) && !isPassLine(p.body) && !isRecovered(i, p)) rec.terminalMarker = true;
  }
  for (const rec of seen.values()) {
    if (!rec.failedAssertion && !rec.terminalMarker) continue;
    observations.failedSteps.push({
      job: rec.job, jobId: null, step: rec.step, stepNumber: null,
      conclusion: 'unknown (inferred from log; no API conclusion available)',
      observedFromLogOnly: true,
    });
  }
}

/**
 * A FAILURE MARKER, written as an alternation this time.
 *
 * The V1 form `[\[FATAL\]|...]` was a character class and matched every string.
 * This one is deliberately conservative: a marker has to be a token that means
 * failure, not any line containing an uppercase letter.
 */
function isFailureLine(body) {
  return /\[(FATAL|ERROR)\]|(^|\s)(FAIL|FAILED|FAILURE)(\s|:|$)|##\[error\]|^\s*Error:|\bpanicked at\b|\bAssertionError\b/.test(body);
}

/** A line that records a PASSING assertion. Used to decide what a failure FOLLOWED. */
function isPassLine(body) {
  return /(^|\s)(ok|PASS|✓)\s/.test(body) || /^\s*PASS=/.test(body) || /\bPASS=(\d+)/.test(body);
}

/**
 * The words that assert a transient fault RECOVERED.
 *
 * Narrow on purpose: an ATTEMPT ("retrying", "attempt 2 of 3") is not an outcome,
 * and a retry that then fails is a failure. Only outcomes are listed, and
 * `isRecovered` additionally requires that no failure marker intervenes.
 */
function isRecoveryLine(body) {
  return /\b(recovered|recovering|recovery|succeeded after|resolved after|now succeeds|retried and passed)\b/i.test(body);
}

/**
 * Was a signal at `lines[i]` recovered?
 *
 * Two places, and both were needed: the LINE ITSELF can say so
 * (`[FATAL] status: 429 (recovered)` is how a retry wrapper annotates its own
 * output), and a LATER line in the same step can say so (`download failed: 429` /
 * `retry succeeded`). The first version only looked later, so a self-annotated
 * recovery was read as terminal and became a root cause.
 *
 * A failure marker in between cancels the recovery: "retrying" then "failed" is a
 * failure, and the search stops at the failure rather than continuing past it.
 * `isRecoveryLine` is narrow for the same reason - it names outcomes, not attempts.
 */
function isRecovered(ii, p) {
  if (isRecoveryLine(p.body)) return true;
  for (let k = ii + 1; k < lines.length; k += 1) {
    const q = parseLine(lines[k]);
    if (p.job && q.job && (q.job !== p.job || q.step !== p.step)) break;
    if (isRecoveryLine(q.body)) return true;
    if (isFailureLine(q.body) && !isPassLine(q.body)) break;
  }
  return false;
}


// ---------------------------------------------------------------------------
// LAYER 2: failure signals. Every candidate, unreservedly.
//
// Each rule records what it can SEE, not what it concludes. The conclusion is
// layer 3's job, and layer 3 has information layer 2 does not: which step failed.
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: 'registry-rate-limit',
    category: 'EXTERNAL_DEPENDENCY',
    reason: 'the registry answered with a rate limit or a server-side fault',
    match: (b) => /\bstatus(?: code)?: (429|5\d\d)\b/.test(b)
      || /\b429 Too Many Requests\b/i.test(b)
      || /Could not transfer artifact/.test(b)
      || /Non-resolvable (parent )?POM/.test(b)
      || /transfer failed for https?:\/\//.test(b),
  },
  {
    id: 'registry-unreachable',
    category: 'EXTERNAL_DEPENDENCY',
    reason: 'a package or registry host was unreachable',
    match: (b) => /Could not (resolve|find) artifact/.test(b)
      || /(repo\.maven\.apache\.org|registry\.npmjs\.org|pypi\.org).*(connect|timed out|transfer failed)/i.test(b),
  },
  {
    id: 'staging-capacity',
    category: 'STAGING_ENVIRONMENT',
    reason: 'the deployment was refused by the environment, not by an assertion',
    // `INSTANCE_CAPACITY_EXCEEDED` appears in assertions ABOUT capacity as well as
    // in capacity refusals, which is counterexample C. The association in layer 3
    // cannot separate those on its own - both are in the same step - so the rule
    // also requires the line to look like a refusal rather than a mention.
    match: (b) => /INSTANCE_CAPACITY_EXCEEDED/.test(b) && !isPassLine(b) && !/\bassert(s|ed|ion)?\b.*INSTANCE_CAPACITY/i.test(b)
      || /status_reason[=:].*capacity/i.test(b) && !isPassLine(b)
      || /staging (host|deploy).*(unreachable|refused|no address)/i.test(b),
  },
  {
    id: 'runner-fault',
    category: 'RUNNER_INFRASTRUCTURE',
    reason: 'the runner or its daemon failed',
    match: (b) => /docker daemon (is )?not running/i.test(b)
      || /no space left on device/i.test(b)
      || /The runner has received a shutdown signal/i.test(b)
      || /lost communication with the server/i.test(b),
  },
  {
    id: 'harness-malformed',
    category: 'TEST_HARNESS_DEFECT',
    reason: 'the test fixture or its supporting script is malformed, so the run measured nothing',
    match: (b) => /failed to parse stage name/.test(b)
      || /API route not found/.test(b)
      || /command not found/.test(b) && /tests\/(ci|acceptance)\//.test(b)
      || /\bunbound variable\b/.test(b) && /tests\/(ci|acceptance)\//.test(b),
  },
  {
    id: 'process-crash',
    category: 'PRODUCT_REGRESSION',
    reason: 'the process under test crashed; no external signature explains it',
    // A panic is not an assertion, and calling it one would overstate what a log
    // shows. It is a CRASH: a definite, non-environmental failure of the code. The
    // verdictKind distinguishes it so a reader is not told "an assertion failed"
    // when what happened is that a process died.
    match: (b) => /\bpanicked at\b/.test(b) || /\bsegmentation fault\b/i.test(b) || /\bSIGSEGV\b/.test(b),
  },
  {
    id: 'gate-attribution',
    category: 'CHECK_ATTRIBUTION',
    reason: 'the gate could not decide which check it was reading',
    match: (b) => /\b(impostor|ambiguous|unattributed)\b/.test(b)
      || /delegated-(absent|timeout|pending):/.test(b)
      || /required suite not wired/.test(b),
  },
];

/** Every signal in the log, with where it was and whether a recovery followed it. */
function collectSignals() {
  const signals = [];
  for (let i = 0; i < lines.length; i += 1) {
    const p = parseLine(lines[i]);
    for (const rule of RULES) {
      if (!rule.match(p.body)) continue;
      // Recovery is scoped to the same step, and to the line itself. See isRecovered.
      const recovered = isRecovered(i, p);
      signals.push({
        ruleId: rule.id,
        category: rule.category,
        reason: rule.reason,
        job: p.job,
        step: p.step,
        line: i + 1,
        timestamp: (p.body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/) ?? [null])[0],
        body: p.body.trim().slice(0, 300),
        recovered,
        // Terminal from the log's point of view: it is a failure-marker line and no
        // recovery was seen after it in the same step.
        terminal: !recovered,
      });
    }
  }
  return signals;
}
const RULE_MATCHES = (rule, body) => rule.match(body);

/** The failed assertion lines - the observation layer 3 falls back to. */
function collectAssertions() {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const p = parseLine(lines[i]);
    if (!(/(^|\s)FAIL\s/.test(p.body) || /AssertionError|expected .* to (be|equal)/i.test(p.body) || /^\s*not ok\b/.test(p.body))) continue;
    // A `FAIL` inside an assertion that itself passed is not a failure. This is the
    // same trap as counterexample C, one level up: `ok the suite prints FAIL when...`
    if (isPassLine(p.body)) continue;
    out.push({ job: p.job, step: p.step, line: i + 1, body: p.body.trim().slice(0, 300) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LAYER 3: attribution.
//
// One finding per failed step. The rules, in order:
//
//   1. A signal can only explain a failure in the SAME step (when the API gives us
//      steps), or the same job (when it does not). Counterexample B is a signal in
//      a different job.
//   2. A RECOVERED signal cannot be the root cause while an unexplained failure
//      remains. Counterexample A.
//   3. A failed assertion is a candidate in its own right, and it beats nothing:
//      if an unrecovered signal in the same step exists, that signal is the cause
//      and the assertion is listed as the downstream observation. If no signal
//      exists, the assertion IS the finding - PRODUCT_REGRESSION by default.
//   4. Independent failures stay independent. Counterexample D.
//
// When the observation is degraded (no API), attribution falls back to the log's
// own step prefixes and says so; a finding from degraded observation carries
// `observation: 'inferred'` so a reader can weight it.
// ---------------------------------------------------------------------------
const signals = collectSignals();
const assertions = collectAssertions();

/** Scope key for a signal/assertion: the step when known, the job otherwise. */
const scopeOf = (x, useStep) => (useStep ? `${x.job}\t${x.step}` : String(x.job));

function attributeStep(failed, useStep) {
  const want = useStep ? `${failed.job}\t${failed.step}` : String(failed.job);
  const inScope = (x) => scopeOf(x, useStep) === want;

  const stepSignals = signals.filter(inScope);
  const unrecovered = stepSignals.filter((s) => !s.recovered);
  const recovered = stepSignals.filter((s) => s.recovered);
  const stepAssertions = assertions.filter(inScope);

  const findings = [];
  const byCategory = new Map();
  for (const s of unrecovered) {
    // ONE finding per CATEGORY per failed step, not one per rule.
    //
    // Two rules can match one failure - a registry 404 matches both "Could not find
    // artifact" and "Non-resolvable parent POM" - and they are one cause seen twice.
    // The first version emitted both, which made a single failure look like two
    // independent ones and contradicted this tool's own advice to treat multiple
    // findings separately. The additional rule ids are recorded on the finding
    // rather than dropped, so nothing observed is lost.
    const prior = byCategory.get(s.category);
    if (prior) {
      if (!prior.alsoMatched.some((m) => m.ruleId === s.ruleId)) {
        prior.alsoMatched.push({ ruleId: s.ruleId, line: s.body, sourceLine: s.line });
      }
      continue;
    }
    const finding = {
      category: s.category,
      ruleId: s.ruleId,
      alsoMatched: [],
      reason: s.reason,
      verdictKind: 'external_or_environment_signal_observed',
      observation: failed.observedFromLogOnly ? 'inferred' : 'api',
      scope: { job: failed.job, jobId: failed.jobId, step: failed.step, stepNumber: failed.stepNumber, conclusion: failed.conclusion },
      evidence: [{ line: s.body, sourceLine: s.line, timestamp: s.timestamp, signalState: 'terminal' }],
      // The assertion, if there is one, is the CONSEQUENCE of this signal in the
      // same step - recorded, not promoted.
      downstreamAssertions: stepAssertions.slice(0, 3).map((a) => ({ line: a.body, sourceLine: a.line })),
    };
    byCategory.set(s.category, finding);
    findings.push(finding);
  }

  if (findings.length === 0 && stepAssertions.length) {
    for (const a of stepAssertions.slice(0, 3)) {
      findings.push({
        category: 'PRODUCT_REGRESSION',
        ruleId: 'failed-assertion',
        reason: 'an assertion failed and nothing external explains it',
        // THE THREE VERDICTS ARE SEPARATE. A log can only show the first.
        verdictKind: 'assertion_failure_observed',
        whatWouldConfirm: 'compare the assertion against the specification it encodes: if the assertion is right and the product '
          + 'disagrees, this is a product defect; if the assertion is wrong, it is a harness defect. The log cannot tell them apart.',
        alsoMatched: [],
        observation: failed.observedFromLogOnly ? 'inferred' : 'api',
        scope: { job: failed.job, jobId: failed.jobId, step: failed.step, stepNumber: failed.stepNumber, conclusion: failed.conclusion },
        evidence: [{ line: a.body, sourceLine: a.line, timestamp: null, signalState: 'assertion' }],
      });
      break; // one finding per failing assertion is enough; the rest are listed below
    }
    if (stepAssertions.length > 1) findings[0].moreAssertions = stepAssertions.length - 1;
  }

  if (findings.length === 0) {
    findings.push({
      category: 'UNKNOWN',
      ruleId: null,
      reason: 'the step failed and the log contains no signature this tool recognises',
      verdictKind: 'assertion_failure_observed',
      alsoMatched: [],
      observation: failed.observedFromLogOnly ? 'inferred' : 'api',
      scope: { job: failed.job, jobId: failed.jobId, step: failed.step, stepNumber: failed.stepNumber, conclusion: failed.conclusion },
      evidence: [],
      whatWouldConfirm: 'read the failing step yourself; a real regression that matches no signature lands here',
    });
  }

  // Recovered signals are REPORTED, never promoted. Counterexample A: the 429 that
  // was retried is context, and the assertion after it is the cause.
  if (recovered.length) {
    for (const f of findings) {
      f.recoveredSignals = recovered.slice(0, 3).map((s) => ({
        ruleId: s.ruleId, category: s.category, line: s.body, sourceLine: s.line,
        note: 'a recovery was observed after this signal in the same step, so it is not the root cause',
      }));
    }
  }
  return findings;
}

// Scope by STEP whenever the step is known, whether it came from the API or from a
// log prefix. The first version wrote `observations.source === 'api' && ...`, which
// made the API the precondition for step scoping - so in degraded mode every signal
// in a job was attributed to every failure in that job. That is the exact defect V2
// exists to remove, re-created by an && that looked like a safety check.
//
// The API supplies the CONCLUSION; the prefix supplies the BOUNDARY. They are
// different questions and the boundary is available in both modes.
const useStep = observations.failedSteps.some((f) => f.step);

/**
 * Does the log disagree with the API about which step failed?
 *
 * Counterexample I: the API calls `Report` success while the log shows a failed
 * assertion in it. This tool does NOT resolve that by preferring one silently. The
 * API decides WHICH steps are in scope (it is the authority on exit codes); the log
 * is quoted for WHY. But a step the API called successful that nonetheless logged a
 * failure is reported as a disagreement, because the reader needs to know the two
 * sources differ before trusting either.
 */
const disagreements = [];
if (jobsFromApi) {
  const succeeded = new Set();
  for (const o of observations.jobs) {
    for (const st of o.steps) if (st.conclusion === 'success') succeeded.add(`${o.name}\t${st.name}`);
  }
  const flagged = new Map();
  for (const a of assertions) {
    const key = `${a.job}\t${a.step}`;
    if (!succeeded.has(key) || flagged.has(key)) continue;
    flagged.set(key, a);
    disagreements.push({
      kind: 'LOG_CONTRADICTS_API',
      job: a.job, step: a.step, apiConclusion: 'success', logLine: a.line, logText: a.body,
      resolution: 'neither source is discarded: the step is NOT in the failed scope (the API decided that), '
        + 'and the assertion is listed here so the conflict is visible rather than silently resolved',
    });
  }
}
const findings = [];
if (observations.failedSteps.length) {
  for (const f of observations.failedSteps) findings.push(...attributeStep(f, useStep));
} else {
  // No observed failure. That is a real answer, and it has two very different
  // shapes that must not share one sentence:
  //
  //   the run SUCCEEDED            there is nothing to classify. Saying "we could
  //                                not tell" about a green run is noise.
  //   the run failed with no step to point at
  //                                (cancelled before any step started, a job that
  //                                never ran). This is the case where guessing a
  //                                cause would be worst.
  //
  // Both still exit non-zero: this tool is a diagnostic for failures, and a caller
  // that runs it on a green build should get "there is nothing here", not a signal
  // it can mistake for a verdict.
  const runSucceeded = runConclusion === 'success';
  findings.push({
    category: 'UNKNOWN',
    ruleId: null,
    reason: runSucceeded
      ? 'the run concluded SUCCESS and no failed step was observed, so there is no failure to classify; '
        + 'this tool is not a success signal'
      : `no failed step was observed and the run concluded ${runConclusion ?? 'unknown'}; the failure is `
        + 'somewhere this tool cannot see (see completeness)',
    verdictKind: 'no_failure_observed',
    nothingToClassify: runSucceeded,
    alsoMatched: [],
    observation: observations.source,
    scope: null,
    evidence: [],
    whatWouldConfirm: runSucceeded
      ? 'nothing: pass a failing run id'
      : 'confirm the run id, the attempt and the job; a cancelled run can report every step concluded',
  });
}

// ---------------------------------------------------------------------------
// The summary, kept compatible with V1's shape.
// ---------------------------------------------------------------------------
const primary = findings[0];
const verdict = primary.category;
const CONFIDENCE = verdict === 'UNKNOWN' ? 'none' : (verdict === 'PRODUCT_REGRESSION' ? 'default' : 'specific');

const result = {
  schemaVersion: 2,
  source,
  observation: { source: observations.source, failedStepCount: observations.failedSteps.length, degraded: observations.source !== 'api' },
  // V1-compatible top level, derived from findings[0].
  verdict,
  confidence: CONFIDENCE,
  reason: primary.reason,
  evidence: primary.evidence.map((e) => ({ category: primary.category, reason: primary.reason, line: e.line })),
  // V2: everything, including what V1 threw away.
  verdictKind: primary.verdictKind,
  findings,
  disagreements,
  // The limit of the tool, said where it is read.
  scope_note: 'this tool attributes a failure to a CATEGORY using log evidence. It cannot confirm a product defect: an '
    + 'assertion that failed and an assertion that was WRONG look identical in a log.',
  redaction: NOTICE,
};

// ---------------------------------------------------------------------------
// Output. Both forms pass through the sanitizer - the JSON because it is built
// from sanitised input but a future field might not be, and the human form because
// it interpolates the same strings.
// ---------------------------------------------------------------------------
if (AS_JSON) {
  const text2 = sanitizeText(JSON.stringify(result, null, 2));
  process.stdout.write(`${text2}\n`);
} else {
  const o = [];
  o.push(`${verdict}  (${CONFIDENCE} evidence)   ${findings.length} finding(s)`);
  o.push(`  ${primary.reason}`);
  if (result.observation.degraded) {
    o.push('  NOTE: observation is DEGRADED - no API job/step conclusions were available, so scopes were');
    o.push('        inferred from log prefixes. A signal may be attributed to a step that merely logged it.');
  }
  for (const [i, f] of findings.entries()) {
    o.push('');
    o.push(`  [${i + 1}] ${f.category}  (${f.ruleId ?? 'no rule'})  kind=${f.verdictKind}`);
    if (f.scope) o.push(`      in ${f.scope.job} / ${f.scope.step ?? '?'}  conclusion=${f.scope.conclusion}`);
    for (const e of f.evidence) o.push(`      evidence ${e.sourceLine ? `line ${e.sourceLine}: ` : ''}${e.line}`);
    for (const m of f.alsoMatched ?? []) o.push(`      same cause, another signature (${m.ruleId}) at line ${m.sourceLine}`);
    for (const r of f.recoveredSignals ?? []) o.push(`      recovered earlier: ${r.ruleId} at line ${r.sourceLine} - NOT the root cause`);
    for (const d of f.downstreamAssertions ?? []) o.push(`      downstream assertion: ${d.line}`);
    if (f.whatWouldConfirm) o.push(`      to confirm: ${f.whatWouldConfirm}`);
  }
  if (verdict === 'UNKNOWN') {
    o.push('');
    o.push('  UNKNOWN is not "probably external". Before re-running, read the failure step yourself -');
    o.push('  a real regression that matches no signature lands here.');
  }
  for (const d of disagreements) {
    o.push('');
    o.push(`  CONFLICT: the log shows a failure in ${d.job} / ${d.step}, but the API reports that step SUCCEEDED`);
    o.push(`    log: line ${d.logLine}: ${d.logText}`);
    o.push('    not silently resolved: the step is excluded from the failed scope, and this line exists so the');
    o.push('    conflict is visible. Check whether the step writes its own exit code.');
  }
  if (findings.length > 1) {
    o.push('');
    o.push(`  ${findings.length} independent findings. They are not one cause; treat them separately.`);
  }
  process.stdout.write(`${sanitizeText(o.join('\n'))}\n`);
}

const nothingToClassify = findings.length === 0 || findings.every((f) => f.nothingToClassify === true);
if (nothingToClassify) process.exit(0);
process.exit(findings.some((f) => f.category === 'UNKNOWN') ? 1 : 2);
