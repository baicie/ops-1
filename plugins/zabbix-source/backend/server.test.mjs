// Real HTTP socket tests for the Zabbix plugin.
//
// Why this file exists: `node --check` does not resolve imports, the contract
// validator only compares path strings, and each unit test imports the symbols
// it uses. None of them can prove the server starts. In this repository that
// gap already shipped a `server.mjs` that crashed on its first import. These
// tests bind a real port, drive the real router, and talk to a real HTTP
// upstream, so "the service starts and answers" is an executed fact.
//
// The upstream is a local fixture, explicitly not a real Zabbix: it is labelled
// UPSTREAM_ZABBIX_FIXTURE in the test names where it matters. Real Zabbix
// verification remains NOT_RUN until an instance is available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

// The plugin's outbound guard refuses loopback unless this is set. Set it
// before the dynamic import so the module-level constant sees it.
process.env.OPSWEAVE_ALLOW_LOOPBACK_SOURCE = '1';

const { createPlugin, secretConfiguration } = await import('./server.mjs');
const { MemoryStore } = await import('./storage.mjs');
const { createIdentityResolver, signContext } = await import('./identity.mjs');
const { attestationPayload } = await import('./zabbix.mjs');

const PLUGIN_ID = 'opsweave.zabbix-source';
const KEY_HEX = 'a1'.repeat(32);
const ADAPTER_ID = 'zabbix-main';
const ADAPTER_SECRET = 'fixture-adapter-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INCIDENT_ID = '33333333-3333-4333-8333-333333333333';

function startFakeZabbix() {
  const state = { calls: [], history: [{ clock: 1793500200, value: '17.5', ns: 0 }] };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400).end('{}');
      return;
    }
    state.calls.push({ method: rpc.method, authorization: req.headers.authorization || null });
    let result = null;
    if (rpc.method === 'apiinfo.version') result = '7.0.0';
    else if (rpc.method === 'host.get') result = [{ hostid: '10084', name: 'web-01', available: '1' }];
    else if (rpc.method === 'item.get') {
      result = [{ itemid: '10401', key_: 'system.cpu.util', name: 'CPU utilization', units: '%', value_type: '0' }];
    } else if (rpc.method === 'history.get') result = state.history;
    const payload = JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/api_jsonrpc.php`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

function userContext({ role = 'operator', workspaces = [WORKSPACE_A], userId = USER_ID } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signContext({
    keyHex: KEY_HEX,
    prefix: 'owu1',
    payload: {
      v: 1,
      userId,
      role,
      pluginId: PLUGIN_ID,
      workspaceIds: workspaces,
      issuedAt: now,
      expiresAt: now + 60,
      requestId: crypto.randomUUID(),
    },
  });
}

function workloadContext({ scopes = ['telemetry.source.read'], workspaces = [WORKSPACE_A], pluginId = 'opsweave.test-caller' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signContext({
    keyHex: KEY_HEX,
    prefix: 'oww1',
    payload: {
      v: 1,
      sub: 'instance-1',
      pluginId,
      instanceId: '44444444-4444-4444-8444-444444444444',
      nodeId: '55555555-5555-4555-8555-555555555555',
      nodeGeneration: 1,
      capabilityName: 'telemetry.source.v1',
      capabilityMajor: 1,
      audience: 'plugin:telemetry.source.v1',
      scope: [...scopes, ...workspaces.map((id) => `workspace:${id}`)],
      issuedAt: now,
      expiresAt: now + 60,
      jti: crypto.randomUUID(),
    },
  });
}

async function startPlugin({ store = new MemoryStore(), adapter = true, workspaceSecretMap = null } = {}) {
  const plugin = createPlugin({
    store,
    verifyIdentity: createIdentityResolver({ contextKeyHex: KEY_HEX, pluginId: PLUGIN_ID }),
    adapterId: adapter ? ADAPTER_ID : '',
    adapterSecret: adapter ? ADAPTER_SECRET : '',
    secretMap: workspaceSecretMap ? {} : { 'secretref:zabbix/main': 'fixture-token' },
    workspaceSecretMap,
  });
  await new Promise((resolve) => plugin.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${plugin.server.address().port}`;
  return { plugin, base, store };
}

async function call(base, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, text };
}

async function createSource(base, upstream, overrides = {}) {
  return call(base, '/api/zabbix-source/sources', {
    method: 'POST',
    headers: { 'x-opsweave-user-context': userContext() },
    body: {
      workspaceId: WORKSPACE_A,
      name: 'zabbix-main',
      endpoint: upstream.url,
      credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
      ...overrides,
    },
  });
}

test('the server starts and serves health, runtime info and the storage mode', async () => {
  const { plugin, base } = await startPlugin();
  try {
    assert.equal((await call(base, '/_opsweave/health/live')).status, 200);
    assert.equal((await call(base, '/_opsweave/health/ready')).status, 200);
    assert.equal((await call(base, '/_opsweave/health/startup')).status, 200);
    const info = await call(base, '/_opsweave/runtime-info');
    assert.equal(info.status, 200);
    assert.equal(info.body.pluginId, PLUGIN_ID);
    assert.equal(info.body.storage.mode, 'memory');
    assert.equal(info.body.attestation.configured, true);
  } finally {
    await plugin.close();
  }
});

test('the Node runtime info endpoint carries the fields the supervisor checks', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const info = await call(base, '/_opsweave/runtime/v1/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.pluginId, PLUGIN_ID);
    assert.equal(info.body.runtimeProtocol, 'http-json-v1');
    assert.equal(typeof info.body.capabilityDigest, 'string');
    assert.equal(typeof info.body.buildDigest, 'string');
  } finally {
    await plugin.close();
  }
});

test('an unsigned role header is not an identity', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const anonymous = await call(base, '/api/zabbix-source/sources');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, 'ZBX_IDENTITY_UNVERIFIED');
    // The counterfactual for G10 R1: the old code treated this header as an
    // admin grant. It must now be worth exactly nothing.
    const forged = await call(base, '/api/zabbix-source/sources', {
      headers: { 'x-opsweave-user-role': 'admin', 'x-opsweave-user-id': USER_ID },
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'ZBX_IDENTITY_UNVERIFIED');
  } finally {
    await plugin.close();
  }
});

test('a viewer may read sources but not create one', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const viewer = { 'x-opsweave-user-context': userContext({ role: 'viewer' }) };
    assert.equal((await call(base, '/api/zabbix-source/sources', { headers: viewer })).status, 200);
    const created = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      headers: viewer,
      body: {
        workspaceId: WORKSPACE_A,
        name: 'viewer-cannot-write',
        endpoint: 'https://zabbix.example.invalid/api_jsonrpc.php',
        credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
      },
    });
    assert.equal(created.status, 403);
    assert.equal(created.body.code, 'FORBIDDEN');
  } finally {
    await plugin.close();
  }
});

test('a source cannot be created in a workspace the signed context does not name', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const response = await createSource(base, { url: 'https://zabbix.example.invalid/api_jsonrpc.php' }, { workspaceId: WORKSPACE_B });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'ZBX_WORKSPACE_FORBIDDEN');
  } finally {
    await plugin.close();
  }
});

test('GET /sources returns the contract shape {items}, not the old {sources,nextCursor}', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const created = await createSource(base, upstream);
    assert.equal(created.status, 201);
    assert.equal(created.body.workspaceId, WORKSPACE_A);
    assert.equal(created.body.status, 'UNVERIFIED');
    const list = await call(base, '/api/zabbix-source/sources', {
      headers: { 'x-opsweave-user-context': userContext() },
    });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.items));
    assert.equal(list.body.items.length, 1);
    assert.equal('sources' in list.body, false);
    assert.equal('nextCursor' in list.body, false);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('raw credentials are refused, and the stored view never contains a token', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const raw = await createSource(base, upstream, {
      credential: { kind: 'api-token', ref: 'abc123-real-token' },
    });
    assert.equal(raw.status, 400);
    assert.equal(raw.body.code, 'CREDENTIAL_NOT_A_REFERENCE');

    const credentialInUrl = await createSource(base, upstream, {
      endpoint: 'https://user:pass@zabbix.example.invalid/api_jsonrpc.php',
    });
    assert.equal(credentialInUrl.status, 400);
    assert.equal(credentialInUrl.body.code, 'CREDENTIAL_IN_URL');

    const created = await createSource(base, upstream);
    assert.equal(created.status, 201);
    assert.equal(JSON.stringify(created.body).includes('fixture-token'), false);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a duplicate source in one workspace is a conflict, not a silent overwrite', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    assert.equal((await createSource(base, upstream)).status, 201);
    const duplicate = await createSource(base, upstream, { name: 'second-name' });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'ZBX_SOURCE_CONFLICT');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a DNS-named endpoint is reachable (autoSelectFamily lookup)', async () => {
  const upstream = await startFakeZabbix();
  const port = new URL(upstream.url).port;
  const { plugin, base } = await startPlugin();
  try {
    const created = await createSource(base, upstream, {
      endpoint: `http://localhost:${port}/api_jsonrpc.php`,
    });
    assert.equal(created.status, 201);
    const probed = await call(base, `/api/zabbix-source/sources/${created.body.sourceId}/probe`, {
      method: 'POST',
      headers: { 'x-opsweave-user-context': userContext() },
    });
    assert.equal(probed.status, 200);
    assert.equal(probed.body.outcome, 'OK');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('probe records what it saw and promotes the source only on OK', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const created = await createSource(base, upstream);
    const sourceId = created.body.sourceId;
    const probed = await call(base, `/api/zabbix-source/sources/${sourceId}/probe`, {
      method: 'POST',
      headers: { 'x-opsweave-user-context': userContext() },
    });
    assert.equal(probed.status, 200);
    assert.equal(probed.body.outcome, 'OK');
    assert.equal(probed.body.apiVersion, '7.0.0');
    // apiinfo.version is the one call Zabbix refuses when authenticated.
    assert.equal(upstream.state.calls[0].authorization, null);

    const list = await call(base, '/api/zabbix-source/sources', {
      headers: { 'x-opsweave-user-context': userContext() },
    });
    assert.equal(list.body.items[0].status, 'READY');
    assert.equal(list.body.items[0].lastProbe.outcome, 'OK');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('hosts and items are enumerated, and a missing hostId is refused', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const headers = { 'x-opsweave-user-context': userContext() };
    const hosts = await call(base, `/api/zabbix-source/sources/${sourceId}/hosts`, { headers });
    assert.equal(hosts.status, 200);
    assert.deepEqual(hosts.body.items, [{ hostId: '10084', name: 'web-01', available: 'AVAILABLE' }]);
    const items = await call(base, `/api/zabbix-source/sources/${sourceId}/items?hostId=10084`, { headers });
    assert.equal(items.status, 200);
    assert.equal(items.body.items[0].itemId, '10401');
    assert.equal(items.body.items[0].valueType, 'FLOAT');
    const missing = await call(base, `/api/zabbix-source/sources/${sourceId}/items`, { headers });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'ZABBIX_HOST_REQUIRED');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('collection bytes and the attestation digest are the same bytes', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const headers = { 'x-opsweave-user-context': userContext() };
    const collected = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      headers,
      body: {
        itemIds: ['10401'],
        window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' },
      },
    });
    assert.equal(collected.status, 200);
    assert.match(collected.body.collectionId, /^[0-9a-f-]{36}$/);
    assert.equal(collected.body.outcome, 'OK');
    assert.equal(collected.body.requestedItems, 1);
    assert.equal(collected.body.answeredItems, 1);
    assert.equal(collected.body.series[0].samples[0].value, 17.5);
    assert.match(collected.body.contentRef, /^sha256:[0-9a-f]{64}$/);
    // The bytes are not part of the HTTP collection response.
    assert.equal(collected.text.includes('evidenceBody'), false);

    const attested = await call(base, `/api/zabbix-source/collections/${collected.body.collectionId}/attestation`, {
      method: 'POST',
      headers,
      // A body workspaceId is not a trust input: the signature must name the
      // persisted collection's workspace, not this one.
      body: { incidentId: INCIDENT_ID, kind: 'METRIC_SNAPSHOT', workspaceId: WORKSPACE_B },
    });
    assert.equal(attested.status, 200);
    const { evidence } = attested.body;
    assert.equal(evidence.content.contentType, 'application/json');
    assert.equal(evidence.contentRef, collected.body.contentRef);
    const digest = 'sha256:' + crypto.createHash('sha256').update(evidence.content.body, 'utf8').digest('hex');
    assert.equal(digest, evidence.contentRef, 'the signed digest covers the exact submitted bytes');

    assert.equal(evidence.attestation.workspaceId, WORKSPACE_A);
    const payload = attestationPayload({
      adapterId: ADAPTER_ID,
      workspaceId: evidence.attestation.workspaceId,
      incidentId: INCIDENT_ID,
      kind: 'METRIC_SNAPSHOT',
      source: evidence.source,
      collectedAt: evidence.collectedAt,
      contentRef: evidence.contentRef,
      issuedAt: evidence.attestation.issuedAt,
    });
    const signature = crypto.createHmac('sha256', ADAPTER_SECRET).update(payload).digest('base64url');
    assert.equal(signature, evidence.attestation.signature);

    const stored = JSON.parse(evidence.content.body);
    assert.equal(stored.outcome, 'OK');
    assert.equal(stored.requestedItems, 1);
    assert.equal(stored.series[0].samples[0].value, 17.5);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a collection over the 64 KiB bound is a PARTIAL snapshot, not a truncated lie', async () => {
  const upstream = await startFakeZabbix();
  // Deterministically over the bound: 2000 samples with six-digit values make
  // the canonical body ~170 KB before truncation.
  upstream.state.history = Array.from({ length: 2000 }, (_, index) => ({
    clock: 1793500000 + index,
    value: String(100000 + index),
    ns: 0,
  }));
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const headers = { 'x-opsweave-user-context': userContext() };
    const collected = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      headers,
      body: {
        itemIds: ['10401'],
        window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' },
        budget: { maxSamplesPerItem: 2000 },
      },
    });
    assert.equal(collected.status, 200);
    assert.equal(collected.body.outcome, 'PARTIAL');
    assert.equal(collected.body.snapshot?.truncated, true, 'the fixture must exceed the 64 KiB bound');
    assert.equal(collected.body.snapshot.reason, 'CONTENT_LIMIT');
    assert.ok(collected.body.snapshot.returnedSamples < collected.body.snapshot.requestedSamples);
    const attested = await call(base, `/api/zabbix-source/collections/${collected.body.collectionId}/attestation`, {
      method: 'POST',
      headers,
      body: { incidentId: INCIDENT_ID, kind: 'METRIC_SNAPSHOT' },
    });
    assert.equal(attested.status, 200);
    assert.ok(Buffer.byteLength(attested.body.evidence.content.body, 'utf8') <= 65536);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a collection is not visible from another workspace, and neither is its source', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const headersA = { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_A] }) };
    const headersB = { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_B] }) };
    const collected = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      headers: headersA,
      body: { itemIds: ['10401'], window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' } },
    });
    assert.equal(collected.status, 200);

    assert.deepEqual((await call(base, '/api/zabbix-source/sources', { headers: headersB })).body.items, []);
    assert.equal((await call(base, `/api/zabbix-source/sources/${sourceId}/probe`, { method: 'POST', headers: headersB })).status, 404);
    assert.equal((await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST', headers: headersB, body: { itemIds: ['10401'], window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' } },
    })).status, 404);
    assert.equal((await call(base, `/api/zabbix-source/collections/${collected.body.collectionId}/attestation`, {
      method: 'POST', headers: headersB, body: { incidentId: INCIDENT_ID },
    })).status, 404);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a workload identity needs an explicit workspace grant and cannot write', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const workload = { 'x-opsweave-caller-context': workloadContext() };
    const list = await call(base, '/api/zabbix-source/sources', { headers: workload });
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);

    const unaffiliated = { 'x-opsweave-caller-context': workloadContext({ workspaces: [] }) };
    assert.deepEqual((await call(base, '/api/zabbix-source/sources', { headers: unaffiliated })).body.items, []);

    const write = await call(base, `/api/zabbix-source/sources/${sourceId}/probe`, { method: 'POST', headers: workload });
    assert.equal(write.status, 403);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('an attestation is refused when no adapter credential is configured', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin({ adapter: false });
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const headers = { 'x-opsweave-user-context': userContext() };
    const collected = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      headers,
      body: { itemIds: ['10401'], window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' } },
    });
    const attested = await call(base, `/api/zabbix-source/collections/${collected.body.collectionId}/attestation`, {
      method: 'POST', headers, body: { incidentId: INCIDENT_ID },
    });
    assert.equal(attested.status, 503);
    assert.equal(attested.body.code, 'EVIDENCE_ADAPTER_NOT_CONFIGURED');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a source cannot borrow a credential configured for another workspace', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin({
    workspaceSecretMap: {
      [WORKSPACE_A]: { 'secretref:zabbix/a': 'token-a' },
      [WORKSPACE_B]: { 'secretref:zabbix/b': 'token-b' },
    },
  });
  try {
    const borrowed = await createSource(base, upstream, {
      workspaceId: WORKSPACE_A,
      credential: { kind: 'api-token', ref: 'secretref:zabbix/b' },
    });
    assert.equal(borrowed.status, 422);
    assert.equal(borrowed.body.code, 'CREDENTIAL_UNRESOLVED');

    const a = await createSource(base, upstream, {
      workspaceId: WORKSPACE_A,
      credential: { kind: 'api-token', ref: 'secretref:zabbix/a' },
    });
    assert.equal(a.status, 201);
    const b = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      headers: { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_B] }) },
      body: {
        workspaceId: WORKSPACE_B,
        name: 'zabbix-b',
        endpoint: upstream.url,
        credential: { kind: 'api-token', ref: 'secretref:zabbix/b' },
      },
    });
    assert.equal(b.status, 201);

    const headersA = { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_A] }) };
    const headersB = { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_B] }) };
    await call(base, `/api/zabbix-source/sources/${a.body.sourceId}/hosts`, { headers: headersA });
    await call(base, `/api/zabbix-source/sources/${b.body.sourceId}/hosts`, { headers: headersB });
    const auth = upstream.state.calls.filter((entry) => entry.method === 'host.get').map((entry) => entry.authorization);
    assert.deepEqual(auth, ['Bearer token-a', 'Bearer token-b']);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a viewer cannot spend the collection budget or write a retained collection', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const sourceId = (await createSource(base, upstream)).body.sourceId;
    const viewer = { 'x-opsweave-user-context': userContext({ role: 'viewer' }) };
    const collected = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      headers: viewer,
      body: { itemIds: ['10401'], window: { from: '2026-11-01T02:00:00Z', to: '2026-11-01T03:00:00Z' } },
    });
    assert.equal(collected.status, 403);
    assert.equal(collected.body.code, 'FORBIDDEN');
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('changing the endpoint invalidates READY and the stale probe', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base } = await startPlugin();
  try {
    const created = await createSource(base, upstream);
    const headers = { 'x-opsweave-user-context': userContext() };
    await call(base, `/api/zabbix-source/sources/${created.body.sourceId}/probe`, { method: 'POST', headers });
    const updated = await call(base, `/api/zabbix-source/sources/${created.body.sourceId}`, {
      method: 'PUT',
      headers,
      body: {
        name: 'renamed',
        endpoint: 'http://127.0.0.1:18099/api_jsonrpc.php',
        credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, 'UNVERIFIED');
    assert.equal(updated.body.lastProbe, undefined);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('a TIMEOUT collection cannot be attested as a measurement', async () => {
  const { plugin, base, store } = await startPlugin();
  try {
    const collectionId = crypto.randomUUID();
    await store.saveCollection({
      collectionId,
      sourceId: crypto.randomUUID(),
      workspaceId: WORKSPACE_A,
      createdBy: USER_ID,
      outcome: 'TIMEOUT',
      contentRef: 'sha256:' + '1'.repeat(64),
      body: '{"outcome":"TIMEOUT"}',
      observedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await call(base, `/api/zabbix-source/collections/${collectionId}/attestation`, {
      method: 'POST',
      headers: { 'x-opsweave-user-context': userContext() },
      body: { incidentId: INCIDENT_ID, kind: 'METRIC_SNAPSHOT' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'ZBX_COLLECTION_NOT_ATTESTABLE');
  } finally {
    await plugin.close();
  }
});

test('source update is audited, scoped and conflict-checked', async () => {
  const upstream = await startFakeZabbix();
  const { plugin, base, store } = await startPlugin();
  try {
    const created = await createSource(base, upstream);
    const sourceId = created.body.sourceId;
    const headers = { 'x-opsweave-user-context': userContext() };
    const updated = await call(base, `/api/zabbix-source/sources/${sourceId}`, {
      method: 'PUT',
      headers,
      body: {
        name: 'renamed',
        endpoint: upstream.url,
        credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'renamed');
    assert.ok(store.audit.some((entry) => entry.action === 'UPDATE'));

    const otherWorkspace = await call(base, `/api/zabbix-source/sources/${sourceId}`, {
      method: 'PUT',
      headers: { 'x-opsweave-user-context': userContext({ workspaces: [WORKSPACE_B] }) },
      body: {
        name: 'stolen',
        endpoint: upstream.url,
        credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
      },
    });
    assert.equal(otherWorkspace.status, 404);
  } finally {
    await plugin.close();
    await upstream.close();
  }
});

test('invalid JSON, oversized bodies and unknown paths fail with stable codes', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const headers = { 'x-opsweave-user-context': userContext() };
    const invalid = await call(base, '/api/zabbix-source/sources', { method: 'POST', headers, body: '{' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_REQUEST');
    const huge = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      headers,
      body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(huge.status, 413);
    const unknown = await call(base, '/api/zabbix-source/nope', { headers });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'NOT_FOUND');
  } finally {
    await plugin.close();
  }
});

test('a forged user context under a different key is refused', async () => {
  const { plugin, base } = await startPlugin();
  try {
    const now = Math.floor(Date.now() / 1000);
    const forged = signContext({
      keyHex: 'dead'.repeat(16),
      prefix: 'owu1',
      payload: {
        v: 1,
        userId: USER_ID,
        role: 'admin',
        pluginId: PLUGIN_ID,
        workspaceIds: [WORKSPACE_A],
        issuedAt: now,
        expiresAt: now + 60,
        requestId: crypto.randomUUID(),
      },
    });
    const response = await call(base, '/api/zabbix-source/sources', {
      headers: { 'x-opsweave-user-context': forged },
    });
    assert.equal(response.status, 401);
  } finally {
    await plugin.close();
  }
});

test('the plugin reads the Kernel-delivered secret map first and never reports values', async () => {
  const workspace = '00000000-0000-4000-8000-000000000001';
  const pluginSecrets = secretConfiguration({
    OPSWEAVE_PLUGIN_SECRETS: JSON.stringify({ [workspace]: { 'secretref:zabbix/main': 'plugin-token' } }),
    OPSWEAVE_ZABBIX_SECRETS: JSON.stringify({ 'secretref:zabbix/main': 'dev-token' }),
  });
  assert.equal(pluginSecrets.mode, 'workspace');
  assert.equal(pluginSecrets.workspaceSecrets[workspace]['secretref:zabbix/main'], 'plugin-token');
  assert.equal(JSON.stringify(pluginSecrets.workspaceSecrets).includes('dev-token'), false);

  // The old flat shape is the P0 shape; it must not become a working map.
  const flat = secretConfiguration({
    OPSWEAVE_PLUGIN_SECRETS: JSON.stringify({ 'secretref:zabbix/main': 'flat-token' }),
  });
  assert.equal(flat.mode, 'workspace');
  assert.equal(Object.keys(flat.workspaceSecrets).length, 0);

  const dev = secretConfiguration({
    NODE_ENV: 'test',
    OPSWEAVE_ZABBIX_SECRETS: JSON.stringify({ 'secretref:zabbix/main': 'dev-token' }),
  });
  assert.equal(dev.mode, 'dev');
  assert.equal(secretConfiguration({}).mode, 'none');
  // A production process never takes the developer fallback.
  assert.equal(secretConfiguration({ NODE_ENV: 'production', OPSWEAVE_ZABBIX_SECRETS: '{"secretref:x":"y"}' }).mode, 'none');

  const { plugin, base } = await startPlugin();
  try {
    const info = await call(base, '/_opsweave/runtime-info');
    assert.equal(info.status, 200);
    assert.equal(info.body.secrets.mode, 'none');
    assert.equal(JSON.stringify(info.body).includes('fixture-token'), false);
  } finally {
    await plugin.close();
  }
});
