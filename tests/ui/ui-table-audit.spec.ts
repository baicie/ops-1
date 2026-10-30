import { Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Table audit: the measurement half of docs/design/ui-visual-v3/spec/table-spec.md §4.1.
 *
 * Same instrument for the before and the after run (V3_MODE), so the pair is comparable.
 * The data endpoints are answered from fixtures here: this host's kernel has no jobs, so a
 * live /admin/jobs is an empty state and the table geometry - which is the thing under test -
 * cannot be measured against it. Auth still goes to the real kernel.
 */
// This host has no Playwright-managed Chromium (the browser download is not part of the repo);
// the installed Chrome is a real engine and the geometry measured here is engine-independent.
test.use({ channel: 'chrome' });

const MODE = process.env.V3_MODE === 'after' ? 'after' : 'before';
const OUT = process.env.V3_OUT || path.resolve('../../artifacts/ui/visual-v3/table', MODE);
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5173';

type Row = Record<string, unknown>;
const report: Row[] = [];

const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const DAY = 24;

/* 14 jobs: the review's measured page. pipeline + revision are constant (14/14, the two
   columns §2.2 demotes); status, attempts, duration and age vary. */
const JOB_IDS = [
  '1285fbe8-9bb8-459f-b073-af245d32b3ae',
  'e273620e-41c7-4b0d-9a3e-5f0c1d7a2b64',
  '9c4a71f2-6d38-4e5b-8c19-2ab7f0e34d51',
  '3f8b25a0-7c94-4d61-b2e8-9d0a4c7f16b3',
  'a71d0c93-2e58-4b47-9f36-1c8e5d2a704b',
  '5b6e91c4-8a27-4f30-9d84-7e2b10c6a5f9',
  'c04f7d18-3b96-4a52-8e71-d5a29c034f6b',
  '7d2e48b5-1c60-4f93-a7d2-6b9e35c81a04',
  'f19a6c37-5e04-4b28-8c63-0d7f4a219e58',
  '6e35b90d-4a71-4c86-b59f-3a1d8e72c40b',
  '2a8f4e61-9d37-4b04-8e52-cf6b7a9031de',
  'b53c1a7f-0e96-4d24-97a8-4d2e6b8150fc',
  '8f47d2b0-6c15-4e93-a04b-9e7c3816d5a2',
  '41e6c9a3-d582-4f70-b831-2f5a0d94e7c6',
];
const STATUSES = ['SUCCEEDED', 'SUCCEEDED', 'RUNNING', 'FAILED', 'SUCCEEDED', 'QUEUED', 'SUCCEEDED', 'CANCELLED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SUCCEEDED', 'RUNNING', 'SUCCEEDED'];
const jobs = JOB_IDS.map((jobId, index) => ({
  jobId,
  pipelineId: 'host-metrics',
  pipelineRevision: 7,
  status: STATUSES[index],
  attempts: (index % 3) + 1,
  maxAttempts: 3,
  createdAt: ago(18 - index * 1.15),
  startedAt: ago(17.5 - index * 1.15),
  finishedAt: STATUSES[index] === 'RUNNING' || STATUSES[index] === 'QUEUED' ? null : ago(17 - index * 1.15),
  updatedAt: ago(17 - index * 1.15),
  currentFence: 1200 + index,
  currentLeaseId: null,
  lastErrorCode: STATUSES[index] === 'FAILED' ? 'NODE_UNREACHABLE' : null,
}));

/* 25 audit rows with one 9-row burst: the page the review measured (§1.6). */
const EVENT_KINDS = [
  ['deployment.created', 'deployment.create', 'deployment'],
  ['plugin.enabled', 'plugin.enable', 'plugin'],
  ['node.enrolled', 'node.enroll', 'node'],
  ['plugin.disabled', 'plugin.disable', 'plugin'],
  ['policy.updated', 'policy.update', 'publisher'],
  ['enrollment_token.issued', 'token.issue', 'enrollment_token'],
  ['deployment.failed', 'deployment.deploy', 'deployment'],
  ['node.unreachable', 'node.observe', 'node'],
];
const SUBJECTS = [
  'f0fe3808-4531-4fd0-ad1c-d85c9e60b11a',
  '6b1c9a24-7f30-4d18-8e57-2a94c0d13f6b',
  '22dddaf1-657d-40c8-8d27-3170289d9803',
  'd47a05e9-3c86-4b21-9f70-8b1e6a2590cd',
  '19e4b7f3-8a52-4c06-b3d9-5e7081c4a2f6',
];
function auditEvents(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 25; i += 1) {
    // rows 8..16 are the 9-identical burst
    const burst = i >= 8 && i <= 16;
    const kind = burst ? ['plugin.probed', 'plugin.probe', 'plugin'] : EVENT_KINDS[i % EVENT_KINDS.length];
    const subject = burst ? SUBJECTS[1] : SUBJECTS[i % SUBJECTS.length];
    rows.push({
      id: 'event-' + String(i).padStart(3, '0'),
      eventType: kind[0],
      action: kind[1],
      subjectType: kind[2],
      subjectId: subject,
      actorType: 'USER',
      actorId: '82475274-80eb-432e-85db-c2be567ee543',
      result: burst ? 'ACCEPTED' : ['ACCEPTED', 'SUCCEEDED', 'DENIED'][i % 3],
      details: { sequence: i },
      requestId: null,
      occurredAt: ago(i * 0.4 + (burst ? 0.05 * (i - 8) : 0)),
    });
  }
  return rows;
}

const NODE_IDS = [
  '9b426dab-27c4-45ce-9773-b51a3db4f246',
  '22dddaf1-657d-40c8-8d27-3170289d9803',
  'c4f10a7e-8b26-4d93-9e05-3a71b6d28f4c',
  '71e3d9b4-0c58-4a26-b87f-6d24e1a9c530',
  '5d80f2a6-4e19-4b73-90c8-2f6a7e13b409',
  'ad2b6c01-9f47-4e35-8a91-7c04d5e63b28',
  '30f9e4c7-1a68-4b52-9d70-e5c39a06f41b',
  '86c17b2d-5e03-4a94-b076-1f8d3c29a7e5',
  'e9024f3b-7d61-4c08-a5e2-8b47f09c16da',
  '4a6d81f0-2c95-4e37-91b4-0e5a7d48c263',
  'f2730e95-6b48-4d17-8c02-7a91e564b3fd',
  '6b5c08d4-3e72-4a06-b95d-2c80f4719a3b',
];
const nodes = NODE_IDS.map((id, index) => ({
  id,
  name: ['lab-node-1', 'lab-node-2', 'edge-ams-3', 'edge-fra-1', 'edge-sin-2', 'edge-iad-4', 'batch-05', 'batch-06', 'gpu-01', 'gpu-02', 'spare-07', 'spare-08'][index],
  generation: 1 + (index % 3),
  os: ['macos', 'linux'][index % 2],
  arch: ['aarch64', 'x86_64'][index % 2],
  status: ['READY', 'READY', 'READY', 'UNREACHABLE', 'READY', 'STALE', 'READY', 'READY', 'READY', 'DRAINING', 'READY', 'READY'][index],
  stale: index === 5,
  revokedAt: null,
  lastSeenAt: ago(index * 0.7),
  instancesReady: (index % 3) + 1,
  instancesTotal: 4,
  resourceSnapshot: index === 3 ? null : {
    cpuUtilization: 0.12 + index * 0.06,
    memoryUsedBytes: 2_500_000_000 + index * 90_000_000,
    memoryTotalBytes: 8_000_000_000,
    filesystemUsedBytes: 40_000_000_000,
    filesystemTotalBytes: 120_000_000_000,
    sampledAt: ago(index * 0.05),
  },
}));

const PLUGIN_IDS = [
  'dev.opsweave.hello',
  'dev.opsweave.metrics',
  'dev.opsweave.logtail',
  'dev.trusted.catalog',
  'dev.trusted.policy',
  'dev.trusted.registry',
  'dev.edge.probe',
  'dev.edge.tunnel',
  'dev.lab.faults',
  'dev.lab.replay',
  'dev.opsweave.audit',
  'dev.opsweave.console',
];
const plugins = PLUGIN_IDS.map((id, index) => ({
  id,
  name: ['Hello Ops', 'Host Metrics', 'Log Tail', 'Data Catalog', 'Policy Engine', 'Registry Mirror', 'Edge Probe', 'Edge Tunnel', 'Fault Lab', 'Replay Lab', 'Audit Sink', 'Console Bridge'][index],
  publisher: ['trusted-team', 'trusted-team', 'lab'][index % 3],
  latestVersion: '0.2.' + (index % 4),
  activeVersion: index === 11 ? null : '0.2.' + (index % 3),
  state: ['ENABLED', 'ENABLED', 'DISABLED', 'ENABLED', 'STAGED', 'ERROR', 'ENABLED', 'ENABLED', 'STAGED', 'ENABLED', 'ENABLED', 'DISABLED'][index],
  signatureState: index === 8 ? 'UNSIGNED' : 'VERIFIED',
  readyInstances: index % 3,
  totalInstances: 3,
  isSystem: index === 0,
}));

const publishers = ['trusted-team', 'lab', 'partner-a', 'partner-b', 'community', 'vendor-x'].map((publisherId, index) => ({
  publisherId,
  fingerprint: 'sha256:' + String(index + 1).repeat(64),
  trustState: ['TRUSTED', 'TRUSTED', 'PENDING', 'TRUSTED', 'REVOKED', 'PENDING'][index],
  note: index % 2 ? null : 'Seeded for the table audit',
  createdAt: ago(index * 26),
}));

const users = [['Platform Admin', 'admin@opsweave.local', 'admin'], ['Dana Ops', 'dana@opsweave.local', 'operator'], ['Lee Chen', 'lee@opsweave.local', 'viewer'], ['Sam Ito', 'sam@opsweave.local', 'operator'], ['Nia Park', 'nia@opsweave.local', 'viewer'], ['Rui Costa', 'rui@opsweave.local', 'operator'], ['Aki Tan', 'aki@opsweave.local', 'auditor'], ['Noa Berg', 'noa@opsweave.local', 'viewer']].map(([displayName, email, role], index) => ({
  id: '0000000' + index + '-1111-4222-8333-44445555666' + index,
  displayName,
  email,
  role,
  disabled: index === 7,
  createdAt: ago(index * 30),
}));

const jobDetail = {
  ...jobs[2],
  stateDigest: 'sha256:' + 'ab'.repeat(32),
};
const jobDiagnostics = {
  events: [
    { eventId: 'e1', eventType: 'job.created', toStatus: 'QUEUED', fencingSequence: null, occurredAt: ago(18) },
    { eventId: 'e2', eventType: 'job.claimed', toStatus: 'RUNNING', fencingSequence: 1201, occurredAt: ago(17.5) },
  ],
  attempts: [
    { attemptNumber: 1, status: 'FAILED', fencingSequence: 1200, nodeId: NODE_IDS[0], startedAt: ago(18) },
    { attemptNumber: 2, status: 'RUNNING', fencingSequence: 1201, nodeId: NODE_IDS[1], startedAt: ago(17.5) },
  ],
  checkpoints: [
    { checkpointId: 'c1', attemptNumber: 1, sequence: 1, stateDigest: 'sha256:' + 'cd'.repeat(32) },
    { checkpointId: 'c2', attemptNumber: 2, sequence: 2, stateDigest: 'sha256:' + 'ef'.repeat(32) },
  ],
  truncated: false,
};

const diagnostics = {
  kernel: { version: '0.0.4', apiMajor: 1, runtimeProtocol: 'http-json-v1', uptimeSeconds: 48120, database: 'sqlite', dataDir: '/var/lib/opsweave', webDist: '/usr/share/opsweave/web' },
  counts: { packages: 12, installedPlugins: 11, deployments: 9, readyInstances: 21, auditEvents: 4021 },
  nodes: nodes.map((node) => ({ id: node.id, name: node.name, status: node.status, lastSeenAt: node.lastSeenAt })),
  recentEvents: auditEvents().slice(0, 5),
  policies: { 'bundle.signature': 1, 'placement.fence': 1 },
  bootstrap: { availableWithoutPlugins: true, recoveryCli: 'opsctl recover', note: 'Bootstrap stays reachable without any plugin.' },
};

const datasets = [
  ['orders-raw', 'ORDERS'], ['orders-curated', 'ORDERS'], ['shipments', 'LOGISTICS'], ['events-click', 'TELEMETRY'],
  ['events-impression', 'TELEMETRY'], ['inventory', 'WAREHOUSE'], ['invoice-lines', 'FINANCE'], ['node-metrics', 'TELEMETRY'],
  ['plugin-invocations', 'PLATFORM'], ['audit-ledger', 'PLATFORM'], ['risk-scores', 'FINANCE'], ['stale-feed', 'EXTERNAL'],
].map(([name, domain], index) => ({
  datasetId: '7f1b' + String(index).padStart(4, '0') + '-2a4c-4d18-9e05-3c71b6d28f4c',
  name,
  domain,
  schemaRevision: 3 + (index % 4),
  // A run that examined no records reports nothing: the last three datasets have no run at all.
  latest: index < 9 ? {
    runId: 'run' + String(index).padStart(5, '0') + '-' + index,
    status: ['PASSED', 'PASSED', 'FAILED', 'PASSED', 'PASSED', 'ERROR', 'PASSED', 'PASSED', 'PASSED'][index],
    recordsExamined: 120_000 + index * 13_700,
    recordsFailed: index === 2 ? 41 : index === 5 ? 3 : 0,
    createdAt: ago(index * 2),
    completedAt: ago(index * 2 - 0.1),
  } : null,
}));
const governanceSummary = {
  datasetCount: datasets.length,
  lineageWindowCount: 184,
  lineageWindow: '24h',
  latestQuality: { passed: 6, failed: 2, error: 1, unknown: 0, pending: 0 },
  recentFailures: [
    { runId: 'run00002-2', datasetName: 'orders-curated', status: 'FAILED', createdAt: ago(4), completedAt: ago(3.9) },
    { runId: 'run00005-5', datasetName: 'inventory', status: 'ERROR', createdAt: ago(10), completedAt: ago(9.8) },
    { runId: 'run00002-2b', datasetName: 'orders-curated', status: 'FAILED', createdAt: ago(28), completedAt: ago(27.9) },
  ],
};

const pluginDetail = {
  id: 'dev.opsweave.metrics',
  name: 'Host Metrics',
  publisher: 'trusted-team',
  state: 'ENABLED',
  activeVersion: '0.2.1',
  activeRevision: { id: 'rev-2', version: '0.2.1', generation: 4, status: 'READY', activatedAt: ago(30) },
  manifest: {},
  permissions: ['metrics.read'],
  provides: [{ id: 'host.metrics', version: '1' }],
  requires: [],
  isSystem: false,
  packageVersions: [
    { version: '0.2.2', status: 'PUBLISHED', signatureState: 'VERIFIED', imageRef: 'registry.local/opsweave/host-metrics@sha256:' + 'a1'.repeat(32), createdAt: ago(6) },
    { version: '0.2.1', status: 'PUBLISHED', signatureState: 'VERIFIED', imageRef: 'registry.local/opsweave/host-metrics@sha256:' + 'b2'.repeat(32), createdAt: ago(30) },
    { version: '0.2.0', status: 'REVOKED', signatureState: 'UNSIGNED', imageRef: null, createdAt: ago(60) },
  ],
  deployments: [{
    id: 'dep-1',
    pluginId: 'dev.opsweave.metrics',
    version: '0.2.1',
    desiredReplicas: 6,
    generation: 4,
    status: 'READY',
    placement: {},
    resources: { cpuMillis: 250, memoryMiB: 128 },
    readyInstances: 5,
    totalInstances: 6,
    createdAt: ago(30),
    updatedAt: ago(1),
    instances: nodes.slice(0, 6).map((node, index) => ({
      id: NODE_IDS[index],
      deploymentId: 'dep-1',
      slot: index,
      nodeId: node.id,
      nodeName: node.name,
      nodeStatus: node.status,
      nodeLastSeenAt: node.lastSeenAt,
      state: ['RUNNING', 'RUNNING', 'ERROR', 'RUNNING', 'STARTING', 'STOPPED'][index],
      containerId: 'c0ffee' + index + 'deadbeef',
      restartCount: index % 3,
      lastError: index === 2 ? 'exit code 137' : null,
      observedAt: ago(index * 0.3),
      pluginId: 'dev.opsweave.metrics',
      version: '0.2.1',
      deploymentStatus: 'READY',
      streamId: 'stream-' + index,
    })),
  }],
};

/** Deterministic answers for every data endpoint the eight audited routes read. */
const FIXTURES: [RegExp, unknown][] = [
  [/\/api\/v1\/jobs\?/, { items: jobs, nextCursor: null }],
  [/\/api\/v1\/jobs\/[0-9a-f-]+\/result$/, { status: 'RUNNING', output: { sampled: 42 }, resultDigest: 'sha256:' + '11'.repeat(32), errorCode: null, errorMessage: null }],
  [/\/api\/v1\/jobs\/[0-9a-f-]+\/diagnostics$/, jobDiagnostics],
  [/\/api\/v1\/jobs\/[0-9a-f-]+$/, jobDetail],
  [/\/api\/v1\/audit/, auditEvents()],
  [/\/api\/v1\/nodes$/, nodes],
  [/\/api\/v1\/plugins$/, plugins],
  [/\/api\/v1\/plugins\/[^/]+$/, pluginDetail],
  [/\/api\/v1\/publishers$/, publishers],
  [/\/api\/v1\/users$/, users],
  [/\/api\/v1\/diagnostics$/, diagnostics],
  [/\/api\/data-catalog\/datasets$/, { items: datasets }],
  [/\/api\/data-catalog\/governance-summary$/, governanceSummary],
  [/\/api\/data-catalog\/datasets\/[^/]+\/quality-runs/, { items: [] }],
  [/\/api\/data-catalog\/datasets\/[^/]+\/lineage/, { items: [] }],
];

async function stub(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    const hit = FIXTURES.find(([pattern]) => pattern.test(new URL(url).pathname + (url.includes('?') ? '?' : '')));
    if (!hit) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit[1]) });
  });
}

/** Everything §4.1 says the audit records, read out of one live page. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const client = de.clientWidth;
    const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
    const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10);
    const pct = (list: number[], p: number) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((list.length * p) / 100))] : null);
    const identity = Array.from(document.querySelectorAll('[data-identity-key]')).map((el) => el.getAttribute('data-identity-key') || '');
    // Runs of identical row keys: §2.4 says a run above 2 is un-collapsed repetition.
    const keys = Array.from(document.querySelectorAll('tbody tr[data-row-key]')).map((el) => el.getAttribute('data-row-key') || '');
    let run = 0;
    let runMax = 0;
    let previous = '';
    for (const key of keys) {
      run = key === previous ? run + 1 : 1;
      previous = key;
      if (run > runMax) runMax = run;
    }
    // §2.2 distinct ratio per column, over the rows on screen.
    // A column is a heading: the trailing action cell has no label, so it is chrome, not a column.
    const headCount = Array.from(document.querySelectorAll('table thead th')).filter((th) => (th.textContent || '').trim().length > 0).length;
    const ratios: (number | null)[] = [];
    for (let column = 0; column < headCount; column += 1) {
      const values = rows.map((tr) => {
        const cells = Array.from(tr.children) as HTMLElement[];
        const cell = cells.filter((el) => el.tagName === 'TD')[column];
        return cell ? (cell.textContent || '').trim() : null;
      }).filter((value): value is string => value !== null);
      ratios.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
    }
    const overflowers = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > client + 1.5;
      })
      .slice(0, 8)
      .map((el) => {
        const box = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), left: Math.round(box.left), right: Math.round(box.right) };
      });
    const table = document.querySelector('table');
    const tableRect = table ? table.getBoundingClientRect() : null;
    // §2.5: at 390 the first line of each card must distinguish the card. A first line that is
    // clipped at the same character position on every card is the defect, so compare the
    // visible prefix against the identity key it was cut from.
    // §2.5 card: the visible facts are the cells whose stack label is painted. Above 768 the
    // label span is display:none, so the count only means something on the phone viewport.
    const cards = Array.from(document.querySelectorAll('tbody tr')).map((tr) => {
      const cell = tr.querySelector('[data-identity-key]') as HTMLElement | null;
      if (!cell) return null;
      const facts = Array.from(tr.querySelectorAll('td[data-label]')).filter((td) => {
        const label = td.querySelector('span');
        return Boolean(label && label.getBoundingClientRect().width > 0);
      }).length;
      return {
        key: cell.getAttribute('data-identity-key') || '',
        clipped: cell.scrollWidth > cell.clientWidth + 1,
        width: Math.round(cell.getBoundingClientRect().width),
        facts,
      };
    }).filter(Boolean);
    return {
      overflow: de.scrollWidth - de.clientWidth,
      docScrollW: de.scrollWidth,
      docClientW: client,
      docHeight: de.scrollHeight,
      offenders: overflowers,
      identityKey: identity,
      identityUnique: identity.length ? Math.round((new Set(identity).size / identity.length) * 1000) / 1000 : null,
      rowHeight: { p50: pct(heights, 50), p95: pct(heights, 95), max: heights.length ? Math.max(...heights) : null, n: heights.length },
      columns: headCount,
      distinctRatio: ratios,
      duplicateRunMax: runMax,
      rows: rows.length,
      cardFactCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c: any) => c.facts)) : null,
      cards,
      tableWidth: tableRect ? Math.round(tableRect.width) : null,
      tablePanelWidth: (document.querySelector('.table-panel') as HTMLElement | null)?.clientWidth ?? null,
    };
  });
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

const ROUTES = [
  { key: 'jobs', route: '/admin/jobs' },
  { key: 'activity', route: '/admin/activity' },
  { key: 'nodes', route: '/admin/nodes' },
  { key: 'plugins', route: '/admin/plugins' },
  { key: 'governance', route: '/admin/governance' },
  { key: 'access', route: '/admin/access' },
  { key: 'diagnostics', route: '/admin/settings/diagnostics' },
  { key: 'plugin-detail', route: '/admin/plugins/dev.opsweave.metrics' },
  { key: 'job-detail', route: '/admin/jobs/' + JOB_IDS[2] },
];
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 390, h: 844 }];
type PageMeasurement = Row;
const pages: Record<string, Record<string, PageMeasurement>> = {};

for (const viewport of VIEWPORTS) {
  for (const locale of ['en', 'zh-CN']) {
    if (locale === 'zh-CN' && viewport.w === 1440) continue;
    const label = 'r' + viewport.w + '-light-' + (locale === 'en' ? 'en' : 'zh');
    test(label, async ({ browser }) => {
      test.setTimeout(240_000);
      const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1, baseURL: BASE });
      await context.addInitScript(([l]) => {
        localStorage.setItem('opsweave-theme', 'light');
        localStorage.setItem('opsweave-locale', l);
      }, [locale]);
      const page = await context.newPage();
      pages[label] = {};
      await stub(page);
      await page.goto(BASE + '/login');
      await page.fill('input[type=email]', ADMIN_EMAIL);
      await page.fill('input[type=password]', ADMIN_PASSWORD);
      await page.click('[data-testid=login-submit]');
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
      for (const target of ROUTES) {
        await page.goto(BASE + target.route);
        await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        pages[label][target.route] = await measure(page);
        if (viewport.w === 390 || target.key === 'jobs' || target.key === 'activity') {
          await page.screenshot({ path: path.join(OUT, label + '__' + target.key + '.png'), fullPage: true });
        }
      }
      await context.close();
    });
  }
}

test.afterAll(() => {
  for (const [label, pageMap] of Object.entries(pages)) {
    fs.writeFileSync(
      path.join(OUT, '_metrics_' + label + '.json'),
      JSON.stringify({ config: { label, theme: 'light', mode: MODE, baseURL: BASE, data: 'fixtures' }, pages: pageMap }, null, 1),
    );
  }
  fs.writeFileSync(path.join(OUT, '_report.json'), JSON.stringify(report, null, 1));
});
