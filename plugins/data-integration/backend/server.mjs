import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';

const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'opsweave.data-integration';
const VERSION = process.env.OPSWEAVE_PLUGIN_VERSION || '0.0.1';
const CAPABILITY_DIGEST = process.env.OPSWEAVE_CAPABILITY_DIGEST || 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const BUILD_DIGEST = process.env.OPSWEAVE_BUILD_DIGEST || 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const DATABASE_URL = process.env.OPSWEAVE_PLUGIN_DATABASE_URL || '';
const CONTEXT_KEY = process.env.OPSWEAVE_CALLER_CONTEXT_KEY || '';
const KERNEL_URL = process.env.OPSWEAVE_KERNEL_URL || 'http://host.docker.internal:18181';
const ALLOW_LOOPBACK = process.env.OPSWEAVE_ALLOW_LOOPBACK_SOURCE === '1';
const ALLOWED_PRIVATE_HOSTS = new Set((process.env.OPSWEAVE_ALLOW_PRIVATE_SOURCE_HOSTS || '').split(',').map((value) => value.trim()).filter(Boolean));
const PORT = Number(process.env.PORT || 8080);
const MAX_BYTES = 8 * 1024 * 1024;
const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
let ready = false;
let stopping = false;

function rid(req) { const v = req.headers['x-opsweave-request-id']; return typeof v === 'string' && v.length <= 128 ? v : crypto.randomUUID(); }
function send(res, status, body, id) { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', 'x-opsweave-request-id': id }); res.end(payload); }
function fail(res, status, code, message, id, retryable = false, details) { send(res, status, { code, message, requestId: id, retryable, ...(details ? { details } : {}) }, id); }
async function readJson(req, limit = 1024 * 1024) { let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('body too large'), { status: 413 }); } if (!body) return {}; try { return JSON.parse(body); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); } }
function canonical(v) { if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; return JSON.stringify(v); }
function digest(v) { return 'sha256:' + crypto.createHash('sha256').update(canonical(v)).digest('hex'); }
function verifyContext(token) { if (!token || !CONTEXT_KEY) return null; const p = token.split('.'); if (p.length !== 3 || p[0] !== 'oww1') return null; const expected = crypto.createHmac('sha256', Buffer.from(CONTEXT_KEY, 'hex')).update(p[1]).digest('base64url'); if (expected.length !== p[2].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(p[2]))) return null; try { const c = JSON.parse(Buffer.from(p[1], 'base64url').toString()); if (c.v !== 1 || Number(c.expiresAt) * 1000 <= Date.now()) return null; return c; } catch { return null; } }
function identity(req) { const c = verifyContext(req.headers['x-opsweave-caller-context']); if (c) return { kind: 'workload', pluginId: c.pluginId, scope: c.scope || [] }; if (req.headers['x-opsweave-user-role']) { const role = String(req.headers['x-opsweave-user-role']); return { kind: 'user', role, scope: role === 'viewer' ? ['source:read'] : ['source:read', 'source:write'] }; } return null; }
function hasScope(who, scope) { return who && (who.kind === 'user' || who.scope.includes(scope)); }
function isPrivate(ip) {
  if (net.isIPv4(ip)) { const p = ip.split('.').map(Number); return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127); }
  if (net.isIPv6(ip)) { const lower = ip.toLowerCase(); if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('ff')) return true; if (lower.startsWith('::ffff:')) { const mapped = lower.slice(7); if (net.isIPv4(mapped)) return isPrivate(mapped); } return false; }
  return true;
}
async function assertUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('SOURCE_SSRF_BLOCKED: unsupported URL'), { code: 'SOURCE_SSRF_BLOCKED', status: 422 });
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length) throw Object.assign(new Error('SOURCE_DNS_FAILED'), { code: 'SOURCE_DNS_FAILED', status: 422 });
  for (const { address } of addresses) {
    const loopbackAllowed = ALLOW_LOOPBACK && (address === '127.0.0.1' || address === '::1');
    if (isPrivate(address) && !loopbackAllowed && !ALLOWED_PRIVATE_HOSTS.has(url.hostname)) throw Object.assign(new Error('SOURCE_SSRF_BLOCKED: private address'), { code: 'SOURCE_SSRF_BLOCKED', status: 422 });
  }
  return { url, addresses };
}
async function fetchJson(rawUrl, timeoutSeconds = 10, maxBytes = MAX_BYTES) {
  const { url, addresses } = await assertUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const request = client.request(url, { method: 'GET', timeout: timeoutSeconds * 1000, headers: { accept: 'application/json' }, lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, addresses[0].family === 6 ? 6 : 4) }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return finish(Object.assign(new Error('SOURCE_REDIRECT_BLOCKED'), { code: 'SOURCE_REDIRECT_BLOCKED', status: 422 })); }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { response.resume(); return finish(Object.assign(new Error(`SOURCE_HTTP_${response.statusCode || 0}`), { code: 'SOURCE_HTTP_ERROR', status: 422 })); }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { request.destroy(); finish(Object.assign(new Error('SOURCE_LIMIT_EXCEEDED'), { code: 'SOURCE_LIMIT_EXCEEDED', status: 422 })); } else chunks.push(chunk); });
      response.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString())); } catch { finish(Object.assign(new Error('SOURCE_PARSE_FAILED'), { code: 'SOURCE_PARSE_FAILED', status: 422 })); } });
    });
    request.on('timeout', () => { request.destroy(); finish(Object.assign(new Error('SOURCE_TIMEOUT'), { code: 'SOURCE_TIMEOUT', status: 422 })); });
    request.on('error', (error) => finish(Object.assign(new Error(error.code === 'ENOTFOUND' ? 'SOURCE_DNS_FAILED' : 'SOURCE_UNAVAILABLE'), { code: error.code === 'ENOTFOUND' ? 'SOURCE_DNS_FAILED' : 'SOURCE_UNAVAILABLE', status: 422 })));
    request.end();
  });
}
function flattenFields(value, prefix = '', output = new Map(), depth = 0) {
  if (depth > 5 || output.size >= 256) return output;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) { const path = prefix ? `${prefix}.${key}` : key; if (child && typeof child === 'object' && !Array.isArray(child)) flattenFields(child, path, output, depth + 1); else if (!output.has(path)) output.set(path, child); }
  }
  return output;
}
function inferType(value) { if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'; if (typeof value === 'boolean') return 'boolean'; if (typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /T|Z/.test(value)) return 'timestamp'; return 'string'; }
function validateMapping(mapping) { return mapping && typeof mapping.sourcePath === 'string' && typeof mapping.targetField === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(mapping.targetField); }
function getPath(value, path) { return path.split('.').reduce((current, key) => current == null ? undefined : current[key], value); }
async function callCatalog(datasetId, body, idempotencyKey) {
  const tokens = JSON.parse(process.env.OPSWEAVE_CAPABILITY_TOKENS || '{}');
  const token = tokens['data.catalog.v1'];
  if (!token) throw Object.assign(new Error('CAPABILITY_UNAVAILABLE: no data.catalog.v1 workload token'), { code: 'CAPABILITY_UNAVAILABLE', status: 503 });
  let response;
  try {
    response = await fetch(`${KERNEL_URL.replace(/\/$/, '')}/api/v1/capabilities/data.catalog.v1/1/api/data-catalog/datasets/${datasetId}/records`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  } catch (error) {
    // The request may have reached Catalog before the transport failed. Do not
    // claim a definite failure; the caller must reconcile with the same key.
    throw Object.assign(new Error('UNKNOWN_OUTCOME: catalog request transport failed'), { code: 'UNKNOWN_OUTCOME', status: 504 });
  }
  const text = await response.text(); let payload; try { payload = JSON.parse(text); } catch { payload = {}; }
  if (!response.ok) throw Object.assign(new Error(payload.message || `catalog ${response.status}`), { code: payload.code || 'CAPABILITY_UNAVAILABLE', status: response.status });
  return payload;
}
function sourceView(row) { return { sourceId: row.source_id, name: row.name, connectorType: row.connector_type, endpoint: row.endpoint, credential: row.credential, status: row.status, lastTestAt: row.last_test_at?.toISOString?.(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
function runView(row) { return { runId: row.run_id, specId: row.spec_id, sourceBatchKey: row.source_batch_key, status: row.status, inputCount: row.input_count, accepted: row.accepted, rejected: row.rejected, unknown: row.unknown, startedAt: row.started_at.toISOString(), finishedAt: row.finished_at?.toISOString?.(), receiptId: row.receipt_id, failureCode: row.failure_code, failureMessage: row.failure_message }; }
async function initDb() { await pool.query(`
  CREATE TABLE IF NOT EXISTS integration_sources (source_id uuid PRIMARY KEY, name text NOT NULL, connector_type text NOT NULL, endpoint text NOT NULL, credential jsonb NOT NULL, status text NOT NULL, last_test_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS integration_specs (spec_id uuid PRIMARY KEY, source_id uuid NOT NULL, source_revision integer NOT NULL, schema_revision integer NOT NULL, target_dataset_id uuid NOT NULL, mappings jsonb NOT NULL, batch_size integer NOT NULL, timeout_seconds integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS integration_runs (run_id uuid PRIMARY KEY, spec_id uuid NOT NULL, source_batch_key text NOT NULL UNIQUE, request_digest text NOT NULL DEFAULT '', status text NOT NULL, input_count integer NOT NULL DEFAULT 0, accepted integer NOT NULL DEFAULT 0, rejected integer NOT NULL DEFAULT 0, unknown integer NOT NULL DEFAULT 0, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, receipt_id uuid, failure_code text, failure_message text);
  ALTER TABLE integration_runs ADD COLUMN IF NOT EXISTS request_digest text NOT NULL DEFAULT '';
`); ready = true; }
async function handle(req, res) {
  const id = rid(req); const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/_opsweave/runtime/v1/info') return send(res, 200, { pluginId: PLUGIN_ID, version: VERSION, runtimeProtocol: 'http-json-v1', capabilityDigest: CAPABILITY_DIGEST, buildDigest: BUILD_DIGEST }, id);
  if (url.pathname === '/_opsweave/health/live') return send(res, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'live' }, id);
  if (url.pathname === '/_opsweave/health/ready') return send(res, ready && !stopping ? 200 : 503, { status: ready && !stopping ? 'ready' : 'not_ready' }, id);
  if (url.pathname === '/_opsweave/health/startup') return send(res, 200, { status: 'started' }, id);
  const who = identity(req); if (!who) return fail(res, 401, 'UNAUTHENTICATED', 'caller identity required', id);
  if (url.pathname === '/api/data-integration/sources' && req.method === 'GET') { if (!hasScope(who, 'source:read')) return fail(res, 403, 'FORBIDDEN', 'source:read required', id); const rows = await pool.query('SELECT * FROM integration_sources ORDER BY created_at DESC LIMIT 100'); return send(res, 200, rows.rows.map(sourceView), id); }
  if (url.pathname === '/api/data-integration/sources' && req.method === 'POST') {
    if (!hasScope(who, 'source:write')) return fail(res, 403, 'FORBIDDEN', 'source:write required', id); const body = await readJson(req); if (!body.name || body.connectorType !== 'http-json' || !body.endpoint || typeof body.credential?.credentialRef !== 'string' || !/^secret:\/\/[a-z0-9][a-z0-9/_-]{2,120}$/.test(body.credential.credentialRef)) return fail(res, 400, 'INVALID_REQUEST', 'name, http-json connector, endpoint and a secret:// credentialRef are required', id); const row = await pool.query('INSERT INTO integration_sources (source_id,name,connector_type,endpoint,credential,status) VALUES ($1,$2,$3,$4,$5,\'UNVERIFIED\') RETURNING *', [crypto.randomUUID(), body.name, body.connectorType, body.endpoint, JSON.stringify(body.credential)]); return send(res, 201, sourceView(row.rows[0]), id);
  }
  const sourceMatch = url.pathname.match(/^\/api\/data-integration\/sources\/([0-9a-f-]{36})(?:\/(.*))?$/);
  if (sourceMatch) {
    if (!hasScope(who, 'source:read')) return fail(res, 403, 'FORBIDDEN', 'source:read required', id); const sourceId = sourceMatch[1]; const tail = sourceMatch[2] || ''; const source = await pool.query('SELECT * FROM integration_sources WHERE source_id=$1', [sourceId]); if (!source.rows[0]) return fail(res, 404, 'SOURCE_NOT_FOUND', 'source not found', id);
    if (!tail && req.method === 'GET') return send(res, 200, sourceView(source.rows[0]), id);
    if (tail === 'test' && req.method === 'POST') { try { await assertUrl(source.rows[0].endpoint); const start = Date.now(); await fetchJson(source.rows[0].endpoint, 5); await pool.query('UPDATE integration_sources SET status=\'READY\',last_test_at=now(),updated_at=now() WHERE source_id=$1', [sourceId]); return send(res, 200, { sourceId, status: 'OK', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() }, id); } catch (error) { await pool.query('UPDATE integration_sources SET status=\'DEGRADED\',last_test_at=now(),updated_at=now() WHERE source_id=$1', [sourceId]); return fail(res, 422, error.code || 'SOURCE_FAILED', error.message, id); } }
    if (tail === 'discover' && req.method === 'POST') { if (!hasScope(who, 'source:write')) return fail(res, 403, 'FORBIDDEN', 'source:write required', id); try { const body = await readJson(req); const data = await fetchJson(source.rows[0].endpoint, 10); const records = Array.isArray(data) ? data.slice(0, 100) : [data]; const fields = new Map(); for (const record of records) flattenFields(record, '', fields); const list = [...fields.entries()].map(([path, value], index) => ({ path, type: inferType(value), nullable: records.some((record) => getPath(record, path) == null), sampleCount: records.length, ordinal: index })); const snapshot = { snapshotId: crypto.randomUUID(), sourceId, sourceRevision: 1, digest: digest(records), capturedAt: new Date().toISOString(), byteSize: Buffer.byteLength(JSON.stringify(records)) }; return send(res, 200, { sourceId, snapshot, fields: list, discoveredAt: new Date().toISOString() }, id); } catch (error) { return fail(res, 422, error.code || 'SOURCE_FAILED', error.message, id); } }
    if (tail === 'preview' && req.method === 'POST') { if (!hasScope(who, 'source:read')) return fail(res, 403, 'FORBIDDEN', 'source:read required', id); try { const body = await readJson(req); const data = await fetchJson(source.rows[0].endpoint, 10); const records = Array.isArray(data) ? data : [data]; const limit = Math.min(Number(body.limit || 5), 10); const preview = records.slice(0, limit); const snapshot = { snapshotId: crypto.randomUUID(), sourceId, sourceRevision: 1, digest: digest(preview), capturedAt: new Date().toISOString(), byteSize: Buffer.byteLength(JSON.stringify(preview)) }; return send(res, 200, { sourceId, snapshot, records: preview, truncated: records.length > limit, readOnly: true }, id); } catch (error) { return fail(res, 422, error.code || 'SOURCE_FAILED', error.message, id); } }
    if (tail === 'ingestion-specs' && req.method === 'POST') { if (!hasScope(who, 'source:write')) return fail(res, 403, 'FORBIDDEN', 'source:write required', id); const body = await readJson(req); if (!Array.isArray(body.mappings) || !body.mappings.every(validateMapping) || !body.targetDatasetId) return fail(res, 400, 'INVALID_REQUEST', 'targetDatasetId and valid mappings are required', id); const row = await pool.query('INSERT INTO integration_specs (spec_id,source_id,source_revision,schema_revision,target_dataset_id,mappings,batch_size,timeout_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [crypto.randomUUID(), sourceId, body.sourceRevision || 1, body.schemaRevision || 1, body.targetDatasetId, JSON.stringify(body.mappings), body.batchSize || 100, body.timeoutSeconds || 30]); const s = row.rows[0]; return send(res, 201, { specId: s.spec_id, sourceId: s.source_id, sourceRevision: s.source_revision, schemaRevision: s.schema_revision, targetDatasetId: s.target_dataset_id, mappings: s.mappings, mode: 'MANUAL', batchSize: s.batch_size, timeoutSeconds: s.timeout_seconds, createdAt: s.created_at.toISOString() }, id); }
  }
  const specRunMatch = url.pathname.match(/^\/api\/data-integration\/ingestion-specs\/([0-9a-f-]{36})\/runs$/);
  if (specRunMatch && req.method === 'POST') {
    if (!hasScope(who, 'source:write')) return fail(res, 403, 'FORBIDDEN', 'source:write required', id); const specId = specRunMatch[1]; const spec = await pool.query('SELECT s.*, src.endpoint, src.source_id FROM integration_specs s JOIN integration_sources src ON src.source_id=s.source_id WHERE s.spec_id=$1', [specId]); if (!spec.rows[0]) return fail(res, 404, 'SPEC_NOT_FOUND', 'ingestion spec not found', id); const idem = String(req.headers['idempotency-key'] || ''); if (!idem) return fail(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required for an ingestion run', id); const batchKey = `source-${spec.rows[0].source_id}-${digest(idem).slice(7, 39)}`; const requestDigest = digest({ specId, idem }); const existing = await pool.query('SELECT * FROM integration_runs WHERE source_batch_key=$1', [batchKey]); if (existing.rows[0]) { if (existing.rows[0].request_digest && existing.rows[0].request_digest !== requestDigest) return fail(res, 409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used for a different run', id); return send(res, 202, runView(existing.rows[0]), id); } const runId = crypto.randomUUID(); await pool.query('INSERT INTO integration_runs (run_id,spec_id,source_batch_key,request_digest,status) VALUES ($1,$2,$3,$4,\'RUNNING\')', [runId, specId, batchKey, requestDigest]); try { const data = await fetchJson(spec.rows[0].endpoint, spec.rows[0].timeout_seconds); const records = Array.isArray(data) ? data.slice(0, spec.rows[0].batch_size) : [data]; const mapped = records.map((record) => { const out = {}; for (const mapping of spec.rows[0].mappings) { const value = getPath(record, mapping.sourcePath); if (value == null) { if (mapping.required) continue; if (mapping.defaultValue !== undefined) out[mapping.targetField] = mapping.defaultValue; continue; } out[mapping.targetField] = mapping.castTo === 'string' ? String(value) : mapping.castTo === 'integer' ? Number.parseInt(value, 10) : mapping.castTo === 'number' ? Number(value) : mapping.castTo === 'boolean' ? Boolean(value) : value; } return out; }); const receipt = await callCatalog(spec.rows[0].target_dataset_id, { schemaRevision: spec.rows[0].schema_revision, sourceBatchKey: batchKey, source: { pluginId: PLUGIN_ID, sourceId: spec.rows[0].source_id, sourceRevision: spec.rows[0].source_revision }, ingestionRunId: runId, records: mapped }, idem); await pool.query('UPDATE integration_runs SET status=$2,input_count=$3,accepted=$4,rejected=$5,unknown=$6,receipt_id=$7,finished_at=now() WHERE run_id=$1', [runId, receipt.status === 'REJECTED' ? 'FAILED' : receipt.status === 'PARTIAL' ? 'PARTIAL' : 'SUCCEEDED', records.length, receipt.accepted, receipt.rejected, receipt.unknown, receipt.receiptId]); const updated = await pool.query('SELECT * FROM integration_runs WHERE run_id=$1', [runId]); return send(res, 202, runView(updated.rows[0]), id); } catch (error) { const unknown = ['CAPABILITY_TIMEOUT', 'UNKNOWN_OUTCOME'].includes(error.code); await pool.query('UPDATE integration_runs SET status=$2,failure_code=$3,failure_message=$4,finished_at=now() WHERE run_id=$1', [runId, unknown ? 'UNKNOWN' : 'FAILED', error.code || 'INGESTION_FAILED', String(error.message).slice(0, 1024)]); return fail(res, unknown ? 504 : 422, error.code || 'INGESTION_FAILED', error.message, id); }
  }
  if (url.pathname === '/api/data-integration/ingestion-runs' && req.method === 'GET') { if (!hasScope(who, 'source:read')) return fail(res, 403, 'FORBIDDEN', 'source:read required', id); const rows = await pool.query('SELECT * FROM integration_runs ORDER BY started_at DESC LIMIT 100'); return send(res, 200, rows.rows.map(runView), id); }
  const runMatch = url.pathname.match(/^\/api\/data-integration\/ingestion-runs\/([0-9a-f-]{36})(?:\/(quality|lineage))?$/);
  if (runMatch) { if (!hasScope(who, 'source:read')) return fail(res, 403, 'FORBIDDEN', 'source:read required', id); const run = await pool.query('SELECT * FROM integration_runs WHERE run_id=$1', [runMatch[1]]); if (!run.rows[0]) return fail(res, 404, 'RUN_NOT_FOUND', 'run not found', id); if (runMatch[2] === 'quality') return send(res, 200, { runId: run.rows[0].run_id, total: run.rows[0].input_count, missing: 0, validationRejected: run.rows[0].rejected, unknown: run.rows[0].unknown, sampleLimit: 100, computedAt: new Date().toISOString() }, id); if (runMatch[2] === 'lineage') { const spec = await pool.query('SELECT source_id,source_revision,target_dataset_id,schema_revision FROM integration_specs WHERE spec_id=$1', [run.rows[0].spec_id]); return send(res, 200, { runId: run.rows[0].run_id, sourceId: spec.rows[0]?.source_id, sourceRevision: spec.rows[0]?.source_revision, sourceBatchKey: run.rows[0].source_batch_key, datasetId: spec.rows[0]?.target_dataset_id, schemaRevision: spec.rows[0]?.schema_revision, counts: { accepted: run.rows[0].accepted, rejected: run.rows[0].rejected, unknown: run.rows[0].unknown } }, id); } return send(res, 200, runView(run.rows[0]), id); }
  return fail(res, 404, 'NOT_FOUND', 'route not found', id);
}
const server = http.createServer((req, res) => { handle(req, res).catch((error) => { const id = rid(req); fail(res, error.status || 500, error.code || 'INTERNAL', error.status && error.status < 500 ? error.message : 'internal integration error', id); }); });
server.on('SIGTERM', () => { stopping = true; server.close(() => pool.end().then(() => process.exit(0))); });
initDb().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`data-integration ${VERSION} listening ${PORT}`))).catch((error) => { console.error(error); process.exit(1); });
