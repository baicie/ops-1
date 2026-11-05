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
//
// Identity: only Kernel-signed contexts are accepted (identity.mjs). The bare
// x-opsweave-user-role header is not read: G10's R1 showed that trusting it is
// safe only while the data port is unreachable, and a signature does not depend
// on that network assumption.
//
// Storage: sources and collections live in the plugin's own PostgreSQL schema
// (storage.mjs). Without it the plugin refuses to start unless an explicit
// test-only memory flag is set; it never silently forgets configured sources.

import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  BUDGET_CEILING,
  collect,
  evidenceBodyOf,
  listHosts,
  listItems,
  probe,
  redact,
  resolveBudget,
  signAttestation,
  statusFromProbe,
} from './zabbix.mjs';
import {
  SourceConflictError,
  StorageUnavailableError,
  openStorage,
  sourceView,
} from './storage.mjs';
import { createIdentityResolver, hasScope, workspaceAllowed } from './identity.mjs';

const DEFAULTS = {
  pluginId: 'opsweave.zabbix-source',
  version: '0.0.1',
  capabilityDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  buildDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  port: 8080,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_KINDS = new Set(['METRIC_SNAPSHOT']);

function parseSecretMap(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A malformed map is the same as none: refuse to resolve rather than guess.
    return {};
  }
}

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

/**
 * Build the plugin with explicit dependencies, so the socket tests can start a
 * real server against a real database without importing a self-listening
 * module. `server.mjs` only listens when it is executed as the entry point.
 */
export function createPlugin(options) {
  const pluginId = options.pluginId || DEFAULTS.pluginId;
  const version = options.version || DEFAULTS.version;
  const store = options.store;
  const verifyIdentity = options.verifyIdentity;
  const adapterId = options.adapterId || '';
  const adapterSecret = options.adapterSecret || '';
  const secretMap = options.secretMap || {};
  const capabilityDigest = options.capabilityDigest || DEFAULTS.capabilityDigest;
  const buildDigest = options.buildDigest || DEFAULTS.buildDigest;
  const logger = options.logger || console;
  const state = { stopping: false };

  function knownSecrets() {
    const values = Object.values(secretMap).filter((value) => typeof value === 'string');
    return adapterSecret ? [...values, adapterSecret] : values;
  }

  function fail(res, status, code, message, id, retryable = false) {
    // Every message that reaches a client goes through redact: an error path is
    // exactly where a token tends to escape, and a stable code is what the UI
    // localises against (AGENTS.md).
    send(res, status, { code, message: redact(message, knownSecrets()), requestId: id, retryable }, id);
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

  function whoOr401(req) {
    const who = verifyIdentity(req.headers);
    if (!who) {
      throw Object.assign(new Error('this endpoint requires a Kernel-signed caller identity'), {
        status: 401,
        code: 'ZBX_IDENTITY_UNVERIFIED',
      });
    }
    return who;
  }

  function requireUuidPath(value, code) {
    if (!UUID_RE.test(value)) {
      throw Object.assign(new Error('the path id is not a UUID'), { status: 404, code });
    }
    return value.toLowerCase();
  }

  function requireScope(who, scope) {
    if (!hasScope(who, scope)) {
      throw Object.assign(new Error(`this endpoint requires ${scope}`), { status: 403, code: 'FORBIDDEN' });
    }
  }

  /** Writes need a user: a workload has no principal to attribute the change to
   *  and no membership of its own beyond grant-scoped workspaces. */
  function requireUser(who) {
    if (who.kind !== 'user' || !UUID_RE.test(String(who.userId || ''))) {
      throw Object.assign(new Error('this operation requires a signed user identity'), {
        status: 403,
        code: 'ZBX_USER_REQUIRED',
      });
    }
    return who.userId;
  }

  /** Resolve a secretref to its value, for the duration of one call. */
  function resolveSecret(ref) {
    const value = secretMap[ref];
    if (typeof value !== 'string' || !value) {
      throw Object.assign(
        new Error('the secret store has no value for this source credential reference'),
        { status: 422, code: 'CREDENTIAL_UNRESOLVED' },
      );
    }
    return value;
  }

  function resolveSecretQuietly(ref) {
    try {
      return resolveSecret(ref);
    } catch {
      return null;
    }
  }

  const BUDGET_BOUNDS = {
    maxWindowSeconds: [60, 86400],
    maxItems: [1, 500],
    maxSamplesPerItem: [1, 5000],
    requestTimeoutMs: [500, 60000],
    maxConcurrency: [1, 8],
  };

  function validateBudget(input) {
    if (input === undefined || input === null) return;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw Object.assign(new Error('budget must be an object'), { status: 400, code: 'INVALID_BUDGET' });
    }
    for (const [key, [min, max]] of Object.entries(BUDGET_BOUNDS)) {
      if (input[key] === undefined) continue;
      const value = input[key];
      if (!Number.isInteger(value) || value < min || value > max) {
        throw Object.assign(
          new Error(`${key} must be an integer between ${min} and ${max}`),
          { status: 400, code: 'INVALID_BUDGET' },
        );
      }
    }
  }

  /** A per-request budget may narrow the source's configured budget, never widen it. */
  function effectiveBudget(sourceBudget, requestBudget) {
    const requested = resolveBudget(requestBudget).budget;
    const bounded = {};
    for (const key of Object.keys(requested)) {
      bounded[key] = Math.min(requested[key], sourceBudget?.[key] ?? requested[key]);
    }
    return bounded;
  }

  function validateSourceBody(body, { requireWorkspace }) {
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
    let workspaceId;
    if (requireWorkspace) {
      workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.toLowerCase() : '';
      if (!UUID_RE.test(workspaceId)) {
        throw Object.assign(new Error('workspaceId is required and must be a UUID'), {
          status: 400,
          code: 'ZBX_WORKSPACE_REQUIRED',
        });
      }
    }
    return {
      name,
      endpoint,
      credential: { kind: credential.kind, ref: credential.ref },
      workspaceId,
      verifyTls: body.verifyTls !== false,
      budget: (validateBudget(body.budget), resolveBudget(body.budget).budget),
    };
  }

  async function handle(req, res) {
    const id = rid(req);
    const url = new URL(req.url, 'http://plugin.invalid');
    const path = url.pathname.replace(/^\/api\/zabbix-source/, '') || '/';

    if (url.pathname === '/_opsweave/health/live') {
      return send(res, state.stopping ? 503 : 200, { status: state.stopping ? 'stopping' : 'live' }, id);
    }
    if (url.pathname === '/_opsweave/health/ready') {
      return send(res, state.stopping ? 503 : 200, { status: state.stopping ? 'not_ready' : 'ready' }, id);
    }
    if (url.pathname === '/_opsweave/health/startup') {
      return send(res, 200, { status: 'started' }, id);
    }
    if (url.pathname === '/_opsweave/runtime-info') {
      return send(res, 200, {
        pluginId,
        version,
        protocol: { name: 'http-json', version: '1' },
        capabilityDigest,
        buildDigest,
        // Whether this instance can attest at all is operational truth a reader
        // needs: without it, evidence silently arrives as UNVERIFIED.
        attestation: { adapterId: adapterId || null, configured: Boolean(adapterId && adapterSecret) },
        storage: { mode: store.mode },
        budgetCeiling: BUDGET_CEILING,
      }, id);
    }

    const who = whoOr401(req);

    if (path === '/sources' && req.method === 'GET') {
      requireScope(who, 'telemetry.source.read');
      const items = await store.listSources(who.workspaces);
      // The contract has always said {items}; the old {sources,nextCursor}
      // shape was server-side drift with no consumer to preserve.
      return send(res, 200, { items }, id);
    }

    if (path === '/sources' && req.method === 'POST') {
      requireScope(who, 'telemetry.source.write');
      const actorId = requireUser(who);
      const body = await readJson(req);
      const parsed = validateSourceBody(body, { requireWorkspace: true });
      if (!workspaceAllowed(who, parsed.workspaceId)) {
        throw Object.assign(new Error('the signed caller context does not include this workspace'), {
          status: 403,
          code: 'ZBX_WORKSPACE_FORBIDDEN',
        });
      }
      const row = await store.createSource({
        sourceId: crypto.randomUUID(),
        workspaceId: parsed.workspaceId,
        createdBy: actorId,
        name: parsed.name,
        endpoint: parsed.endpoint,
        credential: parsed.credential,
        verifyTls: parsed.verifyTls,
        budget: parsed.budget,
      });
      return send(res, 201, sourceView(row), id);
    }

    const sourceMatch = path.match(/^\/sources\/([^/]+)$/);
    if (sourceMatch && req.method === 'PUT') {
      requireScope(who, 'telemetry.source.write');
      const actorId = requireUser(who);
      const body = await readJson(req);
      const parsed = validateSourceBody(body, { requireWorkspace: false });
      const row = await store.updateSource(requireUuidPath(sourceMatch[1], 'SOURCE_NOT_FOUND'), who.workspaces, parsed, actorId);
      if (!row) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      return send(res, 200, sourceView(row), id);
    }

    const probeMatch = path.match(/^\/sources\/([^/]+)\/probe$/);
    if (probeMatch && req.method === 'POST') {
      requireScope(who, 'telemetry.source.write');
      const actorId = requireUser(who);
      const row = await store.getSource(requireUuidPath(probeMatch[1], 'SOURCE_NOT_FOUND'), who.workspaces);
      if (!row) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      // A probe that cannot resolve its secret still runs, so it reports
      // UNAUTHORIZED rather than a local configuration error the operator
      // cannot distinguish from a bad token.
      const result = await probe({
        sourceId: row.source_id,
        endpoint: row.endpoint,
        verifyTls: row.verify_tls,
        budget: row.budget,
        secret: resolveSecretQuietly(row.credential_ref),
      });
      const updated = await store.recordProbe(row.source_id, who.workspaces, result, statusFromProbe(result, { verifyTls: row.verify_tls }), actorId);
      if (!updated) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      return send(res, 200, result, id);
    }

    const hostsMatch = path.match(/^\/sources\/([^/]+)\/hosts$/);
    if (hostsMatch && req.method === 'GET') {
      requireScope(who, 'telemetry.source.read');
      const row = await store.getSource(requireUuidPath(hostsMatch[1], 'SOURCE_NOT_FOUND'), who.workspaces);
      if (!row) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      const result = await listHosts({
        sourceId: row.source_id,
        endpoint: row.endpoint,
        verifyTls: row.verify_tls,
        budget: row.budget,
        secret: resolveSecret(row.credential_ref),
      });
      return send(res, 200, result, id);
    }

    const itemsMatch = path.match(/^\/sources\/([^/]+)\/items$/);
    if (itemsMatch && req.method === 'GET') {
      requireScope(who, 'telemetry.source.read');
      const row = await store.getSource(requireUuidPath(itemsMatch[1], 'SOURCE_NOT_FOUND'), who.workspaces);
      if (!row) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      const result = await listItems(
        {
          sourceId: row.source_id,
          endpoint: row.endpoint,
          verifyTls: row.verify_tls,
          budget: row.budget,
          secret: resolveSecret(row.credential_ref),
        },
        url.searchParams.get('hostId'),
      );
      return send(res, 200, result, id);
    }

    const collectMatch = path.match(/^\/sources\/([^/]+)\/collect$/);
    if (collectMatch && req.method === 'POST') {
      // collect writes a retained collection and spends outbound budget, so a
      // read-only viewer cannot drive it (and cannot evict another operator's
      // un-attested collection through the retention cap).
      requireScope(who, 'telemetry.source.write');
      // collect persists a collection for attestation; a workload has no
      // principal and therefore no attributable evidence.
      const actorId = requireUser(who);
      const row = await store.getSource(requireUuidPath(collectMatch[1], 'SOURCE_NOT_FOUND'), who.workspaces);
      if (!row) throw Object.assign(new Error('no such source'), { status: 404, code: 'SOURCE_NOT_FOUND' });
      const body = await readJson(req);
      validateBudget(body.budget);
      const itemIds = Array.isArray(body.itemIds)
        ? body.itemIds.filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 64)
        : [];
      const result = await collect({
        source: {
          sourceId: row.source_id,
          endpoint: row.endpoint,
          verifyTls: row.verify_tls,
          budget: row.budget,
          secret: resolveSecret(row.credential_ref),
        },
        itemIds,
        window: body.window,
        budget: effectiveBudget(row.budget, body.budget),
      });
      const bodyBytes = evidenceBodyOf(result);
      await store.saveCollection({
        collectionId: result.collectionId,
        sourceId: row.source_id,
        workspaceId: row.workspace_id,
        createdBy: actorId,
        outcome: result.outcome,
        contentRef: result.contentRef,
        body: bodyBytes,
        observedAt: new Date(result.observedAt),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      return send(res, 200, result, id);
    }

    const attestMatch = path.match(/^\/collections\/([^/]+)\/attestation$/);
    if (attestMatch && req.method === 'POST') {
      requireScope(who, 'telemetry.source.write');
      requireUser(who);
      const collection = await store.getCollection(requireUuidPath(attestMatch[1], 'COLLECTION_NOT_FOUND'), who.workspaces);
      if (!collection) {
        throw Object.assign(new Error('no such collection, or it is no longer retained'), {
          status: 404,
          code: 'COLLECTION_NOT_FOUND',
        });
      }
      if (!adapterId || !adapterSecret) {
        // Refused rather than returned unsigned: an unsigned envelope would be
        // stored as UNVERIFIED while looking like attested evidence to a caller
        // that did not check.
        throw Object.assign(
          new Error('this instance has no evidence adapter credential, so it cannot attest a collection'),
          { status: 503, code: 'EVIDENCE_ADAPTER_NOT_CONFIGURED' },
        );
      }
      const body = await readJson(req);
      const incidentId = typeof body.incidentId === 'string' ? body.incidentId.toLowerCase() : '';
      if (!UUID_RE.test(incidentId)) {
        throw Object.assign(new Error('incidentId must be a UUID'), { status: 400, code: 'INVALID_REQUEST' });
      }
      const kind = body.kind === undefined ? 'METRIC_SNAPSHOT' : body.kind;
      if (!EVIDENCE_KINDS.has(kind)) {
        throw Object.assign(new Error('this plugin produces METRIC_SNAPSHOT evidence only'), {
          status: 400,
          code: 'INVALID_REQUEST',
        });
      }
      // TIMEOUT is not a measurement either: the deadline passed before an
      // answer, so signing it would dress "we do not know" as an observation.
      if (['UNAVAILABLE', 'UNKNOWN', 'TIMEOUT'].includes(collection.outcome)) {
        throw Object.assign(
          new Error('a collection that never obtained data cannot be attested as a measurement'),
          { status: 409, code: 'ZBX_COLLECTION_NOT_ATTESTABLE' },
        );
      }
      const envelope = signAttestation({
        adapterId,
        secret: adapterSecret,
        incidentId,
        kind,
        source: `zabbix:${collection.source_id}`,
        collectedAt: collection.observed_at.toISOString(),
        contentRef: collection.content_ref,
        issuedAt: new Date().toISOString(),
      });
      return send(res, 200, {
        // Exactly the body the Kernel's evidence endpoint expects, so the caller
        // relays it without reassembling the signed fields.
        evidence: {
          kind,
          source: `zabbix:${collection.source_id}`,
          collectedAt: collection.observed_at.toISOString(),
          contentRef: collection.content_ref,
          content: { contentType: 'application/json', body: collection.body },
          attestation: envelope,
        },
        outcome: collection.outcome,
      }, id);
    }

    return fail(res, 404, 'NOT_FOUND', 'no such endpoint', id);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const id = rid(req);
      const status = error.status || (error instanceof StorageUnavailableError ? 503 : error instanceof SourceConflictError ? 409 : 500);
      const code = error.code || (status === 500 ? 'INTERNAL' : 'INVALID_REQUEST');
      if (status >= 500) {
        logger.error(
          `zabbix-source internal error (${id}) ${code}: ${redact(error instanceof Error ? error.message : String(error), knownSecrets())}`,
        );
      }
      // Below 500 the message is the caller's own input problem and is safe to
      // return once redacted; at 500 it is replaced, because an internal message
      // is the one most likely to quote a token or a host path.
      fail(
        res,
        status,
        code,
        status < 500 ? error.message : 'internal zabbix-source error',
        id,
        Boolean(error.retryable),
      );
    });
  });

  return {
    server,
    state,
    async close() {
      state.stopping = true;
      const closed = new Promise((resolve) => server.close(resolve));
      // Keep-alive sockets from fetch/Playwright would otherwise hold the close
      // open until their timeout; a test that cannot stop its server is not a
      // passing test.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closed;
      await store.close();
    },
  };
}

/**
 * Start the plugin from the environment. This is the only path that listens on
 * a port; `createPlugin` is the test entry point.
 */
export async function startServer(env = process.env) {
  const pluginId = env.OPSWEAVE_PLUGIN_ID || DEFAULTS.pluginId;
  const store = await openStorage({
    databaseUrl: env.OPSWEAVE_PLUGIN_DATABASE_URL || '',
    allowMemory: env.OPSWEAVE_ALLOW_MEMORY_STORAGE === '1',
  });
  const verifyIdentity = createIdentityResolver({
    contextKeyHex: env.OPSWEAVE_CALLER_CONTEXT_KEY || '',
    pluginId,
  });
  const plugin = createPlugin({
    pluginId,
    version: env.OPSWEAVE_PLUGIN_VERSION || DEFAULTS.version,
    capabilityDigest: env.OPSWEAVE_CAPABILITY_DIGEST,
    buildDigest: env.OPSWEAVE_BUILD_DIGEST,
    adapterId: env.OPSWEAVE_EVIDENCE_ADAPTER_ID || '',
    adapterSecret: env.OPSWEAVE_EVIDENCE_ADAPTER_SECRET || '',
    secretMap: parseSecretMap(env.OPSWEAVE_ZABBIX_SECRETS),
    store,
    verifyIdentity,
  });
  const port = Number(env.PORT || DEFAULTS.port);
  plugin.server.listen(port, '0.0.0.0', () => {
    console.log(`zabbix-source ${pluginId} listening on ${port} (storage=${store.mode})`);
    if (!env.OPSWEAVE_EVIDENCE_ADAPTER_ID || !env.OPSWEAVE_EVIDENCE_ADAPTER_SECRET) {
      // Said once at startup, because "evidence is arriving as UNVERIFIED" is
      // otherwise discovered much later by a reader who trusted it.
      console.log('zabbix-source: no evidence adapter credential configured; collections cannot be attested');
    }
  });
  process.on('SIGTERM', () => {
    plugin.close().then(() => process.exit(0)).catch(() => process.exit(1));
  });
  return plugin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error(`zabbix-source failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { sourceView };
