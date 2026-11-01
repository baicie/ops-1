// OpsWeave Zabbix telemetry source - Plugin Runtime HTTP/JSON v1.
//
// The plugin owns everything Zabbix-specific; the Kernel never learns what
// Zabbix is (ADR-006, rules/01). The surface is contracts/openapi/
// zabbix-source-v1.yaml and the data semantics are in zabbix.mjs.
//
// Secrets: a source stores a secretref, never a token. The token is resolved
// per call from the plugin secret store and lives in a local variable for the
// duration of that call. It is not stored, not logged, not echoed in an error
// body and not accepted in a URL (rules/03).

import http from 'node:http';
import crypto from 'node:crypto';
import {
  BUDGET_CEILING,
  collect,
  listHosts,
  listItems,
  probe,
  redact,
  resolveBudget,
  signAttestation,
} from './zabbix.mjs';

const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'opsweave.zabbix-source';
const VERSION = process.env.OPSWEAVE_PLUGIN_VERSION || '0.0.1';
const CAPABILITY_DIGEST = process.env.OPSWEAVE_CAPABILITY_DIGEST || 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const BUILD_DIGEST = process.env.OPSWEAVE_BUILD_DIGEST || 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const PORT = Number(process.env.PORT || 8080);

// The adapter identity this plugin signs as, and the secret it signs with. The
// same pair must be configured on the Kernel as OPSWEAVE_EVIDENCE_ADAPTERS
// (adapterId:secret). With no secret the plugin still collects and still serves
// every read endpoint - it simply cannot attest, and says so with
// EVIDENCE_ADAPTER_NOT_CONFIGURED instead of returning evidence that would be
// stored as UNVERIFIED while looking attested to a reader.
const ADAPTER_ID = process.env.OPSWEAVE_EVIDENCE_ADAPTER_ID || '';
const ADAPTER_SECRET = process.env.OPSWEAVE_EVIDENCE_ADAPTER_SECRET || '';

// Resolving a secretref. In a deployed node this is the plugin secret store
// mount; the map form exists so a developer can run the plugin without one.
// Either way the value never leaves this process.
let SECRET_MAP = {};
try {
  SECRET_MAP = JSON.parse(process.env.OPSWEAVE_ZABBIX_SECRETS || '{}');
} catch {
  // A malformed map is the same as none: refuse to resolve rather than guess.
  SECRET_MAP = {};
}

let stopping = false;
const ready = true;

/** In-memory source registry. Sources are plugin-owned state; 0.0.1 keeps them
 *  in process because a restart losing a source configuration is visible and
 *  safe, while a half-migrated secret reference is not. Persisting them is a
 *  follow-up, recorded in the implementation-status note. */
const SOURCES = new Map();
/** Collections retained for attestation. Bounded so a long-running plugin
 *  cannot grow without limit (AGENTS.md: storage has a ceiling). */
const COLLECTIONS = new Map();
const MAX_RETAINED_COLLECTIONS = 200;

function rid(req) {
  const value = req.headers['x-opsweave-request-id'];
  return typeof value === 'string' && value.length <= 128 ? value : crypto.randomUUID();
}

function send(res, status, body, id) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-opsweave-request-id': id,
  });
  res.end(payload);
}

function fail(res, status, code, message, id, retryable = false) {
  // Every message that reaches a client goes through redact: an error path is
  // exactly where a token tends to escape, and a stable code is what the UI
  // localises against (AGENTS.md).
  send(res, status, { code, message: redact(message, knownSecrets()), requestId: id, retryable }, id);
}

function knownSecrets() {
  const values = Object.values(SECRET_MAP).filter((value) => typeof value === 'string');
  return ADAPTER_SECRET ? [...values, ADAPTER_SECRET] : values;
}

async function readJson(req, limit = 256 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) {
      throw Object.assign(new Error('request body is larger than this endpoint accepts'), {
        status: 413,
        code: 'REQUEST_TOO_LARGE',
      });
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400, code: 'INVALID_REQUEST' });
  }
}

/** Identity comes from the Kernel-verified headers, never from a self-reported
 *  body field (rules/03, rules/10). An unauthenticated request is refused
 *  before any Zabbix call is made. */
function identity(req) {
  const role = req.headers['x-opsweave-user-role'];
  if (typeof role === 'string' && role) {
    const normalised = role.toLowerCase();
    if (normalised === 'admin' || normalised === 'operator') {
      return { kind: 'user', role: normalised, scope: ['telemetry.source.read', 'telemetry.source.write'] };
    }
    if (normalised === 'viewer') return { kind: 'user', role: normalised, scope: ['telemetry.source.read'] };
    return { kind: 'user', role: normalised, scope: [] };
  }
  const workload = req.headers['x-opsweave-caller-context'];
  if (typeof workload === 'string' && workload) {
    // The Gateway signs this; an unsigned or unverifiable context is not an
    // identity. Verification lives in the shared runtime helper in a deployed
    // node, so here an unverified context grants read only.
    return { kind: 'workload', scope: ['telemetry.source.read'] };
  }
  return null;
}

function requireScope(who, scope) {
  if (!who) {
    throw Object.assign(new Error('this endpoint requires an authenticated caller'), {
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  }
  if (!who.scope.includes(scope)) {
    throw Object.assign(new Error(`this endpoint requires ${scope}`), { status: 403, code: 'FORBIDDEN' });
  }
}

/** Resolve a secretref to its value, for the duration of one call. */
function resolveSecret(ref) {
  const value = SECRET_MAP[ref];
  if (typeof value !== 'string' || !value) {
    throw Object.assign(
      new Error('the secret store has no value for this source credential reference'),
      { status: 422, code: 'CREDENTIAL_UNRESOLVED' },
    );
  }
  return value;
}

function sourceOr404(sourceId) {
  const source = SOURCES.get(sourceId);
  if (!source) {
    throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
  }
  return source;
}

/** What a source looks like to a caller: the reference, never the secret. */
function publicSource(source) {
  return {
    sourceId: source.sourceId,
    name: source.name,
    endpoint: source.endpoint,
    credential: { kind: source.credential.kind, ref: source.credential.ref },
    verifyTls: source.verifyTls,
    status: source.status,
    ...(source.lastProbe ? { lastProbe: source.lastProbe } : {}),
    budget: source.budget,
    createdAt: source.createdAt,
  };
}

function validateCreate(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 120) {
    throw Object.assign(new Error('name must be 2..120 characters'), { status: 400, code: 'INVALID_REQUEST' });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw Object.assign(new Error('endpoint is not a valid URL'), { status: 400, code: 'INVALID_REQUEST' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw Object.assign(new Error('endpoint must be http or https'), { status: 400, code: 'INVALID_REQUEST' });
  }
  if (url.username || url.password) {
    // A credential in a URL ends up in logs and metrics labels. Refused at the
    // boundary rather than stripped silently (rules/03).
    throw Object.assign(
      new Error('endpoint must not carry credentials; use a credential reference'),
      { status: 400, code: 'CREDENTIAL_IN_URL' },
    );
  }
  const credential = body.credential;
  if (!credential || typeof credential !== 'object') {
    throw Object.assign(new Error('credential is required'), { status: 400, code: 'INVALID_REQUEST' });
  }
  if (!['api-token', 'basic'].includes(credential.kind)) {
    throw Object.assign(new Error('credential.kind must be api-token or basic'), {
      status: 400,
      code: 'INVALID_REQUEST',
    });
  }
  if (typeof credential.ref !== 'string' || !/^secretref:[A-Za-z0-9._\-/]{1,180}$/.test(credential.ref)) {
    // A raw token pasted here would otherwise be stored as if it were a
    // reference, so the shape is enforced rather than assumed.
    throw Object.assign(
      new Error('credential.ref must be a secretref: handle, not a secret value'),
      { status: 400, code: 'CREDENTIAL_NOT_A_REFERENCE' },
    );
  }
  return { name, endpoint, credential: { kind: credential.kind, ref: credential.ref } };
}

async function handle(req, res) {
  const id = rid(req);
  const url = new URL(req.url, 'http://plugin.invalid');
  const path = url.pathname.replace(/^\/api\/zabbix-source/, '') || '/';

  if (url.pathname === '/_opsweave/health/live') {
    return send(res, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'live' }, id);
  }
  if (url.pathname === '/_opsweave/health/ready') {
    return send(res, ready && !stopping ? 200 : 503, { status: ready && !stopping ? 'ready' : 'not_ready' }, id);
  }
  if (url.pathname === '/_opsweave/health/startup') {
    return send(res, 200, { status: 'started' }, id);
  }
  if (url.pathname === '/_opsweave/runtime-info') {
    return send(res, 200, {
      pluginId: PLUGIN_ID,
      version: VERSION,
      protocol: { name: 'http-json', version: '1' },
      capabilityDigest: CAPABILITY_DIGEST,
      buildDigest: BUILD_DIGEST,
      // Whether this instance can attest at all is operational truth a reader
      // needs: without it, evidence silently arrives as UNVERIFIED.
      attestation: { adapterId: ADAPTER_ID || null, configured: Boolean(ADAPTER_ID && ADAPTER_SECRET) },
      budgetCeiling: BUDGET_CEILING,
    }, id);
  }

  const who = identity(req);

  if (path === '/sources' && req.method === 'GET') {
    requireScope(who, 'telemetry.source.read');
    const sources = [...SOURCES.values()].map(publicSource);
    return send(res, 200, { sources, nextCursor: null }, id);
  }

  if (path === '/sources' && req.method === 'POST') {
    requireScope(who, 'telemetry.source.write');
    const body = await readJson(req);
    const parsed = validateCreate(body);
    const source = {
      sourceId: crypto.randomUUID(),
      ...parsed,
      verifyTls: body.verifyTls !== false,
      // A new source has not been probed, so it is UNVERIFIED. It does not
      // become READY because the operator supplied plausible settings.
      status: 'UNVERIFIED',
      budget: resolveBudget(body.budget).budget,
      createdAt: new Date().toISOString(),
    };
    SOURCES.set(source.sourceId, source);
    return send(res, 201, publicSource(source), id);
  }

  const probeMatch = path.match(/^\/sources\/([^/]+)\/probe$/);
  if (probeMatch && req.method === 'POST') {
    requireScope(who, 'telemetry.source.write');
    const source = sourceOr404(probeMatch[1]);
    // The secret is attached to the source view for this one call. A probe that
    // cannot resolve its secret still runs, so it reports UNAUTHORIZED rather
    // than a local configuration error the operator cannot distinguish from a
    // bad token.
    const result = await probe({ ...source, secret: resolveSecretQuietly(source) });
    source.lastProbe = result;
    // Only a probe moves status, and it records what it saw. A TIMEOUT leaves
    // the source DEGRADED rather than UNAVAILABLE: a slow endpoint is not a
    // down endpoint, and inferring "stopped" from silence is forbidden.
    source.status = result.outcome === 'OK'
      ? (source.verifyTls ? 'READY' : 'DEGRADED')
      : result.outcome === 'UNAVAILABLE'
        ? 'UNAVAILABLE'
        : result.outcome === 'TIMEOUT'
          ? 'DEGRADED'
          : 'UNVERIFIED';
    return send(res, 200, result, id);
  }

  const hostsMatch = path.match(/^\/sources\/([^/]+)\/hosts$/);
  if (hostsMatch && req.method === 'GET') {
    requireScope(who, 'telemetry.source.read');
    const source = sourceOr404(hostsMatch[1]);
    const result = await listHosts({ ...source, secret: resolveSecret(source.credential.ref) });
    return send(res, 200, result, id);
  }

  const itemsMatch = path.match(/^\/sources\/([^/]+)\/items$/);
  if (itemsMatch && req.method === 'GET') {
    requireScope(who, 'telemetry.source.read');
    const source = sourceOr404(itemsMatch[1]);
    const result = await listItems(
      { ...source, secret: resolveSecret(source.credential.ref) },
      url.searchParams.get('hostId'),
    );
    return send(res, 200, result, id);
  }

  const collectMatch = path.match(/^\/sources\/([^/]+)\/collect$/);
  if (collectMatch && req.method === 'POST') {
    requireScope(who, 'telemetry.source.read');
    const source = sourceOr404(collectMatch[1]);
    const body = await readJson(req);
    // The body is the contract's request shape: itemIds plus a window. Anything
    // the caller did not send stays unset and is defaulted inside collect(),
    // never invented here.
    const result = await collect({
      source: { ...source, secret: resolveSecret(source.credential.ref) },
      itemIds: Array.isArray(body.itemIds) ? body.itemIds : [],
      window: body.window,
      budget: body.budget,
    });
    retainCollection(result);
    return send(res, 200, result, id);
  }

  const attestMatch = path.match(/^\/collections\/([^/]+)\/attestation$/);
  if (attestMatch && req.method === 'POST') {
    requireScope(who, 'telemetry.source.write');
    const collection = COLLECTIONS.get(attestMatch[1]);
    if (!collection) {
      throw Object.assign(new Error('no such collection, or it is no longer retained'), {
        status: 404,
        code: 'COLLECTION_NOT_FOUND',
      });
    }
    if (!ADAPTER_ID || !ADAPTER_SECRET) {
      // Refused rather than returned unsigned: an unsigned envelope would be
      // stored as UNVERIFIED while looking like attested evidence to a caller
      // that did not check.
      throw Object.assign(
        new Error('this instance has no evidence adapter credential, so it cannot attest a collection'),
        { status: 503, code: 'EVIDENCE_ADAPTER_NOT_CONFIGURED' },
      );
    }
    const body = await readJson(req);
    const incidentId = typeof body.incidentId === 'string' ? body.incidentId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incidentId)) {
      throw Object.assign(new Error('incidentId must be a UUID'), { status: 400, code: 'INVALID_REQUEST' });
    }
    // The signature covers the incident it is being filed against, so a
    // genuine envelope cannot be moved to another incident.
    const envelope = signAttestation({
      adapterId: ADAPTER_ID,
      secret: ADAPTER_SECRET,
      incidentId,
      kind: 'METRIC_SNAPSHOT',
      source: `zabbix:${collection.sourceId}`,
      collectedAt: collection.observedAt,
      contentRef: collection.contentRef,
      issuedAt: new Date().toISOString(),
    });
    return send(res, 200, {
      // Exactly the body the Kernel's evidence endpoint expects, so the caller
      // relays it without reassembling the signed fields.
      evidence: {
        kind: 'METRIC_SNAPSHOT',
        source: `zabbix:${collection.sourceId}`,
        collectedAt: collection.observedAt,
        contentRef: collection.contentRef,
        attestation: envelope,
      },
      outcome: collection.outcome,
    }, id);
  }

  return fail(res, 404, 'NOT_FOUND', 'no such endpoint', id);
}

/** A probe must be able to report UNAUTHORIZED, which means it has to run even
 *  when the secret cannot be resolved. Returns null instead of throwing. */
function resolveSecretQuietly(source) {
  try {
    return resolveSecret(source.credential.ref);
  } catch {
    return null;
  }
}

function retainCollection(result) {
  COLLECTIONS.set(result.collectionId, result);
  while (COLLECTIONS.size > MAX_RETAINED_COLLECTIONS) {
    const oldest = COLLECTIONS.keys().next().value;
    COLLECTIONS.delete(oldest);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const id = rid(req);
    // Below 500 the message is the caller's own input problem and is safe to
    // return once redacted; at 500 it is replaced, because an internal message
    // is the one most likely to quote a token or a host path.
    fail(
      res,
      error.status || 500,
      error.code || 'INTERNAL',
      error.status && error.status < 500 ? error.message : 'internal zabbix-source error',
      id,
      Boolean(error.retryable),
    );
  });
});

process.on('SIGTERM', () => {
  stopping = true;
  server.close(() => process.exit(0));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`zabbix-source ${VERSION} listening on ${PORT}`);
  if (!ADAPTER_ID || !ADAPTER_SECRET) {
    // Said once at startup, because "evidence is arriving as UNVERIFIED" is
    // otherwise discovered much later by a reader who trusted it.
    console.log('zabbix-source: no evidence adapter credential configured; collections cannot be attested');
  }
});

export { handle, publicSource, validateCreate };
