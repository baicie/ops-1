// Credential endpoint binding (G13-A.2).
//
// A workspace-scoped secret reference is not enough: `telemetry.source.write`
// lets an operator edit a source's endpoint. Without a binding, the next
// hosts/items/collect call resolves the approved token and sends it to whatever
// URL the operator typed. The binding is the server-authoritative answer to
// "where may this credential be sent":
//
//   pluginId + workspaceId + secretRef + approvedEndpoint + tlsPolicy
//
// The Kernel owns the binding configuration and injects this plugin's slice as
// OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS. The plugin checks it on create, update
// and every outbound read, so a historical row that predates a binding also
// fails closed.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TLS_POLICIES = new Set(['VERIFY', 'TEST_PLAINTEXT']);

/**
 * The exact origin+path form used for comparison. Scheme/host are lowercased,
 * default ports dropped, and query/fragment are rejected: a token-bearing
 * request to a URL whose query differs is still a different destination, and a
 * binding that cannot state it exactly is not a binding.
 */
export function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const defaultPort = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
  const port = url.port && !defaultPort ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname}`;
}

/**
 * Parse one plugin's slice of OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS.
 * Shape: {workspaceId: {secretref: {endpoint, tls}}}. Malformed entries are
 * dropped; an empty map means no credential may be used (fail closed).
 */
export function parseCredentialBindings(raw, pluginId) {
  const out = {};
  if (typeof raw !== 'string' || !raw.trim()) return out;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  // The Kernel injects this plugin's slice (workspace -> ref -> binding), not
  // the whole map. Accept the full shape too for local tests and older configs.
  const perPlugin = parsed?.[pluginId] ?? parsed;
  if (!perPlugin || typeof perPlugin !== 'object' || Array.isArray(perPlugin)) return out;
  for (const [workspaceId, refs] of Object.entries(perPlugin)) {
    if (!UUID_RE.test(workspaceId) || !refs || typeof refs !== 'object' || Array.isArray(refs)) continue;
    const inner = {};
    for (const [ref, binding] of Object.entries(refs)) {
      if (typeof ref !== 'string' || !ref.startsWith('secretref:')) continue;
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
      const endpoint = normalizeEndpoint(binding.endpoint);
      if (!endpoint || !TLS_POLICIES.has(binding.tls)) continue;
      inner[ref] = { endpoint, tls: binding.tls };
    }
    if (Object.keys(inner).length > 0) out[workspaceId.toLowerCase()] = inner;
  }
  return out;
}

function refuse(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * The single policy check used by create, update, probe, hosts, items, collect
 * and attestation. `allowUnbound` exists only for a developer process with the
 * flat development secret map (never for a deployment); the Kernel-delivered
 * workspace mode always goes through the binding.
 */
export function assertCredentialBinding({
  bindings,
  workspaceId,
  ref,
  endpoint,
  verifyTls,
  allowInsecureEndpoints = false,
  allowUnbound = false,
}) {
  if (allowUnbound) return;
  const binding = bindings?.[workspaceId]?.[ref];
  if (!binding) {
    throw refuse(
      422,
      'ZBX_CREDENTIAL_BINDING_REQUIRED',
      'this credential reference has no approved endpoint binding for this workspace, so it cannot be used',
    );
  }
  const actual = normalizeEndpoint(endpoint);
  if (!actual || actual !== binding.endpoint) {
    throw refuse(
      422,
      'ZBX_CREDENTIAL_ENDPOINT_MISMATCH',
      'this credential is bound to a different endpoint; change the binding in the deployment configuration, not the source',
    );
  }
  const secure = actual.startsWith('https:') && verifyTls !== false;
  if (binding.tls === 'TEST_PLAINTEXT') {
    if (!allowInsecureEndpoints) {
      throw refuse(
        403,
        'ZBX_INSECURE_ENDPOINT_FORBIDDEN',
        'a plaintext/disabled-TLS endpoint is allowed only when the deployment explicitly enables insecure test endpoints',
      );
    }
    return;
  }
  if (!secure) {
    throw refuse(
      403,
      'ZBX_INSECURE_ENDPOINT_FORBIDDEN',
      'this credential is bound with TLS verification required; a plaintext endpoint or verifyTls=false is refused',
    );
  }
}
