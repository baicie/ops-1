import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G03 acceptance for the three Admin sample pages (docs/04 §4.5 A/B/C, docs/09 §9.1/§9.3-9.5).
 *
 * Everything asserted here runs against the live Gateway where the state exists. The four
 * states the running stack cannot produce on demand (revoked node, 403, 409, a node without a
 * resource snapshot) are driven through route interception on a *response*, never through mock
 * data in the application: the page code has one path, and the test points it at a payload.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/g03-admin-pages');

// Explicit /admin paths, not the legacy ones. Since G04 the root '/' resumes the last visited
// admin path, which is the behaviour docs/03 asks for ("last surface / sensible default entry")
// but makes '/' a non-deterministic target: after the loop visited /nodes, '/' landed on
// /admin/nodes and the overflow measurement below silently ran against the wrong page.
const PAGES = [
  { route: '/admin/overview', heading: 'Overview', slug: 'overview' },
  { route: '/admin/plugins', heading: 'Plugins', slug: 'plugins' },
  { route: '/admin/nodes', heading: 'Nodes', slug: 'nodes' },
] as const;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const;

const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await expect(page.getByRole('heading', { name: 'Overview', exact: true }).first()).toBeVisible();
}

async function noOverflow(page: Page, label: string) {
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(measured.scrollWidth, label + ': scrollWidth ' + measured.scrollWidth + ' vs viewport ' + measured.clientWidth)
    .toBeLessThanOrEqual(measured.clientWidth + 1);
}

async function openPage(page: Page, target: (typeof PAGES)[number]) {
  await page.goto(target.route);
  await expect(page.getByRole('heading', { name: target.heading, exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();
}

const NODE_TEMPLATE = {
  id: '00000000-0000-4000-8000-00000000000f',
  name: 'fixture-node',
  generation: 3,
  os: 'linux',
  arch: 'x86_64',
  labels: {},
  capabilities: [],
  status: 'READY',
  lastSeenAt: new Date().toISOString(),
  dataEndpoint: null,
  runtimeAdapterVersion: null,
  enrolledAt: new Date().toISOString(),
  revokedAt: null,
  stale: false,
  instancesReady: 0,
  instancesTotal: 0,
  resourceSnapshot: null,
};

test.describe.configure({ mode: 'serial' });

test('all three sample pages fit 1440/1024/390 without horizontal overflow', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await login(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const target of PAGES) {
      await openPage(page, target);
      await noOverflow(page, target.slug + ' @ ' + viewport.width);
    }
  }
  expect(pageErrors, 'page errors: ' + pageErrors.join('; ')).toEqual([]);
});

test('each page keeps its foundation hooks (nodes-table / plugins-table / data-label)', async ({ page }) => {
  await login(page);
  await page.goto('/nodes');
  await expect(page.locator('.nodes-table')).toBeVisible();
  expect(await page.locator('.nodes-table [data-label]').count()).toBeGreaterThan(0);
  await page.goto('/plugins');
  await expect(page.locator('.plugins-table')).toBeVisible();
  expect(await page.locator('.plugins-table [data-label]').count()).toBeGreaterThan(0);
});

test('nodes keep NO_DATA distinct from a measured 0%', async ({ page }) => {
  await login(page);
  await page.goto('/nodes');
  const rows = page.locator('.nodes-table tbody tr');
  await expect(rows.first()).toBeVisible();

  // Live data: this stack reports capacity and a sample time but no CPU/memory utilisation, and
  // the resource cell never turns a missing reading into a measured 0% (§2.7 / M1).
  const resourceCells = page.locator('.nodes-table [data-resource="resources"]');
  expect(await resourceCells.count()).toBeGreaterThan(0);
  for (const cell of await resourceCells.all()) {
    const text = (await cell.innerText()).trim();
    expect(text.length, 'a resource cell is never empty').toBeGreaterThan(0);
    const utilisation = cell.locator('[data-resource="cpu"]');
    if (await utilisation.count() > 0) {
      expect((await utilisation.innerText()).trim()).toMatch(/^\d+%$/);
    }
  }

  // Intercepted response: one node without a snapshot, one that really measured 0%.
  await page.route('**/api/v1/nodes', async (route) => {
    await route.fulfill({
      json: [
        { ...NODE_TEMPLATE, id: '00000000-0000-4000-8000-000000000001', name: 'no-snapshot', resourceSnapshot: null },
        {
          ...NODE_TEMPLATE,
          id: '00000000-0000-4000-8000-000000000002',
          name: 'zero-usage',
          resourceSnapshot: {
            sampledAt: new Date().toISOString(),
            cpuUtilization: 0,
            memoryUsedBytes: 0,
            memoryTotalBytes: 8589934592,
            filesystemUsedBytes: 0,
            filesystemTotalBytes: 1073741824,
          },
        },
        {
          // One row in three without a sample is under §2.7's half, so the column stays and the
          // row says in words what it could not measure.
          ...NODE_TEMPLATE,
          id: '00000000-0000-4000-8000-000000000003',
          name: 'measured-node',
          resourceSnapshot: {
            sampledAt: new Date().toISOString(),
            cpuUtilization: 0.42,
            memoryUsedBytes: 2147483648,
            memoryTotalBytes: 8589934592,
            filesystemUsedBytes: 1073741824,
            filesystemTotalBytes: 1073741824,
          },
        },
      ],
    });
  });
  await page.reload();
  await expect(page.locator('.nodes-table tbody tr')).toHaveCount(3);
  const missingRow = page.locator('.nodes-table tbody tr').filter({ hasText: 'no-snapshot' });
  const zeroRow = page.locator('.nodes-table tbody tr').filter({ hasText: 'zero-usage' });
  // §2.7: NO_DATA appears at most once per table, so the token is printed once above the table and
  // the row that has no sample says so in words. A cell never carries the dashed box.
  await expect(page.locator('.nodes-table td .value-token[data-value="NO_DATA"]')).toHaveCount(0);
  await expect(page.locator('.table-panel [data-table-note="resources"] .value-token')).toHaveAttribute('data-value', 'NO_DATA');
  await expect(missingRow.locator('[data-resource="resources"]')).toContainText('no resource snapshot');
  for (const resource of ['cpu', 'memory']) {
    await expect(missingRow.locator('[data-resource="' + resource + '"]')).toHaveCount(0);
    await expect(zeroRow.locator('[data-resource="' + resource + '"]')).toHaveText('0%');
  }
  await expect(missingRow.locator('[data-resource="sampled-at"]')).toHaveCount(0);
  await expect(zeroRow.locator('[data-resource="sampled-at"]')).not.toBeEmpty();
  await expect(zeroRow.locator('[data-resource="capacity"]')).toContainText('GiB');
});

test('node states render four different colours and never rely on colour alone', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/nodes', async (route) => {
    await route.fulfill({
      json: [
        { ...NODE_TEMPLATE, id: '00000000-0000-4000-8000-000000000011', name: 'node-ready', status: 'READY', stale: false },
        { ...NODE_TEMPLATE, id: '00000000-0000-4000-8000-000000000012', name: 'node-stale', status: 'READY', stale: true, lastSeenAt: new Date(Date.now() - 3600_000).toISOString() },
        { ...NODE_TEMPLATE, id: '00000000-0000-4000-8000-000000000013', name: 'node-unreachable', status: 'UNREACHABLE', stale: true },
        { ...NODE_TEMPLATE, id: '00000000-0000-4000-8000-000000000014', name: 'node-revoked', status: 'READY', revokedAt: new Date().toISOString() },
      ],
    });
  });
  await page.goto('/nodes');
  const indicators = page.locator('.nodes-table tbody .status-indicator');
  await expect(indicators.first()).toBeVisible();
  const states = ['ready', 'stale', 'unreachable', 'revoked'];
  for (const state of states) {
    await expect(page.locator('.nodes-table tbody [data-indicator="' + state + '"]').first()).toBeVisible();
  }
  const palette = await page.evaluate(() => {
    return ['ready', 'stale', 'unreachable', 'revoked'].map((state) => {
      const node = document.querySelector('.nodes-table tbody [data-indicator="' + state + '"]') as HTMLElement | null;
      if (!node) return { state, color: null };
      const style = window.getComputedStyle(node);
      return { state, color: style.color, hasIcon: Boolean(node.querySelector('svg')), text: (node.textContent || '').trim() };
    });
  });
  const printed = palette.map((entry) => entry.color);
  expect(new Set(printed).size, 'four node states must not share a colour: ' + JSON.stringify(palette)).toBe(4);
  for (const entry of palette) {
    expect(entry.hasIcon, entry.state + ' must carry a glyph').toBe(true);
    expect((entry.text || '').length, entry.state + ' must carry a printed label').toBeGreaterThan(0);
  }
  // The same rule on a page the operator did not intercept.
  await page.unroute('**/api/v1/nodes');
  await page.reload();
  const live = page.locator('.nodes-table tbody .status-indicator').first();
  await expect(live).toBeVisible();
  expect(await live.locator('svg').count()).toBe(1);
  expect((await live.innerText()).trim().length).toBeGreaterThan(0);
});

test('plugins print the counting rule next to the summary', async ({ page }) => {
  await login(page);
  await page.goto('/plugins');
  const summary = page.getByTestId('plugins-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Installed');
  await expect(summary).toContainText('Upgrade available');
  await expect(summary).toContainText('Needs attention');
  // V4 moved the counting rule from a three-line paragraph under each card to the cell's
  // title and accessible name: the number still carries its definition, the strip is 56px
  // tall instead of 130px. The rule itself is still asserted, just where it now lives.
  const rules = await summary.locator('.ow-summary-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('title') || ''));
  expect(rules).toHaveLength(3);
  expect(rules[0]).toContain('INSTALLED');
  expect(rules[1]).toContain('Newest version differs from active');
  expect(rules[2]).toContain('Replicas below desired');
  for (const rule of rules) expect(rule.length, 'every count states what it counts').toBeGreaterThan(0);
  const values = summary.locator('.ow-summary-value');
  await expect(values).toHaveCount(3);
  for (const value of await values.all()) {
    expect((await value.innerText()).trim()).toMatch(/^\d+$/);
  }
  // Column vocabulary of §4.5 B, trimmed to §2.2's cap: the publisher rides the plugin name and
  // the activation generation rides the deployment state instead of each holding a column.
  const head = page.locator('.plugins-table thead');
  for (const column of ['Plugin', 'Version', 'Deployment', 'Digest / trust', 'READY replicas']) {
    await expect(head).toContainText(column);
  }
  await expect(head).not.toContainText('Publisher');
  await expect(head).not.toContainText('Activation');
  await expect(page.locator('.plugins-table tbody tr').first().locator('.ow-ident-meta')).not.toBeEmpty();
});

test('overview offers at least three metrics that navigate somewhere', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const metrics = page.locator('a[data-metric-card]');
  await expect(metrics.first()).toBeVisible();
  expect(await metrics.count()).toBeGreaterThanOrEqual(3);
  for (const metric of await metrics.all()) {
    expect(await metric.getAttribute('href')).toBeTruthy();
    expect((await metric.locator('.ow-metric-label').innerText()).trim().length).toBeGreaterThan(0);
  }
  await expect(page.getByTestId('overview-modules')).toBeVisible();
  // Every first-layer module states what it is doing; the observation time of the whole view
  // is stated once (V4), because four copies of one polling timestamp was not four facts.
  const moduleCards = page.locator('[data-module]');
  expect(await moduleCards.count()).toBe(4);
  await expect(page.getByTestId('overview-observed')).not.toBeEmpty();
  for (const card of await moduleCards.all()) {
    const detail = await card.locator('.module-card-detail').innerText();
    expect(detail.trim().length, 'module card must state its state or its reason').toBeGreaterThan(0);
  }
  // The state is stated once per ROW, not once per card: modules that agree on their state share a
  // row, and that row prints the verdict for every module it holds. The assertion keeps its
  // strength by covering the cards instead of counting indicators - a module inside no row, or a
  // row that states no state, still fails.
  const moduleRows = page.locator('[data-testid="overview-modules"] .module-row');
  expect(await moduleRows.count(), 'the module strip renders rows').toBeGreaterThan(0);
  let covered = 0;
  for (const row of await moduleRows.all()) {
    await expect(row.locator('.status-indicator').first()).toHaveCount(1);
    covered += await row.locator('[data-module]').count();
  }
  expect(covered, 'every module card sits in a row that states its state').toBe(4);
  await metrics.first().click();
  await expect(page).toHaveURL(/\/nodes$/);
});

test('negative paths: forbidden, conflict, error, empty and loading are distinct panels', async ({ page }) => {
  await login(page);
  const cases = [
    { status: 403, body: { code: 'FORBIDDEN', message: 'denied' }, state: 'forbidden', copy: 'You do not have permission to view this' },
    { status: 409, body: { code: 'CONFLICT', message: 'stale generation' }, state: 'conflict', copy: 'This view is out of date' },
    { status: 500, body: { code: 'INTERNAL', message: 'boom' }, state: 'error', copy: 'Could not load this view' },
  ];
  for (const current of cases) {
    await page.route('**/api/v1/nodes', async (route) => {
      await route.fulfill({ status: current.status, json: current.body });
    });
    await page.goto('/nodes');
    const panel = page.locator('[data-async-state="' + current.state + '"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(current.copy);
    await page.unroute('**/api/v1/nodes');
  }
  // Forbidden must not print resource details or the raw server sentence.
  await page.route('**/api/v1/nodes', async (route) => {
    await route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: 'raw-internal-detail-xyz' } });
  });
  await page.goto('/nodes');
  const forbidden = page.locator('[data-async-state="forbidden"]');
  await expect(forbidden).toBeVisible();
  await expect(forbidden).not.toContainText('raw-internal-detail-xyz');
  await expect(forbidden).toContainText('Access is decided by the Kernel RBAC policy');
  await page.unroute('**/api/v1/nodes');

  // Empty: a real empty answer renders the empty state, not an error.
  await page.route('**/api/v1/nodes', async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.goto('/nodes');
  await expect(page.locator('[data-async-state="empty"]')).toBeVisible();
  await page.unroute('**/api/v1/nodes');

  // Loading: the skeleton is announced, not an infinite spinner.
  await page.route('**/api/v1/plugins', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto('/plugins');
  const loading = page.locator('[data-async-state="loading"]');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await page.unroute('**/api/v1/plugins');
});

test('screenshot matrix: three pages x 1440/1024/390 x light/dark x en/zh-CN', async ({ browser }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  for (const target of PAGES) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const locale of LOCALES) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.evaluate(([nextTheme, nextLocale]) => {
            localStorage.setItem('opsweave-theme', nextTheme);
            localStorage.setItem('opsweave-locale', nextLocale);
          }, [theme, locale] as const);
          await page.goto(target.route);
          await expect(page.getByTestId('page-header').first()).toBeVisible();
          await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await noOverflow(page, target.slug + ' ' + viewport.width + ' ' + theme + ' ' + locale);
          const file = path.join(OUT, 'g03-' + target.slug + '-' + viewport.width + '-' + theme + '-' + locale + '.png');
          await page.screenshot({ path: file, fullPage: viewport.width < 700 });
        }
      }
    }
  }
  await context.close();
  const files = fs.readdirSync(OUT).filter((name) => name.startsWith('g03-') && name.endsWith('.png'));
  expect(files.length, 'expected 36 screenshots, got ' + files.length).toBe(36);
});
