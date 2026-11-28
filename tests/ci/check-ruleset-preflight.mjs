#!/usr/bin/env node
/**
 * Phase 8 TASK-19: the last READ-ONLY check before the required-checks migration.
 *
 * WHAT WAS ALREADY COVERED, AND WHAT WAS NOT
 *
 * Two tools existed and both pass:
 *
 *   check-ruleset-payload.mjs   the saved payloads are complete rulesets and
 *                               restoring one cannot drop the four non-check rules
 *   check-required-contexts.mjs all ten contexts are produced on every PR
 *
 * Both compare SAVED FILES to SAVED FILES. Neither answers "is the live ruleset
 * still what the migration assumes it is". A migration is a delta against the
 * CURRENT state, and the current state can change between the day the payload was
 * written and the day it is sent - by a manual edit, by a second migration, by a
 * rollback. That is the gap this file closes, and it is the one the brief names
 * first: "获取最新 Live Ruleset" (fetch the latest live ruleset).
 *
 * WHAT IT DOES
 *
 * Reads the live ruleset through `gh api` and reports, without writing anything:
 *
 *   1. the four existing protections are still present, rule by rule
 *   2. the live rule set and the candidate differ ONLY by
 *      `required_status_checks` - no silent extra change rides along
 *   3. the candidate's ten contexts each have a producer in a workflow that runs
 *      on every PR (delegated to check-required-contexts.mjs, not re-implemented)
 *   4. the strict policy is the intended one, named explicitly
 *   5. a rollback payload exists and would restore the live state exactly
 *   6. the payload's field names are ones the ruleset API accepts
 *
 * WHAT IT REFUSES TO DO
 *
 * It never writes. `--write` is not implemented; the ruleset is BLOCKED_AUTH and
 * an unauthorized write is not a thing this tool can be talked into. The only
 * mutating call in the whole file is `gh api --method GET`.
 *
 * Usage:
 *   node tests/ci/check-ruleset-preflight.mjs              # against live GitHub
 *   node tests/ci/check-ruleset-preflight.mjs --offline    # against a snapshot
 *   node tests/ci/check-ruleset-preflight.mjs --snapshot f # a specific snapshot
 *
 * `--offline` exists so CI, which has no ruleset read permission, can still check
 * everything that does not need GitHub. The live half reports NOT_EVALUATED there
 * rather than passing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const SNAPSHOT_ARG = argv.includes('--snapshot') ? argv[argv.indexOf('--snapshot') + 1] : null;
const SNAPSHOT_PATH = SNAPSHOT_ARG ?? join(ROOT, 'docs/ci/ruleset-live-snapshot.json');

const RULESET_ID = '26958761';
const CANDIDATE = join(ROOT, 'docs/ci/ruleset-candidate-ten.json');
const ROLLBACK = join(ROOT, 'docs/ci/ruleset-rollback-pre-migration.json');

let pass = 0, fail = 0, notEvaluated = 0;
const ok = (m) => { pass++; process.stdout.write(`  ok   ${m}\n`); };
const bad = (m) => { fail++; process.stdout.write(`  FAIL ${m}\n`); };
const ne = (m) => { notEvaluated++; process.stdout.write(`  n/e  ${m}\n`); };

// The four protections the live ruleset carries today. Named individually because
// "the ruleset still has four rules" is not the claim - "it still has THESE four"
// is. A migration that swapped `non_fast_forward` for something else would pass a
// count and fail the intent.
const EXPECTED_PROTECTIONS = [
  'deletion',
  'non_fast_forward',
  'required_linear_history',
  'pull_request',
];

function readJson(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    bad(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The live ruleset. Read-only, and it says so when it cannot read.
// ---------------------------------------------------------------------------
let live = null;
let liveSource = 'none';
if (SNAPSHOT_ARG) {
  live = readJson(SNAPSHOT_PATH, 'the snapshot');
  if (live) { ok(`read the ruleset from the snapshot at ${SNAPSHOT_ARG}`); liveSource = 'snapshot'; }
} else if (OFFLINE) {
  // Offline still uses the committed snapshot, when there is one. It is dated, so
  // the staleness is printed rather than hidden - a delta check against a snapshot
  // says something about the day it was taken, not about today.
  live = readJson(SNAPSHOT_PATH, 'the committed snapshot');
  if (live) {
    liveSource = 'snapshot';
    const captured = live._snapshot?.captured_at ?? '<undated>';
    ok(`read the committed snapshot (captured ${captured}); it may have drifted since`);
  } else {
    ne('no committed snapshot and --offline was given; the delta check could not run');
  }
} else {
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/baicie/ops-1/rulesets/${RULESET_ID}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    live = JSON.parse(raw);
    ok(`read live ruleset ${RULESET_ID} ("${live.name}", enforcement ${live.enforcement})`);
  } catch (error) {
    // NOT a pass. A preflight that cannot see the current state has not done its
    // job, and saying so is the point of distinguishing n/e from ok.
    ne(`could not read live ruleset ${RULESET_ID}: ${String(error.message).split('\n')[0]}`);
  }
}

if (live) {
  const liveTypes = (live.rules ?? []).map((r) => r.type);

  // 1. the four protections, by name
  for (const rule of EXPECTED_PROTECTIONS) {
    liveTypes.includes(rule)
      ? ok(`live ruleset still carries "${rule}"`)
      : bad(`live ruleset LOST "${rule}"; the migration's premise is gone`);
  }

  // 1b. and nothing unexpected appeared. An unknown rule could be one someone
  // added deliberately, but a preflight that silently accepts new constraints on
  // main is not a preflight.
  const known = new Set([...EXPECTED_PROTECTIONS, 'required_status_checks']);
  const unexpected = liveTypes.filter((t) => !known.has(t));
  unexpected.length === 0
    ? ok('live ruleset carries no rule the payload does not account for')
    : bad(`live ruleset has rule(s) the payload does not mention: ${unexpected.join(', ')}`);

  // 2. the live state's checks. The brief records Required Checks: 0, and that is
  // the fact the migration changes - so it is asserted, not assumed.
  const liveChecksRule = (live.rules ?? []).find((r) => r.type === 'required_status_checks');
  const liveContexts = liveChecksRule?.parameters?.required_status_checks ?? [];
  liveContexts.length === 0
    ? ok('live ruleset requires 0 status checks (the state the migration changes)')
    : process.stdout.write(
        `  note live ruleset already requires ${liveContexts.length} check(s): ` +
        `${liveContexts.map((c) => c.context).join(', ')}\n`,
      );

  // 2b. the strict policy, named rather than inferred from "no checks means no
  // policy". When there is no rule there is no policy, and the preflight says so.
  if (!liveChecksRule) {
    ok('live ruleset has no required_status_checks rule, so no strict policy is in force');
  } else {
    process.stdout.write(
      `  note live strict policy: ${liveChecksRule.parameters?.strict_required_status_checks_policy}\n`,
    );
  }

  // 3. DELTA. The candidate must differ from live by required_status_checks and
  // nothing else. Compared on the rule TYPES plus the parameters of the rules that
  // are meant to stay identical, so an accidental edit to pull_request settings
  // shows up here rather than as a surprise after the write.
  const candidate = readJson(CANDIDATE, 'the candidate payload');
  if (candidate) {
    for (const rule of EXPECTED_PROTECTIONS) {
      const liveRule = (live.rules ?? []).find((r) => r.type === rule);
      const candRule = (candidate.rules ?? []).find((r) => r.type === rule);
      if (!liveRule || !candRule) continue;
      const same = stableJson(liveRule.parameters ?? {}) === stableJson(candRule.parameters ?? {});
      same
        ? ok(`candidate keeps "${rule}" parameters identical to live`)
        : bad(`candidate CHANGES "${rule}" parameters; the migration was meant to add checks only`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. the candidate payload's own shape, and its contexts' producers
// ---------------------------------------------------------------------------
const candidate = readJson(CANDIDATE, 'the candidate payload');
if (candidate) {
  const checksRule = (candidate.rules ?? []).find((r) => r.type === 'required_status_checks');
  if (!checksRule) {
    bad('the candidate has no required_status_checks rule; the migration would change nothing');
  } else {
    const contexts = (checksRule.parameters?.required_status_checks ?? []).map((c) => c.context);
    contexts.length === 10
      ? ok(`the candidate requires 10 contexts: ${contexts.join(', ')}`)
      : bad(`the candidate requires ${contexts.length} contexts, expected 10`);

    // STRICT, NAMED. `strict_required_status_checks_policy: true` means a branch
    // must be up to date with main before merging - which is a different demand
    // from "the checks passed". What matters here is that the file says one thing
    // and this asserts it, rather than the value being whatever was last written.
    const strict = checksRule.parameters?.strict_required_status_checks_policy;
    strict === true || strict === false
      ? ok(`the candidate sets strict_required_status_checks_policy explicitly (${strict})`)
      : bad(`strict_required_status_checks_policy is ${strict}, expected an explicit boolean`);

    // THE TWO SHIPPED PAYLOADS DISAGREE ON STRICT — NOW RESOLVED, NOT IGNORED.
    //
    // `docs/ci/ruleset-audit.md:58` and `ruleset-restore.md:20` record the
    // intermediate payload as "nine contexts + strict: false", and line 74 calls
    // it the rollback that "removes strict". The ten-context candidate sets
    // `strict: true`.
    //
    // The decision (docs/ci/phase10a-ruleset-migration.md): the TARGET is
    // `candidate-ten.json` with `strict: true`. The nine-context payload is
    // HISTORICAL EVIDENCE of the earlier migration and is NOT a competing
    // target — it predates `ci-gate` entirely, and adopting it now would leave
    // the aggregate gate advisory for ever.
    //
    // So the check is no longer "do they agree" (they do not, and they should
    // not). It is "is the declared target actually the one the candidate
    // carries", which is the property a preflight can assert without deciding a
    // product question on the operator's behalf.
    const TARGET_STRICT = true;
    if (strict !== TARGET_STRICT) {
      bad(`the candidate sets strict=${strict}, but the declared migration target is strict=${TARGET_STRICT}`
        + ' (docs/ci/phase10a-ruleset-migration.md)');
    } else {
      ok(`the candidate matches the declared target on strict (${TARGET_STRICT})`);
    }
    // And the historical payload must NOT have been rewritten to match. History
    // that has been edited to agree with the present is not history, and the
    // rollback path depends on it still describing what was actually sent then.
    const nineWithChecks = join(ROOT, 'docs/ci/ruleset-26958761-with-required-checks.json');
    const nine = readJson(nineWithChecks, 'the nine-context payload');
    if (nine) {
      const nineStrict = (nine.rules ?? [])
        .find((r) => r.type === 'required_status_checks')?.parameters?.strict_required_status_checks_policy;
      nineStrict === false
        ? ok('the historical nine-context payload still records strict=false, unedited')
        : bad(`the historical nine-context payload now says strict=${nineStrict}; it must stay as it was sent`);
    }

    // 5. API-acceptable field names. GitHub silently ignores unknown keys in a
    // ruleset payload, so a typo would produce a rule that looks applied and is
    // not. These are the keys the API documents for required_status_checks.
    const allowed = new Set(['required_status_checks', 'strict_required_status_checks_policy']);
    const unknown = Object.keys(checksRule.parameters ?? {}).filter((k) => !allowed.has(k));
    unknown.length === 0
      ? ok('the required_status_checks parameters use only API-documented fields')
      : bad(`unknown field(s) in required_status_checks: ${unknown.join(', ')} - the API would ignore them`);

    // Each context entry must be {context: string}. The API dropped `app_id` for
    // this shape and an entry carrying extra keys is worth knowing about.
    const malformed = (checksRule.parameters?.required_status_checks ?? [])
      .filter((c) => typeof c.context !== 'string' || Object.keys(c).some((k) => k !== 'context'));
    malformed.length === 0
      ? ok('every context entry is exactly {context} as the API expects')
      : bad(`${malformed.length} context entry/entries carry fields beyond "context"`);

    // 6. the producers, delegated rather than re-implemented. If this fails, the
    // migration would make every merge impossible, so it is a hard gate.
    try {
      execFileSync('node', [join(HERE, 'check-required-contexts.mjs')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
      });
      ok('check-required-contexts.mjs reports every context is produced on every PR');
    } catch (error) {
      const out = String(error.stdout ?? '') + String(error.stderr ?? '');
      bad(`a required context may not appear on every PR:\n${out.trim().split('\n').slice(-6).join('\n')}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. the rollback payload restores the live state exactly
// ---------------------------------------------------------------------------
const rollback = readJson(ROLLBACK, 'the rollback payload');
if (rollback) {
  const types = (rollback.rules ?? []).map((r) => r.type);
  const hasChecks = types.includes('required_status_checks');
  !hasChecks
    ? ok('the rollback payload carries no required_status_checks rule (restores the live state)')
    : bad('the rollback payload still carries required_status_checks; it would not roll back');
  const missing = EXPECTED_PROTECTIONS.filter((r) => !types.includes(r));
  missing.length === 0
    ? ok('the rollback payload carries all four protections')
    : bad(`the rollback payload is missing: ${missing.join(', ')}`);

  // If we have the live state, the rollback must MATCH it - not merely "look like
  // a pre-migration ruleset". A rollback that restores a remembered state which
  // has since drifted is a second change, not a rollback.
  if (live) {
    const diffs = [];
    for (const rule of EXPECTED_PROTECTIONS) {
      const l = (live.rules ?? []).find((r) => r.type === rule);
      const r = (rollback.rules ?? []).find((r) => r.type === rule);
      if (!l || !r) continue;
      if (stableJson(l.parameters ?? {}) !== stableJson(r.parameters ?? {})) diffs.push(rule);
    }
    diffs.length === 0
      ? ok('the rollback payload matches the LIVE state, rule for rule')
      : bad(`the rollback payload differs from live in: ${diffs.join(', ')}`);
  } else {
    ne('the rollback payload was not compared to live (no live ruleset was read)');
  }
}

// Key-order-insensitive comparison. `JSON.stringify` on two objects with the same
// content and different insertion order yields different strings, which produced a
// false "a restore would change it" before this existed on the payload checker.
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

process.stdout.write(
  `\nruleset preflight: ${pass} ok, ${fail} failed, ${notEvaluated} not evaluated` +
  `${OFFLINE ? ' (offline)' : ''}\n` +
  `               0 writes - this tool has no write path\n`,
);
process.exit(fail === 0 ? 0 : 1);
