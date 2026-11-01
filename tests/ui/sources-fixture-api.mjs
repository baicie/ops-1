/**
 * A stand-in for the Kernel, for the Sources page audit only.
 *
 * The committed table harness (`ui-table-audit.spec.ts`) stubs the data routes inside the
 * browser with `page.route` and sends only auth to a real kernel. That works when a kernel is
 * running. There is none on this host, and the sandbox this session's commands run in refuses
 * every socket bind (TCP *and* Unix domain), so neither a kernel nor a browser can be started
 * from inside it.
 *
 * What CAN run outside that sandbox is the desktop app's own dev-server launcher, so this file
 * is a plain `node:http` server with no dependencies that answers exactly the v1 routes the
 * Sources page reads. Vite already proxies `/api` to 127.0.0.1:18181, so the page talks to this
 * the same way it would talk to the kernel: real HTTP, real cookies, real status codes, the
 * real React app. Nothing is stubbed inside the page.
 *
 * Every shape here is copied from the kernel's own serializers:
 *   - `PluginSummary`      apps/kernel/src/plugins.rs
 *   - `CapabilityView`     apps/kernel/src/plugins.rs  (plugin_id/version/name/major/direction)
 *   - `CapabilityGrantView` apps/kernel/src/capabilities.rs
 *   - `PublisherView`      apps/kernel/src/publishers.rs
 *
 * SCENARIO selects which operational state to serve, so the state matrix is measured against a
 * real server answering real statuses (403 for the grants route, 500 for the registry) instead
 * of a mocked promise.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FIXTURE_PORT || 18181);
/**
 * Which state the page is being measured in. Mutable so one server can serve every
 * interaction state in one run: the runner POSTs /__scenario/<name> between passes
 * instead of restarting (a restart would also drop the session cookie).
 */
let SCENARIO = process.env.SCENARIO || 'populated';
/**
 * Reads served per scenario, so `stale-after-first` can answer once and then stop.
 *
 * Staleness is not a flag the page can be handed: it is the state of having an
 * observation that is old, which needs a first answer and then silence. Resetting the
 * counter on every scenario switch keeps the run repeatable.
 */
let reads = 0;
/** When the opening burst of reads began, for `stale-after-first` (see its branch). */
let firstReadAt = 0;

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

/**
 * Twelve connectors, chosen so the page's own degradation rules have something to bite on:
 * every status/trust/reach combination the model can produce appears at least once, the
 * publisher column is varied enough to earn its width, and two rows share a display name so
 * the identity disambiguator is exercised rather than assumed.
 */
const PLUGINS = [
  { id: 'acme.zabbix', name: 'Zabbix', publisher: 'acme', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 2, total: 2, activeVersion: '1.4.2', updatedAt: hoursAgo(3) },
  { id: 'acme.zabbix-edge', name: 'Zabbix', publisher: 'acme', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 1, total: 1, activeVersion: '1.4.2', updatedAt: hoursAgo(9) },
  { id: 'opsweave.data-integration', name: 'Data Integration', publisher: 'trusted-team', state: 'ACTIVE', signatureState: 'SYSTEM', ready: 1, total: 1, activeVersion: '0.0.1', updatedAt: hoursAgo(26), isSystem: true },
  { id: 'netbox.snmp-poller', name: 'SNMP Poller', publisher: 'netbox', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 1, total: 3, activeVersion: '2.1.0', updatedAt: hoursAgo(1) },
  { id: 'otel.collector', name: 'OTel Collector', publisher: 'otel', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 0, total: 2, activeVersion: '0.9.4', updatedAt: hoursAgo(5) },
  { id: 'vendor.syslog', name: 'Syslog Receiver', publisher: 'vendor-x', state: 'INSTALLED', signatureState: 'VERIFIED', ready: 0, total: 0, activeVersion: null, updatedAt: hoursAgo(50) },
  { id: 'labs.jmx-probe', name: 'JMX Probe', publisher: 'labs', state: 'STAGED', signatureState: 'UNSIGNED', ready: 0, total: 0, activeVersion: null, updatedAt: hoursAgo(74) },
  { id: 'acme.cloudwatch', name: 'CloudWatch', publisher: 'acme-revoked', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 1, total: 1, activeVersion: '3.0.1', updatedAt: hoursAgo(14) },
  { id: 'contrib.prometheus', name: 'Prometheus Scraper', publisher: 'contrib', state: 'ACTIVE', signatureState: null, ready: 1, total: 1, activeVersion: '1.0.0', updatedAt: hoursAgo(38) },
  { id: 'vendor.ipmi', name: 'IPMI Sensors', publisher: 'vendor-x', state: 'DISABLED', signatureState: 'VERIFIED', ready: 0, total: 0, activeVersion: '1.1.0', updatedAt: hoursAgo(120) },
  { id: 'netbox.netflow', name: 'NetFlow', publisher: 'netbox', state: 'FAILED', signatureState: 'VERIFIED', ready: 0, total: 1, activeVersion: '2.0.0', updatedAt: hoursAgo(7) },
  { id: 'otel.hostmetrics', name: 'Host Metrics', publisher: 'otel', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 3, total: 3, activeVersion: '0.9.4', updatedAt: hoursAgo(2) },
];

/** A non-source plugin: it must NOT appear as a connector, and it must be counted as such. */
const NON_SOURCE = [
  { id: 'opsweave.data-catalog', name: 'Data Catalog', publisher: 'trusted-team', state: 'ACTIVE', signatureState: 'SYSTEM', ready: 1, total: 1, activeVersion: '0.0.1', updatedAt: hoursAgo(30), isSystem: true },
];

const pluginSummary = (p) => ({
  id: p.id,
  name: p.name,
  publisher: p.publisher,
  latestVersion: p.activeVersion,
  activeVersion: p.activeVersion,
  state: p.state,
  signatureState: p.signatureState,
  hasFrontend: p.id === 'opsweave.data-integration',
  hasBackend: true,
  imageRef: null,
  desiredReplicas: p.total,
  readyInstances: p.ready,
  totalInstances: p.total,
  updatedAt: p.updatedAt,
  isSystem: Boolean(p.isSystem),
});

/** `provides` rows, in the two source families plus one deliberately unclassified provider. */
const CAPABILITIES = [
  ...PLUGINS.map((p) => ({
    pluginId: p.id,
    version: p.activeVersion || '0.0.0',
    name: p.id.includes('zabbix') || p.id.startsWith('otel') || p.id.startsWith('netbox') ? 'telemetry.metrics.v1' : 'data.source.v1',
    major: 1,
    direction: 'PROVIDES',
    activationRevision: 4,
  })),
  // A second capability on one plugin: the drawer lists both, the row shows the primary.
  { pluginId: 'acme.zabbix', version: '1.4.2', name: 'telemetry.events.v1', major: 1, direction: 'PROVIDES', activationRevision: 4 },
  // Not a source family: proves the classifier is segment-wise, not a prefix match.
  { pluginId: 'opsweave.data-catalog', version: '0.0.1', name: 'data.catalog.v1', major: 1, direction: 'PROVIDES', activationRevision: 2 },
  // A consumer waiting on a provider nothing supplies: its own stated fact, not a broken row.
  { pluginId: 'opsweave.data-catalog', version: '0.0.1', name: 'telemetry.traces.v1', major: 1, direction: 'REQUIRES', activationRevision: 2 },
];

const GRANTS = [
  { id: 'g1', name: 'telemetry.metrics.v1', major: 1, consumerPluginId: 'opsweave.data-catalog', providerPluginId: 'acme.zabbix', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: null, createdAt: hoursAgo(40) },
  { id: 'g2', name: 'telemetry.metrics.v1', major: 1, consumerPluginId: 'opsweave.incidents', providerPluginId: 'otel.hostmetrics', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: null, createdAt: hoursAgo(20) },
  { id: 'g3', name: 'data.source.v1', major: 1, consumerPluginId: 'opsweave.data-catalog', providerPluginId: 'opsweave.data-integration', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: null, createdAt: hoursAgo(60) },
  // Expired and revoked: each must read as its own word, never as "not granted".
  { id: 'g4', name: 'telemetry.events.v1', major: 1, consumerPluginId: 'opsweave.incidents', providerPluginId: 'acme.zabbix', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: hoursAgo(2), createdAt: hoursAgo(80) },
];

const PUBLISHERS = [
  { publisherId: 'acme', fingerprint: 'ab'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(900), revokedAt: null },
  { publisherId: 'trusted-team', fingerprint: 'cd'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(900), revokedAt: null },
  { publisherId: 'netbox', fingerprint: 'ef'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(800), revokedAt: null },
  { publisherId: 'otel', fingerprint: '01'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(700), revokedAt: null },
  { publisherId: 'vendor-x', fingerprint: '23'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(600), revokedAt: null },
  { publisherId: 'labs', fingerprint: '45'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(500), revokedAt: null },
  { publisherId: 'contrib', fingerprint: '67'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: hoursAgo(400), revokedAt: null },
  // Verified bytes, revoked key: the row must fall to OPERATOR_ASSERTED, not stay attested.
  { publisherId: 'acme-revoked', fingerprint: '89'.repeat(16), trustState: 'REVOKED', note: null, createdAt: hoursAgo(300), revokedAt: hoursAgo(10) },
];

const SESSION = {
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'admin@opsweave.local', role: 'admin', createdAt: hoursAgo(1000) },
  csrfToken: 'fixture-csrf',
  access: { allowedSurfaces: ['admin', 'workspace'], capabilities: ['platform:access', 'workspace:access'] },
};

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://127.0.0.1');

  // Test-harness control plane. Namespaced under /__ so it can never collide with an API
  // path, and it exists only in this fixture - the kernel has no such route.
  // Reachable two ways on purpose: the runner talks to this server directly (/__scenario/x),
  // and anything running INSIDE the page can only reach paths the vite dev proxy forwards,
  // which is /api. Same handler, so the two can never drift.
  if (pathname.startsWith('/api/v1/__scenario/') || pathname.startsWith('/__scenario/')) {
    const name = pathname.split('/__scenario/')[1] || 'populated';
    SCENARIO = name;
    reads = 0;
    firstReadAt = 0;
    return json(res, 200, { scenario: SCENARIO });
  }
  if (pathname === '/__scenario') return json(res, 200, { scenario: SCENARIO });

  if (pathname === '/api/v1/auth/me' || pathname === '/api/v1/auth/login') return json(res, 200, SESSION);
  if (pathname === '/api/v1/auth/logout') return json(res, 200, {});
  if (pathname === '/api/v1/version') return json(res, 200, { version: '0.0.5-fixture', apiMajor: 1 });

  if (pathname === '/api/v1/plugins') {
    // 'slow' holds the first answer open so the skeleton is a real measured state rather
    // than a prop somebody set: the page is genuinely waiting on the server here.
    if (SCENARIO === 'slow') return;
    // First read answers; every later poll hangs, so `observedAt` stops advancing and the
    // page's own staleness rule (isStale) eventually fires on a real elapsed clock.
    // First read answers; every later poll is REFUSED with a 5xx. A hang produces no
    // re-render at all, so the page never re-evaluates its own staleness rule and the
    // notice can never appear - that is what an earlier version of this fixture measured.
    // A refused refresh is also the condition the repo's own async-stale.spec.ts uses:
    // the rows from the last good observation stay on screen and the notice ages them.
    /**
     * First OBSERVATION answers; every later refresh is refused with a 5xx.
     *
     * "Later" cannot be "the second request": React StrictMode double-invokes effects in dev,
     * so the first paint issues two /plugins reads and a `reads > 1` counter is already spent
     * before the operator can refresh anything. That is exactly why an earlier version of this
     * fixture measured `rendered=0` - the page was being refused on its FIRST paint, so it
     * never had a retained observation to age in the first place.
     *
     * The boundary is therefore time, not count: reads inside the opening burst all answer,
     * and anything after it is a refresh. A hang is also wrong here (no re-render at all, so
     * the page never re-evaluates its own staleness rule), hence a refusal.
     */
    if (SCENARIO === 'stale-after-first') {
      const now = Date.now();
      if (firstReadAt === 0) firstReadAt = now;
      if (now - firstReadAt > 1500) {
        return json(res, 503, { code: 'UNAVAILABLE', message: 'the registry did not answer this refresh' });
      }
    }
    // 409 is its own panel in AsyncBoundary (a concurrent activation changed the set
    // under this read), and it must not read as a generic error.
    if (SCENARIO === 'conflict') return json(res, 409, { code: 'CONFLICT', message: 'the plugin set changed while this page was reading it' });
    if (SCENARIO === 'registry-down') return json(res, 500, { code: 'INTERNAL', message: 'plugin registry unavailable' });
    if (SCENARIO === 'forbidden') return json(res, 403, { code: 'FORBIDDEN', message: 'not permitted' });
    if (SCENARIO === 'empty') return json(res, 200, []);
    return json(res, 200, [...PLUGINS, ...NON_SOURCE].map(pluginSummary));
  }

  if (pathname === '/api/v1/capabilities') {
    // The registry answering nothing is a different page from no plugins at all: the model
    // must say "no source capability is registered" rather than "there are no connectors".
    if (SCENARIO === 'no-capabilities') return json(res, 200, []);
    if (SCENARIO === 'empty') return json(res, 200, []);
    if (SCENARIO === 'registry-down') return json(res, 500, { code: 'INTERNAL', message: 'capability registry unavailable' });
    return json(res, 200, CAPABILITIES);
  }

  if (pathname === '/api/v1/capability-grants') {
    // A viewer cannot list grants. The page must render reach as UNKNOWN and say the list was
    // withheld - never claim every connector is unreachable (AGENTS.md: no absence as health).
    if (SCENARIO === 'grants-forbidden') return json(res, 403, { code: 'FORBIDDEN', message: 'operator role required' });
    if (SCENARIO === 'empty') return json(res, 200, []);
    return json(res, 200, GRANTS);
  }

  if (pathname === '/api/v1/publishers') {
    if (SCENARIO === 'empty') return json(res, 200, []);
    return json(res, 200, PUBLISHERS);
  }

  if (pathname === '/api/v1/extensions') return json(res, 200, []);
  if (pathname === '/api/v1/overview' || pathname === '/api/v1/health') {
    return json(res, 200, {
      health: 'READY', nodesTotal: 2, nodesReady: 2, pluginsInstalled: PLUGINS.length, pluginsAvailable: PLUGINS.length,
      instancesReady: 9, instancesTotal: 13, activeDeployments: 9, attention: [], recentEvents: [],
    });
  }

  return json(res, 404, { code: 'NOT_FOUND', message: pathname });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`sources-fixture-api listening on http://127.0.0.1:${PORT} scenario=${SCENARIO}\n`);
});
