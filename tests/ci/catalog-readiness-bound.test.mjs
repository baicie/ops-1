// A plugin that advertises READY while it cannot serve is worse than a dead
// one: nothing fails over. Measured on 2026-11-20 against the real data-catalog
// server, PostgreSQL 17.10 and the real Node runtime source.
//
// WHAT WAS MEASURED, BEFORE THE FIX
//
//   1. `new Pool({ max: 5 })` had no acquire bound. Five blocked ingests parked
//      five clients; the sixth request waited in `pool.connect()` indefinitely
//      (6s and counting when the probe gave up).
//
//   2. `/health/ready` answered 200 {"status":"ready"} in 4ms during exactly
//      that window - it was served before any database work, from a boolean
//      latched at boot.
//
//   3. The Node runtime polled only `liveness_path` in steady state, so the
//      manifest's `readinessPath` was consulted only during startup. The
//      Kernel's route query requires `i.state = 'READY'`, so an instance that
//      became incapable after boot stayed in rotation forever.
//
// WHAT THIS SUITE ASSERTS
//
// A: the pool is bounded, and a blocked request fails in bounded time with a
//    retryable code rather than hanging.
// B: readiness reflects the database, so an instance that cannot reach it
//    answers 503 and can be taken out of rotation.
// C: the runtime actually asks the readiness path in steady state.
//
// C is a source-level assertion, deliberately: the alternative is driving a
// container, and a test that needs a Docker daemon to prove a routing rule runs
// nowhere. It reads the loop, not the file, so moving the loop is fine and
// deleting the probe is not.
//
// Run: node --test tests/ci/catalog-readiness-bound.test.mjs
// Requires OPSWEAVE_TEST_PLUGIN_DATABASE_URL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATABASE_URL = process.env.OPSWEAVE_TEST_PLUGIN_DATABASE_URL || '';
const PLUGIN_KEY = 'cc'.repeat(32);
const PLUGIN_ID = 'opsweave.data-catalog';
const WS = '11111111-1111-4111-8111-111111111111';
const DATASET = 'aaaaaaaa-0000-4000-8000-0000000000bb';
const PORT = '18096';

let pg;
let server;
let base;
let pool;

function userContext() {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1, userId: '33333333-3333-4333-8333-333333333333', role: 'operator',
    pluginId: PLUGIN_ID, workspaceIds: [WS], issuedAt: now, expiresAt: now + 300,
    requestId: crypto.randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(PLUGIN_KEY, 'hex')).update(encoded).digest('base64url');
  return `owu1.${encoded}.${signature}`;
}

/** POST one ingestion batch; returns the outcome without throwing on HTTP errors. */
async function ingest(sourceBatchKey, timeoutMs = 30000) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/api/data-catalog/datasets/${DATASET}/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opsweave-user-context': userContext() },
      body: JSON.stringify({ schemaRevision: 1, sourceBatchKey, records: [{ id: 'a' }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    return { ms: Date.now() - started, status: response.status, code: body?.code, retryable: body?.retryable };
  } catch (error) {
    return { ms: Date.now() - started, error: error.name };
  }
}

before(async () => {
  if (!DATABASE_URL) throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required');
  pg = (await import(path.join(ROOT, 'plugins/data-catalog/backend/node_modules/pg/lib/index.js'))).default;

  server = spawn(process.execPath, [path.join(ROOT, 'plugins/data-catalog/backend/server.mjs')], {
    env: {
      ...process.env,
      OPSWEAVE_PLUGIN_DATABASE_URL: DATABASE_URL,
      PORT,
      OPSWEAVE_CALLER_CONTEXT_KEY: PLUGIN_KEY,
      OPSWEAVE_PLUGIN_ID: PLUGIN_ID,
      OPSWEAVE_PLUGIN_WORKSPACE_MODE: 'strict',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buffer}`)), 25000);
    server.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (/listening\s+\d+/i.test(buffer)) { clearTimeout(timer); resolve(`http://127.0.0.1:${PORT}`); }
    });
    server.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buffer}`)); });
  });

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 12 });
  await pool.query(
    `INSERT INTO catalog_datasets
       (dataset_id,name,owner_plugin_id,schema_revision,schema_digest,retention_policy,workspace_id)
     VALUES ($1,'readiness-bound',$3,1,'digest','{"mode":"RETAIN","maxRecords":10000,"maxBytes":16777216}'::jsonb,$2)
     ON CONFLICT (dataset_id) DO NOTHING`,
    [DATASET, WS, PLUGIN_ID],
  );
  await pool.query(
    `INSERT INTO catalog_schema_revisions (dataset_id,schema_revision,digest,status,fields,published_at)
     VALUES ($1,1,'digest','PUBLISHED',$2,now()) ON CONFLICT DO NOTHING`,
    [DATASET, JSON.stringify([{ name: 'id', type: 'string', required: true }])],
  );
});

after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (server) server.kill('SIGTERM');
});

test('readiness answers 200 when the database is reachable', async () => {
  const response = await fetch(`${base}/_opsweave/health/ready`);
  assert.equal(response.status, 200, 'a healthy instance must report ready');
});

test('A: a request blocked on a lock fails in bounded time, and says it is retryable', async () => {
  // Hold the table the ingestion path writes to, the way a migration or a stuck
  // peer would, and ingest through it.
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('LOCK TABLE catalog_receipts IN ACCESS EXCLUSIVE MODE');
  try {
    const outcome = await ingest('readiness-bound-blocked-0001', 30000);
    assert.equal(outcome.error, undefined,
      `the request must fail rather than hang past the test's patience: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.status, 503,
      `expected 503 for an expired lock wait, got ${outcome.status}: ${JSON.stringify(outcome)}`);
    // The contract's retryable flag exists for exactly this: a transient
    // condition the caller should come back from. Before the fix this was
    // 500 INTERNAL with retryable=false - a permanent-looking answer.
    assert.equal(outcome.retryable, true);
    assert.ok(['DEPENDENCY_BLOCKED', 'RESOURCE_EXHAUSTED'].includes(outcome.code),
      `expected a retryable dependency code, got ${outcome.code}`);
    // The bound is lock_timeout (2s) not the test timeout.
    assert.ok(outcome.ms < 15000, `the wait must be bounded by the server, took ${outcome.ms}ms`);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
});

test('D: a malformed body is 400, not 500', async () => {
  // Measured before the fix: `POST /datasets` with `fields: [{name,type,...}]`
  // missing `nullable` and `ordinal` answered `500 INTERNAL / retryable=false`
  // in 27ms. The validator throws to abort the request, the two schema-publish
  // call sites do not wrap it, and the top-level handler had no status to read.
  //
  // A caller with a bad body told "the server broke" files a bug against the
  // platform; an operator paged on INTERNAL looks in the wrong place. The
  // distinction between 400 and 500 is the whole content of this test.
  const bodies = [
    ['missing nullable and ordinal', { fields: [{ name: 'id', type: 'string', required: true }] }],
    ['a field name that is not an identifier', { fields: [{ name: '1bad', type: 'string', nullable: false, ordinal: 0 }] }],
    ['duplicate ordinals', { fields: [
      { name: 'a', type: 'string', nullable: false, ordinal: 0 },
      { name: 'b', type: 'string', nullable: false, ordinal: 0 },
    ] }],
    ['no fields at all', { fields: [] }],
  ];
  for (const [label, fields] of bodies) {
    const response = await fetch(`${base}/api/data-catalog/datasets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-opsweave-user-context': userContext() },
      body: JSON.stringify({ name: `invalid-body-${crypto.randomUUID()}`, ...fields }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 400,
      `${label} must be 400, got ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body?.code, 'INVALID_REQUEST', `${label} must name the failure: ${JSON.stringify(body)}`);
    // And the message is the validator's, not "internal catalog error".
    assert.doesNotMatch(String(body?.message || ''), /internal/i,
      `${label} must explain what was wrong with the body`);
  }
});

test('B: readiness reflects the database, so a wedged instance leaves rotation', async () => {
  // The assertion the pre-fix server could not satisfy: it answered 200 here.
  //
  // Simulated by pointing a second server at a database it cannot reach. That
  // is the same condition the probe exists to detect - the plugin process is
  // alive and its database is not - without needing to wedge a live pool, which
  // the bounded pool now makes hard to arrange on purpose.
  const deadPort = '18095';
  const dead = spawn(process.execPath, [path.join(ROOT, 'plugins/data-catalog/backend/server.mjs')], {
    env: {
      ...process.env,
      // A port with nothing listening: connect() is refused fast, which is a
      // database the plugin cannot reach.
      OPSWEAVE_PLUGIN_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/nonexistent',
      PORT: deadPort,
      OPSWEAVE_CALLER_CONTEXT_KEY: PLUGIN_KEY,
      OPSWEAVE_PLUGIN_ID: PLUGIN_ID,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // It never finishes initDb, so it never starts listening - and that is
    // itself worth stating: a plugin that cannot reach its database at boot
    // exits rather than serving. The probe path under test is the one that
    // matters after boot, asserted directly on the handler's logic below.
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still running'), 8000);
      dead.on('exit', (code) => { clearTimeout(timer); resolve(`exited ${code}`); });
    });
    assert.notEqual(exited, 'still running',
      'a plugin whose database is unreachable at boot must not serve');
  } finally {
    dead.kill('SIGKILL');
  }

  // And the post-boot path, in the source: readiness must depend on the
  // database, not on the boot latch alone. Asserting the shape here is the only
  // honest option - the alternative is wedging a live pool, and a bounded pool
  // is the fix for exactly that, so the two cannot both be arranged.
  const source = fs.readFileSync(path.join(ROOT, 'plugins/data-catalog/backend/server.mjs'), 'utf8');
  const ready = /url\.pathname === '\/_opsweave\/health\/ready'\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(ready, 'the readiness handler must exist');
  assert.match(ready[1], /databaseReachable\(\)/,
    'readiness must ask the database; a boot-time boolean cannot see a wedged pool');
  assert.match(ready[1], /503/,
    'and must be able to answer 503');
});

test('C: the Node runtime asks the readiness path in steady state', async () => {
  // The routing half of the same defect. The Kernel's route query requires
  // `i.state = 'READY'`; if the runtime never re-evaluates readiness, a plugin
  // that starts answering 503 is never taken out of rotation and the fix above
  // has no consumer.
  const runtime = fs.readFileSync(path.join(ROOT, 'apps/node/src/runtime.rs'), 'utf8');
  // The steady-state loop, from its failure counter to the end of its body.
  const loop = /let mut liveness_failures = 0;([\s\S]*?)\n    \}\n\}/.exec(runtime);
  assert.ok(loop, 'the steady-state probe loop must exist');

  assert.match(loop[1], /readiness_path/,
    'the steady-state loop must probe the manifest readinessPath; '
    + 'consulting it only during startup leaves a degraded instance in rotation forever');

  // The counter is liveness-only. Readiness must not be able to restart an
  // instance: a rebuild does not fix an unreachable dependency.
  const counter = /fn next_liveness_failures\(previous: u32, alive: bool\) -> u32 \{([\s\S]*?)\n\}/.exec(runtime);
  assert.ok(counter, 'the failure counter must be a single function');
  assert.doesNotMatch(counter[1], /ready/i,
    'the restart counter must not consult readiness - that turns an outage into a restart storm');

  // And the decision must be able to leave READY.
  assert.match(runtime, /SteadyStateDecision::MarkUnhealthy\("readiness probe failed/,
    'a readiness failure must be able to mark the instance unhealthy');
  assert.match(runtime, /SteadyStateDecision::MarkReady/,
    'and recovery must re-announce READY, or the instance never returns to rotation');
});
