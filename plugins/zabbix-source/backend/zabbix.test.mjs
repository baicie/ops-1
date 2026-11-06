// Failure-semantics and attestation tests for the Zabbix source plugin.
//
// Run with: node --test plugins/zabbix-source/backend/zabbix.test.mjs
//
// No Zabbix instance is involved. Every test drives the collector through the
// `transport` seam, so what is proven here is the plugin's own semantics: which
// outcome it reaches for which kind of failure, and that an absent reading stays
// absent. Collection against a real Zabbix server is a separate, NOT_RUN check
// recorded in docs/design/zabbix-source/IMPLEMENTATION-STATUS.md (N-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  BUDGET_CEILING,
  EVIDENCE_CONTENT_MAX_BYTES,
  assertEndpoint,
  attestationPayload,
  buildEvidence,
  collect,
  collectionOutcome,
  contentRef,
  listHosts,
  listItems,
  probe,
  redact,
  resolveBudget,
  resolveWindow,
  signAttestation,
  statusFromProbe,
} from './zabbix.mjs';

const SOURCE = {
  sourceId: '9f1c1f6e-4d2b-4f7a-9b54-1d6a2f0c7e31',
  endpoint: 'https://zabbix.example.invalid/api_jsonrpc.php',
  verifyTls: true,
  secret: 'token-never-logged',
};

const WINDOW = { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' };

/** A transport that fails every call with the given code. */
const failWith = (code) => async () => {
  throw Object.assign(new Error('injected'), { code, status: 422 });
};

/** A transport that answers per item id from a table. */
const answerWith = (table) => async ({ method, params }) => {
  if (method === 'apiinfo.version') return '7.0.0';
  const id = params.itemids[0];
  const answer = table[id];
  if (typeof answer === 'function') return answer();
  return answer;
};

const row = (clockSeconds, value) => ({ clock: String(clockSeconds), ns: '0', value });

// ---------------------------------------------------------------------------
// The cross-language check that matters most (rules/10)
// ---------------------------------------------------------------------------

test('the signed payload is byte-identical to the Kernel golden vector', () => {
  // This exact string is asserted in apps/kernel/src/incidents.rs
  // (attestation_payload_matches_the_published_golden_vector). If either side
  // changes key order, casing or timestamp precision, one of the two tests
  // fails instead of every signature failing silently in production.
  const expected =
    '{"v":"opsweave-evidence-attestation-v2","adapterId":"zabbix-main",' +
    '"workspaceId":"00000000-0000-4000-8000-000000000001",' +
    '"incidentId":"b17265e7-3ac8-4877-bad4-40c4d2df4a87",' +
    '"kind":"METRIC_SNAPSHOT","source":"zabbix:probe",' +
    '"collectedAtUnix":1793423844,"contentRef":"sha256:probe-1",' +
    '"issuedAtUnix":1793423844}';

  const actual = attestationPayload({
    adapterId: 'zabbix-main',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    incidentId: 'b17265e7-3ac8-4877-bad4-40c4d2df4a87',
    kind: 'METRIC_SNAPSHOT',
    source: 'zabbix:probe',
    collectedAt: '2026-10-31T05:17:24Z',
    contentRef: 'sha256:probe-1',
    issuedAt: '2026-10-31T05:17:24Z',
  });

  assert.equal(actual, expected);
});

test('the signature verifies under the Kernel algorithm and breaks on any edit', () => {
  const secret = 'adapter-secret';
  const tuple = {
    adapterId: 'zabbix-main',
    workspaceId: '00000000-0000-4000-8000-000000000001',
    secret,
    incidentId: 'b17265e7-3ac8-4877-bad4-40c4d2df4a87',
    kind: 'METRIC_SNAPSHOT',
    source: 'zabbix:probe',
    collectedAt: '2026-10-31T05:17:24Z',
    contentRef: 'sha256:probe-1',
    issuedAt: '2026-10-31T05:17:24Z',
  };
  const envelope = signAttestation(tuple);

  // Recompute the way the Kernel does: HMAC-SHA256, base64url, no padding.
  const recomputed = crypto
    .createHmac('sha256', secret)
    .update(attestationPayload(tuple))
    .digest('base64url');
  assert.equal(envelope.signature, recomputed);
  assert.ok(!envelope.signature.includes('='), 'base64url must be unpadded');
  assert.ok(!('secret' in envelope), 'the envelope must not carry the secret');

  // Moving the same signature onto different evidence must not verify: this is
  // what stops a genuine attestation being lifted onto another row.
  const moved = crypto
    .createHmac('sha256', secret)
    .update(attestationPayload({ ...tuple, contentRef: 'sha256:probe-2' }))
    .digest('base64url');
  assert.notEqual(moved, envelope.signature);

  // The workspace is inside the signed bytes: signing the same row for another
  // workspace changes the signature, so a caller cannot move it across the
  // business boundary.
  const otherWorkspace = crypto
    .createHmac('sha256', secret)
    .update(attestationPayload({ ...tuple, workspaceId: '00000000-0000-4000-8000-000000000002' }))
    .digest('base64url');
  assert.notEqual(otherWorkspace, envelope.signature);
  assert.equal(envelope.workspaceId, '00000000-0000-4000-8000-000000000001');

  assert.throws(
    () => signAttestation({ ...tuple, workspaceId: '' }),
    (error) => error.code === 'ZABBIX_WORKSPACE_REQUIRED',
    'a collection without a workspace cannot be signed',
  );
});

test('an unconfigured adapter cannot sign at all', () => {
  assert.throws(
    () => signAttestation({ adapterId: '', workspaceId: '00000000-0000-4000-8000-000000000001', secret: '', incidentId: 'x', kind: 'METRIC_SNAPSHOT', source: 's', collectedAt: WINDOW.to, contentRef: 'sha256:x', issuedAt: WINDOW.to }),
    (error) => error.code === 'ZABBIX_ADAPTER_UNCONFIGURED',
  );
});

// ---------------------------------------------------------------------------
// Probe: unreachable, timeout and unauthorized are three different facts
// ---------------------------------------------------------------------------

test('probe separates unreachable, timeout, unauthorized and unknown', async () => {
  const cases = [
    ['ZABBIX_UNREACHABLE', 'UNAVAILABLE'],
    ['ZABBIX_TIMEOUT', 'TIMEOUT'],
    ['ZABBIX_UNAUTHORIZED', 'UNAUTHORIZED'],
    ['ZABBIX_RESPONSE_UNPARSEABLE', 'UNKNOWN'],
    ['ZABBIX_SSRF_BLOCKED', 'UNAVAILABLE'],
  ];
  for (const [injected, expected] of cases) {
    const result = await probe(SOURCE, { transport: failWith(injected) });
    assert.equal(result.outcome, expected, `${injected} must report ${expected}`);
    assert.equal(result.errorCode, injected);
    assert.ok(result.observedAt, 'a failed probe is still an observation with a time');
  }

  const ok = await probe(SOURCE, { transport: answerWith({}) });
  assert.equal(ok.outcome, 'OK');
  assert.equal(ok.apiVersion, '7.0.0');
});

test('a timeout never reads as the endpoint being down, and silence never promotes a source', () => {
  // The distinction the rules care about: TIMEOUT is "we do not know", so the
  // source is DEGRADED, not UNAVAILABLE.
  assert.equal(statusFromProbe({ outcome: 'TIMEOUT' }), 'DEGRADED');
  assert.equal(statusFromProbe({ outcome: 'UNAVAILABLE' }), 'UNAVAILABLE');
  assert.equal(statusFromProbe({ outcome: 'UNKNOWN' }), 'DEGRADED');
  assert.equal(statusFromProbe({ outcome: 'OK' }), 'READY');
  // Never probed stays UNVERIFIED: absence of a probe is not health.
  assert.equal(statusFromProbe(undefined), 'UNVERIFIED');
  // Reachable only with TLS verification off is not READY.
  assert.equal(statusFromProbe({ outcome: 'OK' }, { verifyTls: false }), 'DEGRADED');
});

// ---------------------------------------------------------------------------
// The rule that matters: EMPTY is not NO_DATA, and neither is 0
// ---------------------------------------------------------------------------

test('an established absence is EMPTY and an unestablished one is NO_DATA', async () => {
  const empty = await collect({
    source: SOURCE,
    itemIds: ['10001'],
    window: WINDOW,
    transport: answerWith({ 10001: [] }),
  });
  assert.equal(empty.outcome, 'EMPTY');
  assert.equal(empty.series[0].outcome, 'EMPTY');
  assert.deepEqual(empty.series[0].samples, [], 'an empty history produces no samples at all');

  // A reply the contract does not describe: whether history exists is not
  // established, so NO_DATA rather than EMPTY.
  const noData = await collect({
    source: SOURCE,
    itemIds: ['10002'],
    window: WINDOW,
    transport: answerWith({ 10002: { unexpected: true } }),
  });
  assert.equal(noData.outcome, 'NO_DATA');
  assert.equal(noData.series[0].outcome, 'NO_DATA');
  assert.equal(noData.series[0].errorCode, 'ZABBIX_RESPONSE_SHAPE');
});

test('a missing reading is null with a reason and is never 0', async () => {
  const result = await collect({
    source: SOURCE,
    itemIds: ['10003'],
    window: WINDOW,
    transport: answerWith({
      10003: [row(1762041600, '12.5'), row(1762041660, ''), row(1762041720, 'not-a-number'), row(1762041780, '0')],
    }),
  });

  const samples = result.series[0].samples;
  assert.equal(samples.length, 4);
  assert.equal(samples[0].value, 12.5);
  assert.equal(samples[0].absenceReason, null);

  // The two unreadable rows must be nulls carrying a reason, not zeros.
  assert.equal(samples[1].value, null);
  assert.equal(samples[1].absenceReason, 'NOT_RECORDED');
  assert.equal(samples[2].value, null);
  assert.equal(samples[2].absenceReason, 'NOT_RECORDED');

  // A genuine zero stays a zero and carries no absence reason: the plugin must
  // not confuse "measured zero" with "no measurement" in either direction.
  assert.equal(samples[3].value, 0);
  assert.equal(samples[3].absenceReason, null);

  assert.equal(
    samples.filter((s) => s.value === 0).length,
    1,
    'exactly one sample is zero: the one Zabbix reported as zero',
  );
});

// ---------------------------------------------------------------------------
// Partial failure keeps what answered
// ---------------------------------------------------------------------------

test('one failing item makes the collection PARTIAL and keeps the rest', async () => {
  const result = await collect({
    source: SOURCE,
    itemIds: ['10001', '10002', '10003'],
    window: WINDOW,
    transport: answerWith({
      10001: [row(1762041600, '1')],
      10002: () => {
        throw Object.assign(new Error('injected'), { code: 'ZABBIX_TIMEOUT' });
      },
      10003: [row(1762041600, '3')],
    }),
  });

  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.requestedItems, 3);
  assert.equal(result.answeredItems, 2, 'the two items that answered are kept');

  const failed = result.series.find((s) => s.itemId === '10002');
  assert.equal(failed.outcome, 'TIMEOUT');
  assert.equal(failed.errorCode, 'ZABBIX_TIMEOUT');
  assert.deepEqual(failed.samples, [], 'a failed item contributes no samples, not zeros');

  // The denominator stays visible: 3 asked, 2 answered.
  assert.equal(result.requestedItems - result.answeredItems, 1);
});

test('total failure reports which kind of nothing it was', async () => {
  const unreachable = await collect({
    source: SOURCE,
    itemIds: ['1', '2'],
    window: WINDOW,
    transport: failWith('ZABBIX_UNREACHABLE'),
  });
  assert.equal(unreachable.outcome, 'UNAVAILABLE');
  assert.equal(unreachable.answeredItems, 0);

  const timedOut = await collect({
    source: SOURCE,
    itemIds: ['1', '2'],
    window: WINDOW,
    transport: failWith('ZABBIX_TIMEOUT'),
  });
  assert.equal(timedOut.outcome, 'TIMEOUT');

  const unknown = await collect({
    source: SOURCE,
    itemIds: ['1', '2'],
    window: WINDOW,
    transport: failWith('ZABBIX_RESPONSE_UNPARSEABLE'),
  });
  assert.equal(unknown.outcome, 'UNKNOWN');

  // A mixture of unreachable and timed out is neither: it is UNKNOWN.
  let call = 0;
  const mixed = await collect({
    source: SOURCE,
    itemIds: ['1', '2'],
    window: WINDOW,
    transport: async () => {
      const code = call++ === 0 ? 'ZABBIX_UNREACHABLE' : 'ZABBIX_TIMEOUT';
      throw Object.assign(new Error('injected'), { code });
    },
  });
  assert.equal(mixed.outcome, 'UNKNOWN');
});

test('requesting no items is EMPTY, not a success over zero items', async () => {
  const result = await collect({ source: SOURCE, itemIds: [], window: WINDOW, transport: answerWith({}) });
  assert.equal(result.outcome, 'EMPTY');
  assert.equal(result.requestedItems, 0);
  assert.equal(result.answeredItems, 0);
});

test('a mix of data and established-absence is PARTIAL, not OK', () => {
  assert.equal(
    collectionOutcome({
      series: [{ outcome: 'OK' }, { outcome: 'EMPTY' }],
      requestedItems: 2,
      attemptedItems: 2,
      clamped: [],
    }),
    'PARTIAL',
  );
  assert.equal(
    collectionOutcome({
      series: [{ outcome: 'OK' }, { outcome: 'OK' }],
      requestedItems: 2,
      attemptedItems: 2,
      clamped: [],
    }),
    'OK',
  );
  // All absences, some established and some not: PARTIAL rather than claiming
  // every absence was confirmed.
  assert.equal(
    collectionOutcome({
      series: [{ outcome: 'EMPTY' }, { outcome: 'NO_DATA' }],
      requestedItems: 2,
      attemptedItems: 2,
      clamped: [],
    }),
    'PARTIAL',
  );
});

// ---------------------------------------------------------------------------
// Budgets and ceilings (AGENTS.md: every collection has a budget and a ceiling)
// ---------------------------------------------------------------------------

test('a budget above the ceiling is clamped and the result says so', async () => {
  const { budget, clamped } = resolveBudget({ maxItems: 100000, maxWindowSeconds: 999999, maxConcurrency: 64 });
  assert.equal(budget.maxItems, BUDGET_CEILING.maxItems);
  assert.equal(budget.maxWindowSeconds, BUDGET_CEILING.maxWindowSeconds);
  assert.equal(budget.maxConcurrency, BUDGET_CEILING.maxConcurrency);
  assert.deepEqual(clamped.sort(), ['maxConcurrency', 'maxItems', 'maxWindowSeconds']);

  assert.throws(() => resolveBudget({ maxItems: 0 }), (e) => e.code === 'ZABBIX_BUDGET_INVALID');
  assert.throws(() => resolveBudget({ maxItems: -1 }), (e) => e.code === 'ZABBIX_BUDGET_INVALID');
});

test('too many items is PARTIAL over the full denominator', async () => {
  const itemIds = Array.from({ length: 5 }, (_, i) => String(20000 + i));
  const result = await collect({
    source: SOURCE,
    itemIds,
    window: WINDOW,
    budget: { maxItems: 2 },
    transport: answerWith(Object.fromEntries(itemIds.map((id) => [id, [row(1762041600, '1')]]))),
  });
  assert.equal(result.outcome, 'PARTIAL');
  assert.equal(result.requestedItems, 5, 'the denominator is what was asked for');
  assert.equal(result.series.length, 2, 'only the budgeted number was attempted');
  assert.ok(result.clamped.includes('items'));
});

test('an over-long window is clamped to the most recent part and reported', () => {
  const { window, clamped } = resolveWindow('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', {
    maxWindowSeconds: 3600,
  });
  assert.equal(clamped, true);
  assert.equal(window.to, '2026-11-02T00:00:00.000Z');
  assert.equal(window.from, '2026-11-01T23:00:00.000Z', 'the most recent hour is kept');

  assert.throws(() => resolveWindow('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z', { maxWindowSeconds: 3600 }), (e) => e.code === 'ZABBIX_WINDOW_INVALID');
  assert.throws(() => resolveWindow('not-a-date', WINDOW.to, { maxWindowSeconds: 3600 }), (e) => e.code === 'ZABBIX_WINDOW_INVALID');
});

test('hitting the per-item sample ceiling marks the series PARTIAL with an explained null', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(1762041600 + i * 60, String(i)));
  const result = await collect({
    source: SOURCE,
    itemIds: ['10004'],
    window: WINDOW,
    budget: { maxSamplesPerItem: 4 },
    transport: answerWith({ 10004: rows }),
  });

  const series = result.series[0];
  assert.equal(series.outcome, 'PARTIAL');
  const last = series.samples[series.samples.length - 1];
  assert.equal(last.value, null);
  assert.equal(last.absenceReason, 'CLAMPED_BY_BUDGET');
  // The covered window must stop where the data stopped, not claim the whole
  // requested window.
  assert.notEqual(series.coveredWindow.to, series.requestedWindow.to);
});

// ---------------------------------------------------------------------------
// Content digest
// ---------------------------------------------------------------------------

test('the content digest is stable under key order and changes with the outcome', () => {
  const base = {
    sourceId: SOURCE.sourceId,
    outcome: 'OK',
    requestedItems: 1,
    answeredItems: 1,
    clamped: [],
    budget: { maxItems: 100 },
    observedAt: '2026-11-01T01:00:00Z',
    series: [{ itemId: '1', outcome: 'OK', samples: [{ occurredAt: WINDOW.from, value: 1, absenceReason: null }] }],
  };
  const reordered = {
    series: base.series,
    observedAt: base.observedAt,
    budget: base.budget,
    clamped: base.clamped,
    answeredItems: base.answeredItems,
    requestedItems: base.requestedItems,
    outcome: base.outcome,
    sourceId: base.sourceId,
  };
  assert.equal(contentRef(base), contentRef(reordered));

  // Re-labelling a PARTIAL collection as OK must not keep the same digest.
  assert.notEqual(contentRef(base), contentRef({ ...base, outcome: 'PARTIAL' }));
  // Changing a sample must not keep the digest either.
  assert.notEqual(
    contentRef(base),
    contentRef({ ...base, series: [{ ...base.series[0], samples: [{ occurredAt: WINDOW.from, value: 2, absenceReason: null }] }] }),
  );
});

// ---------------------------------------------------------------------------
// Secrets never surface
// ---------------------------------------------------------------------------

test('a collection result carries no secret anywhere', async () => {
  const result = await collect({
    source: SOURCE,
    itemIds: ['10005'],
    window: WINDOW,
    transport: answerWith({ 10005: [row(1762041600, '1')] }),
  });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(SOURCE.secret), 'the token must not appear in the result');
  assert.ok(!serialised.includes('token-never-logged'));
});

test('redact removes secret values and credential-shaped text', () => {
  assert.ok(!redact('failed with token-never-logged', [SOURCE.secret]).includes('token-never-logged'));
  // A scheme-prefixed value hides the secret after a space, so the redaction
  // has to run past the scheme word and take the token that follows it.
  assert.equal(redact('authorization: Bearer abc123'), 'authorization: Bearer [redacted]');
  assert.ok(!redact('authorization: Bearer abc123').includes('abc123'));
  // ...and a header with no scheme word still loses its value.
  assert.ok(!redact('Authorization: abc123').includes('abc123'));
  assert.equal(redact('connecting to https://user:pw@zabbix.invalid/x'), 'connecting to https://[redacted]@zabbix.invalid/x');
  // The JSON quoting survives; only the value inside it goes.
  assert.equal(redact('{"password":"hunter2"}'), '{"password":"[redacted]"}');
  assert.ok(!redact('token=abc123&x=1').includes('abc123'));
  // Text with nothing credential-shaped is left alone, so redaction cannot be
  // mistaken for a blanket wipe of every diagnostic message.
  assert.equal(redact('plain text no secret here'), 'plain text no secret here');
});

// ---------------------------------------------------------------------------
// Inventory: host and item listing (the read side of the closed loop)
// ---------------------------------------------------------------------------

test('inventory keeps UNKNOWN availability distinct from UNAVAILABLE', async () => {
  // Zabbix's "never checked" (0) and "checked and down" (2) are different
  // operational facts. Folding the first into the second turns a monitoring gap
  // into a fabricated outage, which rules/05 forbids.
  const transport = async () => [
    { hostid: '10084', name: 'web-01', available: '1' },
    { hostid: '10085', name: 'db-01', available: '2' },
    { hostid: '10086', name: 'new-01', available: '0' },
    { hostid: '10087', name: 'odd-01', available: undefined },
  ];
  const result = await listHosts(SOURCE, { transport });
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(
    result.items.map((host) => host.available),
    ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'UNKNOWN'],
  );
});

test('inventory asks for one more row than it returns, and says when it withheld one', async () => {
  const budget = { ...BUDGET_CEILING, maxItems: 3 };
  const rows = Array.from({ length: 4 }, (_, index) => ({ hostid: String(index + 1), name: `h${index}`, available: '1' }));
  let askedLimit;
  const transport = async ({ params }) => {
    askedLimit = params.limit;
    return rows;
  };
  const result = await listHosts(SOURCE, { budget, transport });
  // The probe row is how a short list is prevented from being read as "this
  // Zabbix only has three hosts".
  assert.equal(askedLimit, 4, 'must probe past the ceiling to detect clamping');
  assert.equal(result.outcome, 'PARTIAL', 'a clamped inventory is not a complete answer');
  assert.equal(result.items.length, 3);
  assert.equal(result.clamped, true);
  assert.equal(result.truncated, null, 'the remainder is unknowable from one bounded call, so it is not 0');
});

test('inventory at exactly the ceiling is complete, not clamped', async () => {
  const budget = { ...BUDGET_CEILING, maxItems: 3 };
  const rows = Array.from({ length: 3 }, (_, index) => ({ hostid: String(index + 1), name: `h${index}`, available: '1' }));
  const result = await listHosts(SOURCE, { budget, transport: async () => rows });
  assert.equal(result.outcome, 'OK');
  assert.equal(result.clamped, false);
  assert.equal(result.truncated, 0);
});

test('an empty inventory is EMPTY and an unmappable one is NO_DATA', async () => {
  const empty = await listHosts(SOURCE, { transport: async () => [] });
  assert.equal(empty.outcome, 'EMPTY');
  assert.deepEqual(empty.items, []);
  // A non-array answer is not "zero hosts" - we failed to establish the count.
  const unknown = await listHosts(SOURCE, { transport: async () => ({ error: 'weird' }) });
  assert.equal(unknown.outcome, 'NO_DATA');
  assert.equal(unknown.truncated, null);
});

test('an inventory failure reports the same failure vocabulary as collection', async () => {
  const down = await listHosts(SOURCE, { transport: failWith('ZABBIX_UNREACHABLE') });
  assert.equal(down.outcome, 'UNAVAILABLE', 'never connected is unavailable, not "no hosts"');
  assert.equal(down.errorCode, 'ZABBIX_UNREACHABLE');
  const slow = await listHosts(SOURCE, { transport: failWith('ZABBIX_TIMEOUT') });
  assert.equal(slow.outcome, 'TIMEOUT', 'a slow server is not a server with no hosts');
  // Unreachable/unavailable inventory must never be reported as an empty list.
  for (const result of [down, slow]) {
    assert.notEqual(result.outcome, 'EMPTY');
    assert.deepEqual(result.items, []);
  }
});

test('items are listed for one host and map Zabbix value types', async () => {
  let seenParams;
  const transport = async ({ method, params }) => {
    seenParams = { method, params };
    return [
      { itemid: '10401', key_: 'system.cpu.load[avg1]', name: 'CPU load', units: '', value_type: '0' },
      { itemid: '10402', key_: 'vfs.fs.size[/,free]', name: 'Free disk', units: 'B', value_type: '3' },
      { itemid: '10403', key_: 'system.hostname', name: 'Hostname', units: undefined, value_type: '4' },
      { itemid: '10404', key_: 'system.run[nope]', name: 'Unsupported', units: null, value_type: '7' },
    ];
  };
  const result = await listItems(SOURCE, '10084', { transport });
  assert.equal(seenParams.method, 'item.get');
  assert.deepEqual(seenParams.params.hostids, ['10084']);
  assert.equal(result.outcome, 'OK');
  assert.deepEqual(
    result.items.map((item) => item.itemId),
    ['10401', '10402', '10403', '10404'],
  );
  assert.deepEqual(
    result.items.map((item) => item.valueType),
    ['FLOAT', 'INTEGER', 'TEXT', 'UNSUPPORTED'],
  );
  // An absent unit is null, not the empty string: "" would render as a real
  // (empty) unit in a chart label.
  assert.equal(result.items[2].unit, null);
  assert.equal(result.items[3].unit, null);
});

test('listing items without a host is refused rather than silently listing every item', () => {
  // listItems rejects before it is ever awaited, so this is assert.throws and
  // not assert.rejects: the guard must fire without a round trip to Zabbix.
  for (const hostId of [undefined, null, '', 0]) {
    assert.throws(() => listItems(SOURCE, hostId, { transport: async () => [] }), (error) => {
      assert.equal(error.code, 'ZABBIX_HOST_REQUIRED');
      assert.equal(error.status, 400);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// Outbound policy (rules/03: bounded outbound targets)
// ---------------------------------------------------------------------------

test('the outbound guard refuses loopback, private, metadata and credential URLs', async () => {
  const blocked = [
    ['https://127.0.0.1/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    // The cloud metadata endpoint is the one that turns an SSRF into a
    // credential theft, so it gets its own case rather than hiding inside
    // "link-local".
    ['https://169.254.169.254/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    ['https://10.1.2.3/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    ['https://192.168.1.10/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    ['https://172.16.0.5/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    ['https://[::1]/api_jsonrpc.php', 'ZABBIX_SSRF_BLOCKED'],
    ['ftp://8.8.8.8/x', 'ZABBIX_SSRF_BLOCKED'],
    // A token smuggled into the URL would reach every access log on the path.
    ['http://user:pw@8.8.8.8/x', 'ZABBIX_ENDPOINT_INVALID'],
  ];
  for (const [url, code] of blocked) {
    await assert.rejects(() => assertEndpoint(url), (error) => error.code === code, `${url} must be refused`);
  }
  // A public literal still resolves, so the guard is a filter and not a wall.
  const allowed = await assertEndpoint('https://8.8.8.8/api_jsonrpc.php');
  assert.equal(allowed.url.hostname, '8.8.8.8');
});


test('a 500-series collection is bounded to 64 KiB, not by an iteration budget', () => {
  const samples = (count) => Array.from({ length: count }, (_, index) => ({
    occurredAt: '2026-11-01T00:30:00Z',
    value: index,
    absenceReason: null,
  }));
  const series = Array.from({ length: 500 }, (_, index) => ({
    itemId: String(10000 + index),
    hostId: '10084',
    key: `system.metric.${index}`,
    unit: '%',
    outcome: 'OK',
    requestedWindow: WINDOW,
    coveredWindow: WINDOW,
    samples: samples(5),
  }));
  const result = {
    sourceId: SOURCE.sourceId,
    outcome: 'OK',
    requestedItems: 500,
    answeredItems: 500,
    clamped: [],
    series,
    budget: { maxWindowSeconds: 3600, maxItems: 500, maxSamplesPerItem: 5000, requestTimeoutMs: 30000, maxConcurrency: 4 },
    observedAt: '2026-11-01T01:00:00Z',
  };
  const evidence = buildEvidence(result);
  assert.equal(evidence.outcome, 'PARTIAL');
  assert.ok(evidence.snapshot, 'an over-bound collection must carry a snapshot');
  assert.ok(
    Buffer.byteLength(evidence.body, 'utf8') <= EVIDENCE_CONTENT_MAX_BYTES,
    `body is ${Buffer.byteLength(evidence.body, 'utf8')} bytes, over the 64 KiB bound`,
  );
  assert.ok(evidence.snapshot.returnedSamples < evidence.snapshot.requestedSamples);
  assert.equal(evidence.snapshot.requestedSamples, 2500);
  assert.match(evidence.contentRef, /^sha256:[0-9a-f]{64}$/);

  // The pathological shape that used to overflow the hardest: 500 series with
  // no samples at all. Metadata alone must still fit.
  const empty = buildEvidence({ ...result, series: series.map((entry) => ({ ...entry, samples: [] })) });
  assert.ok(Buffer.byteLength(empty.body, 'utf8') <= EVIDENCE_CONTENT_MAX_BYTES);
});
