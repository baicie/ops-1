import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuleConfig, normalizeRuleInput, evaluateRules, ruleSetDigest } from './quality.mjs';

const rule = (ruleType, config) => ({ ruleId: crypto.randomUUID(), version: 1, ruleType, config });

test('required field distinguishes missing, null and configured empty strings', () => {
  const one = evaluateRules([rule('REQUIRED_FIELD', { field: 'name', emptyStringFails: true })], [{ name: 'a' }, { name: null }, {}]);
  assert.equal(one.status, 'FAILED');
  assert.equal(one.results[0].result.failed, 2);
});

test('null rate handles empty dataset without NaN', () => {
  const result = evaluateRules([rule('NULL_RATE', { field: 'name', threshold: 0.5 })], []);
  assert.equal(result.status, 'PASSED');
  assert.equal(result.results[0].result.summary.nullRate, null);
});

test('unique key detects duplicates and supports composite keys', () => {
  const config = { fields: ['id', 'name'], nullPolicy: 'FAIL' };
  const result = evaluateRules([rule('UNIQUE_KEY', config)], [{ id: 1, name: 'a' }, { id: 1, name: 'a' }, { id: 1, name: 'b' }]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.results[0].result.failed, 1);
});

test('record count and combined rules distinguish failure from engine error', () => {
  const result = evaluateRules([rule('RECORD_COUNT', { min: 2, max: 5 }), rule('REQUIRED_FIELD', { field: 'id' })], [{ id: 1 }]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.failedRules, 1);
});

test('invalid configurations fail closed', () => {
  assert.throws(() => normalizeRuleConfig('NULL_RATE', { field: 'x', threshold: 2 }), /threshold/);
  assert.throws(() => normalizeRuleConfig('UNIQUE_KEY', { fields: [] }), /fields/);
  assert.throws(() => normalizeRuleInput({ ruleType: 'SQL', config: {} }), /unsupported/);
});

test('rule set digest is stable across object key order', () => {
  const base = [{ ruleId: 'r1', version: 1, ruleType: 'REQUIRED_FIELD', config: { field: 'id', emptyStringFails: false } }];
  const reordered = [{ ruleId: 'r1', version: 1, ruleType: 'REQUIRED_FIELD', config: { emptyStringFails: false, field: 'id' } }];
  assert.equal(ruleSetDigest(base), ruleSetDigest(reordered));
});


test('recordsFailed is distinct records, ruleFailureCount is per-rule failures', () => {
  const result = evaluateRules([
    rule('REQUIRED_FIELD', { field: 'id' }),
    rule('REQUIRED_FIELD', { field: 'name' }),
  ], [{ id: null, name: null }, { id: '1', name: 'ok' }]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.recordsFailed, 1);
  assert.equal(result.results.reduce((total, item) => total + item.result.failed, 0), 2);
});


test('record count aggregate failure does not invent a failed record', () => {
  const result = evaluateRules([rule('RECORD_COUNT', { min: 1, max: 10 })], []);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.recordsFailed, 0);
  assert.equal(result.results[0].result.aggregateFailed, true);
});

test('unique key FAIL rejects null and missing keys; IGNORE skips them', () => {
  const records = [{ id: null }, { id: '1' }, { id: '1' }, {}];
  const fail = evaluateRules([rule('UNIQUE_KEY', { fields: ['id'], nullPolicy: 'FAIL' })], records);
  assert.equal(fail.results[0].result.failed, 3); // null, duplicate 1, missing
  const ignore = evaluateRules([rule('UNIQUE_KEY', { fields: ['id'], nullPolicy: 'IGNORE' })], records);
  assert.equal(ignore.results[0].result.failed, 1); // duplicate 1 only
});
