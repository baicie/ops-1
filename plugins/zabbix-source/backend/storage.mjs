// Plugin-owned persistence for the Zabbix source.
//
// The Kernel provisions a PostgreSQL schema and a least-privilege role for this
// plugin (ADR-012 §3) and injects the connection URL as
// OPSWEAVE_PLUGIN_DATABASE_URL. The role's search_path is the plugin schema, so
// every table here is unqualified and the Kernel never learns a Zabbix table.
//
// Two rules decide the shape of this module:
//
//   * Fail closed. A missing URL or an unreachable database refuses the request;
//     it never silently serves a process-memory copy of the source registry.
//     `OPSWEAVE_ALLOW_MEMORY_STORAGE=1` is the only way to run the memory store,
//     and /runtime-info reports it.
//   * Migrations are additive and checksum-gated. An applied version whose SQL
//     changed is a startup error, not a silent re-run. There is no down
//     migration: the only safe recovery is a new forward version.

import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

export const MAX_COLLECTIONS_PER_WORKSPACE = 500;
export const COLLECTION_TTL_HOURS = 24;

export class StorageUnavailableError extends Error {
  constructor(message = 'the plugin storage is unavailable') {
    super(message);
    this.name = 'StorageUnavailableError';
    this.status = 503;
    this.code = 'ZBX_STORAGE_UNAVAILABLE';
    this.retryable = true;
  }
}

export class SourceConflictError extends Error {
  constructor(message = 'a source with this endpoint already exists in the workspace') {
    super(message);
    this.name = 'SourceConflictError';
    this.status = 409;
    this.code = 'ZBX_SOURCE_CONFLICT';
    this.retryable = false;
  }
}

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS zabbix_sources (
        source_id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL,
        created_by uuid NOT NULL,
        name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
        endpoint text NOT NULL,
        credential_kind text NOT NULL CHECK (credential_kind IN ('api-token','basic')),
        credential_ref text NOT NULL CHECK (credential_ref ~ '^secretref:'),
        verify_tls boolean NOT NULL DEFAULT true,
        status text NOT NULL CHECK (status IN ('UNVERIFIED','READY','DEGRADED','UNAVAILABLE')),
        last_probe jsonb,
        budget jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, endpoint)
      );
      CREATE INDEX IF NOT EXISTS zabbix_sources_workspace_idx
        ON zabbix_sources (workspace_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS zabbix_source_audit (
        audit_id bigserial PRIMARY KEY,
        source_id uuid NOT NULL,
        workspace_id uuid NOT NULL,
        actor_id uuid NOT NULL,
        action text NOT NULL CHECK (action IN ('CREATE','UPDATE','PROBE')),
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS zabbix_source_audit_source_idx
        ON zabbix_source_audit (source_id, at DESC);
      CREATE TABLE IF NOT EXISTS zabbix_collections (
        collection_id uuid PRIMARY KEY,
        source_id uuid NOT NULL,
        workspace_id uuid NOT NULL,
        created_by uuid NOT NULL,
        outcome text NOT NULL,
        content_ref text NOT NULL,
        body text NOT NULL,
        observed_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS zabbix_collections_workspace_idx
        ON zabbix_collections (workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS zabbix_collections_expiry_idx
        ON zabbix_collections (expires_at);
    `,
  },
];

function migrationChecksum(sql) {
  return 'sha256:' + crypto.createHash('sha256').update(sql).digest('hex');
}

/** A row as the API exposes it. Never includes the credential value (there is
 *  none) and never includes another workspace's data. */
export function sourceView(row) {
  return {
    sourceId: row.source_id,
    workspaceId: row.workspace_id,
    name: row.name,
    endpoint: row.endpoint,
    credential: { kind: row.credential_kind, ref: row.credential_ref },
    verifyTls: row.verify_tls,
    status: row.status,
    ...(row.last_probe ? { lastProbe: row.last_probe } : {}),
    budget: row.budget,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
    this.mode = 'postgres';
  }

  async #query(text, values) {
    try {
      return await this.pool.query(text, values);
    } catch (error) {
      if (error && (error.code === 'ECONNREFUSED' || error.code === '57P01' || error.code === '08006' || error.code === '08001')) {
        throw new StorageUnavailableError();
      }
      throw error;
    }
  }

  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('opsweave.zabbix-source.migrations'))");
      await client.query(`
        CREATE TABLE IF NOT EXISTS zabbix_schema_migrations (
          version integer PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      for (const migration of MIGRATIONS) {
        const checksum = migrationChecksum(migration.sql);
        const existing = await client.query(
          'SELECT checksum FROM zabbix_schema_migrations WHERE version=$1',
          [migration.version],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) {
            throw new Error(
              `migration ${migration.version} was applied with checksum ${existing.rows[0].checksum}, but the code now has ${checksum}; add a new forward migration instead of editing an applied one`,
            );
          }
          continue;
        }
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO zabbix_schema_migrations (version,checksum) VALUES ($1,$2)',
          [migration.version, checksum],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof StorageUnavailableError) throw error;
      if (error && error.code === 'ECONNREFUSED') throw new StorageUnavailableError();
      throw error;
    } finally {
      client.release();
    }
  }

  async listSources(workspaceIds) {
    const result = await this.#query(
      'SELECT * FROM zabbix_sources WHERE workspace_id = ANY($1::uuid[]) ORDER BY created_at DESC',
      [workspaceIds],
    );
    return result.rows.map(sourceView);
  }

  async getSource(sourceId, workspaceIds) {
    const result = await this.#query(
      'SELECT * FROM zabbix_sources WHERE source_id=$1 AND workspace_id = ANY($2::uuid[])',
      [sourceId, workspaceIds],
    );
    return result.rows[0] || null;
  }

  async createSource({ sourceId, workspaceId, createdBy, name, endpoint, credential, verifyTls, budget }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO zabbix_sources
           (source_id,workspace_id,created_by,name,endpoint,credential_kind,credential_ref,verify_tls,status,budget)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UNVERIFIED',$9::jsonb)
         RETURNING *`,
        [sourceId, workspaceId, createdBy, name, endpoint, credential.kind, credential.ref, verifyTls, JSON.stringify(budget)],
      );
      // The row and its audit record commit together: a source that exists with
      // no audit trail is a change nobody can account for.
      await client.query(
        'INSERT INTO zabbix_source_audit (source_id,workspace_id,actor_id,action,detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [sourceId, workspaceId, createdBy, 'CREATE', JSON.stringify({ name, endpoint, credentialKind: credential.kind, verifyTls, budget })],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && error.code === '23505') throw new SourceConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSource(sourceId, workspaceIds, patch, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT * FROM zabbix_sources WHERE source_id=$1 AND workspace_id = ANY($2::uuid[]) FOR UPDATE',
        [sourceId, workspaceIds],
      );
      if (!current.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(
        // Changing where or how the source connects invalidates whatever the
        // previous probe observed: carrying READY (and its lastProbe) over to a
        // new endpoint would present an unverified configuration as healthy.
        // Name and budget changes do not change reachability.
        `UPDATE zabbix_sources SET
           name=$2, endpoint=$3, credential_kind=$4, credential_ref=$5,
           verify_tls=$6, budget=$7::jsonb,
           status=CASE WHEN endpoint<>$3 OR credential_kind<>$4
                            OR credential_ref<>$5 OR verify_tls<>$6
                       THEN 'UNVERIFIED' ELSE status END,
           last_probe=CASE WHEN endpoint<>$3 OR credential_kind<>$4
                                OR credential_ref<>$5 OR verify_tls<>$6
                           THEN NULL ELSE last_probe END,
           updated_at=now()
         WHERE source_id=$1 RETURNING *`,
        [sourceId, patch.name, patch.endpoint, patch.credential.kind, patch.credential.ref, patch.verifyTls, JSON.stringify(patch.budget)],
      );
      await client.query(
        'INSERT INTO zabbix_source_audit (source_id,workspace_id,actor_id,action,detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [sourceId, current.rows[0].workspace_id, actorId, 'UPDATE', JSON.stringify({ name: patch.name, endpoint: patch.endpoint })],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && error.code === '23505') throw new SourceConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProbe(sourceId, workspaceIds, outcome, status, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE zabbix_sources SET last_probe=$3::jsonb, status=$4, updated_at=now()
          WHERE source_id=$1 AND workspace_id = ANY($2::uuid[]) RETURNING *`,
        [sourceId, workspaceIds, JSON.stringify(outcome), status],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        'INSERT INTO zabbix_source_audit (source_id,workspace_id,actor_id,action,detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [sourceId, result.rows[0].workspace_id, actorId, 'PROBE', JSON.stringify({ outcome: outcome.outcome })],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async #audit(sourceId, workspaceId, actorId, action, detail) {
    await this.#query(
      'INSERT INTO zabbix_source_audit (source_id,workspace_id,actor_id,action,detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [sourceId, workspaceId, actorId, action, JSON.stringify(detail)],
    );
  }

  async saveCollection(collection) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO zabbix_collections
           (collection_id,source_id,workspace_id,created_by,outcome,content_ref,body,observed_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          collection.collectionId,
          collection.sourceId,
          collection.workspaceId,
          collection.createdBy,
          collection.outcome,
          collection.contentRef,
          collection.body,
          collection.observedAt,
          collection.expiresAt,
        ],
      );
      // Retention has two bounds: a hard TTL and a per-workspace row cap. Both
      // are enforced on write so a busy workspace cannot grow without limit.
      await client.query('DELETE FROM zabbix_collections WHERE expires_at < now()');
      await client.query(
        `DELETE FROM zabbix_collections WHERE collection_id IN (
           SELECT collection_id FROM zabbix_collections
            WHERE workspace_id=$1 ORDER BY created_at DESC OFFSET $2
         )`,
        [collection.workspaceId, MAX_COLLECTIONS_PER_WORKSPACE],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getCollection(collectionId, workspaceIds) {
    const result = await this.#query(
      `SELECT * FROM zabbix_collections
        WHERE collection_id=$1 AND workspace_id = ANY($2::uuid[]) AND expires_at > now()`,
      [collectionId, workspaceIds],
    );
    return result.rows[0] || null;
  }

  async close() {
    await this.pool.end();
  }
}

/** Test/local-only store. Never selected unless OPSWEAVE_ALLOW_MEMORY_STORAGE=1
 *  says so explicitly; the server reports the mode in /runtime-info. */
export class MemoryStore {
  constructor() {
    this.mode = 'memory';
    this.sources = new Map();
    this.collections = new Map();
    this.audit = [];
  }

  async migrate() {}

  async listSources(workspaceIds) {
    return [...this.sources.values()]
      .filter((row) => workspaceIds.includes(row.workspace_id))
      .sort((a, b) => b.created_at - a.created_at)
      .map(sourceView);
  }

  async getSource(sourceId, workspaceIds) {
    const row = this.sources.get(sourceId);
    return row && workspaceIds.includes(row.workspace_id) ? row : null;
  }

  async createSource({ sourceId, workspaceId, createdBy, name, endpoint, credential, verifyTls, budget }) {
    for (const row of this.sources.values()) {
      if (row.workspace_id === workspaceId && row.endpoint === endpoint) throw new SourceConflictError();
    }
    const row = {
      source_id: sourceId,
      workspace_id: workspaceId,
      created_by: createdBy,
      name,
      endpoint,
      credential_kind: credential.kind,
      credential_ref: credential.ref,
      verify_tls: verifyTls,
      status: 'UNVERIFIED',
      last_probe: null,
      budget,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.sources.set(sourceId, row);
    this.audit.push({ source_id: sourceId, workspace_id: workspaceId, actor_id: createdBy, action: 'CREATE', detail: { name, endpoint } });
    return row;
  }

  async updateSource(sourceId, workspaceIds, patch, actorId) {
    const row = this.sources.get(sourceId);
    if (!row || !workspaceIds.includes(row.workspace_id)) return null;
    for (const other of this.sources.values()) {
      if (other.source_id !== sourceId && other.workspace_id === row.workspace_id && other.endpoint === patch.endpoint) {
        throw new SourceConflictError();
      }
    }
    const connectionChanged =
      row.endpoint !== patch.endpoint ||
      row.credential_kind !== patch.credential.kind ||
      row.credential_ref !== patch.credential.ref ||
      row.verify_tls !== patch.verifyTls;
    Object.assign(row, {
      name: patch.name,
      endpoint: patch.endpoint,
      credential_kind: patch.credential.kind,
      credential_ref: patch.credential.ref,
      verify_tls: patch.verifyTls,
      budget: patch.budget,
      ...(connectionChanged ? { status: 'UNVERIFIED', last_probe: null } : {}),
      updated_at: new Date(),
    });
    this.audit.push({ source_id: sourceId, workspace_id: row.workspace_id, actor_id: actorId, action: 'UPDATE', detail: { name: patch.name } });
    return row;
  }

  async recordProbe(sourceId, workspaceIds, outcome, status, actorId) {
    const row = this.sources.get(sourceId);
    if (!row || !workspaceIds.includes(row.workspace_id)) return null;
    row.last_probe = outcome;
    row.status = status;
    row.updated_at = new Date();
    this.audit.push({ source_id: sourceId, workspace_id: row.workspace_id, actor_id: actorId, action: 'PROBE', detail: { outcome: outcome.outcome } });
    return row;
  }

  async saveCollection(collection) {
    // Store the same snake_case row shape the PostgreSQL store returns, so the
    // attestation handler has one shape to read regardless of the backing store.
    this.collections.set(collection.collectionId, {
      collection_id: collection.collectionId,
      source_id: collection.sourceId,
      workspace_id: collection.workspaceId,
      created_by: collection.createdBy,
      outcome: collection.outcome,
      content_ref: collection.contentRef,
      body: collection.body,
      observed_at: collection.observedAt,
      expires_at: collection.expiresAt,
      created_at: new Date(),
    });
    const rows = [...this.collections.values()]
      .filter((row) => row.workspace_id === collection.workspaceId)
      .sort((a, b) => b.created_at - a.created_at);
    for (const row of rows.slice(MAX_COLLECTIONS_PER_WORKSPACE)) {
      this.collections.delete(row.collection_id);
    }
  }

  async getCollection(collectionId, workspaceIds) {
    const row = this.collections.get(collectionId);
    if (!row || !workspaceIds.includes(row.workspace_id)) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return row;
  }

  async close() {}
}

/**
 * Open the store the deployment asked for.
 *
 * With a URL, the database is contacted and migrated before the plugin starts
 * accepting traffic: starting ready while storage is unreachable would make the
 * first create fail on a healthy-looking instance. Without a URL, the only way
 * to start is the explicit test flag; otherwise this throws.
 */
export async function openStorage({ databaseUrl, allowMemory, logger = console }) {
  if (databaseUrl) {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
    });
    const store = new PostgresStore(pool);
    try {
      await store.migrate();
    } catch (error) {
      await pool.end().catch(() => {});
      throw new StorageUnavailableError(
        `the plugin database is configured but unusable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return store;
  }
  if (!allowMemory) {
    throw new Error(
      'OPSWEAVE_PLUGIN_DATABASE_URL is not set. Refusing to start with an in-memory source registry; provision the plugin storage binding or set OPSWEAVE_ALLOW_MEMORY_STORAGE=1 for a test run.',
    );
  }
  logger.warn('zabbix-source: OPSWEAVE_ALLOW_MEMORY_STORAGE=1; sources will not survive a restart');
  return new MemoryStore();
}
