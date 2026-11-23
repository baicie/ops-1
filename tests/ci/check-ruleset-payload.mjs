#!/usr/bin/env node
/**
 * Whether the ruleset can be restored to enforcing checks without silently
 * dropping the protection that is still there.
 *
 * THE HAZARD THIS EXISTS FOR
 *
 * `PUT /rulesets/{id}` REPLACES the entire `rules` array. A payload containing
 * only `required_status_checks` would remove `deletion`, `non_fast_forward`,
 * `required_linear_history` and `pull_request` along with it - turning a restore
 * into a second, unnoticed change to `main`'s protection. This checks the payload
 * before anyone sends it.
 *
 * WHAT IS CHECKED
 *
 *   1. every saved payload in `docs/ci/ruleset-*.json` is a COMPLETE ruleset
 *      object - all five rules present, not just the check list
 *   2. restoring either payload leaves the four non-check rules intact
 *   3. the `required_status_checks` payloads carry exactly the contexts their
 *      MIGRATION PROFILE names, so a restore cannot quietly drop one and an
 *      unknown context cannot be added
 *   4. `strict_required_status_checks_policy` is asserted explicitly rather than
 *      left to whatever the file happens to contain
 *
 * TWO PROFILES, BECAUSE THE TARGET IS NOT THE HISTORICAL STATE
 *
 * `NINE_CONTEXTS` is what `main` has historically required. The migration target
 * adds `ci-gate`, which computes a verdict on every pull request today and which
 * no merge consults - the gate is advisory, and a red gate blocks nothing. That
 * is the gap this migration exists to close.
 *
 * The first version of this checker hard-coded nine and listed `ci-gate` under
 * "contexts not produced by this repository". It IS produced - `ci.yml`'s
 * `ci-gate` job - so the checker would have refused the very payload the
 * migration is for. A checker that cannot express the target state cannot audit
 * the change that reaches it.
 *
 * So the profiles are explicit and each payload declares which one it is under:
 *
 *   historical-nine  what must not silently shrink
 *   candidate-ten    historical nine PLUS ci-gate
 *
 * Neither profile tolerates a context outside itself. `candidate-ten` is a
 * SUPERSET check as well: every historical context must still be present, so the
 * migration cannot trade one required check for another.
 *
 * It does NOT read GitHub. The saved payload is compared to a live snapshot by
 * `docs/ci/ruleset-restore.md`'s procedure; the offline check runs everywhere.
 *
 * Run with `--selftest` to check the checks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/ci/', import.meta.url));

/** The four rules that are NOT about status checks. Restoring must not touch them. */
export const PROTECTIVE_RULES = ['deletion', 'non_fast_forward', 'required_linear_history', 'pull_request'];

/** The nine contexts `main` has required historically. */
export const NINE_CONTEXTS = [
  'contracts', 'linux-runtime', 'platform-image-build', 'platform-only',
  'quality-faults', 'rust', 'spec-coverage', 'web', 'web-unit',
];

/**
 * The migration target: the historical nine plus the merge gate itself.
 *
 * `ci-gate` is produced by `ci.yml` on every pull request, so it is a context
 * GitHub can require. It is not in the historical nine because between 2026-11-20
 * and this migration the gate ran advisory - it computed a verdict nothing
 * consulted. Requiring it is the change these payloads exist to make.
 */
export const CANDIDATE_TEN_CONTEXTS = [...NINE_CONTEXTS, 'ci-gate'];

/** name -> the exact context list a payload under that profile must carry. */
export const MIGRATION_PROFILES = {
  'historical-nine': NINE_CONTEXTS,
  'candidate-ten': CANDIDATE_TEN_CONTEXTS,
};

/** The profile a payload declares, from its own `_profile` note or its contents. */
export function profileOf(payload) {
  const declared = payload?._profile;
  if (declared && MIGRATION_PROFILES[declared]) return declared;
  const rule = (payload?.rules ?? []).find((r) => r?.type === 'required_status_checks');
  if (!rule) return null;
  const contexts = (rule.parameters?.required_status_checks ?? []).map((c) => c?.context);
  if (contexts.includes('ci-gate')) return 'candidate-ten';
  return 'historical-nine';
}

/**
 * JSON equality that does not depend on KEY ORDER.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` is the obvious comparison and it is
 * wrong for anything that crossed a system boundary: this check reported
 *
 *   "pull_request" differs between live and payload; a restore would change it
 *
 * for two rules whose parameters were IDENTICAL - `{type, parameters}` from the API
 * and `{parameters, type}` from the payload file. A false "a restore would change
 * it" is the worst kind of failure here: it trains an operator to ignore the one
 * warning that matters.
 *
 * Sorting keys recursively makes the comparison about content. Array order IS
 * significant and is preserved - `allowed_merge_methods: ["squash","merge"]` must
 * not equal `["merge","squash"]`... except that it must, because it is a set of
 * permitted methods. Sets are sorted by the caller where they are sets; this
 * helper only fixes object key order.
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @returns {string[]} problems; empty means the payload is safe to PUT. */
export function inspectPayload(name, payload) {
  const problems = [];
  if (!payload || typeof payload !== 'object') return [`${name}: not a JSON object`];
  if (!payload.name) problems.push(`${name}: no name`);
  if (!payload.target) problems.push(`${name}: no target; PUT requires it`);
  if (!payload.enforcement) problems.push(`${name}: no enforcement`);

  const rules = Array.isArray(payload.rules) ? payload.rules : null;
  if (!rules) return [...problems, `${name}: no rules array; PUT replaces the whole array`];

  const types = rules.map((r) => r?.type);
  for (const required of PROTECTIVE_RULES) {
    if (!types.includes(required)) {
      problems.push(
        `${name}: missing rule "${required}". PUT replaces the whole rules array, so sending ` +
        'this payload would REMOVE that protection from main',
      );
    }
  }

  const checkRules = rules.filter((r) => r?.type === 'required_status_checks');
  if (checkRules.length > 1) problems.push(`${name}: ${checkRules.length} required_status_checks rules`);
  // The profile is decided ONCE per payload, not per rule: a payload declaring
  // `candidate-ten` and carrying nine contexts is a mistake in the declaration or
  // in the list, and either way it must not pass.
  const profile = profileOf(payload);
  const expected = profile ? MIGRATION_PROFILES[profile] : NINE_CONTEXTS;
  for (const rule of checkRules) {
    const params = rule.parameters ?? {};
    const contexts = (params.required_status_checks ?? []).map((c) => c?.context);

    // A DUPLICATE CONTEXT IS NOT A SECOND CHECK. GitHub accepts the payload and
    // requires the context once, so a payload listing `rust` twice while omitting
    // `web` would satisfy a length test and lose a required check.
    const dupes = contexts.filter((c, i) => contexts.indexOf(c) !== i);
    if (dupes.length) problems.push(`${name}: duplicate context(s): ${[...new Set(dupes)].join(', ')}`);

    if (contexts.length !== expected.length) {
      problems.push(`${name}: ${contexts.length} contexts under profile "${profile ?? 'historical-nine'}",`
        + ` expected ${expected.length}`);
    }
    const missing = expected.filter((c) => !contexts.includes(c));
    if (missing.length) problems.push(`${name}: contexts missing: ${missing.join(', ')}`);
    const extra = contexts.filter((c) => !expected.includes(c));
    if (extra.length) {
      // `ci-gate` is genuinely produced by ci.yml, so the message says which
      // profile would legitimately carry it rather than calling it fictional.
      const hint = extra.includes('ci-gate')
        ? ' (ci-gate is produced and belongs to the "candidate-ten" profile;'
          + ' add _profile: "candidate-ten" and the other nine contexts)'
        : '';
      problems.push(`${name}: contexts not in profile "${profile ?? 'historical-nine'}":`
        + ` ${extra.join(', ')}${hint}`);
    }
    if (typeof params.strict_required_status_checks_policy !== 'boolean') {
      problems.push(`${name}: strict_required_status_checks_policy is not an explicit boolean`);
    }
  }
  return problems;
}

/** Every saved payload under docs/ci/, loaded. */
export function savedPayloads() {
  const out = [];
  for (const file of readdirSync(DOCS).filter((n) => /^ruleset-.*\.json$/.test(n)).sort()) {
    out.push({ file, payload: JSON.parse(readFileSync(DOCS + file, 'utf8')) });
  }
  return out;
}

// ---------------------------------------------------------------------------

function selftest() {
  const good = {
    name: 'main-protection', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      { type: 'pull_request', parameters: { required_approving_review_count: 0, allowed_merge_methods: ['squash'] } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: NINE_CONTEXTS.map((context) => ({ context })),
        },
      },
    ],
  };
  const cases = [
    ['a complete payload passes', good, []],
    ['a payload without the check rule passes (that is the current state)',
      { ...good, rules: good.rules.filter((r) => r.type !== 'required_status_checks') }, []],
    ['a check-only payload is REJECTED - it would delete the other four rules',
      { ...good, rules: [good.rules[4]] }, ['missing rule "deletion"', 'missing rule "pull_request"']],
    ['a payload missing one context is rejected',
      { ...good, rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: NINE_CONTEXTS.slice(0, 8).map((context) => ({ context })),
        },
      }]) }, ['contexts missing: web-unit']],
    // THE OLD CASE HERE SAID `ci-gate` WAS "not produced by this repository".
    // It IS produced, by ci.yml's `ci-gate` job, and that assertion is why the
    // checker would have refused the migration it exists to enable. A context
    // that genuinely nobody produces is still rejected - the replacement uses one.
    ['a context nobody produces is rejected',
      { ...good, rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: NINE_CONTEXTS.concat('security-scan-not-a-job').map((context) => ({ context })),
        },
      }]) }, ['security-scan-not-a-job']],
    // --- profile counterfactuals (TASK-09) ---
    ['the candidate-ten profile with ten contexts passes',
      { ...good, _profile: 'candidate-ten', rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: CANDIDATE_TEN_CONTEXTS.map((context) => ({ context })),
        },
      }]) }, []],
    ['a payload declaring candidate-ten but carrying NINE is rejected',
      { ...good, _profile: 'candidate-ten', rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: NINE_CONTEXTS.map((context) => ({ context })),
        },
      }]) }, ['contexts missing: ci-gate']],
    ['a candidate-ten payload that DROPS a historical context is rejected',
      // The migration must not trade one required check for another.
      { ...good, _profile: 'candidate-ten', rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: CANDIDATE_TEN_CONTEXTS.filter((c) => c !== 'web-unit').map((context) => ({ context })),
        },
      }]) }, ['contexts missing: web-unit']],
    ['a DUPLICATE context is rejected even when the count happens to match',
      { ...good, _profile: 'candidate-ten', rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: CANDIDATE_TEN_CONTEXTS.filter((c) => c !== 'web-unit')
            .concat('rust').map((context) => ({ context })),
        },
      }]) }, ['duplicate context(s): rust']],
    ['an implicit strict flag is rejected',
      { ...good, rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: { required_status_checks: NINE_CONTEXTS.map((context) => ({ context })) },
      }]) }, ['strict_required_status_checks_policy is not an explicit boolean']],
  ];
  let bad = 0;
  for (const [label, payload, want] of cases) {
    let got = [];
    try { got = inspectPayload('fixture.json', payload); } catch (e) { got = [`threw: ${e.message}`]; }
    const ok = want.length === 0 ? got.length === 0 : want.every((w) => got.join(' ').includes(w));
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}\n`);
  }
  process.stdout.write(`ruleset payload selftest: ${cases.length - bad}/${cases.length}\n`);
  return bad === 0;
}

// Import-safety. `check-required-contexts.mjs` imports CANDIDATE_TEN_CONTEXTS
// from this file; without the guard that import ran the whole checker and printed
// its results in the importer's output. Every other tool in this directory has
// the same guard for the same reason.
/**
 * Did the write produce EXACTLY the payload?
 *
 * A 200 is not evidence: GitHub normalises fields, can drop a rule it does not
 * accept, and an accepted PUT can still differ from what was sent. The comparison
 * is field-by-field in BOTH directions, because "the checks are right" is not the
 * question - "nothing else changed" is.
 *
 * @param {object} payload  what was sent
 * @param {object} after    what the API returned, or a read-back snapshot
 * @returns {string[]} problems; empty means the ruleset is what the payload said
 */
export function inspectReadback(payload, after) {
  const problems = [];
  for (const field of ['name', 'target', 'enforcement']) {
    if (after[field] !== payload[field]) {
      problems.push(`${field}: payload said ${JSON.stringify(payload[field])}, GitHub returned ${JSON.stringify(after[field])}`);
    }
  }
  for (const field of ['conditions', 'bypass_actors']) {
    if (stableJson(after[field]) !== stableJson(payload[field])) {
      problems.push(`${field}: payload and read-back differ`);
    }
  }
  const byType = (p) => Object.fromEntries((p.rules ?? []).map((r) => [r.type, r]));
  const want = byType(payload);
  const got = byType(after);
  for (const type of Object.keys(want)) {
    if (!got[type]) { problems.push(`rule "${type}" is in the payload but NOT in the read-back`); continue; }
    if (stableJson(want[type]) !== stableJson(got[type])) {
      problems.push(`rule "${type}" came back different`);
    }
  }
  for (const type of Object.keys(got)) {
    if (!want[type]) {
      problems.push(`rule "${type}" is in the read-back but NOT in the payload - the write ADDED something`);
    }
  }
  for (const type of PROTECTIVE_RULES) {
    if (!got[type]) problems.push(`PROTECTION LOST: "${type}" is not on the ruleset after the write`);
  }
  return problems;
}


const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (RUN_AS_PROGRAM && process.argv[2] === '--selftest') process.exit(selftest() ? 0 : 1);

if (RUN_AS_PROGRAM && process.argv[2] === '--verify-readback') {
  const [payloadFile, afterFile] = process.argv.slice(3);
  if (!payloadFile || !afterFile) {
    process.stderr.write('usage: check-ruleset-payload.mjs --verify-readback <payload.json> <after.json>\n');
    process.exit(2);
  }
  const problems = inspectReadback(
    JSON.parse(readFileSync(payloadFile, 'utf8')),
    JSON.parse(readFileSync(afterFile, 'utf8')),
  );
  for (const p of problems) process.stdout.write(`FAIL ${p}\n`);
  process.stdout.write(problems.length
    ? `readback: ${problems.length} problem(s)\n`
    : 'readback: the ruleset is exactly what the payload described\n');
  process.exit(problems.length === 0 ? 0 : 1);
}


// `--against-live <snapshot.json>` compares a payload to what GitHub actually
// returned. The offline check proves a payload is internally sound; this proves it
// still matches the repository, which is the half that detects the drift a restore
// would otherwise import. The snapshot is a file, not a live fetch, so the check
// works in CI and a review can see the exact bytes it was run against.
if (RUN_AS_PROGRAM && process.argv[2] === '--against-live') {
  const file = process.argv[3];
  if (!file) {
    process.stderr.write('usage: check-ruleset-payload.mjs --against-live <live-snapshot.json>\n');
    process.exit(2);
  }
  const live = JSON.parse(readFileSync(file, 'utf8'));
  const target = savedPayloads().find(({ file: f }) => f === 'ruleset-candidate-ten.json');
  if (!target) {
    process.stderr.write('no docs/ci/ruleset-candidate-ten.json to compare against\n');
    process.exit(2);
  }
  const problems = [];
  for (const field of ['name', 'target', 'enforcement']) {
    if (live[field] !== target.payload[field]) {
      problems.push(`${field}: live is ${JSON.stringify(live[field])}, payload says ${JSON.stringify(target.payload[field])}`);
    }
  }
  for (const field of ['conditions', 'bypass_actors']) {
    if (stableJson(live[field]) !== stableJson(target.payload[field])) {
      problems.push(`${field}: live and payload differ`);
    }
  }
  // Every protective rule must be present in BOTH, byte for byte. A restore that
  // changes a `pull_request` parameter is a second, unnoticed edit to main.
  const byType = (p) => Object.fromEntries((p.rules ?? []).map((r) => [r.type, r]));
  const liveRules = byType(live);
  const payloadRules = byType(target.payload);
  for (const type of PROTECTIVE_RULES) {
    if (!liveRules[type]) problems.push(`live ruleset has NO "${type}" rule - read the snapshot again`);
    else if (!payloadRules[type]) problems.push(`payload is missing "${type}", which live has`);
    else if (stableJson(liveRules[type]) !== stableJson(payloadRules[type])) {
      problems.push(`"${type}" differs between live and payload; a restore would change it`);
    }
  }
  // The ONE intended difference.
  const liveChecks = liveRules.required_status_checks;
  const payloadChecks = payloadRules.required_status_checks;
  if (liveChecks && stableJson(liveChecks) !== stableJson(payloadChecks)) {
    problems.push('live already has a required_status_checks rule and it differs from the payload');
  }
  if (!payloadChecks) problems.push('payload has no required_status_checks rule; it is not the migration');
  for (const p of problems) process.stdout.write(`FAIL ${p}\n`);
  process.stdout.write(problems.length
    ? `against-live: ${problems.length} problem(s)\n`
    : 'against-live: the payload adds only required_status_checks and changes nothing else\n');
  process.exit(problems.length === 0 ? 0 : 1);
}

// `--diff-live <snapshot.json>` prints the Before/After table the migration doc
// embeds, so the document is regenerated from data instead of retyped.
if (RUN_AS_PROGRAM && process.argv[2] === '--diff-live') {
  const file = process.argv[3];
  if (!file) {
    process.stderr.write('usage: check-ruleset-payload.mjs --diff-live <live-snapshot.json>\n');
    process.exit(2);
  }
  const live = JSON.parse(readFileSync(file, 'utf8'));
  const target = savedPayloads().find(({ file: f }) => f === 'ruleset-candidate-ten.json');
  if (!target) { process.stderr.write('no candidate payload\n'); process.exit(2); }
  const ctx = (p) => {
    const r = (p.rules ?? []).find((x) => x.type === 'required_status_checks');
    return r ? r.parameters.required_status_checks.map((c) => c.context).join(', ') : '(none)';
  };
  const rows = [
    ['enforcement', live.enforcement, target.payload.enforcement],
    ['conditions', JSON.stringify(live.conditions), JSON.stringify(target.payload.conditions)],
    ['bypass_actors', JSON.stringify(live.bypass_actors), JSON.stringify(target.payload.bypass_actors)],
    ['rule types', (live.rules ?? []).map((r) => r.type).join(', '),
      (target.payload.rules ?? []).map((r) => r.type).join(', ')],
    ['required contexts', ctx(live), ctx(target.payload)],
    ['strict policy', '-', String(target.payload.rules.find((r) => r.type === 'required_status_checks')
      ?.parameters?.strict_required_status_checks_policy)],
  ];
  process.stdout.write('| field | before (live) | after (payload) |\n|---|---|---|\n');
  for (const [a, b, c] of rows) process.stdout.write(`| ${a} | ${b} | ${c} |\n`);
  process.exit(0);
}

if (RUN_AS_PROGRAM) {
let errors = 0;
const payloads = savedPayloads();
if (payloads.length === 0) {
  process.stdout.write('ERROR no docs/ci/ruleset-*.json payloads found\n');
  errors += 1;
}
for (const { file, payload } of payloads) {
  const problems = inspectPayload(file, payload);
  const hasChecks = (payload.rules ?? []).some((r) => r?.type === 'required_status_checks');
  process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${file} checks=${hasChecks ? 'yes' : 'no'}\n`);
  for (const p of problems) { errors += 1; process.stdout.write(`ERROR ${p}\n`); }
}
process.stdout.write(`ruleset payloads: ${errors} error(s) across ${payloads.length} file(s)\n`);
process.exit(errors === 0 ? 0 : 1);
}
