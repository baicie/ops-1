#!/usr/bin/env node
/**
 * The read-back comparison: did the write produce EXACTLY the payload?
 *
 * `PUT /rulesets/{id}` answers 200 whether or not the ruleset ended up as sent.
 * The dangerous failure is not a rejected write - it is an accepted one that put
 * back something different, and the thing it can silently lose is the protection
 * that was there before the migration.
 *
 * Run: node --test tests/ci/check-ruleset-payload.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectReadback, PROTECTIVE_RULES, CANDIDATE_TEN_CONTEXTS }
  from './check-ruleset-payload.mjs';

const payload = () => ({
  name: 'main-protection',
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'required_linear_history' },
    { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: CANDIDATE_TEN_CONTEXTS.map((context) => ({ context })),
      },
    },
  ],
});

test('an exact read-back passes', () => {
  assert.deepEqual(inspectReadback(payload(), payload()), []);
});

test('a LOST protective rule is reported by name AND as lost protection', () => {
  const after = payload();
  after.rules = after.rules.filter((r) => r.type !== 'pull_request');
  const problems = inspectReadback(payload(), after);
  assert.ok(problems.some((p) => /"pull_request" is in the payload but NOT in the read-back/.test(p)),
    JSON.stringify(problems));
  assert.ok(problems.some((p) => /PROTECTION LOST: "pull_request"/.test(p)),
    'the message must say what was lost, not only that something differs');
});

test('EVERY protective rule is covered, so a new one cannot be forgotten', () => {
  for (const type of PROTECTIVE_RULES) {
    const after = payload();
    after.rules = after.rules.filter((r) => r.type !== type);
    assert.ok(inspectReadback(payload(), after).some((p) => p.includes(`PROTECTION LOST: "${type}"`)),
      `${type} was removed but not reported as lost`);
  }
});

test('a rule the write ADDED is reported: the payload did not ask for it', () => {
  const after = payload();
  after.rules.push({ type: 'workflows' });
  const problems = inspectReadback(payload(), after);
  assert.ok(problems.some((p) => /"workflows".*write ADDED something/.test(p)), JSON.stringify(problems));
});

test('a rule whose PARAMETERS changed is reported', () => {
  // The classic silent edit: same rule type, different merge methods.
  const after = payload();
  after.rules.find((r) => r.type === 'pull_request').parameters.allowed_merge_methods = ['merge'];
  const problems = inspectReadback(payload(), after);
  assert.ok(problems.some((p) => /"pull_request" came back different/.test(p)), JSON.stringify(problems));
});

test('a changed CONTEXT LIST is reported', () => {
  const after = payload();
  after.rules.find((r) => r.type === 'required_status_checks').parameters
    .required_status_checks = CANDIDATE_TEN_CONTEXTS.slice(0, 9).map((context) => ({ context }));
  const problems = inspectReadback(payload(), after);
  assert.ok(problems.some((p) => /"required_status_checks" came back different/.test(p)),
    JSON.stringify(problems));
});

test('a changed enforcement is reported: GitHub normalising is still a difference', () => {
  const after = payload();
  after.enforcement = 'evaluate';
  assert.ok(inspectReadback(payload(), after).some((p) => /enforcement/.test(p)));
});

test('changed conditions or bypass_actors are reported', () => {
  for (const field of ['conditions', 'bypass_actors']) {
    const after = payload();
    after[field] = field === 'conditions' ? { ref_name: { include: ['refs/heads/*'], exclude: [] } } : [{ actor_id: 1, actor_type: 'Team' }];
    assert.ok(inspectReadback(payload(), after).some((p) => p.includes(field)), `${field} not reported`);
  }
});

test('the ROLLBACK payload is what the pre-migration state looked like', async () => {
  // A rollback file that claims to restore the old state but does not is worse
  // than no rollback file. Its shape is asserted here so drifting it is a failure.
  const { readFileSync } = await import('node:fs');
  const rollback = JSON.parse(readFileSync('docs/ci/ruleset-rollback-pre-migration.json', 'utf8'));
  assert.deepEqual(rollback.rules.map((r) => r.type).sort(), [...PROTECTIVE_RULES].sort(),
    'the rollback must carry exactly the four protective rules and NO required_status_checks');
  // And it is a complete, PUT-able ruleset object.
  for (const field of ['name', 'target', 'enforcement']) {
    assert.ok(rollback[field], `rollback payload has no ${field}; PUT requires it`);
  }
});
