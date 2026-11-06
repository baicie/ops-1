// Caller identity for the Zabbix source plugin.
//
// Two signed tokens are accepted, and nothing else:
//
//   * `x-opsweave-user-context` (owu1) is issued by the Kernel Gateway for a
//     user session. It binds the user, their role, this plugin and the business
//     workspaces the Kernel's membership table currently names.
//   * `x-opsweave-caller-context` (oww1) is issued by the Kernel for a workload
//     capability call. It binds the calling plugin, capability and grant scope.
//
// The bare `x-opsweave-user-role` header is deliberately NOT read. G10's
// permission ADR registered that trust as R1: it is safe only while the plugin
// data port is unreachable, and a deployment that exposes the port turns a
// self-declared admin header into a grant. A signature makes the boundary the
// key, not the network position.
//
// Both tokens are base64url(payload) + "." + base64url(HMAC-SHA256) under a
// per-plugin key derived by the Kernel from its cursor secret:
//   HMAC(cursor_secret, "caller-context:" + pluginId)
// which the instance receives as OPSWEAVE_CALLER_CONTEXT_KEY (hex).

import crypto from 'node:crypto';

export const USER_CONTEXT_PREFIX = 'owu1';
export const WORKLOAD_CONTEXT_PREFIX = 'oww1';
export const AUTOMATION_CONTEXT_PREFIX = 'owa1';

const ROLE_SCOPES = {
  admin: ['telemetry.source.read', 'telemetry.source.write'],
  operator: ['telemetry.source.read', 'telemetry.source.write'],
  viewer: ['telemetry.source.read'],
};

function decodePayload(token, prefix, key, expectedPluginId, now) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const encoded = parts[1];
  const signature = parts[2];
  const expected = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  // Compare equal-length buffers; timingSafeEqual throws on a length mismatch,
  // and a length mismatch is itself an invalid signature, not a crash.
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || claims.v !== 1) return null;
  // A user context names the plugin it was minted for; a workload context names
  // the CALLER plugin, not this provider, so only the signature binds it here.
  if (expectedPluginId && claims.pluginId !== expectedPluginId) return null;
  const nowSeconds = Math.floor(now() / 1000);
  if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= nowSeconds) return null;
  if (!Number.isFinite(claims.issuedAt) || claims.issuedAt > nowSeconds + 60) return null;
  return claims;
}

/**
 * Build the identity resolver for one plugin instance.
 *
 * `contextKeyHex` is the hex key the Kernel injected. With no key, no signed
 * token can be checked, so every request is anonymous: refusing is the only
 * safe direction.
 */
export function createIdentityResolver({ contextKeyHex, pluginId, now = () => Date.now() }) {
  const key = typeof contextKeyHex === 'string' && /^[0-9a-fA-F]{2,128}$/.test(contextKeyHex)
    ? Buffer.from(contextKeyHex, 'hex')
    : null;

  return function identity(headers) {
    if (!key) return null;
    const user = decodePayload(headers['x-opsweave-user-context'], USER_CONTEXT_PREFIX, key, pluginId, now);
    if (user) {
      const role = String(user.role || '').toLowerCase();
      const scope = ROLE_SCOPES[role];
      if (!scope) return null;
      const workspaces = Array.isArray(user.workspaceIds)
        ? user.workspaceIds.filter((value) => typeof value === 'string')
        : [];
      return {
        kind: 'user',
        userId: user.userId,
        role,
        scopes: scope,
        workspaces,
        requestId: user.requestId,
      };
    }

    const automation = decodePayload(headers['x-opsweave-automation-context'], AUTOMATION_CONTEXT_PREFIX, key, pluginId, now);
    if (automation) {
      if (automation.kind !== 'automation') return null;
      const ops = Array.isArray(automation.allowedOps)
        ? automation.allowedOps.filter((value) => typeof value === 'string')
        : [];
      // The Kernel resolves the workspace/source and signs them into the token.
      // The plugin does not accept either from the request body.
      const workspaceId = String(automation.workspaceId || '');
      const sourceId = String(automation.sourceId || '');
      if (!workspaceId || !sourceId) return null;
      const scopes = [];
      if (ops.includes('SOURCE_COLLECT') || ops.includes('EVIDENCE_APPEND')) {
        scopes.push('telemetry.source.write');
      }
      return {
        kind: 'automation',
        principalId: automation.principalId,
        pluginId: automation.pluginId,
        workspaceId,
        sourceId,
        ops,
        scopes,
        workspaces: [workspaceId],
        requestId: automation.jti,
      };
    }

    const workload = decodePayload(headers['x-opsweave-caller-context'], WORKLOAD_CONTEXT_PREFIX, key, null, now);
    if (workload) {
      const granted = Array.isArray(workload.scope) ? workload.scope.filter((value) => typeof value === 'string') : [];
      // A workload has no user session and therefore no automatic workspace
      // membership. It may only act inside workspaces its grant names
      // explicitly, as `workspace:<uuid>` entries.
      const workspaces = granted
        .filter((value) => value.startsWith('workspace:'))
        .map((value) => value.slice('workspace:'.length));
      const scopes = granted.filter((value) => value.startsWith('telemetry.source.'));
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
  return Boolean(who && Array.isArray(who.workspaces) && who.workspaces.includes(workspaceId));
}

/** Sign a context exactly as the Kernel does. Exported for the socket tests and
 *  for local development; production plugins never mint their own identity. */
export function signContext({ keyHex, prefix, payload }) {
  const key = Buffer.from(keyHex, 'hex');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return `${prefix}.${encoded}.${signature}`;
}
