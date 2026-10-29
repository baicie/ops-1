import crypto from 'node:crypto';

const TYPES = new Set(['REQUIRED_FIELD', 'NULL_RATE', 'UNIQUE_KEY', 'RECORD_COUNT']);
const SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

function assert(condition, message) { if (!condition) throw new Error(message); }
function finiteNumber(value, name) { assert(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number`); }
function fieldName(value, name = 'field') { assert(typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value), `${name} is invalid`); return value; }

export function normalizeRuleConfig(type, config) {
  assert(TYPES.has(type), 'unsupported ruleType');
  assert(config && typeof config === 'object' && !Array.isArray(config), 'config must be an object');
  if (type === 'REQUIRED_FIELD') {
    return { field: fieldName(config.field), emptyStringFails: config.emptyStringFails === true };
  }
  if (type === 'NULL_RATE') {
    finiteNumber(config.threshold, 'threshold');
    assert(config.threshold >= 0 && config.threshold <= 1, 'threshold must be in [0,1]');
    return { field: fieldName(config.field), threshold: config.threshold };
  }
  if (type === 'UNIQUE_KEY') {
    assert(Array.isArray(config.fields) && config.fields.length >= 1 && config.fields.length <= 8, 'fields must contain 1..8 names');
    return { fields: config.fields.map((field) => fieldName(field, 'fields')), nullPolicy: config.nullPolicy === 'IGNORE' ? 'IGNORE' : 'FAIL' };
  }
  if (type === 'RECORD_COUNT') {
    const min = config.min === undefined ? 0 : config.min;
    const max = config.max === undefined ? 10000 : config.max;
    assert(Number.isInteger(min) && min >= 0, 'min must be a non-negative integer');
    assert(Number.isInteger(max) && max >= min, 'max must be an integer >= min');
    return { min, max };
  }
  throw new Error('unsupported ruleType');
}

export function normalizeRuleInput(body) {
  assert(body && typeof body === 'object', 'body required');
  assert(SEVERITIES.has(body.severity || 'MEDIUM'), 'severity is invalid');
  return {
    ruleType: body.ruleType,
    config: normalizeRuleConfig(body.ruleType, body.config),
    severity: body.severity || 'MEDIUM',
    enabled: body.enabled === undefined ? true : body.enabled === true,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function ruleSetDigest(rules) {
  const stable = rules.map((rule) => ({ ruleId: rule.rule_id || rule.ruleId, version: rule.version, ruleType: rule.rule_type || rule.ruleType, config: rule.config }))
    .sort((a, b) => String(a.ruleId).localeCompare(String(b.ruleId)));
  return 'sha256:' + crypto.createHash('sha256').update(canonical(stable)).digest('hex');
}

function hasValue(record, field) { return Object.prototype.hasOwnProperty.call(record, field) && record[field] !== null && record[field] !== undefined; }

export function evaluateRule(rule, records) {
  const config = normalizeRuleConfig(rule.ruleType, rule.config);
  let failed = 0;
  const failedIndexes = [];
  if (rule.ruleType === 'REQUIRED_FIELD') {
    records.forEach((record, index) => {
      if (!hasValue(record, config.field) || (config.emptyStringFails && record[config.field] === '')) {
        failed += 1; failedIndexes.push(index);
      }
    });
  } else if (rule.ruleType === 'NULL_RATE') {
    let missing = 0;
    records.forEach((record, index) => { if (!hasValue(record, config.field)) { missing += 1; failedIndexes.push(index); } });
    const rate = records.length === 0 ? null : missing / records.length;
    failed = rate !== null && rate > config.threshold ? missing : 0;
    return { status: failed > 0 ? 'FAILED' : 'PASSED', examined: records.length, failed, failedIndexes: failed > 0 ? failedIndexes : [], summary: { missing, nullRate: rate, threshold: config.threshold } };
  } else if (rule.ruleType === 'UNIQUE_KEY') {
    const seen = new Set();
    records.forEach((record, index) => {
      const values = config.fields.map((field) => hasValue(record, field) ? record[field] : null);
      const hasNull = values.some((value) => value === null);
      if (hasNull) {
        if (config.nullPolicy === 'IGNORE') return;
        failed += 1; failedIndexes.push(index); return;
      }
      const key = canonical(values);
      if (seen.has(key)) { failed += 1; failedIndexes.push(index); } else seen.add(key);
    });
  } else if (rule.ruleType === 'RECORD_COUNT') {
    failed = records.length < config.min || records.length > config.max ? 1 : 0;
    return { status: failed ? 'FAILED' : 'PASSED', examined: records.length, failed, failedIndexes: [], aggregateFailed: Boolean(failed), summary: { min: config.min, max: config.max, observed: records.length, aggregateFailed: Boolean(failed) } };
  }
  return { status: failed > 0 ? 'FAILED' : 'PASSED', examined: records.length, failed, failedIndexes, summary: { failed } };
}

export function evaluateRules(rules, records) {
  const results = rules.map((rule) => ({ rule, result: evaluateRule(rule, records) }));
  const failed = results.some((item) => item.result.status === 'FAILED');
  const failedRecords = new Set();
  for (const item of results) for (const index of item.result.failedIndexes || []) failedRecords.add(index);
  return { status: failed ? 'FAILED' : 'PASSED', results, failedRules: results.filter((item) => item.result.status === 'FAILED').length, recordsFailed: failedRecords.size };
}

export const QUALITY_RULE_TYPES = [...TYPES];
