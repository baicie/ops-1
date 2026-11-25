#!/usr/bin/env node
/**
 * Phase 8C TASK-37: one index of what a commit's checks actually concluded.
 *
 * THE GAP THIS FILLS, MEASURED
 *
 * The repository uploads 8 artifacts across 8 workflows, and `ci.yml` - the
 * workflow that runs the gate - uploads **none**. Measured against the run for the
 * 8A merge commit:
 *
 *     $ gh api repos/baicie/ops-1/actions/runs/45576929658/artifacts --jq .total_count
 *     0
 *
 * And the two Phase 8A tools (the classifier and the evidence collector) are
 * invoked by NO workflow outside their own self-tests. They were built, tested, and
 * connected to nothing - the exact "shipped but not connected" shape this
 * repository has recorded before.
 *
 * So the index is not a new collector. `ci-gate.mjs` already:
 *   - reads every check run on the exact commit, by name and by producing workflow
 *   - separates verified / failed / skipped / pending / absent / unverifiable /
 *     impostor / ambiguous
 *   - names which suites were NOT wired
 * and it already prints all of it as JSON (`ci-gate.mjs:1808`). What was missing is
 * that nothing persisted it, and nothing linked a check to its evidence.
 *
 * THE THREE STATES THE INDEX MUST NOT CONFLATE
 *
 *   no evidence       the check passed and produced nothing. NOT "verified".
 *   failed check      the check is red.
 *   pending check     the check has not answered.
 *
 * The brief is explicit: 「没有证据不得伪造成功」. A check that passed without
 * uploading anything is indexed as `passed_no_evidence`, never as evidence-backed.
 *
 * Usage:
 *   node tests/ci/evidence-index.mjs --gate-json gate.json --out index.json
 *   node tests/ci/evidence-index.mjs --gate-json gate.json --artifacts artifacts.json
 *   node tests/ci/evidence-index.mjs --run <id>            # fetch both, needs gh
 *
 * `--artifacts` takes `gh api .../runs/<id>/artifacts` output; without it the index
 * records every check as `evidence: UNAVAILABLE` with the reason, rather than
 * guessing that a check has none.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const REPO = 'baicie/ops-1';
const SCHEMA = 1;

/**
 * Every check state the index distinguishes, and what it means for a reader.
 *
 * The ORDER is a precedence: when one check is both failed and evidence-less, it is
 * a failure first. Naming the evidence gap is a separate field, never a downgrade.
 */
const CHECK_STATES = Object.freeze({
  FAILED: 'the check concluded failure',
  PENDING: 'the check has not concluded',
  PASSED_WITH_EVIDENCE: 'the check passed and an artifact from ITS OWN run is indexed',
  PASSED_EVIDENCE_UNATTRIBUTED: 'the check passed and an artifact exists somewhere on this commit, but nothing links it to this check',
  PASSED_NO_EVIDENCE: 'the check passed and produced no artifact - this is not the same as verified',
  UNKNOWN: 'the check did not appear on this commit, or its producer could not be identified',
});

/** How much of the requested material this index actually covers. */
const COMPLETENESS = Object.freeze({
  COMPLETE: 'every required check was attributed and every artifact matched to a run',
  PARTIAL: 'something could not be read; omissions names it',
  UNAVAILABLE: 'neither the gate result nor the artifact list could be read',
});

const omissions = [];
const note = (what, why) => omissions.push({ what, why });

let producerOf = null;


function ghJson(path) {
  try {
    const out = execFileSync('gh', ['api', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
    });
    return { ok: true, value: JSON.parse(out) };
  } catch (e) {
    const stderr = String(e.stderr ?? '').trim();
    const status = Number((stderr.match(/\(HTTP (\d{3})\)/) ?? [])[1] ?? 0) || null;
    return { ok: false, status, error: stderr.split('\n')[0]?.slice(0, 200) ?? String(e.message).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Inputs. A missing input is a recorded omission, never an empty list.
// ---------------------------------------------------------------------------
const RUN = arg('--run');
let gate = null;
let gateSource = null;
let artifacts = null;
let artifactsSource = null;
let runMeta = null;

if (RUN) {
  const run = ghJson(`repos/${REPO}/actions/runs/${RUN}`);
  if (run.ok) runMeta = run.value;
  else note('run', `the run could not be read: ${run.status ? `HTTP ${run.status}: ` : ''}${run.error}`);

  const art = ghJson(`repos/${REPO}/actions/runs/${RUN}/artifacts`);
  if (art.ok) { artifacts = art.value.artifacts ?? []; artifactsSource = `run:${RUN}`; }
  else note('artifacts', `the artifact list could not be read: ${art.status ? `HTTP ${art.status}: ` : ''}${art.error}`);

  // The gate's own result is the authoritative check picture. Without it the index
  // falls back to the check-run API, and says so.
  const checks = ghJson(`repos/${REPO}/commits/${run.value?.head_sha ?? 'HEAD'}/check-runs?per_page=100`);
  if (checks.ok) {
    gate = { verdict: null, checkRuns: checks.value.check_runs ?? [], from: `check-runs:${run.value?.head_sha}` };
    gateSource = 'check-runs';
    note('gate', 'no gate result was supplied, so the index was built from raw check runs; '
      + 'suite attribution (impostor/ambiguous/unwired) is not available in this mode');
  } else {
    note('gate', `check runs could not be read: ${checks.status ? `HTTP ${checks.status}: ` : ''}${checks.error}`);
  }
} else {
  const gatePath = arg('--gate-json');
  if (gatePath) {
    gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    gateSource = `file:${gatePath}`;
  } else {
    note('gate', 'no --gate-json and no --run: there is nothing to index');
  }
  const artPath = arg('--artifacts');
  if (artPath) {
    const parsed = JSON.parse(readFileSync(artPath, 'utf8'));
    artifacts = Array.isArray(parsed) ? parsed : (parsed.artifacts ?? []);
    artifactsSource = `file:${artPath}`;
  } else if (gate) {
    note('artifacts', 'no artifact list was supplied, so every check is indexed as evidence-UNKNOWN rather than assumed to have none');
  }
}

if (!gate && artifacts === null) {
  const artifact = {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    completeness: { status: 'UNAVAILABLE', reason: 'neither a gate result nor an artifact list could be read' },
    omissions,
    checks: [],
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  process.stdout.write(text);
  const out = arg('--out');
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text); }
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The check picture.
//
// `ci-gate.mjs --json` emits `{verdict, required, failed, skippedRequired,
// notWired, verified, absent, ...}`. A raw check-run read emits `checkRuns[]`.
// Both are normalised into one list here, and the source is recorded so a reader
// knows which they are looking at.
// ---------------------------------------------------------------------------
const byName = new Map();
const put = (name, patch) => {
  const prior = byName.get(name) ?? { name };
  byName.set(name, { ...prior, ...patch });
};

if (Array.isArray(gate.checkRuns)) {
  // Raw check-run mode: one row per attempt; the latest start wins, which is the
  // same rule the gate uses and for the same reason - a re-run does not reuse a
  // check run, it creates a new one.
  const latest = new Map();
  for (const r of gate.checkRuns) {
    const order = Date.parse(r.started_at ?? '') || Number(r.id) || 0;
    const prior = latest.get(r.name);
    if (!prior || order >= prior.order) latest.set(r.name, { order, run: r });
  }
  for (const [name, { run }] of latest) {
    put(name, {
      conclusion: run.conclusion ?? null,
      status: run.status ?? null,
      startedAt: run.started_at ?? null,
      checkRunId: run.id ?? null,
      detailUrl: run.details_url ?? null,
    });
  }
} else {
  // `required` lists the OBLIGATIONS, not the results. A name that is required and
  // appears in no result list has not answered - that is UNKNOWN, not PENDING.
  // The first version recorded only `required: true` and the missing conclusion
  // then fell through to PENDING, which says "still running" about a check that
  // never started.
  for (const n of gate.required ?? []) put(n, { required: true, conclusion: undefined, attributed: 'absent-from-result-lists' });
  for (const n of gate.verified ?? []) put(n, { conclusion: 'success', attributed: 'verified' });
  for (const n of gate.failed ?? []) put(n, { conclusion: 'failure', attributed: 'failed' });
  for (const n of gate.absent ?? []) put(n, { conclusion: null, attributed: 'absent' });
  for (const n of gate.pending ?? []) put(n, { conclusion: null, status: 'in_progress', attributed: 'pending' });
  for (const n of gate.skippedRequired ?? []) put(n, { conclusion: 'skipped', attributed: 'skipped-required' });
  for (const n of gate.notWired ?? []) put(n, { conclusion: null, attributed: 'not-wired' });
  for (const n of gate.impostor ?? []) put(n, { conclusion: gate.verdict === 'FAIL' ? 'failure' : null, attributed: 'impostor' });
  for (const n of gate.ambiguous ?? []) put(n, { conclusion: null, attributed: 'ambiguous' });
  for (const n of gate.unverifiable ?? []) put(n, { conclusion: null, attributed: 'unverifiable' });
}

// ---------------------------------------------------------------------------
// Artifact linkage.
//
// An artifact knows the RUN it came from, not the check. So the link is
// run -> check, and the honest statement is "this check's run produced these
// artifacts", not "this artifact proves this check passed". The distinction is the
// whole point of the exercise: an artifact is material a human can read, and only
// a human can say whether it verifies the check.
// ---------------------------------------------------------------------------
// WHICH PRODUCER OWNS WHICH CHECK, when the caller knows.
//
// `--workflow-of map.json` is `{ "<check name>": "<producer>" }`. Without it, no
// check is attributed to an artifact: there is no basis for the link, and a guess
// here is a false pass - the precise thing this index exists to prevent.
//
// Each ARTIFACT names its own producer (GitHub's artifact object does not carry
// one, so the caller supplies `producer` per artifact, or a `__artifacts` map keyed
// by artifact name). One global `__workflow` is not enough and the first version
// that used one credited a single producer's artifact to every check: measured, it
// turned 26 PASSED_NO_EVIDENCE into 26 PASSED_WITH_EVIDENCE.
const WORKFLOW_OF = arg('--workflow-of');
let artifactProducerOf = () => null;
if (WORKFLOW_OF) {
  const map = JSON.parse(readFileSync(WORKFLOW_OF, 'utf8'));
  producerOf = (checkName) => map[checkName] ?? null;
  artifactProducerOf = (artifact) => artifact.producer ?? map.__artifacts?.[artifact.name] ?? null;
}

const artifactRows = (artifacts ?? []).map((a) => ({
  name: a.name,
  producer: artifactProducerOf(a),
  sizeBytes: a.size_in_bytes ?? null,
  createdAt: a.created_at ?? null,
  expiresAt: a.expires_at ?? null,
  // Retention is a property of the WORKFLOW's upload step, and the API reports the
  // expiry it computed from it. Both are kept: expiry is what a reader can act on.
  digest: a.digest ?? null,
}));

const unlinkedArtifacts = artifacts === null
  ? null
  : artifactRows.filter((a) => !a.createdAt);

// ---------------------------------------------------------------------------
// The index.
// ---------------------------------------------------------------------------
const checks = [...byName.values()].map((c) => {
  const concluded = c.conclusion;
  let state;
  if (concluded === 'failure' || concluded === 'timed_out') state = 'FAILED';
  // PENDING requires POSITIVE evidence that the check is running. A name with no
  // conclusion and no status was never seen to start, and "it must be running" is
  // exactly the assumption this index cannot make.
  else if (c.status === 'in_progress' || c.status === 'queued') state = 'PENDING';
  else if (concluded === null || concluded === undefined) state = 'UNKNOWN';
  else if (concluded === 'success') {
    // AN ARTIFACT BELONGS TO A RUN, NOT TO EVERY CHECK ON THE COMMIT.
    //
    // The first version of this said `artifactRows.length > 0` -> every passing
    // check is evidence-backed. Measured on the #217 commit: 32 checks, ONE
    // artifact uploaded by plugin-lifecycle, and the index called 27 of them
    // PASSED_WITH_EVIDENCE - including checks produced by workflows that upload
    // nothing. That is the same false assurance as calling them all verified, one
    // step removed.
    //
    // So the link is only made when the caller tells us which workflow produced
    // which check (`--workflow-of`), or when the check's own name matches the
    // artifact's producer. Without that mapping the honest state is
    // EVIDENCE_UNATTRIBUTED: an artifact exists somewhere on this commit, and this
    // check cannot be said to be the one it belongs to.
    if (artifacts === null) state = 'PASSED_NO_EVIDENCE';
    else if (artifactRows.length === 0) state = 'PASSED_NO_EVIDENCE';
    else if (producerOf && producerOf(c.name)) {
      const own = artifactRows.filter((a) => producerOf(c.name) === a.producer);
      state = own.length > 0 ? 'PASSED_WITH_EVIDENCE' : 'PASSED_NO_EVIDENCE';
    } else state = 'PASSED_EVIDENCE_UNATTRIBUTED';
  } else if (concluded === 'skipped' || concluded === 'cancelled') state = 'FAILED';
  else state = 'UNKNOWN';

  return {
    name: c.name,
    required: c.required ?? null,
    conclusion: concluded ?? null,
    checkRunId: c.checkRunId ?? null,
    attributed: c.attributed ?? null,
    state,
    stateMeaning: CHECK_STATES[state],
    // Flattened so a reader can grep one key, and so "no evidence" is a FIELD
    // rather than the absence of one.
    evidence: artifacts === null
      ? 'UNKNOWN'
      : (artifactRows.length > 0 ? 'PRESENT_ON_RUN' : 'NONE'),
  };
});

// A check that is PASSED_NO_EVIDENCE is reported, never silently upgraded. The
// count is a top-level number because it is the number a reader will want to argue
// with, and an argument needs a figure.
const passedNoEvidence = checks.filter((c) => c.state === 'PASSED_NO_EVIDENCE').map((c) => c.name);

const completeness = (() => {
  if (artifacts === null && gateSource !== null) {
    return { status: 'PARTIAL', reason: 'the artifact list was not available, so evidence presence is UNKNOWN for every check' };
  }
  if (omissions.length) return { status: 'PARTIAL', reason: omissions.map((o) => o.why).join('; ') };
  return { status: 'COMPLETE', reason: null };
})();

const index = {
  schemaVersion: SCHEMA,
  generatedAt: new Date().toISOString(),
  // Every field the brief names, in its order.
  headSha: runMeta?.head_sha ?? gate.headSha ?? null,
  runId: runMeta?.id ?? (RUN ? Number(RUN) : null),
  attempt: runMeta?.run_attempt ?? null,
  workflow: runMeta?.name ?? null,
  event: runMeta?.event ?? null,
  conclusion: runMeta?.conclusion ?? gate.verdict ?? null,
  requiredCheckIdentity: {
    // Where the required set came from. A reader must be able to tell whether the
    // index is describing the ruleset or a local list.
    source: gateSource,
    required: gate.required ?? null,
    verdict: gate.verdict ?? null,
  },
  completeness,
  checks: checks.sort((a, b) => a.name.localeCompare(b.name)),
  evidenceArtifacts: artifactRows.map((a) => ({
    ...a,
    // Not "proves", and not "belongs to": an artifact belongs to a RUN.
    belongsTo: 'run',
    retentionExpiresAt: a.expiresAt,
    // The brief asks for a digest. GitHub reports one for artifacts on newer
    // runners; when it is absent this is null rather than a hash this tool
    // computed, because a locally computed hash cannot be compared to anything.
    digest: a.digest ?? null,
  })),
  // The classes the brief insists on separating, as counts a reader can check.
  summary: {
    total: checks.length,
    failed: checks.filter((c) => c.state === 'FAILED').length,
    pending: checks.filter((c) => c.state === 'PENDING').length,
    passedWithEvidence: checks.filter((c) => c.state === 'PASSED_WITH_EVIDENCE').length,
    passedEvidenceUnattributed: checks.filter((c) => c.state === 'PASSED_EVIDENCE_UNATTRIBUTED').length,
    passedNoEvidence: passedNoEvidence.length,
    unknown: checks.filter((c) => c.state === 'UNKNOWN').length,
    artifacts: artifactRows.length,
  },
  passedNoEvidence,
  omissions,
  unlinkedArtifacts,
  // The sentence this tool exists to make true.
  note: 'A check is listed as PASSED_WITH_EVIDENCE only when its run produced an artifact. That is '
    + 'not a claim that the artifact verifies the check: an artifact is material a human can read, '
    + 'and only a human can say whether it proves what the check asserted.',
};

const text = `${JSON.stringify(index, null, 2)}\n`;
process.stdout.write(text);
const outPath = arg('--out');
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  process.stderr.write(`wrote ${outPath}\n`);
}
process.exit(completeness.status === 'COMPLETE' ? 0 : 1);
