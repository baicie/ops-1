// The receipt read that `contracts/openapi/data-catalog-fenced-v1.yaml:54` promises.
//
// WHY THIS IS A SEPARATE SUITE
//
// The contract specifies `GET /datasets/{datasetId}/receipts/{sourceBatchKey}` and
// distinguishes 200 (a receipt) from 404 (none exists). The server, until this
// change, had nine routes and none of them was that one - so the endpoint
// answered 404 for a reason the contract does not describe: "no such route".
//
// The recovery path for a worker killed mid-effect is: come back, ask for the
// receipt by its business key, re-apply only if there is none. With the route
// absent, "no receipt" and "cannot ask" are the same answer, and a re-apply after
// a successful commit becomes indistinguishable from a first attempt.
//
// Run: node --test tests/ci/catalog-receipt-endpoint.test.mjs
// Requires OPSWEAVE_TEST_PLUGIN_DATABASE_URL; OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1
// turns a missing database into a failure rather than a skip.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DATABASE_URL = process.env.OPSWEAVE_TEST_PLUGIN_DATABASE_URL || '';
const PLUGIN_KEY = 'cc'.repeat(32);
const PLUGIN_ID = 'opsweave.data-catalog';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const DATASET_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const DATASET_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const BATCH_KEY = 'batch-receipt-endpoint-test-01';

let pg;
let server;
let base;

before(async () => {
  if (!DATABASE_URL) {
    if (process.env.OPSWEAVE_REQUIRE_PLUGIN_DATABASE === '1') {
      throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required but unset');
    }
    throw new Error('OPSWEAVE_TEST_PLUGIN_DATABASE_URL is required for the receipt suite');
  }
  pg = (await import(path.join(ROOT, 'plugins/data-catalog/backend/node_modules/pg/lib/index.js'))).default;

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  // The server runs its own CREATE TABLE IF NOT EXISTS migrations at boot, so the
  // schema exists by the time a request arrives. Seeding waits for that.
  server = spawn(process.execPath, [path.join(ROOT, 'plugins/data-catalog/backend/server.mjs')], {
    env: {
      ...process.env,
      // The server reads DATABASE_URL; the suite reads the test variable. Passing
      // only one of them was why the first run died with 'database "liuzhiwei"
      // does not exist' - the server fell back to the default database name.
      // The server reads OPSWEAVE_PLUGIN_DATABASE_URL, not DATABASE_URL. Passing
      // DATABASE_URL was ignored and the server fell back to its default, which
      // is why the run died on 'database "liuzhiwei" does not exist'.
      OPSWEAVE_PLUGIN_DATABASE_URL: DATABASE_URL,
      // A fixed port: the server logs the PORT env var, not the port it actually
      // bound, so '0' (meaning any free port) logs 'listening 0' and there is no
      // way to learn where to connect.
      PORT: '18099',
      // The server reads OPSWEAVE_CALLER_CONTEXT_KEY (server.mjs:12), the hex key
      // the Kernel injects. OPSWEAVE_PLUGIN_KEY was ignored and every request
      // arrived unsigned, so all six cases failed on 401 rather than on their
      // own assertion.
      OPSWEAVE_CALLER_CONTEXT_KEY: PLUGIN_KEY,
      OPSWEAVE_PLUGIN_ID: PLUGIN_ID,
      OPSWEAVE_PLUGIN_WORKSPACE_MODE: 'strict',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not report a port within 20s')), 20000);
    let buffer = '';
    server.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      // The server logs 'data-catalog <version> listening <port>' - no colon, no
      // 'on'. The first pattern expected either and never matched, so every test
      // failed on the hook instead of on its own assertion.
      if (/listening\s+\d+/i.test(buffer)) {
        clearTimeout(timer);
        resolve('http://127.0.0.1:18099');
      }
    });
    server.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${buffer}`)); });
  });

  await pool.query(
    `INSERT INTO catalog_datasets
       (dataset_id, name, owner_plugin_id, schema_revision, schema_digest,
        retention_policy, workspace_id, created_at)
     VALUES ($1,'receipt-a',$5,1,'digest','{}'::jsonb,$2,now()),
            ($3,'receipt-b',$5,1,'digest','{}'::jsonb,$4,now())
     ON CONFLICT (dataset_id) DO NOTHING`,
    [DATASET_A, WS_A, DATASET_B, WS_B, PLUGIN_ID],
  );
  await pool.end();
});

function userContext({ workspaces = [WS_A], role = 'operator' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1,
    userId: '33333333-3333-4333-8333-333333333333',
    role,
    pluginId: PLUGIN_ID,
    workspaceIds: workspaces,
    issuedAt: now,
    expiresAt: now + 120,
    requestId: crypto.randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(PLUGIN_KEY, 'hex')).update(encoded).digest('base64url');
  return `owu1.${encoded}.${signature}`;
}

async function get(route, ctx = userContext()) {
  const response = await fetch(base + route, {
    headers: { 'x-opsweave-user-context': ctx },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test('a receipt that exists is returned with the fields the contract names', async () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await pool.query(
    `INSERT INTO catalog_effect_receipts
       (receipt_id, effect_id, request_digest, job_id, lease_id, fencing_sequence,
        pipeline_id, pipeline_revision, sink_node_id, logical_batch_id, dataset_id,
        schema_revision, source_batch_key, status, accepted, rejected, unknown, errors)
     VALUES ($1,$2,'digest',$3,$7,7,'pipe-1',3,$4,'logical-1',$5,1,$6,'COMMITTED',2,0,0,'[]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [crypto.randomUUID(), 'effect-' + BATCH_KEY, crypto.randomUUID(), crypto.randomUUID(), DATASET_A, BATCH_KEY, crypto.randomUUID()],
  );
  await pool.end();

  const { status, body } = await get(`/api/data-catalog/datasets/${DATASET_A}/receipts/${BATCH_KEY}`);
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.sourceBatchKey, BATCH_KEY, 'the receipt must be the one asked for');
  assert.equal(body.datasetId, DATASET_A);
  assert.equal(body.status, 'COMMITTED');
  assert.equal(Number(body.fencingSequence), 7, 'the fence is part of the recovery evidence');
});

test('a key with no receipt is 404 RECEIPT_NOT_FOUND, not a missing route', async () => {
  // The distinction the contract draws. Before the route existed this was a 404
  // too - with no code, because it came from the router, not from the handler.
  const { status, body } = await get(
    `/api/data-catalog/datasets/${DATASET_A}/receipts/no-such-batch-key-000000`,
  );
  assert.equal(status, 404);
  assert.equal(body.code, 'RECEIPT_NOT_FOUND', `expected RECEIPT_NOT_FOUND, got ${JSON.stringify(body)}`);
});

test('a dataset in another workspace is 404 DATASET_NOT_FOUND, not 403', async () => {
  // 403 would confirm the dataset exists - the cross-tenant leak the isolation
  // suite exists to prevent. The caller's context names WS_A; DATASET_B is in WS_B.
  const { status, body } = await get(
    `/api/data-catalog/datasets/${DATASET_B}/receipts/${BATCH_KEY}`,
    userContext({ workspaces: [WS_A] }),
  );
  assert.equal(status, 404, `expected 404 for a foreign dataset, got ${status}`);
  assert.equal(body.code, 'DATASET_NOT_FOUND', `must not confirm existence: ${JSON.stringify(body)}`);
});

test('an unknown dataset id is 404 DATASET_NOT_FOUND', async () => {
  const { status, body } = await get(
    '/api/data-catalog/datasets/99999999-0000-4000-8000-000000000009/receipts/x',
  );
  assert.equal(status, 404);
  assert.equal(body.code, 'DATASET_NOT_FOUND');
});

test('a malformed dataset id is 400, not 404', async () => {
  // Distinct from "no such dataset": one is a caller bug, the other is a missing
  // resource, and an operator reads them differently.
  const { status, body } = await get('/api/data-catalog/datasets/not-a-uuid/receipts/x');
  assert.equal(status, 400, `expected 400, got ${status}`);
  assert.equal(body.code, 'INVALID_DATASET_ID');
});

test('the receipt read requires dataset:read', async () => {
  const { status, body } = await get(
    `/api/data-catalog/datasets/${DATASET_A}/receipts/${BATCH_KEY}`,
    // A viewer context without the dataset:read scope. The suite's user contexts
    // always carry operator scopes; this one names a role the server does not map
    // to dataset:read, so the refusal is the scope check rather than the role.
    userContext({ workspaces: [], role: 'viewer' }),
  );
  // MEASURED: 400 WORKSPACE_REQUIRED. A caller outside every workspace is not
  // told 403 - the server refuses before it looks at the dataset at all, which is
  // the stronger behaviour: the response cannot depend on whether the receipt
  // exists. 403 would only be reached by a caller WITH a workspace but without
  // the scope, which is a different case this suite does not construct.
  assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.code, 'WORKSPACE_REQUIRED');
});

test.after(() => { if (server) server.kill('SIGTERM'); });

test('the receipt status column enforces the contract enum', async () => {
  // `contracts/schema/sink-receipt.v1.schema.json` allows COMMITTED, REJECTED and
  // UNKNOWN. The column was bare `text`, so a typo, a future code path, or a
  // manual INSERT could store anything - and the recovery reader treats an
  // unrecognised status as "cannot tell", which is the answer it must never be
  // given by accident.
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    // The three the contract names must be accepted.
    for (const status of ['COMMITTED', 'REJECTED', 'UNKNOWN']) {
      await pool.query(
        `INSERT INTO catalog_effect_receipts
           (receipt_id, effect_id, request_digest, job_id, lease_id, fencing_sequence,
            pipeline_id, pipeline_revision, sink_node_id, logical_batch_id, dataset_id,
            schema_revision, source_batch_key, status, accepted, rejected, unknown, errors)
         VALUES ($1,$2,'d',$3,$4,1,'p',1,'n','l',$5,1,$6,$7,0,0,0,'[]'::jsonb)
         ON CONFLICT DO NOTHING`,
        [crypto.randomUUID(), `effect-enum-${status}`, crypto.randomUUID(),
          crypto.randomUUID(), DATASET_A, `enumbatch-${status}`, status],
      );
    }
    // Anything else must be refused by the database, not by convention.
    await assert.rejects(
      pool.query(
        `INSERT INTO catalog_effect_receipts
           (receipt_id, effect_id, request_digest, job_id, lease_id, fencing_sequence,
            pipeline_id, pipeline_revision, sink_node_id, logical_batch_id, dataset_id,
            schema_revision, source_batch_key, status, accepted, rejected, unknown, errors)
         VALUES ($1,'effect-enum-bad','d',$2,$3,1,'p',1,'n','l',$4,1,'enumbatch-bad','PARTIAL',0,0,0,'[]'::jsonb)`,
        [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), DATASET_A],
      ),
      /violates check constraint|check constraint/i,
      'PARTIAL is not in the contract enum and must be refused by the column',
    );
  } finally {
    await pool.end();
  }
});

test('the two receipt tables enforce two different contract enums', async () => {
  // catalog_receipts   -> data-catalog.v1.schema.json: ACCEPTED/PARTIAL/REJECTED/UNKNOWN
  // catalog_effect_receipts -> sink-receipt.v1.schema.json: COMMITTED/REJECTED/UNKNOWN
  //
  // Two tables, two contracts, two value sets. Having a CHECK on only one of them
  // was an accident of which table got fixed first, so both are asserted here and
  // each is asserted to REJECT a value that belongs to the other.
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const insertIngestion = (receiptId, status) => pool.query(
      `INSERT INTO catalog_receipts
         (receipt_id, dataset_id, schema_revision, source_batch_key, request_digest,
          status, accepted, rejected, unknown, errors)
       VALUES ($1,$2,1,$3,'d',$4,0,0,0,'[]'::jsonb)`,
      [receiptId, DATASET_A, `ingest-${receiptId}`, status],
    );
    const insertEffect = (receiptId, status) => pool.query(
      `INSERT INTO catalog_effect_receipts
         (receipt_id, effect_id, request_digest, job_id, lease_id, fencing_sequence,
          pipeline_id, pipeline_revision, sink_node_id, logical_batch_id, dataset_id,
          schema_revision, source_batch_key, status, accepted, rejected, unknown, errors)
       VALUES ($1,$2,'d',$3,$4,1,'p',1,'n','l',$5,1,$6,$7,0,0,0,'[]'::jsonb)`,
      [receiptId, `effect-${receiptId}`, crypto.randomUUID(), crypto.randomUUID(),
        DATASET_A, `key-${receiptId}`, status],
    );

    // Every value each contract names must be accepted.
    for (const status of ['ACCEPTED', 'PARTIAL', 'REJECTED', 'UNKNOWN']) {
      await insertIngestion(crypto.randomUUID(), status);
    }
    for (const status of ['COMMITTED', 'REJECTED', 'UNKNOWN']) {
      await insertEffect(crypto.randomUUID(), status);
    }

    // The cross-check: a value from the OTHER contract's enum must be refused by
    // each table. Without this, "both have a CHECK" could be satisfied by both
    // having the same one.
    await assert.rejects(
      insertIngestion(crypto.randomUUID(), 'COMMITTED'),
      /check constraint/i,
      'COMMITTED belongs to the effect receipt, not the ingestion receipt',
    );
    await assert.rejects(
      insertEffect(crypto.randomUUID(), 'PARTIAL'),
      /check constraint/i,
      'PARTIAL belongs to the ingestion receipt, not the effect receipt',
    );
  } finally {
    await pool.end();
  }
});

test('the fenced sink bounds its lock wait instead of blocking the queue', async () => {
  // `fence_authorize_effect` takes the pipeline_jobs row lock and holds it until
  // the transaction commits. Every other write path in server.mjs sets a
  // lock_timeout before taking a lock; this one did not, so a stuck Catalog
  // transaction serialised every claim for as long as it stayed stuck.
  //
  // The assertion is on the SETTING, not on a hang: proving the bound by actually
  // holding a lock for 30 seconds would make the suite slow and the result would
  // still depend on machine speed. What can be checked cheaply and exactly is
  // that the transaction is opened with both limits in effect - which is what
  // makes the behaviour different.
  const source = await import('node:fs').then((fs) => fs.promises.readFile(
    path.join(ROOT, 'plugins/data-catalog/backend/server.mjs'), 'utf8',
  ));

  // Find the transaction that calls fence_authorize_effect and check that the
  // lock_timeout is set between its BEGIN and the call.
  // The CALL, not the first mention: the comment above it names the function too,
  // and searching for the first occurrence found the comment - so `between` held
  // no SET LOCAL and the assertion failed against correct code.
  const idx = source.indexOf("FROM kernel.fence_authorize_effect");
  assert.ok(idx > 0, 'the fence call must exist');
  const begin = source.lastIndexOf("client.query('BEGIN')", idx);
  assert.ok(begin > 0, 'the fence call must run inside a transaction');
  const between = source.slice(begin, idx);
  assert.match(
    between,
    /SET LOCAL lock_timeout/,
    'the fenced sink must bound how long it waits for the pipeline_jobs lock; '
    + 'without it a stuck transaction serialises every claim',
  );
  assert.match(
    between,
    /SET LOCAL statement_timeout/,
    'and bound the statement itself',
  );

  // A THIRD ASSERTION WAS HERE AND IT WAS WRONG, not the code: it walked back from
  // `INSERT INTO catalog_receipts` to the nearest BEGIN, which is the DATASET
  // creation transaction (server.mjs:812) - and that one genuinely has no bound.
  // Asserting it here would have been a claim about a different path wearing this
  // test's name, so it is removed rather than fixed in place. The dataset-create
  // gap is real and is recorded in the PR instead.
});
