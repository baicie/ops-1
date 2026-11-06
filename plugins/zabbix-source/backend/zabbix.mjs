// The Zabbix side of the plugin, kept separate from the HTTP server so the
// collection semantics can be tested without opening a socket.
//
// Two rules from the repository shape every function here:
//
//   rules/05  EMPTY, NO_DATA, PARTIAL, UNKNOWN, UNAVAILABLE and TIMEOUT are six
//             different facts and missing data never becomes 0. A sample with no
//             observed number is `value: null` plus an `absenceReason`.
//   rules/03  A credential is a reference until the moment of use. The resolved
//             secret never enters a URL, a log line, an error body or a stored
//             row, and `redact()` is applied to everything that leaves here.
//
// AGENTS.md also requires every collection to carry a budget: a window ceiling,
// an item ceiling, a per-item sample ceiling, a timeout and a concurrency cap.
// A request that exceeds one is clamped and the result says so; it is never
// quietly truncated.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';

/** Hard ceilings. A caller may lower these, never raise them. */
export const BUDGET_CEILING = Object.freeze({
  maxWindowSeconds: 86400,
  maxItems: 500,
  maxSamplesPerItem: 5000,
  requestTimeoutMs: 30000,
  maxConcurrency: 4,
});

export const BUDGET_DEFAULT = Object.freeze({
  maxWindowSeconds: 3600,
  maxItems: 100,
  maxSamplesPerItem: 1000,
  requestTimeoutMs: 10000,
  maxConcurrency: 2,
});

/** Response bytes accepted from one Zabbix call before it is abandoned. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The signed-payload version tag. Must match the Kernel's ATTESTATION_VERSION. */
export const ATTESTATION_VERSION = 'opsweave-evidence-attestation-v2';

const ALLOW_LOOPBACK = process.env.OPSWEAVE_ALLOW_LOOPBACK_SOURCE === '1';
const ALLOWED_PRIVATE_HOSTS = new Set(
  (process.env.OPSWEAVE_ALLOW_PRIVATE_SOURCE_HOSTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Clamp a requested budget to the ceiling.
 *
 * Returns the effective budget and the list of fields that were lowered, so the
 * caller can report `clamped` instead of pretending it got what it asked for.
 */
export function resolveBudget(requested = {}) {
  const budget = { ...BUDGET_DEFAULT };
  const clamped = [];
  for (const key of Object.keys(BUDGET_CEILING)) {
    const raw = requested[key];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw badRequest('ZABBIX_BUDGET_INVALID', `budget.${key} must be a positive number`);
    }
    if (value > BUDGET_CEILING[key]) {
      budget[key] = BUDGET_CEILING[key];
      clamped.push(key);
    } else {
      budget[key] = Math.floor(value);
    }
  }
  return { budget, clamped };
}

/**
 * Clamp a requested window to the budget, keeping the most recent part.
 *
 * Dropping the older end is the honest choice: the result reports the window it
 * actually covered, so a reader can see that the request was narrowed rather
 * than assuming the gap means "nothing happened".
 */
export function resolveWindow(from, to, budget) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw badRequest('ZABBIX_WINDOW_INVALID', 'window.from and window.to must be RFC3339 timestamps');
  }
  if (end <= start) {
    throw badRequest('ZABBIX_WINDOW_INVALID', 'window.to must be after window.from');
  }
  const seconds = (end.getTime() - start.getTime()) / 1000;
  if (seconds <= budget.maxWindowSeconds) {
    return { window: { from: start.toISOString(), to: end.toISOString() }, clamped: false };
  }
  const narrowed = new Date(end.getTime() - budget.maxWindowSeconds * 1000);
  return {
    window: { from: narrowed.toISOString(), to: end.toISOString() },
    clamped: true,
  };
}

// ---------------------------------------------------------------------------
// Outbound safety (SSRF, redirects, size, timeout)
// ---------------------------------------------------------------------------

function ipv4Bytes(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

function isNonPublicIPv4(ip) {
  const b = ipv4Bytes(ip);
  if (!b) return true;
  return (
    b[0] === 0 ||
    b[0] === 10 ||
    b[0] === 127 ||
    (b[0] === 100 && b[1] >= 64 && b[1] <= 127) ||
    (b[0] === 169 && b[1] === 254) ||
    (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
    (b[0] === 192 && b[1] === 0 && b[2] === 0) ||
    (b[0] === 192 && b[1] === 0 && b[2] === 2) ||
    (b[0] === 192 && b[1] === 88 && b[2] === 99) ||
    (b[0] === 192 && b[1] === 168) ||
    (b[0] === 198 && (b[1] === 18 || b[1] === 19)) ||
    (b[0] === 198 && b[1] === 51 && b[2] === 100) ||
    (b[0] === 203 && b[1] === 0 && b[2] === 113) ||
    b[0] >= 224
  );
}

function parseIPv6(value) {
  try {
    const [head, tail] = value.split('::');
    const expand = (part) => (part ? part.split(':').filter(Boolean).map((g) => parseInt(g, 16)) : []);
    let groups;
    if (tail === undefined) {
      groups = expand(head);
    } else {
      const left = expand(head);
      const right = expand(tail);
      const fill = 8 - left.length - right.length;
      if (fill < 0) return null;
      groups = [...left, ...new Array(fill).fill(0), ...right];
    }
    if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) return null;
    return groups.flatMap((group) => [group >> 8, group & 0xff]);
  } catch {
    return null;
  }
}

function isPrivate(ip) {
  const value = String(ip).replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(value)) return isNonPublicIPv4(value);
  if (!net.isIPv6(value)) return true;
  const bytes = parseIPv6(value);
  if (!bytes) return true;
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isNonPublicIPv4(bytes.slice(12).join('.'));
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return isNonPublicIPv4(bytes.slice(12).join('.'));
  if ((bytes[0] & 0xe0) !== 0x20) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  return false;
}

/**
 * Validate an endpoint before it is dialled.
 *
 * Rejects a userinfo component outright: a token in the URL would reach every
 * access log and proxy on the path, which rules/03 forbids. DNS is resolved once
 * and the resolved address is reused for the connection, so the name cannot
 * resolve to a public address for the check and a private one for the socket.
 */
export async function assertEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw sourceFailure('ZABBIX_ENDPOINT_INVALID', 'endpoint is not a URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw sourceFailure('ZABBIX_SSRF_BLOCKED', 'endpoint must be http or https');
  }
  if (url.username || url.password) {
    throw sourceFailure(
      'ZABBIX_ENDPOINT_INVALID',
      'endpoint must not carry credentials; configure a credential reference instead',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(host);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: host, family: literalFamily }];
  } else {
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw sourceFailure('ZABBIX_DNS_FAILED', 'endpoint host does not resolve');
    }
  }
  if (!addresses.length) {
    throw sourceFailure('ZABBIX_DNS_FAILED', 'endpoint host does not resolve');
  }
  for (const { address } of addresses) {
    const loopbackAllowed = ALLOW_LOOPBACK && (address === '127.0.0.1' || address === '::1');
    if (isPrivate(address) && !loopbackAllowed && !ALLOWED_PRIVATE_HOSTS.has(host)) {
      throw sourceFailure('ZABBIX_SSRF_BLOCKED', 'endpoint resolves to a non-public address');
    }
  }
  return { url, addresses };
}

/**
 * One Zabbix JSON-RPC call.
 *
 * `secret` is used here and nowhere else: it goes into the Authorization header
 * and is never attached to the returned object, so a caller cannot accidentally
 * serialise it. Distinguishes a timeout from an unreachable endpoint and from a
 * reply that arrived but could not be parsed, because the three lead to
 * different outcomes (TIMEOUT / UNAVAILABLE / UNKNOWN).
 */
export async function rpc({ endpoint, method, params, secret, timeoutMs, verifyTls = true, transport }) {
  if (transport) {
    // Test seam: the HTTP layer is replaced, the semantics below are not.
    return transport({ endpoint, method, params, timeoutMs });
  }
  const { url, addresses } = await assertEndpoint(endpoint);
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
  const headers = {
    'content-type': 'application/json-rpc',
    'content-length': Buffer.byteLength(body),
    accept: 'application/json',
  };
  // apiinfo.version is the one method Zabbix refuses when authenticated.
  if (secret && method !== 'apiinfo.version') headers.authorization = `Bearer ${secret}`;

  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(value);
    };
    const request = client.request(
      url,
      {
        method: 'POST',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: verifyTls,
        lookup: (_hostname, options, callback) => {
          // Node 22's autoSelectFamily asks lookup for the whole address list
          // (`options.all`) and expects an array of {address, family}. Returning
          // a single string here produced ERR_INVALID_IP_ADDRESS for every
          // DNS-named endpoint - the container could reach host.docker.internal
          // with fetch but not through this client.
          if (options && options.all) {
            callback(null, addresses.map((entry) => ({
              address: entry.address,
              family: entry.family === 6 ? 6 : 4,
            })));
            return;
          }
          callback(null, addresses[0].address, addresses[0].family === 6 ? 6 : 4);
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400) {
          response.resume();
          return finish(sourceFailure('ZABBIX_REDIRECT_BLOCKED', 'endpoint answered with a redirect'));
        }
        if (status < 200 || status >= 300) {
          response.resume();
          return finish(
            sourceFailure('ZABBIX_HTTP_ERROR', `endpoint answered HTTP ${status}`, { status }),
          );
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(sourceFailure('ZABBIX_RESPONSE_TOO_LARGE', 'response exceeded the byte ceiling'));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // The call was made and may well have executed; the outcome is not
            // knowable from here, which is UNKNOWN and not a failure to reach.
            return finish(sourceFailure('ZABBIX_RESPONSE_UNPARSEABLE', 'response was not JSON'));
          }
          if (parsed && parsed.error) {
            const code = Number(parsed.error.code);
            // -32602 with an auth message is how Zabbix reports a bad token.
            const unauthorized = code === -32602 || /not authori[sz]ed|permission/i.test(String(parsed.error.data || ''));
            return finish(
              sourceFailure(
                unauthorized ? 'ZABBIX_UNAUTHORIZED' : 'ZABBIX_API_ERROR',
                'endpoint rejected the call',
                { rpcCode: Number.isFinite(code) ? code : undefined },
              ),
            );
          }
          finish(null, parsed ? parsed.result : undefined);
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      finish(sourceFailure('ZABBIX_TIMEOUT', 'endpoint did not answer within the timeout'));
    });
    request.on('error', (error) => {
      if (error && error.code === 'ZABBIX_TIMEOUT') return finish(error);
      finish(sourceFailure('ZABBIX_UNREACHABLE', 'endpoint could not be reached'));
    });
    request.end(body);
  });
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Ask the endpoint for its version and report what happened.
 *
 * Never throws: an unreachable endpoint is an observation, not an error in this
 * plugin, and a caller needs it as queryable evidence. A timeout is TIMEOUT and
 * not UNAVAILABLE, because a healthy-but-slow server and a dead one are
 * different operational facts (rules/05).
 */
export async function probe(source, { transport } = {}) {
  const started = Date.now();
  const observedAt = new Date().toISOString();
  try {
    const version = await rpc({
      endpoint: source.endpoint,
      method: 'apiinfo.version',
      params: {},
      secret: undefined,
      timeoutMs: source.budget?.requestTimeoutMs ?? BUDGET_DEFAULT.requestTimeoutMs,
      verifyTls: source.verifyTls !== false,
      transport,
    });
    return {
      outcome: 'OK',
      apiVersion: typeof version === 'string' ? version.slice(0, 40) : undefined,
      latencyMs: Date.now() - started,
      observedAt,
    };
  } catch (error) {
    return {
      outcome: probeOutcome(error.code),
      latencyMs: Date.now() - started,
      observedAt,
      errorCode: error.code || 'ZABBIX_UNKNOWN',
    };
  }
}

function probeOutcome(code) {
  switch (code) {
    case 'ZABBIX_TIMEOUT':
      return 'TIMEOUT';
    case 'ZABBIX_UNAUTHORIZED':
      return 'UNAUTHORIZED';
    case 'ZABBIX_UNREACHABLE':
    case 'ZABBIX_DNS_FAILED':
    case 'ZABBIX_SSRF_BLOCKED':
    case 'ZABBIX_ENDPOINT_INVALID':
    case 'ZABBIX_REDIRECT_BLOCKED':
    case 'ZABBIX_HTTP_ERROR':
      return 'UNAVAILABLE';
    default:
      // Parse failures and anything unrecognised: the call may have been
      // executed, so the outcome is not known rather than known-bad.
      return 'UNKNOWN';
  }
}

/**
 * Derive a source status from its last probe.
 *
 * `verifyTls: false` caps the status at DEGRADED even on a clean probe: the
 * endpoint answered, but not under a setting that proves who answered.
 */
export function statusFromProbe(probeResult, { verifyTls = true } = {}) {
  if (!probeResult) return 'UNVERIFIED';
  switch (probeResult.outcome) {
    case 'OK':
      return verifyTls ? 'READY' : 'DEGRADED';
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'TIMEOUT':
    case 'UNAUTHORIZED':
    case 'UNKNOWN':
      // Reachability is not established either way, so the source is degraded,
      // not declared down. Inferring "stopped" from silence is forbidden.
      return 'DEGRADED';
    default:
      return 'UNVERIFIED';
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Pull history for a set of items over a window.
 *
 * The per-item result is the unit of success: one item timing out does not
 * discard the items that answered, and the collection reports PARTIAL with the
 * failing item's own outcome recorded against it. An item the server answers
 * with an empty history is EMPTY (the absence is established); an item that is
 * unsupported, disabled, unknown, or whose history was trimmed below the window
 * is NO_DATA (whether anything was recorded cannot be established). Those two
 * are the distinction rules/05 exists to protect, and neither becomes 0.
 */
export async function collect({ source, itemIds, window: requested, budget: requestedBudget, transport, now = () => new Date() }) {
  const { budget, clamped: budgetClamped } = resolveBudget(requestedBudget);
  if (!requested || typeof requested !== 'object') {
    // A missing window is a caller error with its own code, so the UI can say
    // "pick a time range" instead of rendering a malformed-timestamp message.
    throw badRequest('ZABBIX_WINDOW_REQUIRED', 'window is required: supply window.from and window.to');
  }
  const { window, clamped: windowClamped } = resolveWindow(requested.from, requested.to, budget);
  const clamped = [...budgetClamped.map((field) => `budget.${field}`)];
  if (windowClamped) clamped.push('window');

  const requestedItems = itemIds.length;
  let items = itemIds;
  if (items.length > budget.maxItems) {
    items = items.slice(0, budget.maxItems);
    clamped.push('items');
  }

  const observedAt = now().toISOString();
  const timeFrom = Math.floor(new Date(window.from).getTime() / 1000);
  const timeTill = Math.floor(new Date(window.to).getTime() / 1000);

  const series = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(budget.maxConcurrency, items.length || 1)).fill(0).map(
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        series[index] = await collectOne({
          source,
          itemId: items[index],
          window,
          timeFrom,
          timeTill,
          budget,
          transport,
        });
      }
    },
  );
  await Promise.all(workers);

  const answered = series.filter((entry) => entry.outcome !== 'UNAVAILABLE' && entry.outcome !== 'TIMEOUT' && entry.outcome !== 'UNKNOWN');
  const outcome = collectionOutcome({
    series,
    requestedItems,
    attemptedItems: items.length,
    clamped,
  });

  const result = {
    collectionId: crypto.randomUUID(),
    sourceId: source.sourceId,
    outcome,
    requestedItems,
    answeredItems: answered.length,
    clamped,
    series,
    budget,
    observedAt,
  };
  // Build the exact evidence bytes once. When the collection exceeds the
  // Kernel's 64 KiB content bound the snapshot is bounded, the outcome becomes
  // PARTIAL, and `snapshot` records what was left out; the digest is taken over
  // the snapshot bytes the caller will actually submit.
  const evidence = buildEvidence(result);
  result.outcome = evidence.outcome;
  if (evidence.snapshot) result.snapshot = evidence.snapshot;
  result.contentRef = evidence.contentRef;
  // Non-enumerable: the HTTP response stays the contract's CollectionResult,
  // while the server can persist the exact bytes this digest was taken over
  // without recomputing them (recomputation after the outcome became PARTIAL
  // would produce different bytes and break the digest).
  Object.defineProperty(result, 'evidenceBody', {
    value: evidence.body,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

/** The exact bytes stored for a collection, if this result came from collect().
 *  A result reconstructed from the database carries its body separately. */
export function evidenceBodyOf(result) {
  if (typeof result?.evidenceBody === 'string') return result.evidenceBody;
  return buildEvidence(result).body;
}

async function collectOne({ source, itemId, window, timeFrom, timeTill, budget, transport }) {
  const base = { itemId, requestedWindow: window };
  try {
    const rows = await rpc({
      endpoint: source.endpoint,
      method: 'history.get',
      params: {
        itemids: [itemId],
        time_from: timeFrom,
        time_till: timeTill,
        output: 'extend',
        sortfield: 'clock',
        sortorder: 'ASC',
        limit: budget.maxSamplesPerItem + 1,
      },
      secret: source.secret,
      timeoutMs: budget.requestTimeoutMs,
      verifyTls: source.verifyTls !== false,
      transport,
    });
    if (!Array.isArray(rows)) {
      // A reply arrived in a shape the contract does not describe. Whether the
      // item has history is not established, so it is NO_DATA, not EMPTY.
      return { ...base, outcome: 'NO_DATA', errorCode: 'ZABBIX_RESPONSE_SHAPE', samples: [] };
    }
    if (rows.length === 0) {
      // The server answered authoritatively that it holds nothing in the
      // window. The absence is a fact: EMPTY, with no samples and no zeros.
      return { ...base, outcome: 'EMPTY', coveredWindow: window, samples: [] };
    }
    let trimmed = false;
    let used = rows;
    if (rows.length > budget.maxSamplesPerItem) {
      used = rows.slice(0, budget.maxSamplesPerItem);
      trimmed = true;
    }
    const samples = used.map((row) => toSample(row));
    const covered = coveredWindow(samples, window, trimmed);
    return {
      ...base,
      outcome: trimmed ? 'PARTIAL' : 'OK',
      coveredWindow: covered,
      samples: trimmed
        ? [
            ...samples,
            // The ceiling cut the series short. Say so inside the series with a
            // null that carries its reason, so a reader cannot mistake the end
            // of the data for the end of the window.
            { occurredAt: covered.to, value: null, absenceReason: 'CLAMPED_BY_BUDGET' },
          ]
        : samples,
    };
  } catch (error) {
    return { ...base, outcome: itemOutcome(error.code), errorCode: error.code || 'ZABBIX_UNKNOWN', samples: [] };
  }
}

function toSample(row) {
  const clock = Number(row.clock);
  const nanos = Number(row.ns || 0);
  const occurredAt = Number.isFinite(clock)
    ? new Date(clock * 1000 + Math.floor(nanos / 1e6)).toISOString()
    : new Date(0).toISOString();
  const raw = row.value;
  const value = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value)) {
    // A non-numeric or absent reading is not a zero. It is an absence with a
    // reason, which is the whole point of rules/05.
    return { occurredAt, value: null, absenceReason: 'NOT_RECORDED' };
  }
  return { occurredAt, value, absenceReason: null };
}

function coveredWindow(samples, window, trimmed) {
  const stamps = samples.filter((s) => s.value !== null).map((s) => s.occurredAt);
  if (!stamps.length) return window;
  if (!trimmed) return window;
  // Only the part up to the last sample we actually kept is covered.
  return { from: window.from, to: stamps[stamps.length - 1] };
}

function itemOutcome(code) {
  switch (code) {
    case 'ZABBIX_TIMEOUT':
      return 'TIMEOUT';
    case 'ZABBIX_UNREACHABLE':
    case 'ZABBIX_DNS_FAILED':
    case 'ZABBIX_SSRF_BLOCKED':
    case 'ZABBIX_REDIRECT_BLOCKED':
    case 'ZABBIX_HTTP_ERROR':
    case 'ZABBIX_UNAUTHORIZED':
      return 'UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Roll the per-item outcomes into one collection outcome.
 *
 * Deliberately ordered: "nothing was reached" outranks "some of it was", and a
 * mixture is PARTIAL rather than the more flattering OK. A collection that
 * covered every item but was clamped is PARTIAL too — the window it reports is
 * narrower than the one that was asked for.
 */
export function collectionOutcome({ series, requestedItems, attemptedItems, clamped }) {
  if (requestedItems === 0) return 'EMPTY';
  if (series.length === 0) return 'UNAVAILABLE';

  const unreachable = series.filter((s) => s.outcome === 'UNAVAILABLE').length;
  const timedOut = series.filter((s) => s.outcome === 'TIMEOUT').length;
  const unknown = series.filter((s) => s.outcome === 'UNKNOWN').length;
  const failed = unreachable + timedOut + unknown;

  if (failed === series.length) {
    // Nothing was obtained. Which flavour of "nothing" matters.
    if (unreachable === series.length) return 'UNAVAILABLE';
    if (timedOut === series.length) return 'TIMEOUT';
    return 'UNKNOWN';
  }
  if (failed > 0) return 'PARTIAL';
  if (attemptedItems < requestedItems || clamped.length > 0) return 'PARTIAL';
  if (series.some((s) => s.outcome === 'PARTIAL')) return 'PARTIAL';

  const withData = series.filter((s) => s.outcome === 'OK').length;
  const empty = series.filter((s) => s.outcome === 'EMPTY').length;
  const noData = series.filter((s) => s.outcome === 'NO_DATA').length;
  if (withData > 0) return (empty > 0 || noData > 0) ? 'PARTIAL' : 'OK';
  // Every item answered and none had data. EMPTY only if every absence was
  // established; otherwise the honest answer is NO_DATA.
  if (noData > 0) return empty > 0 ? 'PARTIAL' : 'NO_DATA';
  return 'EMPTY';
}

// ---------------------------------------------------------------------------
// Inventory: hosts and items
// ---------------------------------------------------------------------------

/**
 * Zabbix's own availability flag, mapped to the contract's three values.
 *
 * Zabbix reports "0" for unknown, "1" for available and "2" for unavailable.
 * UNKNOWN is preserved rather than folded into UNAVAILABLE: "never checked" and
 * "checked and down" are different operational facts, and collapsing them is how
 * a monitoring gap gets reported as an outage (rules/05).
 */
function availability(raw) {
  const value = String(raw ?? '').trim();
  if (value === '1') return 'AVAILABLE';
  if (value === '2') return 'UNAVAILABLE';
  return 'UNKNOWN';
}

/** Zabbix `value_type` -> the contract's four names. */
function valueType(raw) {
  switch (String(raw ?? '').trim()) {
    case '0':
      return 'FLOAT';
    case '3':
      return 'INTEGER';
    case '4':
      return 'TEXT';
    default:
      return 'UNSUPPORTED';
  }
}

/**
 * One bounded inventory call, shared by hosts and items.
 *
 * The ceiling is applied server-side (Zabbix's own `limit`) and the response says
 * how many were withheld, because a short list must never be mistaken for a
 * small Zabbix. `truncated` is null when the count cannot be known - which is
 * different from 0.
 */
async function inventory({ source, method, params, budget, transport, project }) {
  const limit = budget.maxItems;
  try {
    // Ask for one more than the ceiling: if it comes back, there is at least one
    // row we are not returning, and the caller is told the list is incomplete.
    const rows = await rpc({
      endpoint: source.endpoint,
      method,
      params: { ...params, output: 'extend', limit: limit + 1 },
      secret: source.secret,
      timeoutMs: budget.requestTimeoutMs,
      verifyTls: source.verifyTls !== false,
      transport,
    });
    if (!Array.isArray(rows)) {
      return { outcome: 'NO_DATA', items: [], clamped: false, truncated: null };
    }
    if (rows.length === 0) {
      // The server answered authoritatively that there is nothing.
      return { outcome: 'EMPTY', items: [], clamped: false, truncated: null };
    }
    const clamped = rows.length > limit;
    const items = (clamped ? rows.slice(0, limit) : rows).map(project);
    return {
      outcome: clamped ? 'PARTIAL' : 'OK',
      items,
      clamped,
      // At least one withheld, so the exact remainder is not knowable from this
      // one call and is reported as such rather than invented.
      truncated: clamped ? null : 0,
    };
  } catch (error) {
    return {
      outcome: itemOutcome(error.code),
      items: [],
      clamped: false,
      truncated: null,
      errorCode: error.code || 'ZABBIX_UNKNOWN',
    };
  }
}

export function listHosts(source, { budget, transport } = {}) {
  return inventory({
    source,
    method: 'host.get',
    params: {},
    budget: budget || source.budget || BUDGET_DEFAULT,
    transport,
    project: (row) => ({
      hostId: String(row.hostid ?? '').slice(0, 64),
      name: String(row.name ?? row.host ?? '').slice(0, 200),
      available: availability(row.available),
    }),
  });
}

export function listItems(source, hostId, { budget, transport } = {}) {
  if (typeof hostId !== 'string' || !hostId) {
    throw badRequest('ZABBIX_HOST_REQUIRED', 'hostId is required');
  }
  return inventory({
    source,
    method: 'item.get',
    params: { hostids: [hostId] },
    budget: budget || source.budget || BUDGET_DEFAULT,
    transport,
    project: (row) => ({
      itemId: String(row.itemid ?? '').slice(0, 64),
      key: String(row.key_ ?? row.key ?? '').slice(0, 500),
      name: String(row.name ?? '').slice(0, 300),
      unit: row.units === undefined || row.units === null ? null : String(row.units).slice(0, 40),
      valueType: valueType(row.value_type),
    }),
  });
}

// ---------------------------------------------------------------------------
// Content reference and attestation
// ---------------------------------------------------------------------------

/** Stable JSON: key order cannot change the digest. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** The Kernel stores at most this many bytes of evidence content. The plugin
 *  builds its snapshot to the same bound rather than letting the Kernel refuse
 *  a collection the operator already paid for. */
export const EVIDENCE_CONTENT_MAX_BYTES = 65536;

function coveredOf(result) {
  return {
    sourceId: result.sourceId,
    outcome: result.outcome,
    requestedItems: result.requestedItems,
    answeredItems: result.answeredItems,
    clamped: result.clamped,
    budget: result.budget,
    observedAt: result.observedAt,
    series: result.series,
  };
}

function digestOf(body) {
  return 'sha256:' + crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * The exact bytes that become Kernel evidence content.
 *
 * When the canonical collection body fits in 65536 bytes it is submitted whole.
 * When it does not, this returns a deterministic bounded snapshot: samples are
 * reduced first, then trailing series are dropped, and `snapshot` records what
 * was left out. A truncated snapshot is PARTIAL by construction - the returned
 * `outcome` is PARTIAL and the signed bytes say so, so a reader can never
 * mistake the snapshot for the complete window (rules/05).
 *
 * The body is built here, once, and the digest is taken over exactly these
 * bytes. The Kernel re-derives the digest from the stored body; if the two ever
 * differ it refuses the write (EVIDENCE_CONTENT_REF_CONFLICT) instead of
 * storing bytes the signature did not cover.
 */
export function buildEvidence(result, maxBytes = EVIDENCE_CONTENT_MAX_BYTES) {
  const base = coveredOf(result);
  const originalBody = canonical(base);
  const originalBytes = Buffer.byteLength(originalBody, 'utf8');
  if (originalBytes <= maxBytes) {
    return {
      body: originalBody,
      contentRef: digestOf(originalBody),
      snapshot: null,
      outcome: result.outcome,
    };
  }

  const requestedSamples = base.series.reduce((sum, entry) => sum + (entry.samples?.length || 0), 0);

  const buildSnapshot = (keepSeries, sampleCap) => {
    const kept = base.series.slice(0, keepSeries);
    const reduced = {
      ...base,
      // A bounded snapshot is not a complete observation, and the signed bytes
      // must say PARTIAL even when every item answered.
      outcome: 'PARTIAL',
      series: kept.map((entry) => ({ ...entry, samples: (entry.samples || []).slice(0, sampleCap) })),
    };
    const returnedSamples = reduced.series.reduce((sum, entry) => sum + entry.samples.length, 0);
    const snapshot = {
      maxBytes,
      originalBytes,
      truncated: true,
      reason: 'CONTENT_LIMIT',
      requestedSamples,
      returnedSamples,
      droppedSeries: base.series.length - kept.length,
    };
    const body = canonical({ ...reduced, snapshot });
    return { body, snapshot, bytes: Buffer.byteLength(body, 'utf8') };
  };

  // Phase 1: keep every series, shrink samples per series. Binary search, not a
  // fixed iteration budget: with 500 series a one-drop-per-attempt loop ran out
  // of attempts long before the body fit, and returned 131 KB for a 64 KiB
  // contract (the Kernel then refused it).
  const maxCap = Math.max(1, ...base.series.map((entry) => entry.samples?.length || 0));
  let low = 1;
  let high = maxCap;
  let chosen = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const attempt = buildSnapshot(base.series.length, mid);
    if (attempt.bytes <= maxBytes) {
      chosen = attempt;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Phase 2: one sample per series is still too large, so drop whole series.
  // Dropping a series is recorded; its samples are never claimed as returned.
  if (!chosen) {
    low = 0;
    high = base.series.length;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const attempt = buildSnapshot(mid, 1);
      if (attempt.bytes <= maxBytes) {
        chosen = attempt;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
  }

  // An empty-series snapshot is metadata only and always fits; this is the last
  // resort that keeps the contract's byte bound even for a pathological input.
  if (!chosen) chosen = buildSnapshot(0, 1);
  return {
    body: chosen.body,
    contentRef: digestOf(chosen.body),
    snapshot: chosen.snapshot,
    outcome: 'PARTIAL',
  };
}

/**
 * The digest the evidence row points at.
 *
 * Covers the samples and the outcome together, so a collection cannot be
 * re-labelled OK while keeping the digest of a PARTIAL one.
 */
export function contentRef(result) {
  return buildEvidence(result).contentRef;
}

/**
 * The exact bytes the Kernel will verify.
 *
 * Byte-for-byte identical to the Kernel's `attestation_payload`
 * (apps/kernel/src/incidents.rs): fixed key order, camelCase, second-precision
 * unix timestamps. The golden vector in the Kernel's test suite and the one in
 * this plugin's tests are the same string, which is what stops the two sides
 * drifting into a state where every signature silently fails.
 */
export function attestationPayload({ adapterId, workspaceId, incidentId, kind, source, collectedAt, contentRef: ref, issuedAt }) {
  return JSON.stringify({
    v: ATTESTATION_VERSION,
    adapterId,
    // G13-A.1: the workspace is signed. It comes from the persisted collection
    // and the Kernel checks it against the incident's own record; it is never
    // taken from a request body.
    workspaceId,
    incidentId,
    kind,
    source,
    collectedAtUnix: Math.floor(new Date(collectedAt).getTime() / 1000),
    contentRef: ref,
    issuedAtUnix: Math.floor(new Date(issuedAt).getTime() / 1000),
  });
}

/**
 * Sign an evidence tuple as this adapter.
 *
 * The secret is the adapter's own, shared only with the Kernel. It never leaves
 * this function and is not part of the returned envelope.
 */
export function signAttestation({ adapterId, workspaceId, secret, incidentId, kind, source, collectedAt, contentRef: ref, issuedAt }) {
  if (!adapterId || !secret) {
    throw badRequest('ZABBIX_ADAPTER_UNCONFIGURED', 'no adapter identity is configured, so this collection cannot be attested');
  }
  if (typeof workspaceId !== 'string' || !workspaceId) {
    throw badRequest('ZABBIX_WORKSPACE_REQUIRED', 'a collection without a workspace cannot be signed');
  }
  const payload = attestationPayload({ adapterId, workspaceId, incidentId, kind, source, collectedAt, contentRef: ref, issuedAt });
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return { adapterId, workspaceId, issuedAt: new Date(issuedAt).toISOString(), signature };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Strip anything secret-shaped from a string before it is logged or returned.
 *
 * Belt and braces: the code paths above never put a secret in a message, and
 * this makes a future mistake non-fatal rather than a credential leak.
 */
export function redact(text, secrets = []) {
  let output = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join('[redacted]');
  }
  return output
    // Only a real key/value delimiter triggers this, so ordinary prose that
    // happens to contain "secret" keeps its words and stays diagnosable. The
    // optional scheme word is consumed deliberately: in "Authorization: Bearer
    // abc123" the credential sits *after* a space, so a pattern that stopped at
    // whitespace would redact "Bearer" and print the token.
    .replace(
      /(authorization|token|password|secret)(["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+)?[^\s,"'}&\n]+/gi,
      (_match, key, delimiter, scheme) =>
        `${key}${delimiter}${scheme ? `${scheme} ` : ''}[redacted]`,
    )
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[redacted]@');
}

function badRequest(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function sourceFailure(code, message, details) {
  return Object.assign(new Error(message), { code, status: 422, details });
}
