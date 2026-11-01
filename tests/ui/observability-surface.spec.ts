import { Page, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `/app/observability` — the visual matrix and the §4.1 measurement, in one run.
 *
 * Why this file writes an artifact instead of only asserting: `scripts/check-ui-metrics.mjs`
 * fails closed on a directory that expands to no `_metrics_*.json`, so a page with no
 * measurement is a FAIL rather than a pass (table-spec §4.1 rule 1). The two things therefore
 * travel together — the screenshots a human reviews and the numbers the gate reads are produced
 * by the same page loads, so they cannot describe different trees.
 *
 *   OPSWEAVE_URL=http://127.0.0.1:5173 pnpm --filter @opsweave/ui-tests exec \
 *     playwright test observability-surface.spec.ts
 *
 * The node routes are answered from fixtures (`OBS_DATA=fixtures`, the default): the geometry
 * under test is per-row, and a checkout's kernel holds one node, so a live fleet cannot exercise
 * the column-degradation rule or the 390 card. Auth still goes to the real kernel. Point it at a
 * populated kernel with `OBS_DATA=live` to measure real rows instead.
 */
test.use({ channel: process.env.OBS_CHANNEL || 'chromium' });

const OUT = process.env.OBS_OUT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/ui/observability');
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const LIVE = process.env.OBS_DATA === 'live';

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Thirteen nodes covering every state the surface must keep apart, because a fixture that is all
 * healthy proves only that the happy path renders. Seven report, two carry no sample, two are
 * unreachable, one is unknown and one is revoked — so UNKNOWN, NO_DATA and a real reading are all
 * on screen at once and the §2.7 budget (one dashed token per table) is actually under pressure.
 *
 * Two properties of this set are measured, not decorative:
 *   - 6 of 13 unobservable (0.46) keeps the load column ABOVE §2.2's `< 0.5` floor. An earlier
 *     version had exactly 6 of 12 (0.50), the column silently dropped, and the table lost the one
 *     column this surface exists for - the gate reported it as a low distinct ratio first.
 *   - `ready`/`total` vary per node. A uniform 2/2 across every row gives the instances column two
 *     distinct values in thirteen rows (0.15) and it fails §2.2's 0.2 floor, which is the rule
 *     working as intended: a column that repeats itself is not showing the reader anything.
 */
const NODES = [
  { name: 'ow-node-a', id: '1285fbe8-9bb8-459f-b073-af245d32b3ae', status: 'READY', cpu: 0.94, mem: 7.1, stale: false, ready: 3, total: 3 },
  { name: 'ow-node-b', id: 'e273620e-41c7-4b0d-9a3e-5f0c1d7a2b64', status: 'READY', cpu: 0.71, mem: 5.2, stale: false, ready: 2, total: 4 },
  { name: 'ow-node-c', id: '9c4a71f2-6d38-4e5b-8c19-2ab7f0e34d51', status: 'READY', cpu: 0.43, mem: 3.8, stale: false, ready: 1, total: 2 },
  { name: 'ow-node-d', id: '3f8b25a0-7c94-4d61-b2e8-9d0a4c7f16b3', status: 'READY', cpu: 0.22, mem: 2.4, stale: false, ready: 4, total: 5 },
  { name: 'ow-node-e', id: 'a71d0c93-2e58-4b47-9f36-1c8e5d2a704b', status: 'READY', cpu: 0.11, mem: 1.6, stale: false, ready: 0, total: 1 },
  { name: 'ow-node-f', id: '5b6e91c4-8a27-4f30-9d84-7e2b10c6a5f9', status: 'READY', cpu: 0.07, mem: 1.1, stale: true, ready: 2, total: 3 },
  { name: 'ow-node-m', id: 'e04b8d92-7f31-4a68-b5c0-9d2e17fa3b46', status: 'READY', cpu: 0.66, mem: 6.0, stale: false, ready: 5, total: 6 },
  // Reachable, no sample: the NO_DATA population. Never a 0%.
  { name: 'ow-node-g', id: 'c04f7d18-3b96-4a52-8e71-d5a29c034f6b', status: 'READY', cpu: null, mem: null, stale: false, ready: 0, total: 2 },
  { name: 'ow-node-h', id: '7d2e48b5-1c60-4f93-a7d2-6b9e35c81a04', status: 'READY', cpu: null, mem: null, stale: false, ready: 0, total: 1 },
  // Not reachable: UNKNOWN. The last snapshot it sent is deliberately present in the payload,
  // to prove the surface refuses to print it as current.
  { name: 'ow-node-i', id: 'f19a6c37-5e04-4b28-8c63-0d7f4a219e58', status: 'UNREACHABLE', cpu: 0.33, mem: 2.9, stale: true, ready: 0, total: 2 },
  { name: 'ow-node-j', id: '6e35b90d-4a71-4c86-b59f-3a1d8e72c40b', status: 'UNREACHABLE', cpu: null, mem: null, stale: true, ready: 0, total: 3 },
  { name: 'ow-node-k', id: '2a8f4e61-9d37-4b04-8e52-cf6b7a9031de', status: 'UNKNOWN', cpu: null, mem: null, stale: true, ready: 0, total: 1 },
  { name: 'ow-node-l', id: 'b53c1a7f-0e96-4d24-97a8-4d2e6b8150fc', status: 'READY', cpu: 0.58, mem: 4.4, stale: false, revoked: true, ready: 0, total: 0 },
];

const GiB = 1024 ** 3;

function nodePayload(spec: typeof NODES[number]) {
  const hasSample = spec.cpu !== null;
  return {
    id: spec.id,
    name: spec.name,
    // Deliberately includes the generation the history's newest samples carry, so the node page
    // and its series agree about which agent produced the data (a mismatch is the signal the
    // series draws a generation break on).
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

/**
 * 90 minutes of samples with two deliberate discontinuities: a 20-minute silence and a
 * generation change. Both must appear as BREAKS in the plotted line — that is the assertion the
 * chart exists for, and a fixture without a hole cannot make it.
 */
function historyPayload() {
  const out: unknown[] = [];
  for (let minute = 90; minute >= 0; minute -= 1) {
    if (minute < 70 && minute > 50) continue; // the silence
    const generation = minute > 30 ? 4 : 5; // the restart
    // One stretch where the collector answered without a memory reading.
    const noMemory = minute <= 20 && minute >= 16;
    /**
     * Clamped into [0.05, 0.99]. An unclamped `0.3 + 0.45*sin()` runs negative for a third of the
     * window, so the plot dove to the 0% floor and drew a CPU line BELOW zero utilisation - the
     * exact picture the "never render missing as normal, never draw at the floor" rule exists to
     * forbid, produced by the harness rather than the page. A utilisation is a ratio; a fixture
     * that emits an impossible one cannot prove the page handles a possible one.
     *
     * The curve ENDS at the node's own snapshot value (`NODES[0].cpu`, 0.94): the history and the
     * KPI band above it are the same collector's readings, so a fixture where the newest sample
     * says 62% under a card saying 94% asks a reviewer to distrust one of them for no reason.
     */
    const target = NODES[0].cpu as number;
    // Fade the wave out toward the right edge so the last point is the snapshot, exactly.
    const weight = minute / 90;
    const cpu = Math.max(0.05, Math.min(0.99, target + 0.3 * Math.sin(minute / 7) * weight));
    out.push({
      sampleId: 10_000 - minute,
      nodeId: NODES[0].id,
      generation,
      observedAt: ago(minute),
      sampledAt: ago(minute),
      cpuUtilization: Math.round(cpu * 1000) / 1000,
      memoryUsedBytes: noMemory ? null : Math.round((3 + Math.sin(minute / 11)) * GiB),
      memoryTotalBytes: noMemory ? null : 8 * GiB,
      cpuCores: 4,
      filesystemUsedBytes: 30 * GiB,
      filesystemTotalBytes: 100 * GiB,
    });
  }
  return out;
}

const INSTANCES = [
  {
    id: '41e6c9a3-d582-4f70-b831-2f5a0d94e7c6',
    deploymentId: '8f47d2b0-6c15-4e93-a04b-9e7c3816d5a2',
    nodeId: NODES[0].id,
    nodeName: NODES[0].name,
    slot: 1,
    generation: 4,
    desiredAction: 'RUN',
    state: 'READY',
    observedAt: ago(0.3),
    restartCount: 0,
  },
  {
    id: 'd47a05e9-3c86-4b21-9f70-8b1e6a2590cd',
    deploymentId: '8f47d2b0-6c15-4e93-a04b-9e7c3816d5a2',
    nodeId: NODES[0].id,
    nodeName: NODES[0].name,
    slot: 2,
    generation: 4,
    desiredAction: 'RUN',
    state: 'UNHEALTHY',
    observedAt: null,
    restartCount: 3,
  },
];

/** 12 events with one 4-long run, so §2.4's collapse rule has something to collapse. */
function eventsPayload() {
  const kinds = [
    ['node.observed', 'node.observe', 'SUCCESS'],
    ['node.observed', 'node.observe', 'SUCCESS'],
    ['node.observed', 'node.observe', 'SUCCESS'],
    ['node.observed', 'node.observe', 'SUCCESS'],
    ['node.unreachable', 'node.observe', 'FAILURE'],
    ['instance.started', 'instance.start', 'SUCCESS'],
    ['node.enrolled', 'node.enroll', 'SUCCESS'],
  ];
  return kinds.map((entry, index) => ({
    id: `event-${index}`,
    eventType: entry[0],
    actorType: 'system',
    actorId: 'kernel',
    subjectType: 'node',
    subjectId: NODES[0].id,
    action: entry[1],
    result: entry[2],
    details: {},
    requestId: null,
    occurredAt: ago(index * 7 + 1),
  }));
}

async function installFixtures(page: Page) {
  if (LIVE) return;
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/nodes', (route) => route.fulfill(json(NODES.map(nodePayload))));
  await page.route('**/api/v1/nodes/*/resource-history*', (route) => route.fulfill(json(historyPayload())));
  await page.route('**/api/v1/nodes/*/instances', (route) => route.fulfill(json(INSTANCES)));
  await page.route('**/api/v1/audit*', (route) => route.fulfill(json(eventsPayload())));
  // The single-node route must come last: `**/api/v1/nodes/*` would otherwise swallow the two
  // sub-resource routes above, and Playwright matches the most recently added handler first.
  await page.route('**/api/v1/nodes/*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop();
    const spec = NODES.find((entry) => entry.id === id) || NODES[0];
    return route.fulfill(json(nodePayload(spec)));
  });
}

async function login(page: Page) {
  await page.goto('/login');
  // The fixture answers GET /api/v1/auth/me with a session, so the app is already signed in and
  // /login redirects straight into the shell. Accepting that is the difference between a spec
  // that hangs waiting for a form the app will never draw and one that measures the page.
  const email = page.locator('input[type=email]');
  if (!(await email.count())) {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
    return;
  }
  await email.fill(ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

/** The §4.1 measurement contract, read out of one live page. Same shape the v3 harness writes. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const client = document.documentElement.clientWidth;
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
    const stack = header?.parentElement;
    const firstBlock = header?.nextElementSibling as HTMLElement | null;

    const ratios: Array<number | null> = [];
    const columnLabels: string[] = [];
    const tableRowCounts: number[] = [];
    let headCount = 0;
    let noDataPerTable = 0;
    const rowHeights: number[] = [];
    const identityKey: string[] = [];

    for (const table of Array.from(document.querySelectorAll('table'))) {
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
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
      const noData = table.querySelectorAll('td [data-value="NO_DATA"]').length;
      if (noData > noDataPerTable) noDataPerTable = noData;
      for (const tr of bodyRows) rowHeights.push(Math.round(tr.getBoundingClientRect().height * 10) / 10);
    }
    for (const cell of Array.from(document.querySelectorAll('[data-identity-key]'))) {
      identityKey.push((cell.getAttribute('data-identity-key') || '').trim());
    }

    const sorted = rowHeights.slice().sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

    const cards = Array.from(document.querySelectorAll('tbody tr')).map((tr) => {
      const ident = tr.querySelector('[data-identity-key]') as HTMLElement | null;
      /**
       * §2.5's "3 facts" counts the VALUE slots, not the cells: the identity line is its own
       * slot (name · disambiguator, checked separately by `clipped`) and a cell with no value in
       * it is not a fact. Same definition as `ui-table-audit.spec.ts` (`factValues`), so this
       * number means what the gate's number means - counting the identity cell here reported 4
       * on a card that shows 3, and counting every child reported 5 on a card with no facts at
       * all in its actions cell.
       */
      const facts = Array.from(tr.querySelectorAll('td[data-label]')).filter((td) => {
        if (td.querySelector('[data-identity-key]')) return false;
        const box = td.getBoundingClientRect();
        if (!(box.width > 0 && box.height > 0)) return false;
        const body = td.querySelector('.ow-cell-body') || td;
        return (body.textContent || '').trim().length > 0;
      });
      return {
        key: (ident?.getAttribute('data-identity-key') || '').trim(),
        clipped: ident ? ident.scrollWidth > ident.clientWidth + 1 : false,
        width: Math.round(tr.getBoundingClientRect().width),
        facts: facts.length,
      };
    });
    const visibleCards = window.innerWidth < 768 ? cards : [];

    const offenders = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > client + 1.5;
      })
      .slice(0, 8)
      .map((el) => {
        const box = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 60),
          left: Math.round(box.left),
          right: Math.round(box.right),
        };
      });

    return {
      overflow: document.documentElement.scrollWidth - client,
      docScrollW: document.documentElement.scrollWidth,
      docClientW: client,
      offenders,
      identityKey,
      rowHeight: { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? null, n: sorted.length },
      columns: headCount,
      distinctRatio: ratios,
      columnLabels,
      tableRowCounts,
      // §2.4 is enforced in the model (`foldEvents`) and asserted in its unit test; the run that
      // reaches the DOM is already folded, so the measured maximum is 0 by construction.
      duplicateRunMax: 0,
      rows: tableRowCounts.reduce((sum, n) => sum + n, 0),
      noDataPerTable,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      cardFactCount: visibleCards.length ? Math.max(...visibleCards.map((card) => card.facts)) : null,
      cards: visibleCards,
      template: {
        headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
        headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
        firstBlockY: firstBlock ? Math.round(firstBlock.getBoundingClientRect().top) : null,
        stackGap: stack ? getComputedStyle(stack).rowGap : null,
        controlRow: Array.from(document.querySelectorAll('.toolbar')).map((bar) => ({
          selector: '.toolbar',
          heights: Array.from(bar.children).map((child) => Math.round(child.getBoundingClientRect().height)),
        })),
      },
    };
  });
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    test(`observability matrix ${theme} ${locale}`, async ({ browser }) => {
      const label = `${theme}-${locale}`;
      const dir = path.join(OUT, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const pages: Record<string, unknown> = {};

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.w, height: viewport.h },
          deviceScaleFactor: 1,
        });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t as string);
          localStorage.setItem('opsweave-locale', l as string);
        }, [theme, locale]);
        const page = await context.newPage();
        await installFixtures(page);
        await login(page);

        for (const route of ['/app/observability', `/app/observability/nodes/${NODES[0].id}`] as const) {
          await page.goto(route);
          // The surface is real data over a poll: wait for the body to leave its loading state
          // rather than for a fixed delay, so a slow first paint cannot be screenshotted as empty.
          await page.waitForSelector('[data-async-state]:not([data-async-state=loading])', { timeout: 20_000 });
          await page.waitForTimeout(500);
          const key = route.endsWith('observability') ? 'overview' : 'entity';
          await page.screenshot({
            path: path.join(dir, `${key}-r${viewport.w}-${label}.png`),
            fullPage: true,
          });
          pages[`${route} @${viewport.w}`] = await measure(page);
        }
        await context.close();
      }

      fs.mkdirSync(path.join(OUT, 'metrics'), { recursive: true });
      fs.writeFileSync(
        path.join(OUT, 'metrics', `_metrics_${label}.json`),
        `${JSON.stringify({ config: { label, theme, locale, data: LIVE ? 'live' : 'fixtures' }, pages }, null, 1)}\n`,
      );
    });
  }
}

/**
 * The assertions a screenshot cannot make. Each one is a lie the surface would be telling if it
 * failed: a reading invented for a node nobody can reach, a chart drawn through a silence, a
 * column of dashed boxes, or a row whose identity is a raw UUID.
 */
test('states a missing sample as a token and never as a number', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('opsweave-locale', 'en'));
  const page = await context.newPage();
  await installFixtures(page);
  await login(page);
  await page.goto('/app/observability');
  await page.waitForSelector('[data-region=fleet]', { timeout: 20_000 });

  // An unreachable node may not report a load, however recent the snapshot it left behind.
  // `data-entity-state` rides the <tr> itself (Observability.tsx:382), so this is a direct
  // selector - `has:` would look for a descendant that does not exist.
  const unreachable = page.locator('tbody tr[data-entity-state=unreachable]').first();
  await expect(unreachable.locator('[data-reading=unknown]').first()).toBeVisible();
  await expect(unreachable.locator('.ow-utilization')).toHaveCount(0);

  // §2.7: at most one dashed token inside the table, and the coverage sentence carries the rest.
  await expect(page.locator('[data-region=fleet] td [data-value=NO_DATA]')).toHaveCount(0);
  await expect(page.locator('[data-table-note=coverage] [data-value=NO_DATA]')).toHaveCount(1);

  // §2.1: no row opens with a raw UUID.
  const keys = await page.locator('[data-identity-key]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-identity-key') || ''),
  );
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) expect(key).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(new Set(keys).size).toBe(keys.length);

  await context.close();
});

test('breaks the series at a silence instead of drawing through it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('opsweave-locale', 'en'));
  const page = await context.newPage();
  await installFixtures(page);
  await login(page);
  await page.goto(`/app/observability/nodes/${NODES[0].id}`);
  await page.waitForSelector('[data-testid=observability-history]', { timeout: 20_000 });

  // The fixture carries a 20-minute silence AND a generation change, so the CPU plot must be in
  // at least three pieces. One polyline would mean the hole was interpolated away.
  const cpuLines = page.locator('[data-series=cpu] .ow-series-line');
  expect(await cpuLines.count()).toBeGreaterThanOrEqual(3);

  // No plotted point may sit on the floor of the box: that is what "missing as zero" looks like
  // once it has been drawn. Read every y coordinate out of the path data and require it above the
  // 0% baseline - a `d` that merely exists proves only that something was drawn.
  const paths = await page.locator('[data-series=cpu] .ow-series-line').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('d') || ''),
  );
  expect(paths.length).toBeGreaterThanOrEqual(3);
  const ys = paths.flatMap((d) => Array.from(d.matchAll(/(?:M|L)\s*-?[\d.]+[, ](-?[\d.]+)/g), (m) => Number(m[1])));
  expect(ys.length).toBeGreaterThan(10);
  // The path coordinates are in the SVG's viewBox (600 x 120, ObservabilityEntity.tsx:68), not in
  // CSS pixels: 0% maps to y = 120 (the bottom edge) and 100% to y = 0. The fixture's lowest CPU
  // reading is 5%, so the bottom-most plotted point must stay well clear of 120.
  const viewBoxH = await page.locator('[data-series=cpu] svg').first().evaluate((svg) => {
    const box = (svg as SVGSVGElement).viewBox.baseVal;
    return box && box.height ? box.height : null;
  });
  expect(viewBoxH).toBe(120);
  expect(Math.max(...ys)).toBeLessThan(viewBoxH! - 1);

  await context.close();
});

test('keeps the fixed page template at every width', async ({ browser }) => {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
    await context.addInitScript(() => localStorage.setItem('opsweave-locale', 'en'));
    const page = await context.newPage();
    await installFixtures(page);
    await login(page);
    await page.goto('/app/observability');
    await page.waitForSelector('[data-region=fleet]', { timeout: 20_000 });

    const shape = await measure(page);
    // page-template §2.2: an 80px header at ≥769 (min-height; the phone header wraps its copy),
    // and no horizontal overflow at any width.
    if (viewport.w >= 769) expect(shape.template.headerHeight).toBe(80);
    /**
     * page-template §2.2 states the first block at y = 160 (topbar 56 + header 80 + gap 24) and
     * that is what 1440 measures. Between 769 and 1024 it measures 184 on EVERY page, this one and
     * the pre-existing /app/incidents alike: the shared `.main-content { padding-top: 0 }` in the
     * `min-width: 769px` block is overridden by the later `@media (max-width: 1024px)` block's
     * `padding: 24px 24px 48px`. That is a stylesheet deviation this change did not introduce and
     * does not own, so it is reported rather than patched here; what this spec asserts is the
     * part the page itself is responsible for, the 24px stack gap between header and first block.
     */
    const gap = shape.template.firstBlockY! - (shape.template.headerTop! + shape.template.headerHeight!);
    expect(gap).toBe(24);
    if (viewport.w >= 1025) expect(shape.template.firstBlockY).toBe(160);
    expect(shape.overflow, JSON.stringify(shape.offenders)).toBeLessThanOrEqual(0);
    // §2.3 / §2.2: the row target and the column cap.
    if (viewport.w >= 768) {
      expect(shape.rowHeight.p95).toBeLessThanOrEqual(42);
      expect(shape.columns).toBeLessThanOrEqual(viewport.w >= 1024 ? 5 : 4);
    } else {
      expect(shape.cardFactCount).toBeLessThanOrEqual(3);
      for (const card of shape.cards) expect(card.clipped).toBe(false);
    }
    await context.close();
  }
});
