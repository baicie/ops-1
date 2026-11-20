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
 *   3. the `required_status_checks` payloads carry exactly the nine contexts the
 *      workflows produce, so a restore cannot quietly drop one
 *   4. `strict_required_status_checks_policy` is asserted explicitly rather than
 *      left to whatever the file happens to contain
 *
 * It does NOT read GitHub. Comparing the saved payloads to the live ruleset is
 * `--against-live`, which needs `gh` and is described in the docs; the offline
 * check runs everywhere.
 *
 * Run with `--selftest` to check the checks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOCS = fileURLToPath(new URL('../../docs/ci/', import.meta.url));

/** The four rules that are NOT about status checks. Restoring must not touch them. */
export const PROTECTIVE_RULES = ['deletion', 'non_fast_forward', 'required_linear_history', 'pull_request'];

/** The nine contexts `main`'s workflows produce today. */
export const NINE_CONTEXTS = [
  'contracts', 'linux-runtime', 'platform-image-build', 'platform-only',
  'quality-faults', 'rust', 'spec-coverage', 'web', 'web-unit',
];

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
  for (const rule of checkRules) {
    const params = rule.parameters ?? {};
    const contexts = (params.required_status_checks ?? []).map((c) => c?.context);
    if (contexts.length !== NINE_CONTEXTS.length) {
      problems.push(`${name}: ${contexts.length} contexts, expected ${NINE_CONTEXTS.length}`);
    }
    const missing = NINE_CONTEXTS.filter((c) => !contexts.includes(c));
    if (missing.length) problems.push(`${name}: contexts missing: ${missing.join(', ')}`);
    const extra = contexts.filter((c) => !NINE_CONTEXTS.includes(c));
    if (extra.length) {
      problems.push(`${name}: contexts not produced by this repository: ${extra.join(', ')}`);
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
    ['a context nobody produces is rejected',
      { ...good, rules: good.rules.slice(0, 4).concat([{
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: NINE_CONTEXTS.concat('ci-gate').map((context) => ({ context })),
        },
      }]) }, ['not produced by this repository: ci-gate']],
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

if (process.argv[2] === '--selftest') process.exit(selftest() ? 0 : 1);

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
