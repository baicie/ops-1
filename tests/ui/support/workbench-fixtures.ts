import type { Page } from '@playwright/test';

/** Shared fixtures for the DS-V1-2 workbench matrix and a11y gates. */
export const WORKBENCH_ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
export const WORKBENCH_ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const GiB = 1024 ** 3;

export const NODES = [
  { name: 'edge-01', id: '1285fbe8-9bb8-459f-b073-af245d32b3ae', status: 'READY', cpu: 0.94, mem: 7.1, stale: false, ready: 3, total: 3 },
  { name: 'edge-02', id: 'e273620e-41c7-4b0d-9a3e-5f0c1d7a2b64', status: 'READY', cpu: 0.71, mem: 5.2, stale: false, ready: 2, total: 4 },
  { name: 'collector-01', id: '9c4a71f2-6d38-4e5b-8c19-2ab7f0e34d51', status: 'READY', cpu: 0.43, mem: 3.8, stale: false, ready: 1, total: 2 },
  { name: 'collector-02', id: '3f8b25a0-7c94-4d61-b2e8-9d0a4c7f16b3', status: 'READY', cpu: 0.22, mem: 2.4, stale: false, ready: 4, total: 5 },
  { name: 'gateway-01', id: 'a71d0c93-2e58-4b47-9f36-1c8e5d2a704b', status: 'READY', cpu: 0.11, mem: 1.6, stale: false, ready: 0, total: 1 },
  { name: 'gateway-02', id: '5b6e91c4-8a27-4f30-9d84-7e2b10c6a5f9', status: 'READY', cpu: 0.07, mem: 1.1, stale: true, ready: 2, total: 3 },
  { name: 'runner-01', id: 'e04b8d92-7f31-4a68-b5c0-9d2e17fa3b46', status: 'READY', cpu: 0.66, mem: 6.0, stale: false, ready: 5, total: 6 },
  { name: 'runner-02', id: 'c7b1e9a4-2d68-4f05-9b73-6e1d4a8c20f5', status: 'DEGRADED', cpu: 0.62, mem: 4.8, stale: false, ready: 1, total: 2 },
  { name: 'store-01', id: 'c04f7d18-3b96-4a52-8e71-d5a29c034f6b', status: 'READY', cpu: null, mem: null, stale: false, ready: 0, total: 2 },
  { name: 'store-02', id: '7d2e48b5-1c60-4f93-a7d2-6b9e35c81a04', status: 'READY', cpu: null, mem: null, stale: false, ready: 0, total: 1 },
  { name: 'edge-03', id: 'f19a6c37-5e04-4b28-8c63-0d7f4a219e58', status: 'UNREACHABLE', cpu: 0.33, mem: 2.9, stale: true, ready: 0, total: 2 },
  { name: 'edge-04', id: '6e35b90d-4a71-4c86-b59f-3a1d8e72c40b', status: 'UNREACHABLE', cpu: null, mem: null, stale: true, ready: 0, total: 3 },
  { name: 'unknown-01', id: '2a8f4e61-9d37-4b04-8e52-cf6b7a9031de', status: 'UNKNOWN', cpu: null, mem: null, stale: true, ready: 0, total: 1 },
  { name: 'retired-01', id: 'b53c1a7f-0e96-4d24-97a8-4d2e6b8150fc', status: 'READY', cpu: 0.58, mem: 4.4, stale: false, revoked: true, ready: 0, total: 0 },
];

function nodePayload(spec: typeof NODES[number]) {
  const hasSample = spec.cpu !== null;
  return {
    id: spec.id,
    name: spec.name,
    generation: 5,
    os: 'linux',
    arch: 'arm64',
    labels: { zone: 'a' },
    capabilities: ['docker'],
    status: spec.status,
    lastSeenAt: spec.stale ? ago(30) : ago(0.1),
    dataEndpoint: null,
    runtimeAdapterVersion: '0.0.1',
    resourceSnapshot: hasSample
      ? {
        sampledAt: spec.stale ? ago(30) : ago(0.2),
        cpuUtilization: spec.cpu,
        memoryUsedBytes: Math.round((spec.mem as number) * GiB),
        memoryTotalBytes: 8 * GiB,
        cpuCores: 4,
        filesystemUsedBytes: 30 * GiB,
        filesystemTotalBytes: 100 * GiB,
      }
      : null,
    enrolledAt: ago(60 * 24 * 7),
    revokedAt: spec.revoked ? ago(120) : null,
    stale: spec.stale,
    instancesReady: spec.ready,
    instancesTotal: spec.total,
  };
}

function historyPayload(nodeId: string) {
  const out: unknown[] = [];
  for (let minute = 90; minute >= 0; minute -= 1) {
    if (minute < 70 && minute > 50) continue;
    const generation = minute > 30 ? 4 : 5;
    const noMemory = minute <= 20 && minute >= 16;
    const cpu = Math.max(0.05, Math.min(0.99, 0.94 + 0.3 * Math.sin(minute / 7) * (minute / 90)));
    out.push({
      sampleId: 10_000 - minute,
      nodeId,
      generation,
      observedAt: ago(minute),
      sampledAt: ago(minute),
      cpuUtilization: cpu,
      cpuCores: 4,
      memoryUsedBytes: noMemory ? null : 7 * GiB,
      memoryTotalBytes: 8 * GiB,
      filesystemUsedBytes: 30 * GiB,
      filesystemTotalBytes: 100 * GiB,
    });
  }
  return out;
}

export async function installFixtures(page: Page) {
  await page.route('**/api/v1/nodes**', async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/api\/v1\/nodes\/([^/]+)(\/.*)?$/);
    if (!match) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NODES.map(nodePayload)) });
    const node = NODES.find((item) => item.id === match[1]);
    if (!node) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', message: 'fixture node missing' }) });
    if (match[2] === '/resource-history') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyPayload(node.id)) });
    }
    if (match[2] === '/instances') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: node.id + '-a', nodeId: node.id, nodeName: node.name, slot: 1, state: 'RUNNING', restartCount: 0, observedAt: ago(1) },
          { id: node.id + '-b', nodeId: node.id, nodeName: node.name, slot: 2, state: node.status === 'DEGRADED' ? 'DEGRADED' : 'RUNNING', restartCount: 2, observedAt: ago(4) },
        ]),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nodePayload(node)) });
  });
  await page.route('**/api/v1/audit**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'e1', eventType: 'node.heartbeat', action: 'heartbeat', result: 'SUCCEEDED', actorId: 'node', occurredAt: ago(2), subjectType: 'node', subjectId: NODES[0].id },
      { id: 'e2', eventType: 'node.degraded', action: 'degrade', result: 'SUCCEEDED', actorId: 'kernel', occurredAt: ago(18), subjectType: 'node', subjectId: NODES[0].id },
    ]),
  }));
}

export async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', WORKBENCH_ADMIN_EMAIL);
  await page.fill('input[type=password]', WORKBENCH_ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  // G14.2: each application serves /login INSIDE its base (/admin/login,
  // /app/login), so a predicate that only excluded '/login' became true the
  // moment the browser landed on /admin/login - the wait returned before
  // sign-in finished and the next goto raced the redirect.
  await page.waitForURL((url) => !/\/login$/.test(url.pathname));
}

export async function firstIncidentId(page: Page): Promise<string> {
  const list = await page.request.get('/api/v1/incidents?limit=1');
  if (!list.ok()) return '';
  const body = await list.json();
  return body?.items?.[0]?.id ?? '';
}
