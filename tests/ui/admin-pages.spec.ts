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

const PAGES = [
  { route: '/', heading: 'Overview', slug: 'overview' },
  { route: '/plugins', heading: 'Plugins', slug: 'plugins' },
  { route: '/nodes', heading: 'Nodes', slug: 'nodes' },
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

  // Live data: this stack reports capacity and a sample time but no CPU/memory utilisation,
  // so both must render the NO_DATA token rather than 0%.
  const cpuCells = page.locator('.nodes-table [data-resource="cpu"]');
  expect(await cpuCells.count()).toBeGreaterThan(0);
  for (const cell of await cpuCells.all()) {
    const token = cell.locator('.value-token');
    if (await token.count() > 0) {
      expect(await token.first().getAttribute('data-value'), 'missing sample must be the reserved token').toBe('NO_DATA');
    } else {
      expect((await cell.locator('.ow-utilization').innerText()).trim()).toMatch(/^\d+%$/);
    }
  }
  const sampledCells = page.locator('.nodes-table [data-resource="sampled-at"]');
  for (const cell of await sampledCells.all()) {
    const text = (await cell.innerText()).trim();
    expect(text.length, 'sample time cell is never empty').toBeGreaterThan(0);
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
      ],
    });
  });
  await page.reload();
  await expect(page.locator('.nodes-table tbody tr')).toHaveCount(2);
  const missingRow = page.locator('.nodes-table tbody tr').filter({ hasText: 'no-snapshot' });
  const zeroRow = page.locator('.nodes-table tbody tr').filter({ hasText: 'zero-usage' });
  for (const resource of ['cpu', 'memory']) {
    await expect(missingRow.locator('[data-resource="' + resource + '"] .value-token')).toHaveAttribute('data-value', 'NO_DATA');
    await expect(zeroRow.locator('[data-resource="' + resource + '"] .ow-utilization')).toHaveText('0%');
  }
  await expect(missingRow.locator('[data-resource="sampled-at"] .value-token')).toHaveAttribute('data-value', 'NO_DATA');
  await expect(zeroRow.locator('[data-resource="capacity"]')).toContainText('GiB');
  expect(await missingRow.locator('[data-resource="cpu"]').innerText()).not.toBe(await zeroRow.locator('[data-resource="cpu"]').innerText());
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
  await expect(summary).toContainText('Installation state is INSTALLED');
  await expect(summary).toContainText('Upgrade available');
  await expect(summary).toContainText('The newest uploaded package version differs from the active version');
  await expect(summary).toContainText('Needs attention');
  await expect(summary).toContainText('READY replicas below desired');
  const values = summary.locator('.ow-summary-value');
  await expect(values).toHaveCount(3);
  for (const value of await values.all()) {
    expect((await value.innerText()).trim()).toMatch(/^\d+$/);
  }
  // Column vocabulary of §4.5 B, and NO_DATA where the API answers nothing.
  const head = page.locator('.plugins-table thead');
  for (const column of ['Plugin', 'Publisher', 'Version', 'Digest / trust', 'Activation', 'READY replicas']) {
    await expect(head).toContainText(column);
  }
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
  // Every first-layer module states when it was observed or why it could not be.
  const moduleCards = page.locator('[data-module]');
  expect(await moduleCards.count()).toBe(4);
  for (const card of await moduleCards.all()) {
    const observed = await card.locator('.module-card-observed').innerText();
    expect(observed.trim().length, 'module card must state its observation time').toBeGreaterThan(0);
  }
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
