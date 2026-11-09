// B2.1a: workspace isolation for the data plane, over real sockets.
//
// B2.1 made identity unforgeable. This suite proves the second half: an
// authenticated caller still sees only the workspaces its signed context names,
// and every refusal leaves the database untouched.
//
// The pre-fix behaviour this catches: `catalog_datasets` and
// `integration_sources` had no workspace column at all, so any authenticated
// caller - and any workload token, however narrowly scoped - read every
// dataset and every source on the platform.
//
// Run: node --test tests/ci/b2_workspace_isolation.test.mjs
// Requires OPSWEAVE_TEST_PLUGIN_DATABASE_URL; OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1
// turns a missing database into a failure rather than a skip.

import { test, before } from 'node:test';
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

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_ID = '11111111-1111-4111-8111-111111111111';

let pg;
before(async () => {
  if (!DATABASE_URL) {
    if (process.env.OPSWEAVE_REQUIRE_PLUGIN_DATABASE === '1') {
      throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required but unset');
    }
    throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required for the isolation suite');
  }
  pg = (await import(path.join(ROOT, 'plugins/data-catalog/backend/node_modules/pg/lib/index.js'))).default;
});

function userContext({ pluginId, role = 'operator', workspaces = [WS_A], userId = USER_ID }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: 1, userId, role, pluginId, workspaceIds: workspaces, issuedAt: now, expiresAt: now + 120, requestId: crypto.randomUUID() };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(PLUGIN_KEY, 'hex')).update(encoded).digest('base64url');
  return `owu1.${encoded}.${signature}`;
}

function workloadContext({ pluginId = 'opsweave.pipeline.worker', workspaces = [WS_A], scope = ['dataset:read', 'dataset:write'], capabilityName = 'data.catalog.v1' }) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    sub: 'instance-1',
    pluginId,
    instanceId: '44444444-4444-4444-8444-444444444444',
    nodeId: '55555555-5555-4555-8555-555555555555',
    nodeGeneration: 1,
    capabilityName,
    capabilityMajor: 1,
    audience: `plugin:${capabilityName}`,
    scope: [...scope, ...workspaces.map((id) => `workspace:${id}`)],
    issuedAt: now,
    expiresAt: now + 120,
    jti: crypto.randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(PLUGIN_KEY, 'hex')).update(encoded).digest('base64url');
  return `oww1.${encoded}.${signature}`;
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

async function startPlugin(name) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.join(ROOT, 'plugins', name, 'backend'),
    env: { ...process.env, PORT: String(port), DATABASE_URL, OPSWEAVE_PLUGIN_DATABASE_URL: DATABASE_URL, OPSWEAVE_CALLER_CONTEXT_KEY: PLUGIN_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`plugin exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/_opsweave/health/ready`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    base,
    async close() {
      child.kill('SIGTERM');
      await new Promise((resolve) => { child.once('exit', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); });
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

const DATASET_BODY = (name) => ({
  name,
  fields: [{ name: 'id', type: 'string', nullable: false, ordinal: 0 }],
  retentionPolicy: { mode: 'RETAIN', maxRecords: 10, maxBytes: 1024 },
});

test('data-catalog: a dataset is readable only from the workspace that owns it', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const inA = userContext({ pluginId: 'opsweave.data-catalog', workspaces: [WS_A] });
  const inB = userContext({ pluginId: 'opsweave.data-catalog', workspaces: [WS_B] });

  const created = await call(plugin.base, '/api/data-catalog/datasets', { method: 'POST', headers: { 'x-opsweave-user-context': inA }, body: DATASET_BODY(`iso-a-${crypto.randomUUID()}`) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const datasetId = created.body.datasetId;
  assert.equal(created.body.workspaceId, WS_A, 'the dataset records the workspace that filed it');

  // A caller in A sees it; a caller in B does not, and cannot tell it from a
  // dataset that does not exist.
  const listA = await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-user-context': inA } });
  assert.equal(listA.status, 200);
  assert.ok(listA.body.items.some((item) => item.datasetId === datasetId), 'workspace A sees its dataset');

  const listB = await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-user-context': inB } });
  assert.equal(listB.status, 200);
  assert.ok(!listB.body.items.some((item) => item.datasetId === datasetId), 'workspace B does not see it');

  for (const sub of ['', '/records', '/schemas', '/lineage', '/quality-rules', '/quality-runs']) {
    const cross = await call(plugin.base, `/api/data-catalog/datasets/${datasetId}${sub}`, { headers: { 'x-opsweave-user-context': inB } });
    assert.equal(cross.status, 404, `sub-resource ${sub || '(detail)'} must be 404 across workspaces`);
    assert.equal(cross.body.code, 'DATASET_NOT_FOUND', `sub-resource ${sub || '(detail)'} must not disclose the dataset exists`);
  }

  // A write attempt from B must not reach the rows.
  const rowsBefore = (await pool.query('SELECT count(*)::int AS n FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId])).rows[0].n;
  const crossWrite = await call(plugin.base, `/api/data-catalog/datasets/${datasetId}/schemas/drafts`, {
    method: 'POST',
    headers: { 'x-opsweave-user-context': inB },
    body: { baseRevision: 1, fields: [{ name: 'id', type: 'string', nullable: false, ordinal: 0 }, { name: 'x', type: 'string', nullable: true, ordinal: 1 }] },
  });
  assert.equal(crossWrite.status, 404);
  const rowsAfter = (await pool.query('SELECT count(*)::int AS n FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId])).rows[0].n;
  assert.equal(rowsAfter, rowsBefore, 'a refused cross-workspace write left no row');

  // Naming a workspace the caller does not hold is 403, never a silent fallback.
  const forged = await call(plugin.base, `/api/data-catalog/datasets?workspaceId=${WS_B}`, { headers: { 'x-opsweave-user-context': inA } });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, 'WORKSPACE_FORBIDDEN');

  // Governance aggregates are scoped too: B's summary must not count A's dataset.
  const govA = await call(plugin.base, '/api/data-catalog/governance-summary', { headers: { 'x-opsweave-user-context': inA } });
  const govB = await call(plugin.base, '/api/data-catalog/governance-summary', { headers: { 'x-opsweave-user-context': inB } });
  assert.equal(govA.status, 200);
  assert.equal(govB.status, 200);
  assert.ok(govA.body.datasetCount >= 1);
  assert.equal(govB.body.datasetCount, 0, 'the other workspace has no datasets');

  // Clean up through the owning workspace.
  for (const [sql, params] of [
    ['DELETE FROM catalog_quality_rules WHERE dataset_id=$1', [datasetId]],
    ['DELETE FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId]],
    ['DELETE FROM catalog_datasets WHERE dataset_id=$1', [datasetId]],
  ]) await pool.query(sql, params);
});

test('data-catalog: a workload with no workspace claim reaches nothing', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-catalog');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const owner = userContext({ pluginId: 'opsweave.data-catalog', workspaces: [WS_A] });
  const created = await call(plugin.base, '/api/data-catalog/datasets', { method: 'POST', headers: { 'x-opsweave-user-context': owner }, body: DATASET_BODY(`iso-wl-${crypto.randomUUID()}`) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const datasetId = created.body.datasetId;

  // The pre-fix shape: a valid workload token with only capability scopes. The
  // Kernel now always adds `workspace:<uuid>`, and a token minted without a live
  // lease has none - which must reach no data rather than all of it.
  const unscoped = workloadContext({ workspaces: [] });
  const list = await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-caller-context': unscoped } });
  assert.equal(list.status, 400, 'a workload with no workspace is refused, not served globally');
  assert.equal(list.body.code, 'WORKSPACE_REQUIRED');

  // With the Kernel's placement it works, and only inside that workspace.
  const placementA = workloadContext({ workspaces: [WS_A] });
  const okList = await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-caller-context': placementA } });
  assert.equal(okList.status, 200);
  assert.ok(okList.body.items.some((item) => item.datasetId === datasetId));

  const placementB = workloadContext({ workspaces: [WS_B] });
  const crossList = await call(plugin.base, '/api/data-catalog/datasets', { headers: { 'x-opsweave-caller-context': placementB } });
  assert.equal(crossList.status, 200);
  assert.ok(!crossList.body.items.some((item) => item.datasetId === datasetId), 'a placement elsewhere does not see it');

  const crossDetail = await call(plugin.base, `/api/data-catalog/datasets/${datasetId}`, { headers: { 'x-opsweave-caller-context': placementB } });
  assert.equal(crossDetail.status, 404);

  for (const [sql, params] of [
    ['DELETE FROM catalog_quality_rules WHERE dataset_id=$1', [datasetId]],
    ['DELETE FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId]],
    ['DELETE FROM catalog_datasets WHERE dataset_id=$1', [datasetId]],
  ]) await pool.query(sql, params);
});

test('data-integration: a source and its runs are scoped to their workspace', async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const plugin = await startPlugin('data-integration');
  t.after(async () => { await plugin.close(); await pool.end(); });

  const inA = userContext({ pluginId: 'opsweave.data-integration', workspaces: [WS_A] });
  const inB = userContext({ pluginId: 'opsweave.data-integration', workspaces: [WS_B] });

  const created = await call(plugin.base, '/api/data-integration/sources', {
    method: 'POST',
    headers: { 'x-opsweave-user-context': inA },
    body: { name: `iso-src-${crypto.randomUUID()}`, connectorType: 'http-json', endpoint: 'https://example.com/x', credential: { credentialRef: 'secret://local/x' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sourceId = created.body.sourceId;

  const listA = await call(plugin.base, '/api/data-integration/sources', { headers: { 'x-opsweave-user-context': inA } });
  assert.ok(listA.body.some((item) => item.sourceId === sourceId) || listA.body.items?.some((item) => item.sourceId === sourceId), 'A sees its source');

  const listB = await call(plugin.base, '/api/data-integration/sources', { headers: { 'x-opsweave-user-context': inB } });
  const itemsB = Array.isArray(listB.body) ? listB.body : listB.body.items ?? [];
  assert.ok(!itemsB.some((item) => item.sourceId === sourceId), 'B does not see it');

  for (const sub of ['', '/test']) {
    const route = `/api/data-integration/sources/${sourceId}${sub}`;
    const cross = await call(plugin.base, route, { method: sub ? 'POST' : 'GET', headers: { 'x-opsweave-user-context': inB } });
    assert.equal(cross.status, 404, `${route} must be 404 across workspaces`);
    assert.equal(cross.body.code, 'SOURCE_NOT_FOUND');
  }

  // Cross-workspace spec creation must not be possible either.
  const rowsBefore = (await pool.query('SELECT count(*)::int AS n FROM integration_specs').then((r) => r.rows[0].n));
  const crossSpec = await call(plugin.base, `/api/data-integration/sources/${sourceId}/ingestion-specs`, {
    method: 'POST',
    headers: { 'x-opsweave-user-context': inB },
    body: { sourceRevision: 1, schemaRevision: 1, targetDatasetId: datasetless(), mappings: [{ sourcePath: 'id', targetField: 'id', required: true, errorPolicy: 'REJECT_RECORD' }] },
  });
  assert.equal(crossSpec.status, 404);
  const rowsAfter = (await pool.query('SELECT count(*)::int AS n FROM integration_specs').then((r) => r.rows[0].n));
  assert.equal(rowsAfter, rowsBefore, 'a refused cross-workspace spec left no row');

  await pool.query('DELETE FROM integration_sources WHERE source_id=$1', [sourceId]);
});

function datasetless() {
  return crypto.randomUUID();
}
