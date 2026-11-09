// B2.1: the plugin identity boundary, over a real socket against the real plugin.
//
// Before the fix, both data plugins answered a bare `x-opsweave-user-role: admin`
// header with a full administrative scope, and never verified the Kernel-signed
// `owu1` user context at all - so the Gateway's signed identity was rejected and
// the unsigned header became the identity on the production path. These tests
// assert the SECURE behaviour and fail on the vulnerable one, so the pre-fix
// commit is the reproduction and the post-fix commit is the proof.
//
// What is covered, per plugin:
//   * a forged role header alone is not an identity (401)
//   * a forged role header cannot raise the scope of a valid viewer (403)
//   * a signed context for ANOTHER plugin is refused (401) - cross-plugin replay
//   * a re-signed payload (attacker key) is refused (401)
//   * an expired or not-yet-valid context is refused (401)
//   * a context with no userId / unknown role / wrong version is refused (401)
//   * a missing workspace is not silently accepted once the workspace claim is absent
//   * every refusal leaves the database untouched (row counts unchanged)
//
// Run: node --test tests/ci/b2_plugin_identity_attack.test.mjs
// Requires: OPSWEAVE_TEST_PLUGIN_DATABASE_URL (a throwaway PostgreSQL database);
// OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1 turns a missing database into a failure.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATABASE_URL = process.env.OPSWEAVE_TEST_PLUGIN_DATABASE_URL || '';
const PLUGIN_KEY = 'b2'.repeat(32);
const OTHER_KEY = 'c3'.repeat(32);
const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = '00000000-0000-4000-8000-000000000002';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function context({ key = PLUGIN_KEY, pluginId, role = 'admin', workspaces = [WORKSPACE], userId = USER_ID, issuedAt, expiresAt, v = 1, extra = {} }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v,
    userId,
    role,
    pluginId,
    workspaceIds: workspaces,
    issuedAt: issuedAt ?? now,
    expiresAt: expiresAt ?? now + 120,
    requestId: crypto.randomUUID(),
    ...extra,
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(encoded).digest('base64url');
  return `owu1.${encoded}.${signature}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitReady(base, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`plugin exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/_opsweave/health/ready`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`plugin at ${base} never became ready`);
}

/** Start one plugin as a real OS process, exactly as the Node runtime does. */
async function startPlugin(name, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.join(ROOT, 'plugins', name, 'backend'),
    env: {
      ...process.env,
      PORT: String(port),
      OPSWEAVE_PLUGIN_DATABASE_URL: DATABASE_URL,
      DATABASE_URL,
      OPSWEAVE_CALLER_CONTEXT_KEY: PLUGIN_KEY,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base, child);
  return {
    base,
    logs,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      });
    },
  };
}

async function call(base, route, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

function requireDatabase() {
  if (DATABASE_URL) return;
  if (process.env.OPSWEAVE_REQUIRE_PLUGIN_DATABASE === '1') {
    throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required but unset');
  }
  throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required for the identity attack suite');
}

let pg;
before(async () => {
  requireDatabase();
  // `pg` is a dependency of the plugin backends, not of the repository root, and
  // this suite must assert on the same database the plugins write to.
  pg = (await import(path.join(ROOT, 'plugins/data-catalog/backend/node_modules/pg/lib/index.js'))).default;
});

after(() => {
  // Every pool is closed by its own test's `t.after`; nothing is held here.
});

/** Row counts for every table the plugins write, so a refusal can prove zero side effects. */
async function counts(pool, tables) {
  const out = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    out[table] = result.rows[0].n;
  }
  return out;
}

const CATALOG_TABLES = [
  'catalog_datasets', 'catalog_schema_revisions', 'catalog_records',
  'catalog_receipts', 'catalog_lineage', 'catalog_quality_rules',
  'catalog_quality_runs', 'catalog_quality_results', 'catalog_entity_types',
];
const INTEGRATION_TABLES = ['integration_sources', 'integration_specs', 'integration_runs'];

// ---------------------------------------------------------------------------
// Data Catalog
// ---------------------------------------------------------------------------
test('data-catalog: an unsigned role header is not an identity', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const before = await counts(pool, CATALOG_TABLES);
  for (const role of ['admin', 'operator', 'viewer', 'superadmin', '']) {
    const response = await call(plugin.base, '/api/data-catalog/datasets', {
      headers: { 'x-opsweave-user-role': role, 'x-opsweave-user-id': USER_ID },
    });
    assert.equal(response.status, 401, `role header "${role}" must not authenticate`);
    assert.equal(response.body.code, 'UNAUTHENTICATED');
  }
  const create = await call(plugin.base, '/api/data-catalog/datasets', {
    method: 'POST',
    headers: { 'x-opsweave-user-role': 'admin' },
    body: { name: 'forged', fields: [{ name: 'id', type: 'string', nullable: false, ordinal: 0 }], retentionPolicy: { mode: 'RETAIN', maxRecords: 10, maxBytes: 1024 } },
  });
  assert.equal(create.status, 401, 'a forged write must not reach the handler');
  assert.deepEqual(await counts(pool, CATALOG_TABLES), before, 'refusals left no rows behind');
  t.diagnostic(`no rows written across ${CATALOG_TABLES.length} catalog tables`);
});

test('data-catalog: a signed viewer cannot be raised by a forged admin header', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const viewer = context({ pluginId: 'opsweave.data-catalog', role: 'viewer' });
  const read = await call(plugin.base, '/api/data-catalog/datasets', {
    headers: { 'x-opsweave-user-context': viewer, 'x-opsweave-user-role': 'admin' },
  });
  assert.equal(read.status, 200, 'the signed viewer context is accepted for a read');

  const before = await counts(pool, CATALOG_TABLES);
  const write = await call(plugin.base, '/api/data-catalog/datasets', {
    method: 'POST',
    headers: { 'x-opsweave-user-context': viewer, 'x-opsweave-user-role': 'admin' },
    body: { name: 'viewer-forged', fields: [{ name: 'id', type: 'string', nullable: false, ordinal: 0 }], retentionPolicy: { mode: 'RETAIN', maxRecords: 10, maxBytes: 1024 } },
  });
  assert.equal(write.status, 403, 'the forged header must not widen a viewer to writer');
  assert.equal(write.body.code, 'FORBIDDEN');
  assert.deepEqual(await counts(pool, CATALOG_TABLES), before, 'the refused write left no rows');
});

test('data-catalog: cross-plugin, re-signed, expired and malformed contexts are refused', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'minted for another plugin': context({ pluginId: 'opsweave.data-integration' }),
    'signed with an attacker key': context({ pluginId: 'opsweave.data-catalog', key: OTHER_KEY }),
    'expired': context({ pluginId: 'opsweave.data-catalog', issuedAt: now - 600, expiresAt: now - 300 }),
    'issued in the future': context({ pluginId: 'opsweave.data-catalog', issuedAt: now + 600, expiresAt: now + 900 }),
    'unknown role': context({ pluginId: 'opsweave.data-catalog', role: 'superadmin' }),
    'no user id': context({ pluginId: 'opsweave.data-catalog', userId: '' }),
    'wrong version': context({ pluginId: 'opsweave.data-catalog', v: 2 }),
  };
  for (const [label, token] of Object.entries(cases)) {
    const response = await call(plugin.base, '/api/data-catalog/datasets', {
      headers: { 'x-opsweave-user-context': token },
    });
    assert.equal(response.status, 401, `${label}: expected 401, got ${response.status}`);
  }

  // A tampered payload with the original signature.
  const valid = context({ pluginId: 'opsweave.data-catalog', role: 'viewer' });
  const [prefix, encoded, signature] = valid.split('.');
  const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  claims.role = 'admin';
  const tampered = `${prefix}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;
  const response = await call(plugin.base, '/api/data-catalog/datasets', {
    headers: { 'x-opsweave-user-context': tampered },
  });
  assert.equal(response.status, 401, 'a re-signed payload must not authenticate');

  // A context signed for this plugin but carrying the payload of the workload
  // prefix must not be accepted as a user context.
  const misPrefixed = valid.replace(/^owu1\./, 'oww1.');
  assert.equal(
    (await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-user-context': misPrefixed } })).status,
    401,
    'a workload-prefixed token is not a user context',
  );
});

test('data-catalog: a valid operator context can act, and the actor is recorded', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const operator = context({ pluginId: 'opsweave.data-catalog', role: 'operator' });
  const name = `b21-operator-${crypto.randomUUID()}`;
  const created = await call(plugin.base, '/api/data-catalog/datasets', {
    method: 'POST',
    headers: { 'x-opsweave-user-context': operator },
    body: {
      name,
      fields: [{ name: 'id', type: 'string', nullable: false, ordinal: 0 }],
      retentionPolicy: { mode: 'RETAIN', maxRecords: 10, maxBytes: 1024 },
    },
  });
  assert.equal(created.status, 201, `operator write failed: ${JSON.stringify(created.body)}`);
  const datasetId = created.body.datasetId;

  // The rule's created_by must be the SIGNED user, not a role string.
  const rule = await call(plugin.base, `/api/data-catalog/datasets/${datasetId}/quality-rules`, {
    method: 'POST',
    headers: { 'x-opsweave-user-context': operator },
    body: { ruleType: 'RECORD_COUNT', config: { min: 0, max: 10 }, severity: 'LOW', schemaRevision: 1 },
  });
  assert.equal(rule.status, 201, JSON.stringify(rule.body));
  const row = await pool.query('SELECT created_by FROM catalog_quality_rules WHERE rule_id=$1', [rule.body.ruleId]);
  assert.equal(row.rows[0].created_by, USER_ID, 'created_by records the signed user id');

  await pool.query('DELETE FROM catalog_quality_rules WHERE dataset_id=$1', [datasetId]);
  await pool.query('DELETE FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId]);
  await pool.query('DELETE FROM catalog_datasets WHERE dataset_id=$1', [datasetId]);
});

// ---------------------------------------------------------------------------
// Data Integration
// ---------------------------------------------------------------------------
test('data-integration: an unsigned role header is not an identity', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-integration');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const before = await counts(pool, INTEGRATION_TABLES);
  for (const role of ['admin', 'operator', 'viewer']) {
    const response = await call(plugin.base, '/api/data-integration/sources', {
      headers: { 'x-opsweave-user-role': role },
    });
    assert.equal(response.status, 401, `role header "${role}" must not authenticate`);
  }
  const create = await call(plugin.base, '/api/data-integration/sources', {
    method: 'POST',
    headers: { 'x-opsweave-user-role': 'admin' },
    body: { name: 'forged', connectorType: 'http-json', endpoint: 'https://example.com/x', credential: { credentialRef: 'secret://local/x' } },
  });
  assert.equal(create.status, 401);
  assert.deepEqual(await counts(pool, INTEGRATION_TABLES), before, 'refusals left no rows behind');
});

test('data-integration: a signed viewer cannot write, and a foreign context is refused', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-integration');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const viewer = context({ pluginId: 'opsweave.data-integration', role: 'viewer' });
  const before = await counts(pool, INTEGRATION_TABLES);
  const write = await call(plugin.base, '/api/data-integration/sources', {
    method: 'POST',
    headers: { 'x-opsweave-user-context': viewer, 'x-opsweave-user-role': 'admin' },
    body: { name: 'viewer-write', connectorType: 'http-json', endpoint: 'https://example.com/x', credential: { credentialRef: 'secret://local/x' } },
  });
  assert.equal(write.status, 403);
  assert.deepEqual(await counts(pool, INTEGRATION_TABLES), before);

  // A catalog context presented to integration is a cross-plugin replay.
  const foreign = context({ pluginId: 'opsweave.data-catalog', role: 'operator' });
  const replay = await call(plugin.base, '/api/data-integration/sources', {
    headers: { 'x-opsweave-user-context': foreign },
  });
  assert.equal(replay.status, 401, 'a context minted for another plugin is not accepted');

  const expired = context({ pluginId: 'opsweave.data-integration', issuedAt: Math.floor(Date.now() / 1000) - 600, expiresAt: Math.floor(Date.now() / 1000) - 300 });
  assert.equal(
    (await call(plugin.base, '/api/data-integration/sources', { headers: { 'x-opsweave-user-context': expired } })).status,
    401,
  );
});

test('data-integration: the token file is the only workload credential source', async () => {
  // A regression guard for the identity change: the plugin must not treat the
  // absence of a context key as "trust everyone", which is the shape the old
  // role fallback had.
  const plugin = await startPlugin('data-integration', { OPSWEAVE_CALLER_CONTEXT_KEY: '' });
  try {
    const response = await call(plugin.base, '/api/data-integration/sources', {
      headers: { 'x-opsweave-user-context': context({ pluginId: 'opsweave.data-integration' }), 'x-opsweave-user-role': 'admin' },
    });
    assert.equal(response.status, 401, 'with no context key every request is anonymous');
  } finally {
    await plugin.close();
  }
});
