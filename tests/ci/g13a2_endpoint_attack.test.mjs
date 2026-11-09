// G13-A.2 Phase 0: real-socket reproduction of the credential endpoint swap.
//
// The premise: `telemetry.source.write` lets an operator edit a source's
// endpoint while keeping its credential reference. If the plugin honours that
// edit, the next hosts/items/collect call sends the workspace's Zabbix token to
// whatever URL the operator supplied. This test drives the real plugin over a
// real socket and a real attacker HTTP receiver; it asserts the SECURE behaviour
// and fails on the vulnerable one, so the pre-fix run is the reproduction.
//
// Run: node --test tests/ci/g13a2_endpoint_attack.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.OPSWEAVE_ALLOW_LOOPBACK_SOURCE = '1';

const { createPlugin, ROLE_SCOPES, AUTOMATION_SCOPES } = await import('../../plugins/zabbix-source/backend/server.mjs');
const { MemoryStore } = await import('../../plugins/zabbix-source/backend/storage.mjs');
const { createIdentityResolver, signContext } = await import('../../plugins/zabbix-source/backend/identity.mjs');
const { normalizeEndpoint, parseCredentialBindings } = await import('../../plugins/zabbix-source/backend/credential-binding.mjs');

const PLUGIN_ID = 'opsweave.zabbix-source';
const KEY = 'c2'.repeat(32);
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF = 'secretref:zabbix/main';
const TOKEN = 'g13a2-secret-token';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

function startReceiver() {
  const state = { authorizations: [], calls: 0 };
  const server = http.createServer(async (req, res) => {
    state.calls += 1;
    if (req.headers.authorization) state.authorizations.push(req.headers.authorization);
    let body = '';
    for await (const chunk of req) body += chunk;
    let rpc = {};
    try { rpc = JSON.parse(body); } catch { /* ignore */ }
    const result = rpc.method === 'host.get'
      ? [{ hostid: '10084', name: 'attacker-visible', available: '1' }]
      : rpc.method === 'item.get'
        ? [{ itemid: '10401', key_: 'system.cpu.util', name: 'cpu', units: '%', value_type: '0' }]
        : rpc.method === 'history.get'
          ? [{ clock: 1793500200, value: '17.5', ns: 0 }]
          : '7.0.0';
    const payload = JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/api_jsonrpc.php`,
    state,
    close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }),
  })));
}

function context() {
  const now = Math.floor(Date.now() / 1000);
  return signContext({
    keyHex: KEY,
    prefix: 'owu1',
    payload: {
      v: 1,
      userId: USER,
      role: 'operator',
      pluginId: PLUGIN_ID,
      workspaceIds: [WORKSPACE],
      issuedAt: now,
      expiresAt: now + 120,
      requestId: crypto.randomUUID(),
    },
  });
}

async function startPlugin(approvedEndpoint) {
  const store = new MemoryStore();
  const plugin = createPlugin({
    store,
    verifyIdentity: createIdentityResolver({
      contextKeyHex: KEY,
      pluginId: PLUGIN_ID,
      roleScopes: ROLE_SCOPES,
      scopePrefix: 'telemetry.source.',
      automationScopes: AUTOMATION_SCOPES,
    }),
    workspaceSecretMap: { [WORKSPACE]: { [REF]: TOKEN } },
    secretMode: 'workspace',
    credentialBindings: {
      [WORKSPACE]: {
        [REF]: { endpoint: normalizeEndpoint(approvedEndpoint), tls: 'TEST_PLAINTEXT' },
      },
    },
    allowInsecureEndpoints: true,
  });
  await new Promise((resolve) => plugin.server.listen(0, '127.0.0.1', resolve));
  return { plugin, store, base: `http://127.0.0.1:${plugin.server.address().port}` };
}

async function call(base, path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'x-opsweave-user-context': context(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

test('an endpoint swap cannot send the workspace token to an attacker', async () => {
  const approved = await startReceiver();
  const attacker = await startReceiver();
  const { plugin, store, base } = await startPlugin(approved.url);
  try {
    const created = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      body: {
        workspaceId: WORKSPACE,
        name: 'zabbix-main',
        endpoint: approved.url,
        credential: { kind: 'api-token', ref: REF },
      },
    });
    assert.equal(created.status, 201, 'a trusted endpoint and a bound ref are accepted');
    const sourceId = created.body.sourceId;

    // The attack: keep the valid ref, move the endpoint to the receiver. Run
    // every step before asserting so the failure message reports all three
    // facts (the swap, the read, and the leaked header) at once.
    // A source cannot be created directly at an unapproved endpoint either.
    const direct = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      body: { workspaceId: WORKSPACE, name: 'attacker', endpoint: attacker.url, credential: { kind: 'api-token', ref: REF } },
    });
    assert.equal(direct.status, 422);
    assert.equal(direct.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');

    // The attack: keep the valid ref, move the endpoint to the receiver.
    const swapped = await call(base, `/api/zabbix-source/sources/${sourceId}`, {
      method: 'PUT',
      body: { name: 'zabbix-main', endpoint: attacker.url, credential: { kind: 'api-token', ref: REF } },
    });
    assert.equal(swapped.status, 422);
    assert.equal(swapped.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');

    // The refused swap leaves the source on its approved endpoint.
    const approvedHosts = await call(base, `/api/zabbix-source/sources/${sourceId}/hosts`);
    assert.equal(approvedHosts.status, 200);
    assert.ok(approved.state.authorizations.includes(`Bearer ${TOKEN}`));
    assert.deepEqual(attacker.state.authorizations, [], 'the attacker receiver must never see the token');

    // A historical row that already points at the attacker (written before the
    // binding existed) fails closed on the read path, before resolving the ref.
    store.sources.get(sourceId).endpoint = attacker.url;
    const historical = await call(base, `/api/zabbix-source/sources/${sourceId}/hosts`);
    assert.equal(historical.status, 422);
    assert.equal(historical.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');
    const probe = await call(base, `/api/zabbix-source/sources/${sourceId}/probe`, { method: 'POST' });
    assert.equal(probe.status, 422);
    assert.equal(probe.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');
    const items = await call(base, `/api/zabbix-source/sources/${sourceId}/items?hostId=10084`);
    assert.equal(items.status, 422);
    assert.equal(items.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');
    const collect = await call(base, `/api/zabbix-source/sources/${sourceId}/collect`, {
      method: 'POST',
      body: { itemIds: ['10401'], window: { from: '2026-11-01T00:00:00Z', to: '2026-11-01T01:00:00Z' } },
    });
    assert.equal(collect.status, 422);
    assert.equal(collect.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');
    assert.deepEqual(attacker.state.authorizations, []);
  } finally {
    await plugin.close();
    await approved.close();
    await attacker.close();
  }
});

async function startWith({ bindings = {}, secrets = { [REF]: TOKEN }, allowInsecure = false, allowUnbound = false }) {
  const store = new MemoryStore();
  const plugin = createPlugin({
    store,
    verifyIdentity: createIdentityResolver({
      contextKeyHex: KEY,
      pluginId: PLUGIN_ID,
      roleScopes: ROLE_SCOPES,
      scopePrefix: 'telemetry.source.',
      automationScopes: AUTOMATION_SCOPES,
    }),
    workspaceSecretMap: { [WORKSPACE]: secrets },
    secretMode: 'workspace',
    credentialBindings: bindings,
    allowInsecureEndpoints: allowInsecure,
    allowUnboundCredentials: allowUnbound,
  });
  await new Promise((resolve) => plugin.server.listen(0, '127.0.0.1', resolve));
  return { plugin, store, base: `http://127.0.0.1:${plugin.server.address().port}` };
}

test('a workspace secret without a binding is refused', async () => {
  const { plugin, base } = await startWith({});
  try {
    const created = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      body: { workspaceId: WORKSPACE, name: 'unbound', endpoint: 'https://zabbix.example/api_jsonrpc.php', credential: { kind: 'api-token', ref: REF } },
    });
    assert.equal(created.status, 422);
    assert.equal(created.body.code, 'ZBX_CREDENTIAL_BINDING_REQUIRED');
  } finally {
    await plugin.close();
  }
});

test('a TLS-verified binding refuses plaintext and verifyTls=false', async () => {
  const endpoint = 'https://zabbix.example/api_jsonrpc.php';
  const bindings = { [WORKSPACE]: { [REF]: { endpoint, tls: 'VERIFY' } } };
  const { plugin, base } = await startWith({ bindings });
  try {
    const base64 = {
      workspaceId: WORKSPACE,
      name: 'zabbix-main',
      endpoint,
      credential: { kind: 'api-token', ref: REF },
    };
    const insecure = await call(base, '/api/zabbix-source/sources', { method: 'POST', body: { ...base64, verifyTls: false } });
    assert.equal(insecure.status, 403);
    assert.equal(insecure.body.code, 'ZBX_INSECURE_ENDPOINT_FORBIDDEN');

    const plain = await call(base, '/api/zabbix-source/sources', { method: 'POST', body: { ...base64, endpoint: 'http://zabbix.example/api_jsonrpc.php' } });
    assert.equal(plain.status, 422);
    assert.equal(plain.body.code, 'ZBX_CREDENTIAL_ENDPOINT_MISMATCH');

    const ok = await call(base, '/api/zabbix-source/sources', { method: 'POST', body: base64 });
    assert.equal(ok.status, 201);
  } finally {
    await plugin.close();
  }
});

test('a plaintext binding needs the explicit deployment flag', async () => {
  const approved = await startReceiver();
  const endpoint = approved.url;
  const bindings = { [WORKSPACE]: { [REF]: { endpoint: normalizeEndpoint(endpoint), tls: 'TEST_PLAINTEXT' } } };
  try {
    const closed = await startWith({ bindings, allowInsecure: false });
    try {
      const refused = await call(closed.base, '/api/zabbix-source/sources', {
        method: 'POST',
        body: { workspaceId: WORKSPACE, name: 'plain', endpoint, credential: { kind: 'api-token', ref: REF } },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'ZBX_INSECURE_ENDPOINT_FORBIDDEN');
    } finally {
      await closed.plugin.close();
    }

    const open = await startWith({ bindings, allowInsecure: true });
    try {
      const allowed = await call(open.base, '/api/zabbix-source/sources', {
        method: 'POST',
        body: { workspaceId: WORKSPACE, name: 'plain', endpoint, credential: { kind: 'api-token', ref: REF } },
      });
      assert.equal(allowed.status, 201);
    } finally {
      await open.plugin.close();
    }
  } finally {
    await approved.close();
  }
});

test('a basic credential is sent as HTTP Basic, not Bearer', async () => {
  const approved = await startReceiver();
  const endpoint = approved.url;
  const bindings = { [WORKSPACE]: { [REF]: { endpoint: normalizeEndpoint(endpoint), tls: 'TEST_PLAINTEXT' } } };
  const { plugin, base } = await startWith({ bindings, allowInsecure: true, secrets: { [REF]: 'user:password' } });
  try {
    const created = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      body: { workspaceId: WORKSPACE, name: 'basic', endpoint, credential: { kind: 'basic', ref: REF } },
    });
    assert.equal(created.status, 201);
    const hosts = await call(base, `/api/zabbix-source/sources/${created.body.sourceId}/hosts`);
    assert.equal(hosts.status, 200);
    assert.deepEqual(approved.state.authorizations, ['Basic ' + Buffer.from('user:password').toString('base64')]);
  } finally {
    await plugin.close();
    await approved.close();
  }
});

test('a basic credential without user:password is refused', async () => {
  const approved = await startReceiver();
  const endpoint = approved.url;
  const bindings = { [WORKSPACE]: { [REF]: { endpoint: normalizeEndpoint(endpoint), tls: 'TEST_PLAINTEXT' } } };
  const { plugin, base } = await startWith({ bindings, allowInsecure: true, secrets: { [REF]: 'not-a-pair' } });
  try {
    const created = await call(base, '/api/zabbix-source/sources', {
      method: 'POST',
      body: { workspaceId: WORKSPACE, name: 'basic', endpoint, credential: { kind: 'basic', ref: REF } },
    });
    assert.equal(created.status, 422);
    assert.equal(created.body.code, 'ZBX_BASIC_CREDENTIAL_INVALID');
    assert.deepEqual(approved.state.authorizations, []);
  } finally {
    await plugin.close();
    await approved.close();
  }
});


test('endpoint normalization is exact and rejects credential-bearing URLs', () => {
  assert.equal(normalizeEndpoint('HTTPS://Zabbix.Example:443/api_jsonrpc.php'), 'https://zabbix.example/api_jsonrpc.php');
  assert.equal(normalizeEndpoint('http://host:80/api'), 'http://host/api');
  assert.equal(normalizeEndpoint('http://host:8080/api'), 'http://host:8080/api');
  assert.equal(normalizeEndpoint('https://host/Path/To/Api'), 'https://host/Path/To/Api');
  for (const bad of [
    'https://host/api?x=1',
    'https://host/api#frag',
    'https://user:pw@host/api',
    'ftp://host/api',
  ]) {
    assert.equal(normalizeEndpoint(bad), null, bad);
  }
});

test('the binding parser accepts the Kernel slice and the full map, and drops unsafe entries', () => {
  const workspace = '00000000-0000-4000-8000-000000000001';
  const slice = JSON.stringify({ [workspace]: { [REF]: { endpoint: 'https://zabbix.example/api_jsonrpc.php', tls: 'VERIFY' } } });
  const full = JSON.stringify({ [PLUGIN_ID]: JSON.parse(slice) });
  for (const raw of [slice, full]) {
    const parsed = parseCredentialBindings(raw, PLUGIN_ID);
    assert.equal(parsed[workspace][REF].endpoint, 'https://zabbix.example/api_jsonrpc.php');
  }
  const unsafe = JSON.stringify({ [workspace]: { [REF]: { endpoint: 'https://user:pw@host/api', tls: 'VERIFY' } } });
  assert.deepEqual(parseCredentialBindings(unsafe, PLUGIN_ID), {});
  const badTls = JSON.stringify({ [workspace]: { [REF]: { endpoint: 'https://host/api', tls: 'NONE' } } });
  assert.deepEqual(parseCredentialBindings(badTls, PLUGIN_ID), {});
});
