// Caller identity for OpsWeave plugins: one implementation, three token kinds.
//
// Authority: docs/adr/ADR-016-g13-source-persistence-scoped-identity-and-evidence-content.md,
// docs/design/g13-b0/permission-matrix.md and docs/adr/ADR-020-plugin-identity-hardening.md.
//
// B2.1 closed the last gap here. The data plugins used to fall back to the bare
// `x-opsweave-user-role` header whenever no signed user context was present, and
// they never verified the signed `owu1` context at all - so the Gateway's signed
// identity was rejected and the self-declared role header became the identity on
// the production path. That header is not a weaker identity; it is not an
// identity. Nothing in this module reads it.
//
// Accepted tokens, and nothing else:
//
//   * `x-opsweave-user-context` (owu1) - a user session proxied by the Kernel
//     Gateway. Binds the user, the role, THIS plugin, and the business workspaces
//     the Kernel's membership table named at the instant of the call.
//   * `x-opsweave-caller-context` (oww1) - a workload capability call. Binds the
//     calling plugin, the capability, and the grant scope (which may name
//     workspaces as `workspace:<uuid>` entries).
//   * `x-opsweave-automation-context` (owa2) - an automation principal, Ed25519
//     signed by the Kernel. A plugin holds only the public key and cannot mint it.
//
// owu1/oww1 are base64url(payload) + "." + base64url(HMAC-SHA256) under a
// per-plugin key the Kernel derives from its cursor secret:
//   HMAC(cursor_secret, "caller-context:" + pluginId)
// delivered as OPSWEAVE_CALLER_CONTEXT_KEY (hex). With no key every request is
// anonymous: refusing is the only safe direction.
//
// This file is the canonical source. plugins/*/backend/identity.mjs are byte
// copies written by scripts/sync-plugin-identity.mjs; a CI gate re-checks them
// because each OCI image is built from its own backend directory and cannot
// import across plugin boundaries.

import crypto from 'node:crypto';

export const USER_CONTEXT_PREFIX = 'owu1';
export const WORKLOAD_CONTEXT_PREFIX = 'oww1';
export const AUTOMATION_CONTEXT_PREFIX = 'owa2';

/** How far into the future an `issuedAt` may be before the token is refused. */
const CLOCK_SKEW_SECONDS = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseClaims(encoded) {
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
    return claims;
  } catch {
    return null;
  }
}

function freshEnough(claims, now) {
  const nowSeconds = Math.floor(now() / 1000);
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= nowSeconds) return false;
  if (!Number.isFinite(claims.issuedAt) || claims.issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    return false;
  }
  return true;
}

function decodeAutomation(token, publicKey, expectedPluginId, now) {
  if (typeof token !== 'string' || !token || !publicKey) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== AUTOMATION_CONTEXT_PREFIX) return null;
  const [, encoded, signature] = parts;
  let valid;
  try {
    valid = crypto.verify(null, Buffer.from(encoded), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return null;
  }
  if (!valid) return null;
  const claims = parseClaims(encoded);
  if (!claims || claims.v !== 1 || claims.kind !== 'automation') return null;
  if (expectedPluginId && claims.pluginId !== expectedPluginId) return null;
  if (!freshEnough(claims, now)) return null;
  return claims;
}

function decodeSigned(token, prefix, key, expectedPluginId, now) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const encoded = parts[1];
  const signature = parts[2];
  const expected = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  // Compare equal-length buffers: timingSafeEqual throws on a length mismatch,
  // and a length mismatch is itself an invalid signature, not a crash.
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
  const claims = parseClaims(encoded);
  if (!claims || claims.v !== 1) return null;
  // A user context names the plugin it was minted for; a workload context names
  // the CALLER plugin, not this provider, so only the signature binds it here.
  if (expectedPluginId && claims.pluginId !== expectedPluginId) return null;
  if (!freshEnough(claims, now)) return null;
  return claims;
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * Build the identity resolver for one plugin instance.
 *
 * @param {object} options
 * @param {string} options.contextKeyHex   hex key the Kernel injected (owu1/oww1).
 * @param {string} options.pluginId        the plugin this resolver serves.
 * @param {object} [options.roleScopes]    role -> capability scopes for THIS plugin.
 * @param {string} [options.scopePrefix]   which grant scopes are capability scopes.
 * @param {Record<string, string[]>} [options.automationScopes] allowedOps -> scopes,
 *        the plugin's own mapping of the operations its automation path supports.
 * @param {string} [options.automationPublicKeyHex] the Kernel's Ed25519 public key.
 * @param {() => number} [options.now]
 */
export function createIdentityResolver({
  contextKeyHex,
  pluginId,
  roleScopes = {},
  scopePrefix = '',
  automationScopes = {},
  automationPublicKeyHex = '',
  now = () => Date.now(),
}) {
  const key =
    typeof contextKeyHex === 'string' && /^[0-9a-fA-F]{2,128}$/.test(contextKeyHex)
      ? Buffer.from(contextKeyHex, 'hex')
      : null;
  // The Kernel sends only its Ed25519 public key. It cannot sign `owa2`.
  const automationKey =
    typeof automationPublicKeyHex === 'string' && /^[0-9a-fA-F]{64}$/.test(automationPublicKeyHex)
      ? crypto.createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: Buffer.from(automationPublicKeyHex, 'hex').toString('base64url'),
          },
          format: 'jwk',
        })
      : null;

  return function identity(headers) {
    if (!key) return null;

    const user = decodeSigned(headers['x-opsweave-user-context'], USER_CONTEXT_PREFIX, key, pluginId, now);
    if (user) {
      const role = String(user.role || '').toLowerCase();
      const scopes = roleScopes[role];
      // An unknown role is not "no scopes": it is a token this plugin does not
      // understand, and accepting it would let the Kernel's role vocabulary and
      // this plugin's drift apart silently.
      if (!Array.isArray(scopes)) return null;
      if (typeof user.userId !== 'string' || !user.userId) return null;
      return {
        kind: 'user',
        userId: user.userId,
        role,
        scopes: scopes.slice(),
        workspaces: stringList(user.workspaceIds).map((value) => value.toLowerCase()),
        requestId: user.requestId,
      };
    }

    const automation = decodeAutomation(
      headers['x-opsweave-automation-context'],
      automationKey,
      pluginId,
      now,
    );
    if (automation) {
      const ops = stringList(automation.allowedOps);
      // The Kernel resolves the workspace/source and signs them into the token.
      // The plugin never accepts either from the request body.
      const workspaceId = String(automation.workspaceId || '').toLowerCase();
      const sourceId = String(automation.sourceId || '');
      if (!UUID_RE.test(workspaceId) || !sourceId) return null;
      const scopes = [];
      for (const op of ops) {
        const mapped = automationScopes[op];
        if (Array.isArray(mapped)) scopes.push(...stringList(mapped));
      }
      return {
        kind: 'automation',
        principalId: automation.principalId,
        pluginId: automation.pluginId,
        workspaceId,
        sourceId,
        ops,
        scopes: [...new Set(scopes)],
        workspaces: [workspaceId],
        requestId: automation.jti,
      };
    }

    const workload = decodeSigned(headers['x-opsweave-caller-context'], WORKLOAD_CONTEXT_PREFIX, key, null, now);
    if (workload) {
      const granted = stringList(workload.scope);
      // A workload has no user session and therefore no automatic workspace
      // membership. It may only act inside workspaces its grant names explicitly,
      // as `workspace:<uuid>` entries.
      const workspaces = granted
        .filter((value) => value.startsWith('workspace:'))
        .map((value) => value.slice('workspace:'.length).toLowerCase())
        .filter((value) => UUID_RE.test(value));
      const scopes = granted.filter(
        (value) => !value.startsWith('workspace:') && value.startsWith(scopePrefix),
      );
      return {
        kind: 'workload',
        pluginId: workload.pluginId,
        capability: workload.capabilityName,
        scopes,
        workspaces,
        requestId: workload.jti,
      };
    }

    return null;
  };
}

export function hasScope(who, scope) {
  return Boolean(who && Array.isArray(who.scopes) && who.scopes.includes(scope));
}

export function workspaceAllowed(who, workspaceId) {
  return Boolean(who && Array.isArray(who.workspaces) && who.workspaces.includes(String(workspaceId).toLowerCase()));
}

/**
 * The workspace a request acts in.
 *
 * A caller that names one gets it only if its scope covers it; a caller that
 * names none gets the single workspace it holds, and an explicit refusal when it
 * holds several - guessing would be a silently wrong grant.
 *
 * Returns `{ workspaceId }` or `{ error, message }`; callers map `error` to a
 * stable response code rather than inventing their own.
 */
export function resolveWorkspace(who, named) {
  const workspaces = Array.isArray(who?.workspaces) ? who.workspaces : [];
  if (named !== undefined && named !== null && named !== '') {
    if (typeof named !== 'string') {
      return { error: 'WORKSPACE_INVALID', message: 'workspaceId must be a UUID' };
    }
    const value = named.toLowerCase();
    if (!UUID_RE.test(value)) {
      return { error: 'WORKSPACE_INVALID', message: 'workspaceId must be a UUID' };
    }
    if (!workspaces.includes(value)) {
      return { error: 'WORKSPACE_FORBIDDEN', message: 'the caller is not authorized in this workspace' };
    }
    return { workspaceId: value };
  }
  if (workspaces.length === 1) return { workspaceId: workspaces[0] };
  if (workspaces.length === 0) {
    return {
      error: 'WORKSPACE_REQUIRED',
      message: 'the caller is not a member of any business workspace',
    };
  }
  return {
    error: 'WORKSPACE_REQUIRED',
    message: 'workspaceId is required when the caller holds more than one workspace',
  };
}

/** Sign a context exactly as the Kernel does. Exported for the socket tests and
 *  for local development; production plugins never mint their own identity. */
export function signContext({ keyHex, prefix, payload }) {
  const key = Buffer.from(keyHex, 'hex');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return `${prefix}.${encoded}.${signature}`;
}
