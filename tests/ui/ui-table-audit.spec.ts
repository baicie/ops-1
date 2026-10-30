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
// the installed Chrome is a real engine and the geometry measured here is engine-independent. A CI
// runner is the mirror image - Chromium is installed, branded Chrome is not - so the channel is an
// input (V3_CHANNEL=chromium in staging-preview.yml) instead of an assumption either way.
test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

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

/**
 * One detail per plugin, because the list route carries no digest and the page reads the detail
 * route for it: /admin/plugins answers 12 rows from 12 detail reads. A `PackageVersion` declares
 * `bundleDigest` as required (src/types.ts:75, written by kernel/src/packages.rs:242), so a fixture
 * without it is not a shape the API can produce - it measured the digest column as twelve cells of
 * NO_DATA and made a working column look like a broken one.
 */
function detailFor(index: number) {
  const base = plugins[index];
  const digest = (seed: string) => 'sha256:' + (seed + String(index).padStart(2, '0')).repeat(11).slice(0, 64);
  const versions = [base.latestVersion, base.activeVersion]
    .filter((version): version is string => Boolean(version))
    .filter((version, position, all) => all.indexOf(version) === position);
  return {
    id: base.id,
    name: base.name,
    publisher: base.publisher,
    state: base.state,
    activeVersion: base.activeVersion,
    activeRevision: base.activeVersion
      ? { id: 'rev-' + index, version: base.activeVersion, generation: 2 + index, status: 'READY', activatedAt: ago(index + 1) }
      : null,
    manifest: {},
    permissions: ['metrics.read'],
    provides: [{ id: 'host.metrics', version: '1' }],
    requires: [],
    isSystem: base.isSystem,
    packageVersions: versions.map((version, position) => ({
      version,
      status: position === 0 ? 'PUBLISHED' : 'REVOKED',
      signatureState: base.signatureState,
      imageRef: 'registry.local/opsweave/' + base.id.split('.').join('-') + '@sha256:' + digest('a1'),
      bundleDigest: digest(position === 0 ? 'a1' : 'b2'),
      artifactDigest: digest('c3'),
      createdAt: ago(index * 6 + position * 24),
    })),
    deployments: [{
      id: 'dep-' + index,
      pluginId: base.id,
      version: base.activeVersion ?? base.latestVersion,
      desiredReplicas: base.totalInstances,
      generation: 2 + index,
      status: 'READY',
      placement: {},
      resources: { cpuMillis: 250, memoryMiB: 128 },
      readyInstances: base.readyInstances,
      totalInstances: base.totalInstances,
      createdAt: ago(index * 4),
      updatedAt: ago(index * 0.5),
      instances: nodes.slice(0, 3).map((node, slot) => ({
        id: node.id,
        deploymentId: 'dep-' + index,
        slot,
        nodeId: node.id,
        nodeName: node.name,
        nodeStatus: node.status,
        nodeLastSeenAt: node.lastSeenAt,
        state: ['RUNNING', 'RUNNING', 'ERROR'][slot],
        containerId: 'c0ffee' + slot + 'deadbeef',
        restartCount: slot % 3,
        lastError: slot === 2 ? 'exit code 137' : null,
        observedAt: ago(slot * 0.3),
        pluginId: base.id,
        version: base.activeVersion ?? base.latestVersion,
        deploymentStatus: 'READY',
        streamId: 'stream-' + slot,
      })),
    }],
  };
}

/** One detail per plugin id: a single shared body would render twelve rows of one plugin's data. */
const pluginDetails: Record<string, ReturnType<typeof detailFor>> = Object.fromEntries(
  PLUGIN_IDS.map((id, index) => [id, detailFor(index)]),
);

function pluginDetailFor(url: string): unknown {
  const marker = '/api/v1/plugins/';
  const id = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split('?')[0]);
  return pluginDetails[id] ?? pluginDetails[PLUGIN_IDS[0]];
}

/** Deterministic answers for every data endpoint the eight audited routes read. */
const FIXTURES: [RegExp, unknown | ((url: string) => unknown)][] = [
  [/\/api\/v1\/jobs\?/, { items: jobs, nextCursor: null }],
  [/\/api\/v1\/jobs\/[0-9a-f-]+\/result$/, { status: 'RUNNING', output: { sampled: 42 }, resultDigest: 'sha256:' + '11'.repeat(32), errorCode: null, errorMessage: null }],
  [/\/api\/v1\/jobs\/[0-9a-f-]+\/diagnostics$/, jobDiagnostics],
  [/\/api\/v1\/jobs\/[0-9a-f-]+$/, jobDetail],
  [/\/api\/v1\/audit/, auditEvents()],
  [/\/api\/v1\/nodes$/, nodes],
  [/\/api\/v1\/plugins$/, plugins],
  [/\/api\/v1\/plugins\/[^/]+$/, pluginDetailFor],
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
    const body = typeof hit[1] === 'function' ? (hit[1] as (target: string) => unknown)(url) : hit[1];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
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
    // §2.2 distinct ratio per column, over the rows on screen, measured one table at a time.
    // A column is a heading: a th with no text is chrome (the row-action cell, the select-all
    // checkbox in /admin/plugins). Position is what pairs a heading with its values, so an unlabeled
    // th is skipped on its own index - filtering the th list and then indexing td with the filtered
    // position is what shifted every ratio by one on a table whose first heading is a checkbox, and
    // reading td[c] across every table on the page is what mixed /admin/governance's three tables.
    const ratios: (number | null)[] = [];
    // The heading each ratio belongs to, so §4.2's failure names the column instead of an index.
    const columnLabels: string[] = [];
    // §2.2's n >= 10 is per table, so the rows that fed each table travel with the ratios: without
    // them "no column had 10 rows" and "nobody measured" look identical (see /admin/access, whose
    // two tables have 8 and 6 rows on a page that reports 14).
    const tableRowCounts: number[] = [];
    let headCount = 0;
    let noDataPerTable = 0;
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
      const cellsOf = (tr: Element) => (Array.from(tr.children) as HTMLElement[]).filter((el) => el.tagName === 'TD');
      let labelled = 0;
      Array.from(table.querySelectorAll('thead th')).forEach((th, index) => {
        if ((th.textContent || '').trim().length === 0) return;
        labelled += 1;
        columnLabels.push((th.textContent || '').trim());
        const values = bodyRows
          .map((tr) => cellsOf(tr)[index])
          .filter((cell): cell is HTMLElement => Boolean(cell))
          .map((cell) => (cell.textContent || '').trim());
        ratios.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
      });
      tableRowCounts.push(bodyRows.length);
      if (labelled > headCount) headCount = labelled;
      // §2.7: NO_DATA may appear at most once per table. Counted off the token's data attribute, so
      // this reads what was rendered rather than looking for the copy in a localized string.
      const noData = table.querySelectorAll('td [data-value="NO_DATA"]').length;
      if (noData > noDataPerTable) noDataPerTable = noData;
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
      /**
       * §2.5: the name part may ellipsise; the `disambiguator · age` on the same line never may,
       * because those two are what make two cards tellable apart. It is lost in one of two ways:
       * the cell paints past its own box (scrollWidth), or the tail is painted past the cell's
       * right edge - what a fixed max-width on the line does once the name has shrunk to nothing.
       */
      const tail = cell.querySelector('.ow-ident-tail') as HTMLElement | null;
      const cellBox = cell.getBoundingClientRect();
      const tailOverflow = tail
        ? tail.getBoundingClientRect().right > cellBox.right + 1 || tail.scrollWidth > tail.clientWidth + 1
        : false;
      return {
        key: cell.getAttribute('data-identity-key') || '',
        clipped: cell.scrollWidth > cell.clientWidth + 1 || tailOverflow,
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
      columnLabels,
      tableRowCounts,
      duplicateRunMax: runMax,
      rows: rows.length,
      // §2.7, per table; the page reports its worst table.
      noDataPerTable,
      // §4.2 reads the column cap off the measured width, so it travels with the measurement.
      viewport: { w: window.innerWidth, h: window.innerHeight },
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
        // The pages the table spec is about, at both viewports, so a before/after pair can be
        // read side by side instead of argued about.
        if (viewport.w === 390 || ['jobs', 'activity', 'nodes', 'plugins', 'governance'].includes(target.key)) {
          await page.screenshot({ path: path.join(OUT, label + '__' + target.key + '.png'), fullPage: true });
        }
      }
      await context.close();
    });
  }
}

/**
 * §2.5's instrument, measured against the defect it exists for.
 *
 * `scripts/check-ui-metrics.mjs` now fails on `cards[].clipped`, so the detector needs its red side
 * on the record: the same page is measured twice at 390 - once as it ships, once with §1.4's fixed
 * max-width forced onto the identity line - and both readings are written beside the artifact. A
 * detector that cannot be made to fire proves nothing; this is the file that shows it does.
 */
test('clipped-probe', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, baseURL: BASE });
  await context.addInitScript(() => {
    localStorage.setItem('opsweave-theme', 'light');
    localStorage.setItem('opsweave-locale', 'en');
  });
  const page = await context.newPage();
  await stub(page);
  await page.goto(BASE + '/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
  await page.goto(BASE + '/admin/jobs');
  await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const asShipped = await measure(page);
  await page.addStyleTag({ content: '@media (max-width: 768px) { .ow-ident-cell .ow-ident { max-width: 72px; } }' });
  await page.waitForTimeout(150);
  const truncated = await measure(page);
  const probe = (measurement: any) => ({
    cards: (measurement.cards || []).length,
    clipped: (measurement.cards || []).filter((card: any) => card.clipped).length,
  });
  fs.writeFileSync(
    path.join(OUT, '_clipped_probe.json'),
    JSON.stringify({ route: '/admin/jobs', viewport: 390, asShipped: probe(asShipped), withFixedMaxWidth: probe(truncated) }, null, 1),
  );
  await context.close();
});

test.afterAll(() => {
  for (const [label, pageMap] of Object.entries(pages)) {
    fs.writeFileSync(
      path.join(OUT, '_metrics_' + label + '.json'),
      JSON.stringify({ config: { label, theme: 'light', mode: MODE, baseURL: BASE, data: 'fixtures' }, pages: pageMap }, null, 1),
    );
  }
  fs.writeFileSync(path.join(OUT, '_report.json'), JSON.stringify(report, null, 1));
});
