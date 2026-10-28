import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { normalizeRuleInput, ruleSetDigest, evaluateRules, QUALITY_RULE_TYPES } from './quality.mjs';

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
function validateRuleFields(config, fields) {
  const available = new Set(fields.map((field) => field.name));
  const names = config.fields || (config.field ? [config.field] : []);
  for (const name of names) if (!available.has(name)) throw new Error(`rule field ${name} is not in the published schema`);
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
    const own = Object.prototype.hasOwnProperty.call(record, field.name);
    const value = own ? record[field.name] : undefined;
    if (!own || value === undefined || value === null) {
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
    CREATE INDEX IF NOT EXISTS catalog_records_dataset_revision_idx ON catalog_records (dataset_id, schema_revision, record_id);
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
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS pipeline_id text;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS pipeline_revision integer;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS job_id uuid;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS attempt integer;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS fencing_sequence bigint;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS effect_id text;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS receipt_id uuid;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS source_identity text;
    ALTER TABLE catalog_lineage ADD COLUMN IF NOT EXISTS metadata_status text NOT NULL DEFAULT 'NOT_CAPTURED';
    CREATE INDEX IF NOT EXISTS catalog_lineage_page_idx ON catalog_lineage (dataset_id, occurred_at DESC, lineage_id DESC);
    CREATE INDEX IF NOT EXISTS catalog_lineage_job_idx ON catalog_lineage (job_id);
    CREATE TABLE IF NOT EXISTS catalog_quality_rules (
      rule_id uuid PRIMARY KEY,
      dataset_id uuid NOT NULL REFERENCES catalog_datasets(dataset_id),
      schema_revision integer NOT NULL,
      rule_type text NOT NULL,
      config jsonb NOT NULL,
      severity text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS catalog_quality_rules_dataset_idx ON catalog_quality_rules (dataset_id, schema_revision, enabled);
    CREATE TABLE IF NOT EXISTS catalog_quality_runs (
      run_id uuid PRIMARY KEY,
      dataset_id uuid NOT NULL REFERENCES catalog_datasets(dataset_id),
      schema_revision integer NOT NULL,
      status text NOT NULL CHECK (status IN ('PENDING','RUNNING','PASSED','FAILED','ERROR','CANCELLED')),
      idempotency_key text NOT NULL,
      rule_set jsonb NOT NULL,
      rule_set_digest text NOT NULL,
      request_digest text,
      records_examined integer NOT NULL DEFAULT 0,
      records_failed integer NOT NULL DEFAULT 0,
      failed_rule_count integer NOT NULL DEFAULT 0,
      error_code text,
      created_by text,
      fencing_token bigint NOT NULL DEFAULT 0,
      attempt integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_expires_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (dataset_id, idempotency_key)
    );
    ALTER TABLE catalog_quality_runs ADD COLUMN IF NOT EXISTS request_digest text;
    ALTER TABLE catalog_quality_runs ADD COLUMN IF NOT EXISTS failed_rule_count integer NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS catalog_quality_runs_dataset_idx ON catalog_quality_runs (dataset_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS catalog_quality_runs_claim_idx ON catalog_quality_runs (status, created_at);
    CREATE TABLE IF NOT EXISTS catalog_quality_results (
      result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES catalog_quality_runs(run_id),
      rule_id uuid NOT NULL,
      rule_version integer NOT NULL,
      status text NOT NULL,
      examined integer NOT NULL,
      failed integer NOT NULL,
      summary jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS catalog_quality_results_run_rule_idx ON catalog_quality_results (run_id, rule_id);
    CREATE INDEX IF NOT EXISTS catalog_quality_results_run_idx ON catalog_quality_results (run_id);
  `);
  ready = true;
}

function publicSourceSummary(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const allowed = ['pluginId', 'sourceId', 'sourceRevision', 'type', 'format'];
  const result = {};
  for (const key of allowed) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 128 && !/[\r\n]/.test(value)) result[key] = value;
    else if (Number.isInteger(value) && value >= 0) result[key] = value;
  }
  return result;
}

function safeSourceIdentity(source, fallback) {
  const raw = source && (source.identity || source.url);
  if (typeof raw !== 'string' || !raw.trim()) return String(fallback || 'unknown').slice(0, 128);
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 128);
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/\/[^/@]*@/, '//').slice(0, 128);
  }
}

function lineageView(row) {
  return {
    lineageId: row.lineage_id,
    dataset: { datasetId: row.dataset_id, schemaRevision: row.schema_revision },
    source: publicSourceSummary(row.source),
    sourceIdentity: row.source_identity || null,
    sourceBatchKey: row.source_batch_key,
    ingestionRunId: row.ingestion_run_id,
    pipeline: row.pipeline_id ? { pipelineId: row.pipeline_id, revision: row.pipeline_revision } : null,
    job: row.job_id ? { jobId: row.job_id, attempt: row.attempt } : null,
    fencingSequence: row.fencing_sequence ? Number(row.fencing_sequence) : null,
    effectId: row.effect_id || null,
    receiptId: row.receipt_id || null,
    accepted: row.accepted, rejected: row.rejected, unknown: row.unknown,
    metadataStatus: row.metadata_status,
    occurredAt: row.occurred_at.toISOString(),
  };
}

const LINEAGE_CURSOR_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function lineageFilterFingerprint(filters) {
  return crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0, 16);
}
function encodeLineageCursor(row, filters) {
  return Buffer.from(JSON.stringify({
    v: LINEAGE_CURSOR_VERSION,
    occurredAt: new Date(row.occurred_at).toISOString(),
    lineageId: row.lineage_id,
    filters: lineageFilterFingerprint(filters),
  }), 'utf8').toString('base64url');
}
function decodeLineageCursor(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.v !== LINEAGE_CURSOR_VERSION) return null;
    if (typeof parsed.occurredAt !== 'string' || Number.isNaN(new Date(parsed.occurredAt).getTime())) return null;
    if (typeof parsed.lineageId !== 'string' || !UUID_RE.test(parsed.lineageId)) return null;
    if (typeof parsed.filters !== 'string' || !/^[a-f0-9]{16}$/.test(parsed.filters)) return null;
    if (Object.keys(parsed).sort().join(',') !== 'filters,lineageId,occurredAt,v') return null;
    return parsed;
  } catch { return null; }
}

function qualityRuleView(row) {
  return { ruleId: row.rule_id, datasetId: row.dataset_id, schemaRevision: row.schema_revision,
    ruleType: row.rule_type, config: row.config, severity: row.severity, enabled: row.enabled,
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function qualityRunView(row, results) {
  return { runId: row.run_id, datasetId: row.dataset_id, schemaRevision: row.schema_revision,
    status: row.status, ruleSetDigest: row.rule_set_digest, recordsExamined: row.records_examined,
    recordsFailed: row.records_failed, ruleFailureCount: (results || []).reduce((total, result) => total + Number(result.failed || 0), 0), failedRuleCount: results && results.length ? results.filter((result) => result.status === 'FAILED').length : Number(row.failed_rule_count || 0), errorCode: row.error_code, attempt: row.attempt,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(), results: results || [] };
}
function qualityResultView(row) {
  return { ruleId: row.rule_id, ruleVersion: row.rule_version, status: row.status,
    examined: row.examined, failed: row.failed, summary: row.summary,
    aggregateFailed: Boolean(row.summary && row.summary.aggregateFailed) };
}

async function markQualityError(runId, owner, token, code) {
  await pool.query("UPDATE catalog_quality_runs SET status='ERROR', error_code=$2, completed_at=now(), updated_at=now() WHERE run_id=$1 AND status='RUNNING' AND lease_owner=$3 AND fencing_token=$4", [runId, code, owner, token]);
}

async function executeQualityRun(runId) {
  const owner = crypto.randomUUID();
  const claim = await pool.query(
    `UPDATE catalog_quality_runs SET status='RUNNING', lease_owner=$2,
       lease_expires_at=now()+interval '5 minutes', fencing_token=fencing_token+1,
       attempt=attempt+1, started_at=COALESCE(started_at,now()), updated_at=now()
     WHERE run_id=$1 AND status='PENDING' AND (lease_expires_at IS NULL OR lease_expires_at < now())
     RETURNING *`, [runId, owner]);
  const run = claim.rows[0];
  if (!run) return;
  const token = Number(run.fencing_token);
  let client;
  let leaseTimer;
  let inTransaction = false;
  try {
    const rules = Array.isArray(run.rule_set) ? run.rule_set : [];
    const maxRecords = 10000;
    client = await pool.connect();
    let leaseLost = false;
    leaseTimer = setInterval(() => {
      pool.query("UPDATE catalog_quality_runs SET lease_expires_at=now()+interval '5 minutes', updated_at=now() WHERE run_id=$1 AND status='RUNNING' AND lease_owner=$2 AND fencing_token=$3", [runId, owner, token])
        .then((renewed) => { if (renewed.rowCount === 0) leaseLost = true; })
        .catch(async () => {
          // A transient connection error is not proof that the lease was lost.
          try {
            const check = await pool.query("SELECT status,lease_owner,fencing_token,lease_expires_at > now() AS lease_valid FROM catalog_quality_runs WHERE run_id=$1", [runId]);
            const row = check.rows[0];
            if (!row || row.status !== 'RUNNING' || row.lease_owner !== owner || Number(row.fencing_token) !== token || row.lease_valid !== true) leaseLost = true;
          } catch { /* completion transaction will make the final DB-authoritative decision */ }
        });
    }, 15000);
    leaseTimer.unref();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;
    await client.query("SET LOCAL statement_timeout = '30s'");
    const rows = await client.query('SELECT payload FROM catalog_records WHERE dataset_id=$1 AND schema_revision=$2 ORDER BY record_id LIMIT $3', [run.dataset_id, run.schema_revision, maxRecords + 1]);
    await client.query('COMMIT');
    inTransaction = false;
    if (leaseLost) {
      await markQualityError(runId, owner, token, 'LEASE_LOST');
      return;
    }
    if (rows.rows.length > maxRecords) {
      await markQualityError(runId, owner, token, 'SCAN_LIMIT_EXCEEDED');
      return;
    }
    const records = rows.rows.map((row) => row.payload);
    // Test-only delay used by the isolated reliability harness to make a
    // RUNNING window observable under real process fault injection.
    const testDelay = Number(process.env.OPSWEAVE_QUALITY_TEST_DELAY_MS || 0);
    if (Number.isFinite(testDelay) && testDelay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 30000)));
    const evaluation = evaluateRules(rules, records);
    const write = await pool.connect();
    try {
      await write.query('BEGIN');
      await write.query("SET LOCAL lock_timeout = '2s'");
      await write.query("SET LOCAL statement_timeout = '10s'");
      const current = await write.query("SELECT status,fencing_token,lease_owner,lease_expires_at > now() AS lease_valid FROM catalog_quality_runs WHERE run_id=$1 FOR UPDATE", [runId]);
      const currentRun = current.rows[0];
      if (!currentRun || currentRun.status !== 'RUNNING' || Number(currentRun.fencing_token) !== token
        || currentRun.lease_owner !== owner || currentRun.lease_valid !== true) {
        await write.query('ROLLBACK');
        return;
      }
      for (const item of evaluation.results) {
        const result = item.result;
        await write.query(
          `INSERT INTO catalog_quality_results (run_id,rule_id,rule_version,status,examined,failed,summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [runId, item.rule.ruleId, item.rule.version, result.status, result.examined, result.failed, JSON.stringify(result.summary)],
        );
      }
      const finalized = await write.query(
        `UPDATE catalog_quality_runs SET status=$2, completed_at=now(), updated_at=now(),
           records_examined=$3, records_failed=$4, failed_rule_count=$5, lease_expires_at=NULL
         WHERE run_id=$1 AND status='RUNNING' AND fencing_token=$6 AND lease_owner=$7 AND lease_expires_at > now()
         RETURNING run_id`,
        [runId, evaluation.status, records.length, evaluation.recordsFailed || 0, evaluation.failedRules || 0, token, owner],
      );
      if (finalized.rowCount !== 1) { await write.query('ROLLBACK'); return; }
      await write.query('COMMIT');
    } catch (error) {
      await write.query('ROLLBACK');
      throw error;
    } finally { write.release(); }
  } catch (error) {
    if (client && inTransaction) await client.query('ROLLBACK').catch(() => {});
    const code = error && error.code === '57014' ? 'RUN_TIMEOUT' : 'RUNNER_ERROR';
    await markQualityError(runId, owner, token, code).catch(() => {});
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    if (client) client.release();
  }
}

const qualityActive = new Set();
async function dispatchQualityRuns() {
  if (qualityActive.size >= 4) return;
  const pending = await pool.query("SELECT run_id FROM catalog_quality_runs WHERE status='PENDING' ORDER BY created_at LIMIT $1", [4 - qualityActive.size]);
  for (const row of pending.rows) {
    if (qualityActive.has(row.run_id)) continue;
    qualityActive.add(row.run_id);
    setImmediate(() => {
      executeQualityRun(row.run_id).catch(() => {}).finally(() => {
        qualityActive.delete(row.run_id);
        setImmediate(() => { dispatchQualityRuns().catch(() => {}); });
      });
    });
  }
}

let maintenanceRunning = false;
async function recoverExpiredQualityRuns() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("UPDATE catalog_quality_runs SET status='ERROR', error_code='INTERRUPTED', completed_at=now(), updated_at=now() WHERE status='RUNNING' AND lease_expires_at < now()");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function scheduleQualityMaintenance() {
  setTimeout(async () => {
    if (!maintenanceRunning) {
      maintenanceRunning = true;
      try { await recoverExpiredQualityRuns(); await dispatchQualityRuns(); }
      catch (error) { console.error('quality dispatcher error', error); }
      finally { maintenanceRunning = false; }
    }
    scheduleQualityMaintenance();
  }, 5000).unref();
}

async function recoverQualityRuns() {
  await recoverExpiredQualityRuns();
  await dispatchQualityRuns();
  scheduleQualityMaintenance();
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
  if (url.pathname === '/api/data-catalog/governance-summary' && req.method === 'GET') {
    if (!who) return fail(res, 401, 'UNAUTHENTICATED', 'authentication required', requestId);
    if (!hasScope(who, 'dataset:read')) return fail(res, 403, 'FORBIDDEN', 'dataset:read required', requestId);
    const counts = await pool.query(`
      WITH latest_overall AS (
        SELECT DISTINCT ON (r.dataset_id) r.dataset_id,r.status,r.created_at,r.run_id
        FROM catalog_quality_runs r ORDER BY r.dataset_id, r.created_at DESC, r.run_id DESC
      ), latest_terminal AS (
        SELECT DISTINCT ON (r.dataset_id) r.dataset_id,r.status,r.created_at,r.completed_at,r.error_code,r.run_id
        FROM catalog_quality_runs r
        WHERE r.status IN ('PASSED','FAILED','ERROR')
        ORDER BY r.dataset_id, COALESCE(r.completed_at,r.created_at) DESC, r.run_id DESC
      )
      SELECT (SELECT count(*)::int FROM catalog_datasets) AS dataset_count,
             (SELECT count(*)::int FROM latest_overall) AS datasets_with_runs,
             (SELECT count(*)::int FROM latest_terminal WHERE status='PASSED') AS passed,
             (SELECT count(*)::int FROM latest_terminal WHERE status='FAILED') AS failed,
             (SELECT count(*)::int FROM latest_terminal WHERE status='ERROR') AS errored,
             (SELECT count(*)::int FROM latest_overall WHERE status IN ('PENDING','RUNNING')) AS pending,
             (SELECT count(*)::int FROM latest_overall WHERE status='CANCELLED') AS cancelled,
             (SELECT count(*)::int FROM catalog_lineage WHERE occurred_at > now() - interval '24 hours') AS lineage_window_count
    `);
    const failures = await pool.query(`
      WITH latest_terminal AS (
        SELECT DISTINCT ON (r.dataset_id) r.dataset_id,r.status,r.created_at,r.completed_at,r.error_code,r.run_id
        FROM catalog_quality_runs r
        WHERE r.status IN ('PASSED','FAILED','ERROR')
        ORDER BY r.dataset_id, COALESCE(r.completed_at,r.created_at) DESC, r.run_id DESC
      )
      SELECT l.run_id,l.dataset_id,d.name AS dataset_name,l.status,l.created_at,l.completed_at,l.error_code
      FROM latest_terminal l JOIN catalog_datasets d ON d.dataset_id=l.dataset_id
      WHERE l.status IN ('FAILED','ERROR') ORDER BY COALESCE(l.completed_at,l.created_at) DESC LIMIT 8
    `);
    const row = counts.rows[0];
    return send(res, 200, {
      datasetCount: row.dataset_count,
      datasetsWithQualityRuns: row.datasets_with_runs,
      latestQuality: { passed: row.passed, failed: row.failed, error: row.errored, pending: row.pending, cancelled: row.cancelled, unknown: row.dataset_count - row.datasets_with_runs },
      lineageWindowCount: row.lineage_window_count,
      lineageWindow: '24h',
      recentFailures: failures.rows.map((failure) => ({ runId: failure.run_id, datasetId: failure.dataset_id, datasetName: failure.dataset_name, status: failure.status, createdAt: failure.created_at.toISOString(), completedAt: failure.completed_at ? failure.completed_at.toISOString() : null, errorCode: failure.error_code })),
    }, requestId);
  }
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
        await client.query(
          `INSERT INTO catalog_lineage
            (lineage_id,dataset_id,schema_revision,source_batch_key,ingestion_run_id,source,
             accepted,rejected,unknown,pipeline_id,pipeline_revision,job_id,fencing_sequence,
             effect_id,receipt_id,source_identity,metadata_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,'AVAILABLE')`,
          [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey, body.ingestionRunId || null,
           JSON.stringify(body.source || {}), acceptedRecords.length, errors.length,
           body.pipelineId, body.pipelineRevision, fence.jobId, fence.fencingSequence,
           body.effectId, receiptId, safeSourceIdentity(body.source, body.sourceBatchKey)],
        );
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
        await client.query(
          `INSERT INTO catalog_lineage
            (lineage_id,dataset_id,schema_revision,source_batch_key,ingestion_run_id,source,
             accepted,rejected,unknown,source_identity,metadata_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'PARTIAL')`,
          [crypto.randomUUID(), datasetId, body.schemaRevision, body.sourceBatchKey,
           body.ingestionRunId || null, JSON.stringify(body.source || {}), acceptedRecords.length,
           errors.length, safeSourceIdentity(body.source, body.sourceBatchKey)],
        );
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
    if (tail === 'quality-rules' && req.method === 'GET') {
      const revision = url.searchParams.get('schemaRevision');
      const params = [datasetId];
      let sql = 'SELECT * FROM catalog_quality_rules WHERE dataset_id=$1';
      if (revision) { const parsed = Number(revision); if (!Number.isInteger(parsed) || parsed < 1) return fail(res, 400, 'INVALID_REQUEST', 'schemaRevision invalid', requestId); params.push(parsed); sql += ' AND schema_revision=$2'; }
      sql += ' ORDER BY created_at DESC LIMIT 200';
      const rows = await pool.query(sql, params);
      return send(res, 200, { items: rows.rows.map(qualityRuleView) }, requestId);
    }
    if (tail === 'quality-rules' && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const body = await readJson(req);
      let input;
      try { input = normalizeRuleInput(body); } catch (error) { return fail(res, 400, 'INVALID_RULE', error.message, requestId); }
      if (input.ruleType === 'RECORD_COUNT' && input.config.max > 10000) return fail(res, 400, 'INVALID_RULE', 'RECORD_COUNT max is bounded by the 10000 scan budget', requestId);
      const revision = body.schemaRevision === undefined ? dataset.rows[0].schema_revision : Number(body.schemaRevision);
      if (!Number.isInteger(revision) || revision < 1) return fail(res, 400, 'INVALID_REQUEST', 'schemaRevision invalid', requestId);
      const schema = await pool.query("SELECT fields FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2 AND status='PUBLISHED'", [datasetId, revision]);
      if (!schema.rows[0]) return fail(res, 409, 'SCHEMA_NOT_PUBLISHED', 'schema revision is not published', requestId);
      try { validateRuleFields(input.config, schema.rows[0].fields); } catch (error) { return fail(res, 400, 'INVALID_RULE', error.message, requestId); }
      const enabledCount = await pool.query('SELECT count(*)::int AS count FROM catalog_quality_rules WHERE dataset_id=$1 AND schema_revision=$2 AND enabled=true', [datasetId, revision]);
      if (enabledCount.rows[0].count >= 100) return fail(res, 400, 'RULE_LIMIT_EXCEEDED', 'at most 100 enabled rules', requestId);
      const row = await pool.query(
        `INSERT INTO catalog_quality_rules (rule_id,dataset_id,schema_revision,rule_type,config,severity,enabled,version,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8) RETURNING *`,
        [crypto.randomUUID(), datasetId, revision, input.ruleType, JSON.stringify(input.config), input.severity, input.enabled, who.role || who.pluginId || 'unknown'],
      );
      return send(res, 201, qualityRuleView(row.rows[0]), requestId);
    }
    const ruleMatch = tail.match(/^quality-rules\/([0-9a-f-]{36})$/);
    if (ruleMatch) {
      const ruleId = ruleMatch[1];
      if (req.method === 'GET') {
        const row = await pool.query('SELECT * FROM catalog_quality_rules WHERE dataset_id=$1 AND rule_id=$2', [datasetId, ruleId]);
        if (!row.rows[0]) return fail(res, 404, 'RULE_NOT_FOUND', 'quality rule not found', requestId);
        return send(res, 200, qualityRuleView(row.rows[0]), requestId);
      }
      if (req.method === 'POST') {
        if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
        const body = await readJson(req);
        if (!Number.isInteger(body.version) || body.version < 1) return fail(res, 400, 'INVALID_REQUEST', 'version is required', requestId);
        let input;
        try { input = normalizeRuleInput(body); } catch (error) { return fail(res, 400, 'INVALID_RULE', error.message, requestId); }
        if (input.ruleType === 'RECORD_COUNT' && input.config.max > 10000) return fail(res, 400, 'INVALID_RULE', 'RECORD_COUNT max is bounded by the 10000 scan budget', requestId);
        const existingRule = await pool.query('SELECT schema_revision FROM catalog_quality_rules WHERE dataset_id=$1 AND rule_id=$2', [datasetId, ruleId]);
        if (!existingRule.rows[0]) return fail(res, 404, 'RULE_NOT_FOUND', 'quality rule not found', requestId);
        const schemaForRule = await pool.query('SELECT fields FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2 AND status=\'PUBLISHED\'', [datasetId, existingRule.rows[0].schema_revision]);
        if (!schemaForRule.rows[0]) return fail(res, 409, 'SCHEMA_NOT_PUBLISHED', 'rule schema is not published', requestId);
        try { validateRuleFields(input.config, schemaForRule.rows[0].fields); } catch (error) { return fail(res, 400, 'INVALID_RULE', error.message, requestId); }
        const updated = await pool.query(
          `UPDATE catalog_quality_rules SET rule_type=$3,config=$4,severity=$5,enabled=$6,version=version+1,updated_at=now()
           WHERE dataset_id=$1 AND rule_id=$2 AND version=$7 RETURNING *`,
          [datasetId, ruleId, input.ruleType, JSON.stringify(input.config), input.severity, input.enabled, body.version],
        );
        if (!updated.rows[0]) {
          const exists = await pool.query('SELECT version FROM catalog_quality_rules WHERE dataset_id=$1 AND rule_id=$2', [datasetId, ruleId]);
          if (!exists.rows[0]) return fail(res, 404, 'RULE_NOT_FOUND', 'quality rule not found', requestId);
          return fail(res, 409, 'VERSION_CONFLICT', 'quality rule version conflict', requestId);
        }
        return send(res, 200, qualityRuleView(updated.rows[0]), requestId);
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed', requestId);
    }
    if (tail === 'quality-runs' && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const body = await readJson(req);
      const key = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
      if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) return fail(res, 400, 'INVALID_REQUEST', 'idempotency-key is required', requestId);
      const revision = body.schemaRevision === undefined ? dataset.rows[0].schema_revision : Number(body.schemaRevision);
      if (!Number.isInteger(revision) || revision < 1) return fail(res, 400, 'INVALID_REQUEST', 'schemaRevision invalid', requestId);
      const existing = await pool.query('SELECT * FROM catalog_quality_runs WHERE dataset_id=$1 AND idempotency_key=$2', [datasetId, key]);
      if (existing.rows[0]) {
        const current = existing.rows[0];
        if (body.schemaRevision !== undefined && Number(body.schemaRevision) !== current.schema_revision) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'idempotency key is bound to a different schema revision', requestId);
        const rulesForDigest = await pool.query('SELECT * FROM catalog_quality_rules WHERE dataset_id=$1 AND schema_revision=$2 AND enabled=true ORDER BY rule_id LIMIT 101', [datasetId, current.schema_revision]);
        const currentSnapshot = rulesForDigest.rows.map((rule) => ({ ruleId: rule.rule_id, version: rule.version, ruleType: rule.rule_type, config: rule.config, severity: rule.severity }));
        const currentDigest = digest({ schemaRevision: current.schema_revision, ruleSetDigest: ruleSetDigest(currentSnapshot) });
        if (current.request_digest ? current.request_digest !== currentDigest : current.rule_set_digest !== ruleSetDigest(currentSnapshot)) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was reused with different rule semantics', requestId);
        return send(res, 200, qualityRunView(current, []), requestId);
      }
      const schema = await pool.query("SELECT 1 FROM catalog_schema_revisions WHERE dataset_id=$1 AND schema_revision=$2 AND status='PUBLISHED'", [datasetId, revision]);
      if (!schema.rows[0]) return fail(res, 409, 'SCHEMA_NOT_PUBLISHED', 'schema revision is not published', requestId);
      const rules = await pool.query('SELECT * FROM catalog_quality_rules WHERE dataset_id=$1 AND schema_revision=$2 AND enabled=true ORDER BY rule_id LIMIT 101', [datasetId, revision]);
      if (rules.rows.length === 0) return fail(res, 409, 'NO_ENABLED_RULES', 'dataset has no enabled quality rules', requestId);
      if (rules.rows.length > 100) return fail(res, 400, 'RULE_LIMIT_EXCEEDED', 'at most 100 enabled rules', requestId);
      const snapshot = rules.rows.map((rule) => ({ ruleId: rule.rule_id, version: rule.version, ruleType: rule.rule_type, config: rule.config, severity: rule.severity }));
      const ruleDigest = ruleSetDigest(snapshot);
      const requestDigest = digest({ schemaRevision: revision, ruleSetDigest: ruleDigest });
      const runId = crypto.randomUUID();
      let inserted;
      try {
        inserted = await pool.query(
          `INSERT INTO catalog_quality_runs (run_id,dataset_id,schema_revision,status,idempotency_key,rule_set,rule_set_digest,request_digest,created_by)
           VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8) RETURNING *`,
          [runId, datasetId, revision, key, JSON.stringify(snapshot), ruleDigest, requestDigest, who.role || who.pluginId || 'unknown'],
        );
      } catch (error) {
        if (error.code === '23505') {
          const raced = await pool.query('SELECT * FROM catalog_quality_runs WHERE dataset_id=$1 AND idempotency_key=$2', [datasetId, key]);
          if (raced.rows[0]) {
            if (raced.rows[0].request_digest && raced.rows[0].request_digest !== requestDigest) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was reused with different rule semantics', requestId);
            return send(res, 200, qualityRunView(raced.rows[0], []), requestId);
          }
        }
        throw error;
      }
      setImmediate(() => { dispatchQualityRuns().catch(() => {}); });
      return send(res, 202, qualityRunView(inserted.rows[0], []), requestId);
    }
    if (tail === 'quality-runs' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(res, 400, 'INVALID_REQUEST', 'limit must be 1..100', requestId);
      const rows = await pool.query('SELECT * FROM catalog_quality_runs WHERE dataset_id=$1 ORDER BY created_at DESC LIMIT $2', [datasetId, limit]);
      return send(res, 200, { items: rows.rows.map((row) => qualityRunView(row, [])) }, requestId);
    }
    const runMatch = tail.match(/^quality-runs\/([0-9a-f-]{36})$/);
    if (runMatch && req.method === 'GET') {
      const run = await pool.query('SELECT * FROM catalog_quality_runs WHERE dataset_id=$1 AND run_id=$2', [datasetId, runMatch[1]]);
      if (!run.rows[0]) return fail(res, 404, 'RUN_NOT_FOUND', 'quality run not found', requestId);
      const results = await pool.query('SELECT * FROM catalog_quality_results WHERE run_id=$1 ORDER BY result_id', [runMatch[1]]);
      return send(res, 200, qualityRunView(run.rows[0], results.rows.map(qualityResultView)), requestId);
    }
    const cancelMatch = tail.match(/^quality-runs\/([0-9a-f-]{36})\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      if (!hasScope(who, 'dataset:write')) return fail(res, 403, 'FORBIDDEN', 'dataset:write required', requestId);
      const cancelled = await pool.query(
        `UPDATE catalog_quality_runs SET status='CANCELLED', completed_at=now(), updated_at=now(), fencing_token=fencing_token+1, lease_expires_at=NULL
         WHERE dataset_id=$1 AND run_id=$2 AND status IN ('PENDING','RUNNING') RETURNING *`,
        [datasetId, cancelMatch[1]],
      );
      if (!cancelled.rows[0]) {
        const exists = await pool.query('SELECT status FROM catalog_quality_runs WHERE dataset_id=$1 AND run_id=$2', [datasetId, cancelMatch[1]]);
        if (!exists.rows[0]) return fail(res, 404, 'RUN_NOT_FOUND', 'quality run not found', requestId);
        return fail(res, 409, 'RUN_TERMINAL', 'run is already terminal', requestId);
      }
      return send(res, 200, qualityRunView(cancelled.rows[0], []), requestId);
    }
    if (tail === 'lineage' && req.method === 'GET') {
      const limitRaw = Number(url.searchParams.get('limit') || 50);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) return fail(res, 400, 'INVALID_REQUEST', 'limit must be 1..200', requestId);
      const cursorRaw = url.searchParams.get('cursor');
      const cursor = cursorRaw ? decodeLineageCursor(cursorRaw) : null;
      if (cursorRaw && !cursor) return fail(res, 400, 'INVALID_CURSOR', 'cursor is invalid', requestId);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const fromAt = from ? new Date(from) : null;
      const toAt = to ? new Date(to) : null;
      if ((fromAt && Number.isNaN(fromAt.getTime())) || (toAt && Number.isNaN(toAt.getTime()))) return fail(res, 400, 'INVALID_REQUEST', 'from/to must be ISO timestamps', requestId);
      const filters = { datasetId, from: fromAt ? fromAt.toISOString() : null, to: toAt ? toAt.toISOString() : null,
        pipelineId: url.searchParams.get('pipelineId') || null, jobId: url.searchParams.get('jobId') || null,
        schemaRevision: url.searchParams.get('schemaRevision') || null, sourceBatchKey: url.searchParams.get('sourceBatchKey') || null };
      if (cursor && cursor.filters !== lineageFilterFingerprint(filters)) return fail(res, 400, 'INVALID_CURSOR', 'cursor does not match filters', requestId);
      const values = [datasetId];
      const clauses = ['dataset_id=$1'];
      const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
      if (fromAt) add('occurred_at >= ?', fromAt.toISOString());
      if (toAt) add('occurred_at <= ?', toAt.toISOString());
      const pipelineId = url.searchParams.get('pipelineId');
      const jobId = url.searchParams.get('jobId');
      const schemaRevision = url.searchParams.get('schemaRevision');
      const sourceBatchKey = url.searchParams.get('sourceBatchKey');
      if (pipelineId) add('pipeline_id = ?', pipelineId);
      if (jobId) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return fail(res, 400, 'INVALID_REQUEST', 'jobId must be a UUID', requestId);
        add('job_id = ?', jobId);
      }
      if (schemaRevision) {
        const revision = Number(schemaRevision);
        if (!Number.isInteger(revision) || revision < 1) return fail(res, 400, 'INVALID_REQUEST', 'schemaRevision must be a positive integer', requestId);
        add('schema_revision = ?', revision);
      }
      if (sourceBatchKey) add('source_batch_key = ?', sourceBatchKey);
      if (cursor) {
        values.push(cursor.occurredAt, cursor.lineageId);
        clauses.push(`(occurred_at,lineage_id) < ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
      }
      values.push(limitRaw + 1);
      const rows = await pool.query(`SELECT * FROM catalog_lineage WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC,lineage_id DESC LIMIT $${values.length}`, values);
      const hasMore = rows.rows.length > limitRaw;
      const page = rows.rows.slice(0, limitRaw);
      return send(res, 200, { items: page.map(lineageView), nextCursor: hasMore ? encodeLineageCursor(page[page.length - 1], filters) : null }, requestId);
    }
    const lineageMatch = tail.match(/^lineage\/([0-9a-f-]{36})$/);
    if (lineageMatch && req.method === 'GET') {
      const row = await pool.query('SELECT * FROM catalog_lineage WHERE dataset_id=$1 AND lineage_id=$2', [datasetId, lineageMatch[1]]);
      if (!row.rows[0]) return fail(res, 404, 'LINEAGE_NOT_FOUND', 'lineage record not found', requestId);
      return send(res, 200, lineageView(row.rows[0]), requestId);
    }
  }
  return fail(res, 404, 'NOT_FOUND', 'route not found', requestId);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('catalog request failed', error);
    const requestId = rid(req);
    const status = error.status || 500;
    fail(res, status, status === 400 ? 'INVALID_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL', status >= 500 ? 'internal catalog error' : error.message, requestId);
  });
});
server.on('SIGTERM', () => { stopping = true; server.close(() => pool.end().then(() => process.exit(0))); });
initDb().then(async () => { await recoverQualityRuns(); server.listen(PORT, '0.0.0.0', () => console.log(`data-catalog ${VERSION} listening ${PORT}`)); }).catch((error) => { console.error(error); process.exit(1); });
