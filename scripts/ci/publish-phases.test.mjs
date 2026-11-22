#!/usr/bin/env node
/**
 * What a failure at each phase leaves behind, and whether production moved.
 *
 * A publish that fails prints `exit 1` and a wall of text. The three questions an
 * operator needs answered are: which phase, what changed, and where to retry. If
 * the model gets any of them wrong the tool is worse than nothing, because it
 * answers with confidence.
 *
 * Run: node --test scripts/ci/publish-phases.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PHASES, LAST_HARMLESS_PHASE, explain, scriptDrift,
} from './publish-phases.mjs';

test('the phases are ordered and every mutating phase comes after the harmless ones', () => {
  const firstMutating = PHASES.findIndex((p) => p.mutates);
  const lastHarmless = PHASES.map((p) => p.mutates).lastIndexOf(false);
  assert.ok(firstMutating > PHASES.findIndex((p) => p.name === LAST_HARMLESS_PHASE),
    'SIGNED must be harmless and everything before it too');
  // ACCEPTED is not mutating - it is the read-back.
  const accepted = PHASES.find((p) => p.name === 'ACCEPTED');
  assert.equal(accepted.mutates, false, 'ACCEPTED only reads');
  void lastHarmless;
});

test('a failure before SIGNED leaves nothing outside this host', () => {
  for (const p of ['PREFLIGHT', 'BUILT', 'PUSHED', 'VERIFIED', 'BUNDLED']) {
    const r = explain(p);
    assert.deepEqual(r.leftover, [], `${p} claimed a leftover`);
    assert.equal(r.productionAffected, false);
  }
});

test('a failure AT INSTALLED assumes the install may have written the row', () => {
  // The first version read only the COMPLETED phases, so this case reported
  // "nothing outside this host" while the package row may already exist.
  const r = explain('INSTALLED');
  assert.ok(r.leftover.some((l) => /package row/.test(l)),
    `failing at INSTALLED claimed nothing was written: ${JSON.stringify(r.leftover)}`);
  assert.equal(r.productionAffected, false, 'a package row is not a serving change');
});

test('a failure AT ACTIVATING reports production as AFFECTED, because it is ambiguous', () => {
  // Assuming the switch did NOT commit is the assumption that leaves production on
  // a version nobody chose. The tool must say "may have changed".
  const r = explain('ACTIVATING');
  assert.equal(r.productionAffected, true);
  assert.equal(r.manualRecovery, true);
  assert.match(r.explanation, /MUST be read back/);
  assert.match(r.explanation, /effectiveVersion/);
});

test('a failure AFTER ACTIVE reports production as affected', () => {
  assert.equal(explain('ACTIVE').productionAffected, true);
  assert.equal(explain('ACCEPTED').productionAffected, true);
});

test('every phase before ACTIVATING reports production untouched', () => {
  for (const p of ['PREFLIGHT', 'PUSHED', 'SIGNED', 'INSTALLED', 'DEPLOYING', 'READY']) {
    assert.equal(explain(p).productionAffected, false, `${p} claimed production changed`);
  }
});

test('READY adds the fact that instances may be RUNNING, which changes the recovery', () => {
  const ready = explain('READY');
  assert.ok(ready.leftover.some((l) => /RUNNING and healthy/.test(l)),
    'a healthy-but-not-serving instance is a different recovery from a failed one');
});

test('an unknown phase refuses to guess and points at the read-only preflight', () => {
  const r = explain('SHIPPED');
  assert.equal(r.known, false);
  assert.equal(r.retryFrom, 'PREFLIGHT');
  assert.match(r.explanation, /not a phase this release knows/);
});

test('the explanation names the completed phases, so a reader can see how far it got', () => {
  const r = explain('READY');
  assert.match(r.explanation, /PREFLIGHT -> BUILT -> PUSHED -> VERIFIED -> BUNDLED -> SIGNED -> INSTALLED -> DEPLOYING/);
});

test('the model and the publish script agree on every stage boundary', () => {
  // A model that names phases the script does not go through answers questions
  // about a release that never happens.
  const script = readFileSync('scripts/publish-data-plugins.sh', 'utf8');
  assert.deepEqual(scriptDrift(script), []);
});

test('scriptDrift REFUSES an empty script rather than reporting no drift', () => {
  // "I read nothing" must not read as "everything agrees".
  assert.ok(scriptDrift('').length > 0);
});

test('scriptDrift notices a stage the script no longer has', () => {
  const script = readFileSync('scripts/publish-data-plugins.sh', 'utf8');
  const without = script.replace(/assemble_plugin\.py/g, 'assemble_removed.py');
  assert.ok(scriptDrift(without).some((p) => /BUNDLED/.test(p)),
    'removing the bundling stage must be reported');
});
