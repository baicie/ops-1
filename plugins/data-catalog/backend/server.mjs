import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'opsweave.data-catalog';
const VERSION = process.env.OPSWEAVE_PLUGIN_VERSION || '0.0.1';
const CAPABILITY_DIGEST = process.env.OPSWEAVE_CAPABILITY_DIGEST || 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const BUILD_DIGEST = process.env.OPSWEAVE_BUILD_DIGEST || 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const DATABASE_URL = process.env.OPSWEAVE_PLUGIN_DATABASE_URL || '';
const CONTEXT_KEY = process.env.OPSWEAVE_CALLER_CONTEXT_KEY || '';
const PORT = Number(process.env.PORT || 8080);

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
let ready = false;
let stopping = false;
const startedAt = Date.now();

function rid(req) {
  const value = req.headers['x-opsweave-request-id'];
  return typeof value === 'string' && value.length <= 128 ? value : crypto.randomUUID();
}
function send(res, status, body, requestId) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-opsweave-request-id': requestId,
  });
  res.end(payload);
}
function fail(res, status, code, message, requestId, retryable = false, details) {
  send(res, status, { code, message, requestId, retryable, ...(details ? { details } : {}) }, requestId);
}
async function readJson(req, limit = 1024 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function digest(value) { return 'sha256:' + crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function b64url(value) { return Buffer.from(value).toString('base64url'); }
function verifyContext(token) {
  if (!token || !CONTEXT_KEY) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'oww1') return null;
  const expected = crypto.createHmac('sha256', Buffer.from(CONTEXT_KEY, 'hex')).update(parts[1]).digest('base64url');
  if (expected.length !== parts[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (claims.v !== 1 || Number(claims.expiresAt) * 1000 <= Date.now()) return null;
    return claims;
  } catch { return null; }
}
function identity(req) {
  const context = verifyContext(req.headers['x-opsweave-caller-context']);
  if (context) return { kind: 'workload', pluginId: context.pluginId, scope: Array.isArray(context.scope) ? context.scope : [], claims: context };
  const rawRole = req.headers['x-opsweave-user-role'];
  if (rawRole) {
    const role = String(rawRole).toLowerCase();
    if (role === 'admin' || role === 'operator') return { kind: 'user', role, scope: ['dataset:read', 'dataset:write'] };
    if (role === 'viewer') return { kind: 'user', role, scope: ['dataset:read'] };
    return { kind: 'user', role, scope: [] };
  }
  return null;
}
function hasScope(who, scope) { return Boolean(who && Array.isArray(who.scope) && who.scope.includes(scope)); }

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 512) throw new Error('fields must contain 1..512 entries');
  const names = new Set();
  const ordinals = new Set();
  for (const field of fields) {
    if (!field || typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field.name)) throw new Error('invalid field name');
    if (names.has(field.name)) throw new Error(`duplicate field ${field.name}`);
    names.add(field.name);
    if (!['string', 'integer', 'number', 'boolean', 'timestamp', 'json'].includes(field.type)) throw new Error(`invalid type for ${field.name}`);
    if (typeof field.nullable !== 'boolean') throw new Error(`nullable missing for ${field.name}`);
    if (!Number.isInteger(field.ordinal) || field.ordinal < 0 || field.ordinal > 1023 || ordinals.has(field.ordinal)) throw new Error(`invalid ordinal for ${field.name}`);
    ordinals.add(field.ordinal);
    if (field.semanticTags && (!Array.isArray(field.semanticTags) || field.semanticTags.length > 16)) throw new Error(`invalid semanticTags for ${field.name}`);
  }
  return fields.slice().sort((a, b) => a.ordinal - b.ordinal);
}
function schemaDigest(fields) { return digest(validateFields(fields).slice().sort((a, b) => a.name.localeCompare(b.name))); }
function compareSchemas(from, to) {
  const changes = [];
  const a = new Map(from.map((field) => [field.name, field]));
  const b = new Map(to.map((field) => [field.name, field]));
  for (const [name, field] of b) {
    const old = a.get(name);
    if (!old) changes.push({ kind: 'ADD', field: name, compatible: field.nullable === true, detail: 'added field' });
    else {
      if (old.type !== field.type) changes.push({ kind: 'TYPE_CHANGE', field: name, compatible: false, detail: `${old.type} -> ${field.type}` });
      if (old.nullable === true && field.nullable === false) changes.push({ kind: 'NULLABILITY_CHANGE', field: name, compatible: false, detail: 'nullable -> required' });
    }
  }
  for (const name of a.keys()) if (!b.has(name)) changes.push({ kind: 'REMOVE', field: name, compatible: false, detail: 'field removed' });
  return { compatible: changes.every((change) => change.compatible), changes, errors: changes.filter((change) => !change.compatible).map((change) => `${change.kind} ${change.field}`) };
}
function validateRecord(fields, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record must be an object';
  for (const field of fields) {
    const value = record[field.name];
    if (value === undefined || value === null) {
      if (!field.nullable) return `missing required field ${field.name}`;
      continue;
    }
    if (field.type === 'string' && typeof value !== 'string') return `${field.name} must be string`;
    if (field.type === 'integer' && !Number.isInteger(value)) return `${field.name} must be integer`;
    if (field.type === 'number' && typeof value !== 'number') return `${field.name} must be number`;
    if (field.type === 'boolean' && typeof value !== 'boolean') return `${field.name} must be boolean`;
    if (field.type === 'timestamp' && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) return `${field.name} must be timestamp`;
  }
  return null;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_datasets (
      dataset_id uuid PRIMARY KEY,
      name text NOT NULL UNIQUE,
      description text,
      owner_plugin_id text NOT NULL,
      schema_revision integer NOT NULL,
      schema_digest text NOT NULL,
      storage_provider text NOT NULL DEFAULT 'postgres',
      retention_policy jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS catalog_schema_revisions (
      dataset_id uuid NOT NULL REFERENCES catalog_datasets(dataset_id),
      schema_revision integer NOT NULL,
      digest text NOT NULL,
      status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
      fields jsonb NOT NULL,
      base_revision integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      PRIMARY KEY (dataset_id, schema_revision)
    );
    CREATE TABLE IF NOT EXISTS catalog_records (
      record_id uuid PRIMARY KEY,
      dataset_id uuid NOT NULL REFERENCES catalog_datasets(dataset_id),
      schema_revision integer NOT NULL,
      source_batch_key text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS catalog_receipts (
      receipt_id uuid PRIMARY KEY,
      dataset_id uuid NOT NULL,
      schema_revision integer NOT NULL,
      source_batch_key text NOT NULL,
      request_digest text NOT NULL,
      status text NOT NULL,
      accepted integer NOT NULL,
      rejected integer NOT NULL,
      unknown integer NOT NULL,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset_id, source_batch_key)
    );
    CREATE TABLE IF NOT EXISTS catalog_effect_receipts (
      receipt_id uuid PRIMARY KEY,
      effect_id text NOT NULL UNIQUE,
      request_digest text NOT NULL,
      job_id uuid NOT NULL,
      lease_id uuid NOT NULL,
      fencing_sequence bigint NOT NULL,
      pipeline_id text NOT NULL,
      pipeline_revision integer NOT NULL,
      sink_node_id text NOT NULL,
      logical_batch_id text NOT NULL,
      dataset_id uuid NOT NULL,
      schema_revision integer NOT NULL,
      source_batch_key text NOT NULL,
      status text NOT NULL,
      accepted integer NOT NULL,
      rejected integer NOT NULL,
      unknown integer NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb,
      committed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset_id, source_batch_key)
    );
    CREATE TABLE IF NOT EXISTS catalog_entity_types (
      entity_type_id uuid PRIMARY KEY,
      name text NOT NULL,
      dataset_id uuid NOT NULL REFERENCES catalog_datasets(dataset_id),
      schema_revision integer,
      primary_key_fields jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset_id, name)
    );
    CREATE TABLE IF NOT EXISTS catalog_lineage (
      lineage_id uuid PRIMARY KEY,
      dataset_id uuid NOT NULL,
      schema_revision integer NOT NULL,
      source_batch_key text NOT NULL,
      ingestion_run_id uuid,
      source jsonb NOT NULL,
      accepted integer NOT NULL,
      rejected integer NOT NULL,
      unknown integer NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  ready = true;
}

function datasetView(row) {
  return {
    datasetId: row.dataset_id, name: row.name, description: row.description || '',
    ownerPluginId: row.owner_plugin_id, schemaRevision: row.schema_revision,
    schemaDigest: row.schema_digest, storageProvider: row.storage_provider,
    retentionPolicy: row.retention_policy, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
function schemaView(row) {
  return {
    schemaRevision: row.schema_revision, digest: row.digest, status: row.status,
    fields: row.fields, createdAt: row.created_at.toISOString(),
    ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
  };
}
function receiptView(row) {
  return {
    receiptId: row.receipt_id, datasetId: row.dataset_id, schemaRevision: row.schema_revision,
    sourceBatchKey: row.source_batch_key, status: row.status, accepted: row.accepted,
    rejected: row.rejected, unknown: row.unknown, errors: row.errors,
    createdAt: row.created_at.toISOString(),
  };
}
function effectReceiptView(row) {
  return {
    receiptId: row.receipt_id,
    effectId: row.effect_id,
    requestDigest: row.request_digest,
    jobId: row.job_id,
    pipelineId: row.pipeline_id,
    pipelineRevision: row.pipeline_revision,
    sinkNodeId: row.sink_node_id,
    logicalBatchId: row.logical_batch_id,
    leaseId: row.lease_id,
    fencingSequence: Number(row.fencing_sequence),
    sourceBatchKey: row.source_batch_key,
    datasetId: row.dataset_id,
    schemaRevision: row.schema_revision,
    status: row.status,
    accepted: row.accepted,
    rejected: row.rejected,
    unknown: row.unknown,
    errors: row.errors,
    committedAt: row.committed_at.toISOString(),
  };
}
function fencedEffectId(body) {
  return 'efx:' + crypto.createHash('sha256').update(canonical({
    jobId: body.fence?.jobId, pipelineId: body.pipelineId, pipelineRevision: body.pipelineRevision,
    sinkNodeId: body.sinkNodeId, logicalBatchId: body.logicalBatchId,
  })).digest('hex');
}
function fencedRequestDigest(body) {
  return digest({
    effectId: body.effectId, pipelineId: body.pipelineId, pipelineRevision: body.pipelineRevision,
    sinkNodeId: body.sinkNodeId, logicalBatchId: body.logicalBatchId,
    schemaRevision: body.schemaRevision, sourceBatchKey: body.sourceBatchKey, records: body.records,
  });
}


async function handle(req, res) {
  const requestId = rid(req);
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/_opsweave/runtime/v1/info') return send(res, 200, { pluginId: PLUGIN_ID, version: VERSION, runtimeProtocol: 'http-json-v1', capabilityDigest: CAPABILITY_DIGEST, buildDigest: BUILD_DIGEST }, requestId);
  if (url.pathname === '/_opsweave/health/live') return send(res, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'live' }, requestId);
  if (url.pathname === '/_opsweave/health/ready') return send(res, ready && !stopping ? 200 : 503, { status: ready && !stopping ? 'ready' : 'not_ready' }, requestId);
  if (url.pathname === '/_opsweave/health/startup') return send(res, 200, { status: 'started' }, requestId);
  const who = identity(req);
  if (!who) return fail(res, 401, 'UNAUTHENTICATED', 'caller identity required', requestId);
  if (url.pathname === '/api/data-catalog/datasets' && req.method === 'GET') {
    if (!hasScope(who, 'dataset:read')) return fail(res, 403, 'FORBIDDEN', 'dataset:read required', requestId);
    const result = await pool.query('SELECT * FROM catalog_datasets ORDER BY created_at DESC LIMIT 100');
    return send(res, 200, { items: result.rows.map(datasetView), nextCursor: null }, requestId);
  }
  if (url.pathname === '/api/data-catalog/datasets' && req.method === 'POST') {
    if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
    const body = await readJson(req);
    const fields = validateFields(body.fields);
    const id = typeof body.datasetId === 'string' ? body.datasetId : crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return fail(res, 400, 'INVALID_REQUEST', 'datasetId must be a UUID', requestId);
    const digestValue = schemaDigest(fields);
    const revision = 1;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO catalog_datasets (dataset_id,name,description,owner_plugin_id,schema_revision,schema_digest,retention_policy) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, body.name, body.description || '', PLUGIN_ID, revision, digestValue, body.retentionPolicy || { mode: 'RETAIN', maxRecords: 10000, maxBytes: 16777216 }]);
      await client.query('INSERT INTO catalog_schema_revisions (dataset_id,schema_revision,digest,status,fields,published_at) VALUES ($1,$2,$3,\'PUBLISHED\',$4,now())', [id, revision, digestValue, JSON.stringify(fields)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const row = await pool.query('SELECT * FROM catalog_datasets WHERE dataset_id=$1', [id]);
    return send(res, 201, datasetView(row.rows[0]), requestId);
  }
  if (url.pathname === '/api/data-catalog/entity-types' && req.method === 'GET') {
    if (!hasScope(who, 'dataset:read')) return fail(res, 403, 'FORBIDDEN', 'dataset:read required', requestId);
    const datasetId = url.searchParams.get('datasetId');
    const rows = datasetId
      ? await pool.query('SELECT * FROM catalog_entity_types WHERE dataset_id=$1 ORDER BY created_at DESC', [datasetId])
      : await pool.query('SELECT * FROM catalog_entity_types ORDER BY created_at DESC LIMIT 100');
    return send(res, 200, rows.rows.map((row) => ({ entityTypeId: row.entity_type_id, name: row.name, datasetId: row.dataset_id, schemaRevision: row.schema_revision, primaryKeyFields: row.primary_key_fields })), requestId);
  }
  if (url.pathname === '/api/data-catalog/entity-types' && req.method === 'POST') {
    if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
    const body = await readJson(req);
    if (!body.name || !body.datasetId || !Array.isArray(body.primaryKeyFields) || !body.primaryKeyFields.length) return fail(res, 400, 'INVALID_REQUEST', 'name, datasetId and primaryKeyFields are required', requestId);
    const dataset = await pool.query('SELECT schema_revision FROM catalog_datasets WHERE dataset_id=$1', [body.datasetId]);
    if (!dataset.rows[0]) return fail(res, 404, 'DATASET_NOT_FOUND', 'dataset not found', requestId);
    const row = await pool.query('INSERT INTO catalog_entity_types (entity_type_id,name,dataset_id,schema_revision,primary_key_fields) VALUES ($1,$2,$3,$4,$5) RETURNING *', [crypto.randomUUID(), body.name, body.datasetId, body.schemaRevision || dataset.rows[0].schema_revision, JSON.stringify(body.primaryKeyFields)]);
    return send(res, 201, { entityTypeId: row.rows[0].entity_type_id, name: row.rows[0].name, datasetId: row.rows[0].dataset_id, schemaRevision: row.rows[0].schema_revision, primaryKeyFields: row.rows[0].primary_key_fields }, requestId);
  }
  const datasetMatch = url.pathname.match(/^\/api\/data-catalog\/datasets\/([0-9a-f-]{36})(?:\/(.*))?$/);
  if (datasetMatch) {
    if (!hasScope(who, 'dataset:read')) return fail(res, 403, 'FORBIDDEN', 'dataset:read required', requestId);
    const datasetId = datasetMatch[1];
    const tail = datasetMatch[2] || '';
    const dataset = await pool.query('SELECT * FROM catalog_datasets WHERE dataset_id=$1', [datasetId]);
    if (!dataset.rows[0]) return fail(res, 404, 'DATASET_NOT_FOUND', 'dataset not found', requestId);
    if (!tail && req.method === 'GET') return send(res, 200, datasetView(dataset.rows[0]), requestId);
    if (tail === 'schemas' && req.method === 'GET') {
      const rows = await pool.query('SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 ORDER BY schema_revision DESC', [datasetId]);
      return send(res, 200, rows.rows.map(schemaView), requestId);
    }
    if (tail === 'schemas/drafts' && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const body = await readJson(req);
      const fields = validateFields(body.fields);
      const base = body.baseRevision || dataset.rows[0].schema_revision;
      const previous = await pool.query('SELECT fields FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2', [datasetId, base]);
      if (!previous.rows[0]) return fail(res, 409, 'SCHEMA_BASE_NOT_FOUND', 'base revision not found', requestId);
      const diff = compareSchemas(previous.rows[0].fields, fields);
      if (!diff.compatible) return fail(res, 409, 'SCHEMA_INCOMPATIBLE', 'schema revision is incompatible', requestId, false, diff);
      const next = (await pool.query('SELECT COALESCE(max(schema_revision),0)+1 AS revision FROM catalog_schema_revisions WHERE dataset_id=$1', [datasetId])).rows[0].revision;
      const row = await pool.query('INSERT INTO catalog_schema_revisions (dataset_id,schema_revision,digest,status,fields,base_revision) VALUES ($1,$2,$3,\'DRAFT\',$4,$5) RETURNING *', [datasetId, next, schemaDigest(fields), JSON.stringify(fields), base]);
      return send(res, 201, schemaView(row.rows[0]), requestId);
    }
    const publishMatch = tail.match(/^schemas\/(\d+)\/publish$/);
    if (publishMatch && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const revision = Number(publishMatch[1]);
      const row = await pool.query('SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2', [datasetId, revision]);
      if (!row.rows[0]) return fail(res, 404, 'SCHEMA_NOT_FOUND', 'schema revision not found', requestId);
      if (row.rows[0].status !== 'DRAFT') return fail(res, 409, 'SCHEMA_REVISION_IMMUTABLE', 'only a draft can be published', requestId);
      const base = row.rows[0].base_revision;
      if (base) {
        const prev = await pool.query('SELECT fields FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2', [datasetId, base]);
        if (prev.rows[0]) {
          const diff = compareSchemas(prev.rows[0].fields, row.rows[0].fields);
          if (!diff.compatible) return fail(res, 409, 'SCHEMA_INCOMPATIBLE', 'schema revision is incompatible', requestId, false, diff);
        }
      }
      const updated = await pool.query('UPDATE catalog_schema_revisions SET status=\'PUBLISHED\', published_at=now() WHERE dataset_id=$1 AND schema_revision=$2 RETURNING *', [datasetId, revision]);
      await pool.query('UPDATE catalog_datasets SET schema_revision=$1, schema_digest=$2, updated_at=now() WHERE dataset_id=$3', [revision, updated.rows[0].digest, datasetId]);
      return send(res, 200, schemaView(updated.rows[0]), requestId);
    }
    const diffMatch = tail.match(/^schemas\/(\d+)\/diff$/);
    if (diffMatch && req.method === 'GET') {
      const revision = Number(diffMatch[1]);
      const current = await pool.query('SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2', [datasetId, revision]);
      if (!current.rows[0]) return fail(res, 404, 'SCHEMA_NOT_FOUND', 'schema revision not found', requestId);
      const against = Number(url.searchParams.get('against') || current.rows[0].base_revision || revision);
      const previous = await pool.query('SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2', [datasetId, against]);
      const diff = previous.rows[0] ? compareSchemas(previous.rows[0].fields, current.rows[0].fields) : { compatible: true, changes: [], errors: [] };
      return send(res, 200, { fromRevision: against, toRevision: revision, ...diff }, requestId);
    }
    if (tail === 'fenced-records' && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const body = await readJson(req, 8 * 1024 * 1024);
      if (!body || typeof body.effectId !== 'string' || !/^efx:[a-f0-9]{64}$/.test(body.effectId)) return fail(res, 400, 'INVALID_REQUEST', 'effectId is required', requestId);
      if (typeof body.requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.requestDigest)) return fail(res, 400, 'INVALID_REQUEST', 'requestDigest is required', requestId);
      if (fencedEffectId(body) !== body.effectId) return fail(res, 409, 'EFFECT_ID_MISMATCH', 'effectId is not the stable job/pipeline/sink/batch identity', requestId);
      if (fencedRequestDigest(body) !== body.requestDigest) return fail(res, 409, 'REQUEST_DIGEST_MISMATCH', 'requestDigest does not match the fenced batch', requestId);
      const fence = body.fence || {};
      if (typeof fence.jobId !== 'string' || typeof fence.leaseId !== 'string' || !Number.isInteger(fence.fencingSequence) || fence.fencingSequence < 1) return fail(res, 400, 'INVALID_REQUEST', 'fence jobId, leaseId and fencingSequence are required', requestId);
      if (fence.pipelineId && fence.pipelineId !== body.pipelineId) return fail(res, 409, 'FENCE_SCOPE_MISMATCH', 'fence pipeline does not match the sink', requestId);
      const existing = await pool.query('SELECT * FROM catalog_effect_receipts WHERE effect_id=$1', [body.effectId]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== body.requestDigest) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'effectId was used with different content', requestId);
        return send(res, 200, effectReceiptView(existing.rows[0]), requestId);
      }
      const schema = await pool.query("SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2 AND status='PUBLISHED'", [datasetId, body.schemaRevision]);
      if (!schema.rows[0]) return fail(res, 409, 'SCHEMA_NOT_PUBLISHED', 'target schema revision is not published', requestId);
      if (!Array.isArray(body.records) || body.records.length === 0 || body.records.length > 1000) return fail(res, 400, 'INVALID_REQUEST', 'records must contain 1..1000 entries', requestId);
      const errors = [];
      const acceptedRecords = [];
      body.records.forEach((record, index) => {
        const error = validateRecord(schema.rows[0].fields, record);
        if (error) errors.push({ recordIndex: index, code: 'VALIDATION_FAILED', message: error });
        else acceptedRecords.push(record);
      });
      // 0.0.3 uses strict all-or-nothing batch semantics. A single invalid record
      // rejects the whole batch before any record or receipt is written.
      if (errors.length > 0) {
        return fail(res, 422, 'RECORD_VALIDATION_FAILED', 'batch contains invalid records', requestId, false, { rejected: errors.length, errors });
      }
      if (acceptedRecords.length !== body.records.length) {
        return fail(res, 422, 'RECORD_VALIDATION_FAILED', 'batch validation accounting mismatch', requestId);
      }
      const status = 'COMMITTED';
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The function takes the same pipeline_jobs row lock as Claim. It is the
        // authoritative fence check and remains held until this transaction commits.
        const authority = await client.query(
          'SELECT authorized,reason,pipeline_id,pipeline_revision FROM kernel.fence_authorize_effect($1,$2,$3,$4,$5,$6)',
          [fence.jobId, fence.leaseId, fence.fencingSequence, body.sinkNodeId, datasetId, body.schemaRevision],
        );
        const allowed = authority.rows[0];
        if (!allowed || allowed.authorized !== true) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'STALE_FENCE', allowed?.reason || 'fence is not authoritative', requestId);
        }
        if (allowed.pipeline_id !== body.pipelineId || Number(allowed.pipeline_revision) !== body.pipelineRevision) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'FENCE_SCOPE_MISMATCH', 'fence pipeline revision does not match', requestId);
        }
        const receiptId = crypto.randomUUID();
        const receipt = await client.query(
          `INSERT INTO catalog_effect_receipts
            (receipt_id,effect_id,request_digest,job_id,lease_id,fencing_sequence,pipeline_id,pipeline_revision,sink_node_id,logical_batch_id,dataset_id,schema_revision,source_batch_key,status,accepted,rejected,unknown,errors)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17) RETURNING *`,
          [receiptId, body.effectId, body.requestDigest, fence.jobId, fence.leaseId, fence.fencingSequence,
           body.pipelineId, body.pipelineRevision, body.sinkNodeId, body.logicalBatchId, datasetId,
           body.schemaRevision, body.sourceBatchKey, status, acceptedRecords.length, errors.length, JSON.stringify(errors)],
        );
        for (const record of acceptedRecords) {
          await client.query('INSERT INTO catalog_records (record_id,dataset_id,schema_revision,source_batch_key,payload) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey, JSON.stringify(record)]);
        }
        await client.query('INSERT INTO catalog_lineage (lineage_id,dataset_id,schema_revision,source_batch_key,ingestion_run_id,source,accepted,rejected,unknown) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)', [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey, body.jobId || null, JSON.stringify(body.source || {}), acceptedRecords.length, errors.length]);
        await client.query('COMMIT');
        return send(res, 201, effectReceiptView(receipt.rows[0]), requestId);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {
          const raced = await pool.query('SELECT * FROM catalog_effect_receipts WHERE effect_id=$1', [body.effectId]);
          if (raced.rows[0] && raced.rows[0].request_digest === body.requestDigest) return send(res, 200, effectReceiptView(raced.rows[0]), requestId);
          return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'effectId already exists', requestId);
        }
        throw error;
      } finally { client.release(); }
    }
    if (tail === 'effect-receipts' && req.method === 'GET') {
      if (!hasScope(who, 'dataset:read')) return fail(res, 403, 'FORBIDDEN', 'dataset:read required', requestId);
      const effectId = url.searchParams.get('effectId');
      if (!effectId) return fail(res, 400, 'INVALID_REQUEST', 'effectId is required', requestId);
      const row = await pool.query('SELECT * FROM catalog_effect_receipts WHERE effect_id=$1 AND dataset_id=$2', [effectId, datasetId]);
      if (!row.rows[0]) return fail(res, 404, 'RECEIPT_NOT_FOUND', 'no effect receipt', requestId);
      return send(res, 200, effectReceiptView(row.rows[0]), requestId);
    }
    if (tail === 'records' && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const body = await readJson(req, 8 * 1024 * 1024);
      if (!Number.isInteger(body.schemaRevision) || body.schemaRevision < 1 || typeof body.sourceBatchKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(body.sourceBatchKey) || !Array.isArray(body.records) || body.records.length === 0 || body.records.length > 1000) return fail(res, 400, 'INVALID_REQUEST', 'invalid records batch', requestId);
      const schema = await pool.query('SELECT * FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2 AND status=\'PUBLISHED\'', [datasetId, body.schemaRevision]);
      if (!schema.rows[0]) return fail(res, 409, 'SCHEMA_NOT_PUBLISHED', 'target schema revision is not published', requestId);
      const requestDigest = digest({ schemaRevision: body.schemaRevision, sourceBatchKey: body.sourceBatchKey, source: body.source, records: body.records });
      const existing = await pool.query('SELECT * FROM catalog_receipts WHERE dataset_id=$1 AND source_batch_key=$2', [datasetId, body.sourceBatchKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== requestDigest) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'sourceBatchKey was used with different content', requestId);
        return send(res, 200, receiptView(existing.rows[0]), requestId);
      }
      const errors = [];
      const acceptedRecords = [];
      body.records.forEach((record, index) => {
        const error = validateRecord(schema.rows[0].fields, record);
        if (error) errors.push({ recordIndex: index, code: 'VALIDATION_FAILED', message: error });
        else acceptedRecords.push(record);
      });
      const status = acceptedRecords.length === 0 ? 'REJECTED' : errors.length ? 'PARTIAL' : 'ACCEPTED';
      const receiptId = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const receipt = await client.query('INSERT INTO catalog_receipts (receipt_id,dataset_id,schema_revision,source_batch_key,request_digest,status,accepted,rejected,unknown,errors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9) RETURNING *', [receiptId, datasetId, body.schemaRevision, body.sourceBatchKey, requestDigest, status, acceptedRecords.length, errors.length, JSON.stringify(errors)]);
        for (const record of acceptedRecords) await client.query('INSERT INTO catalog_records (record_id,dataset_id,schema_revision,source_batch_key,payload) VALUES ($1,$2,$3,$4,$5)', [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey, JSON.stringify(record)]);
        await client.query('INSERT INTO catalog_lineage (lineage_id,dataset_id,schema_revision,source_batch_key,ingestion_run_id,source,accepted,rejected,unknown) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)', [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey, body.ingestionRunId || null, JSON.stringify(body.source || {}), acceptedRecords.length, errors.length]);
        await client.query('COMMIT');
        return send(res, 201, receiptView(receipt.rows[0]), requestId);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {
          const raced = await pool.query('SELECT * FROM catalog_receipts WHERE dataset_id=$1 AND source_batch_key=$2', [datasetId, body.sourceBatchKey]);
          if (raced.rows[0] && raced.rows[0].request_digest === requestDigest) return send(res, 200, receiptView(raced.rows[0]), requestId);
          return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'sourceBatchKey already exists', requestId);
        }
        throw error;
      } finally { client.release(); }
    }
    if (tail === 'records' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
      const rows = await pool.query('SELECT record_id,payload,created_at FROM catalog_records WHERE dataset_id=$1 ORDER BY created_at DESC LIMIT $2', [datasetId, limit]);
      return send(res, 200, { items: rows.rows.map((row) => ({ recordId: row.record_id, ...row.payload })), nextCursor: null }, requestId);
    }
    if (tail === 'lineage' && req.method === 'GET') {
      const rows = await pool.query('SELECT * FROM catalog_lineage WHERE dataset_id=$1 ORDER BY occurred_at DESC LIMIT 100', [datasetId]);
      return send(res, 200, rows.rows.map((row) => ({ lineageId: row.lineage_id, dataset: { datasetId: row.dataset_id, schemaRevision: row.schema_revision }, source: row.source, sourceBatchKey: row.source_batch_key, ingestionRunId: row.ingestion_run_id, accepted: row.accepted, rejected: row.rejected, unknown: row.unknown, occurredAt: row.occurred_at.toISOString() })), requestId);
    }
  }
  return fail(res, 404, 'NOT_FOUND', 'route not found', requestId);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const requestId = rid(req);
    const status = error.status || 500;
    fail(res, status, status === 400 ? 'INVALID_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL', status >= 500 ? 'internal catalog error' : error.message, requestId);
  });
});
server.on('SIGTERM', () => { stopping = true; server.close(() => pool.end().then(() => process.exit(0))); });
initDb().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`data-catalog ${VERSION} listening ${PORT}`))).catch((error) => { console.error(error); process.exit(1); });
