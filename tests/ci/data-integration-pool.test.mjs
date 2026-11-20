// The two plugins share the pool shape and the boot-latch readiness handler.
// They are separate files with separate deployments, so a fix in one is not a
// fix in the other - this suite exists so the second one cannot drift back
// silently, and it asserts the behaviour, not a shared import.
//
// MEASURED BEFORE THE FIX (data-integration, 2026-11-20):
//   - `new Pool({ connectionString, max: 5 })`: no acquire bound. pg's
//     `connectionTimeoutMillis` defaults to 0, so the sixth caller waits
//     forever.
//   - `/health/ready` answered from `ready && !stopping` - a boolean latched
//     after initDb. It said 200 while the database was unreachable.
//
// Run: node --test tests/ci/data-integration-pool.test.mjs
// Requires OPSWEAVE_TEST_PLUGIN_DATABASE_URL.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATABASE_URL = process.env.OPSWEAVE_TEST_PLUGIN_DATABASE_URL || '';
const PLUGIN_KEY = 'ee'.repeat(32);
const PLUGIN_ID = 'opsweave.data-integration';
const WS = '11111111-1111-4111-8111-111111111111';
const PORT = '18092';

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

before(async () => {
  if (!DATABASE_URL) throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required');
  pg = (await import(path.join(ROOT, 'plugins/data-integration/backend/node_modules/pg/lib/index.js'))).default;

  server = spawn(process.execPath, [path.join(ROOT, 'plugins/data-integration/backend/server.mjs')], {
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
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 8 });
});

after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (server) server.kill('SIGTERM');
});

test('readiness asks the database, not the boot latch', async () => {
  // Healthy: 200, and the body distinguishes "ready" from "cannot reach db".
  const response = await fetch(`${base}/_opsweave/health/ready`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ready');

  // A healthy database answers 200 under both the old and the new handler, so
  // the request above cannot tell them apart - measured: restoring the
  // boot-latch one-line handler leaves it green. The distinction only shows
  // when the database is unreachable while the process is alive, which needs
  // either a wedged pool (now bounded) or killing the database out from under
  // a running server. Both are arranged badly in a test suite, so the shape is
  // asserted directly and the limit is stated rather than hidden.
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    path.join(ROOT, 'plugins/data-integration/backend/server.mjs'), 'utf8',
  ));
  const handler = /url\.pathname === '\/_opsweave\/health\/ready'\) \{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(handler, 'the readiness handler must be a block, not a one-liner');
  assert.match(handler[1], /databaseReachable\(\)/,
    'readiness must consult the database; a boot-time boolean cannot see a lost connection');
});

test('a request behind a held lock fails in bounded time as retryable', async () => {
  // Hold the exact table `GET /sources` reads. Picking a table by pattern was
  // the first attempt and it locked `integration_runs`, which that endpoint
  // never touches - the request answered 200 in 42ms and the assertion caught
  // it. A test whose lock is not on the path proves nothing about the bound,
  // so the table is named and the endpoint's SQL is checked against it.
  const target = 'integration_sources';
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    path.join(ROOT, 'plugins/data-integration/backend/server.mjs'), 'utf8',
  ));
  assert.match(source, new RegExp(`/api/data-integration/sources' && req\\.method === 'GET'[^\\n]*SELECT[^\\n]*FROM ${target}`),
    `GET /sources must read ${target}, or this test locks a table off its path`);

  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query(`LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE`);
  try {
    const started = Date.now();
    const response = await fetch(`${base}/api/data-integration/sources`, {
      headers: { 'x-opsweave-user-context': userContext() },
      signal: AbortSignal.timeout(30000),
    }).catch((error) => ({ status: 'ERROR', error: error.name }));
    const elapsed = Date.now() - started;
    assert.notEqual(response.status, 'ERROR',
      'the request must fail rather than hang past the client timeout');
    assert.ok(elapsed < 20000, `bounded by the server, took ${elapsed}ms`);
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 503, `expected 503, got ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.retryable, true, 'an expired wait is transient and must say so');
    assert.ok(['DEPENDENCY_BLOCKED', 'RESOURCE_EXHAUSTED'].includes(body.code),
      `expected a retryable dependency code, got ${body.code}`);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
});
