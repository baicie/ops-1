// Persistence tests against a real PostgreSQL database.
//
// These are the tests the in-memory store cannot fake: create -> close ->
// reopen -> the source is still there, the credential is still only a
// reference, and two concurrent creates cannot both win. The database must be
// disposable: this file drops the zabbix_* tables before each test.
//
// OPSWEAVE_TEST_PLUGIN_DATABASE_URL names that database. When it is absent the
// tests are reported as skipped with the reason; CI sets
// OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1 so a missing URL fails instead of skipping.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { openStorage, SourceConflictError, StorageUnavailableError } from './storage.mjs';

const { Client } = pg;
const DATABASE_URL = process.env.OPSWEAVE_TEST_PLUGIN_DATABASE_URL || '';
const REQUIRE_DATABASE = process.env.OPSWEAVE_REQUIRE_PLUGIN_DATABASE === '1';

if (!DATABASE_URL && REQUIRE_DATABASE) {
  throw new Error(
    'OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1 but OPSWEAVE_TEST_PLUGIN_DATABASE_URL is unset; a persistence gate that skips is not a gate',
  );
}

const skip = DATABASE_URL
  ? false
  : 'OPSWEAVE_TEST_PLUGIN_DATABASE_URL is unset; persistence tests need a disposable PostgreSQL database';

const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = '11111111-1111-4111-8111-111111111111';

async function raw(sql, values) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, values);
  } finally {
    await client.end();
  }
}

async function reset() {
  if (!DATABASE_URL) return;
  await raw('DROP TABLE IF EXISTS zabbix_collections, zabbix_source_audit, zabbix_sources, zabbix_schema_migrations CASCADE');
}

beforeEach(reset);
after(reset);

function source(overrides = {}) {
  return {
    sourceId: crypto.randomUUID(),
    workspaceId: WORKSPACE_A,
    createdBy: ACTOR,
    name: 'zabbix-main',
    endpoint: 'https://zabbix.example.invalid/api_jsonrpc.php',
    credential: { kind: 'api-token', ref: 'secretref:zabbix/main' },
    verifyTls: true,
    budget: { maxWindowSeconds: 3600, maxItems: 100, maxSamplesPerItem: 500, requestTimeoutMs: 10000, maxConcurrency: 2 },
    ...overrides,
  };
}

test('a source survives a plugin restart and the token is not in the database', { skip }, async () => {
  const first = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  const created = await first.createSource(source());
  await first.close();

  const second = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  try {
    const listed = await second.listSources([WORKSPACE_A]);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceId, created.source_id);
    assert.equal(listed[0].credential.ref, 'secretref:zabbix/main');
    const looked = await second.getSource(created.source_id, [WORKSPACE_A]);
    assert.ok(looked);
    // The credential reference survived, the value never existed here.
    const row = await raw('SELECT * FROM zabbix_sources WHERE source_id=$1', [created.source_id]);
    assert.equal(JSON.stringify(row.rows[0]).includes('fixture-token'), false);
  } finally {
    await second.close();
  }
});

test('the same endpoint in one workspace cannot be created twice, even concurrently', { skip }, async () => {
  const store = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => store.createSource(source({ sourceId: crypto.randomUUID(), name: 'race' }))),
    );
    const fulfilled = attempts.filter((entry) => entry.status === 'fulfilled');
    const rejected = attempts.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 4);
    for (const entry of rejected) assert.ok(entry.reason instanceof SourceConflictError);
  } finally {
    await store.close();
  }
});

test('a workspace can only read its own sources', { skip }, async () => {
  const store = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  try {
    const a = await store.createSource(source({ sourceId: crypto.randomUUID(), workspaceId: WORKSPACE_A }));
    const b = await store.createSource(source({ sourceId: crypto.randomUUID(), workspaceId: WORKSPACE_B, endpoint: 'https://b.example.invalid/api_jsonrpc.php' }));
    assert.deepEqual((await store.listSources([WORKSPACE_A])).map((row) => row.sourceId), [a.source_id]);
    assert.deepEqual((await store.listSources([WORKSPACE_B])).map((row) => row.sourceId), [b.source_id]);
    assert.equal(await store.getSource(a.source_id, [WORKSPACE_B]), null);
  } finally {
    await store.close();
  }
});

test('a changed checksum on an applied migration refuses to start', { skip }, async () => {
  const first = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  await first.close();
  await raw("UPDATE zabbix_schema_migrations SET checksum='sha256:not-the-same' WHERE version=1");
  await assert.rejects(
    () => openStorage({ databaseUrl: DATABASE_URL, allowMemory: false }),
    /checksum/,
  );
});

test('a raw credential cannot be stored even by direct SQL', { skip }, async () => {
  const store = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  await store.close();
  await assert.rejects(
    () => raw(
      `INSERT INTO zabbix_sources
        (source_id,workspace_id,created_by,name,endpoint,credential_kind,credential_ref,status,budget)
       VALUES ($1,$2,$3,'raw','https://x.example.invalid','api-token','abc123','UNVERIFIED','{}'::jsonb)`,
      [crypto.randomUUID(), WORKSPACE_A, ACTOR],
    ),
    /credential_ref/,
  );
});

test('an unreachable database fails closed instead of starting empty', { skip }, async () => {
  await assert.rejects(
    () => openStorage({ databaseUrl: 'postgres://nobody:nobody@127.0.0.1:1/none', allowMemory: false }),
    (error) => error instanceof StorageUnavailableError,
  );
});

test('collections expire instead of being signed after their retention horizon', { skip }, async () => {
  const store = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  try {
    const collectionId = crypto.randomUUID();
    await store.saveCollection({
      collectionId,
      sourceId: crypto.randomUUID(),
      workspaceId: WORKSPACE_A,
      createdBy: ACTOR,
      outcome: 'OK',
      contentRef: 'sha256:' + '0'.repeat(64),
      body: '{}',
      observedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(await store.getCollection(collectionId, [WORKSPACE_A]));
    // Expire it after the fact: the read path must refuse it even before the
    // next write cleans the row up. Retention is a read rule, not only a sweep.
    await raw('UPDATE zabbix_collections SET expires_at=now() - interval \'1 second\' WHERE collection_id=$1', [collectionId]);
    assert.equal(await store.getCollection(collectionId, [WORKSPACE_A]), null);
  } finally {
    await store.close();
  }
});

test('reopening an already migrated database is a no-op', { skip }, async () => {
  const first = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  await first.close();
  const second = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  await second.close();
  const rows = await raw('SELECT version FROM zabbix_schema_migrations ORDER BY version');
  assert.deepEqual(rows.rows.map((row) => row.version), [1]);
});
