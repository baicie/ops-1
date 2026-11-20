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
import { openStorage, SourceConflictError, StorageUnavailableError, storageFailure } from './storage.mjs';

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

// ---- bounded waits -------------------------------------------------------
//
// B-41. `openStorage` set `connectionTimeoutMillis`, which bounds waiting for a
// free POOL SLOT, and nothing else. Two waits inside a transaction were
// unbounded, and both are reachable from ordinary operations:
//
//   - `updateSource` takes `FOR UPDATE` on the source row;
//   - `migrate` takes `pg_advisory_xact_lock` on a fixed key, and runs on every
//     `openStorage`, so a second instance starting while the first migrates
//     queues behind it.
//
// Measured 2026-11-21 against PostgreSQL 17.10 with a holder sleeping 12s:
//
//   shipped options (acquire bound only), FOR UPDATE  -> STILL WAITING at 5s
//   + lock_timeout=1s, same wait                      -> 55P03 at 1476ms
//   + lock_timeout=1s, pg_advisory_xact_lock          -> 55P03 at 1527ms
//
// The assertion is on the OUTCOME and the CODE, not on a wall-clock number: a
// test that says "fails within N ms" is a test that fails on a slow runner. The
// holder is held for far longer than the bound, so "returned at all" is the
// signal - and with the old options this test hangs until its own timeout.

test('a source update behind a held row lock fails as retryable, not as a hang', { skip }, async () => {
  const store = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  try {
    const created = await store.createSource(source());

    // An independent connection holds the row the way a concurrent update or a
    // stuck transaction would. It is held for 20s - far past lock_timeout, so
    // the only way this test finishes quickly is if the pool bounds the wait.
    const holder = new Client({ connectionString: DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM zabbix_sources WHERE source_id=$1 FOR UPDATE', [created.source_id]);

    try {
      const started = Date.now();
      const attempt = store.updateSource(
        created.source_id, [WORKSPACE_A],
        { name: 'renamed', endpoint: created.endpoint, credential: { kind: 'api-token', ref: 'secretref:zabbix/main' }, verifyTls: true, budget: source().budget },
        ACTOR,
      );
      const bounded = await Promise.race([
        attempt.then(() => ({ settled: 'resolved' }), (error) => ({ settled: 'rejected', error })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: 'HUNG' }), 15000)),
      ]);
      const elapsed = Date.now() - started;

      assert.notEqual(bounded.settled, 'HUNG',
        `the update was still waiting after ${elapsed}ms; the pool has no lock bound`);
      assert.equal(bounded.settled, 'rejected', 'a contended row must not let the update succeed');
      // The translation matters as much as the bound: an untranslated 55P03
      // reaches the server as 500 INTERNAL / retryable=false, which tells the
      // caller to give up on a condition that is transient by construction.
      assert.ok(bounded.error instanceof StorageUnavailableError,
        `expected StorageUnavailableError, got ${bounded.error?.name}: ${bounded.error?.message}`);
      assert.equal(bounded.error.status, 503);
      assert.equal(bounded.error.retryable, true);
      assert.equal(bounded.error.code, 'ZBX_STORAGE_UNAVAILABLE');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end().catch(() => {});
    }
  } finally {
    await store.close();
  }
});

test('a second instance starting while the migration lock is held is bounded too', { skip }, async () => {
  // `migrate` runs from `openStorage`, so this is the path a second replica
  // takes on startup. The lock is `pg_advisory_xact_lock`, which has no row to
  // point at and is therefore easy to assume the row-lock settings do not
  // cover. Measured: it does.
  const first = await openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
  await first.close();

  const holder = new Client({ connectionString: DATABASE_URL });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query("SELECT pg_advisory_xact_lock(hashtext('opsweave.zabbix-source.migrations'))");
  try {
    const started = Date.now();
    const attempt = openStorage({ databaseUrl: DATABASE_URL, allowMemory: false });
    const bounded = await Promise.race([
      attempt.then(() => ({ settled: 'resolved' }), (error) => ({ settled: 'rejected', error })),
      new Promise((resolve) => setTimeout(() => resolve({ settled: 'HUNG' }), 15000)),
    ]);
    const elapsed = Date.now() - started;
    assert.notEqual(bounded.settled, 'HUNG',
      `openStorage was still waiting on the migration lock after ${elapsed}ms`);
    assert.equal(bounded.settled, 'rejected');
    assert.ok(bounded.error instanceof StorageUnavailableError,
      `expected StorageUnavailableError, got ${bounded.error?.name}: ${bounded.error?.message}`);
    assert.equal(bounded.error.status, 503);
    // AND THE MESSAGE MUST BE THE TRANSLATION'S, NOT THE GENERIC WRAP.
    //
    // `openStorage` wraps an untranslated failure as "the plugin database is
    // configured but unusable: ...", and that is also a StorageUnavailableError
    // with status 503 - so the two assertions above pass either way. Measured:
    // with `storageFailure` disabled and only the pool options left in place,
    // this test stayed green, because the outer wrapper had turned the raw
    // 55P03 into the same class of error for a different reason.
    assert.doesNotMatch(bounded.error.message, /configured but unusable/,
      'the advisory-lock timeout must be translated, not laundered through the generic wrapper');
    assert.match(bounded.error.message, /could not be reached in time/,
      `expected the translation's message, got: ${bounded.error.message}`);
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end().catch(() => {});
  }
});


// ---- the translation's coverage -------------------------------------------
//
// This is a superset assertion, and it exists because the first version of
// `storageFailure` was NOT one. The inline list it replaced translated
// ECONNREFUSED, 57P01, 08006 and 08001; the replacement kept ECONNREFUSED and
// a ` 08` prefix, silently dropping 57P01 (admin_shutdown) - the code a
// database sends while restarting. That would have turned a retryable restart
// into a permanent 500 on a path the old code handled correctly.
//
// A pure function, so this needs no database and is always run.
test('every code the old inline translation handled is still transient', () => {
  const previouslyTranslated = ['ECONNREFUSED', '57P01', '08006', '08001'];
  for (const code of previouslyTranslated) {
    const error = Object.assign(new Error(`probe ${code}`), { code });
    const outcome = storageFailure(error);
    assert.ok(outcome instanceof StorageUnavailableError,
      `${code} was translated before this change and must still be: got ${outcome?.name}`);
    assert.equal(outcome.status, 503, `${code} must answer 503`);
    assert.equal(outcome.retryable, true, `${code} is transient and must say so`);
  }
  // The bounded-wait codes this change introduces.
  for (const code of ['55P03', '57014', '40001', '57P03', '08000', '08003', '08004', '08P01']) {
    assert.ok(storageFailure(Object.assign(new Error('x'), { code })) instanceof StorageUnavailableError,
      `${code} must be transient`);
  }
});

test('a genuinely unexpected database error is NOT laundered into a 503', () => {
  // The failure mode of an over-broad translation: everything becomes
  // "retry, the database was slow", and a real bug is retried forever instead
  // of being seen. A constraint violation is the caller's problem and keeps
  // its own handling; an unlisted code stays as it was.
  const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
  assert.equal(storageFailure(conflict), conflict, '23505 must not become a 503');
  const odd = Object.assign(new Error('something else'), { code: 'XX000' });
  assert.equal(storageFailure(odd), odd, 'an unlisted code must pass through');
  const plain = new Error('no code at all');
  assert.equal(storageFailure(plain), plain);
});
