import { expect, test, type Page } from '@playwright/test';

// G07 acceptance: the Business Workspace is a task space, not a KPI wall and not the
// platform console with a different colour.
//
// Two rules shape every assertion here:
//
//   * A business page may not invent data. There is no incident API, so the honest render is
//     a section that names its missing interface - never a zero, which reads as "healthy".
//   * A state must come from an observed answer. EMPTY / PARTIAL / STALE / UNAVAILABLE / 403
//     / 404 are driven below by real HTTP statuses and real payloads (the extension list and
//     the kernel version probe are the two business-safe interfaces that exist).
//
// Selectors are hrefs, data-attributes and data-testids only - never localized copy (rules/06).

const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
const WORKSPACE_GRANT = { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] };

type Grant = 'admin' | 'workspace';

async function stubGrant(page: Page, grant: Grant) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = grant === 'admin' ? ADMIN_GRANT : WORKSPACE_GRANT;
    await route.fulfill({ response, json: body });
  });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

/** The host's own rail: the plugin section is a separate group and is not scanned here. */
function businessRail(page: Page) {
  return page.getByTestId('workspace-sidebar').locator('.nav-group-business');
}

const BUSINESS_DESTINATIONS = ['/app/home', '/app/incidents', '/app/investigations', '/app/observability', '/app/resources', '/app/reports'];
const TASK_AREAS = ['home-awaiting', 'home-investigations', 'home-services', 'home-evidence'];

test.describe.configure({ mode: 'serial' });

test('the business rail carries the six business destinations and no control-plane entry', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);
  await page.goto('/app/home');
  await expect(page.getByTestId('workspace-home')).toBeVisible();

  for (const href of BUSINESS_DESTINATIONS) {
    await expect(businessRail(page).locator(`a[href="${href}"]`), href).toBeVisible();
  }

  // The negative half: none of the platform-console vocabulary survives on this surface.
  const railText = (await businessRail(page).allInnerTexts()).join(' ').toLowerCase();
  expect(railText.length).toBeGreaterThan(0);
  for (const term of ['node', 'publisher', 'oci', 'plugin', 'deploy', 'install', 'pipeline', 'governance', 'settings']) {
    expect(railText, 'the business rail must not mention ' + term).not.toContain(term);
  }

  // And no admin route is reachable from the rail, even for an administrator.
  await expect(businessRail(page).locator('a[href^="/admin"]')).toHaveCount(0);
  // The console frame is not mounted at all - the two shells never share a document.
  await expect(page.locator('.admin-shell')).toHaveCount(0);
  await expect(page.locator('.shell.workspace-shell')).toHaveCount(1);
});

test('the home task space names what is missing instead of rendering a zero', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);
  await page.goto('/app/home');
  await expect(page.getByTestId('workspace-home')).toBeVisible();

  for (const id of TASK_AREAS) {
    const area = page.getByTestId(id);
    await expect(area, id).toBeVisible();
    // Unavailable because the interface does not exist - not because a query returned nothing.
    await expect(area).toHaveAttribute('data-source-status', 'unavailable');
    await expect(area.locator('[data-state="unavailable"]')).toHaveCount(1);
    // The section names the capability it is waiting for, machine-readably.
    expect(await area.getAttribute('data-missing-capability')).toBeTruthy();

    // The red line: no number anywhere in a task area. "0" would be a claim, not a placeholder.
    const text = (await area.innerText()).replace(/\s+/g, ' ');
    expect(text.length, id + ' must explain itself').toBeGreaterThan(40);
    expect(text, id + ' must not contain a digit').not.toMatch(/[0-9]/);
  }

  // No KPI wall: no metric card, no table, no count badge on the home page at all.
  await expect(page.locator('[data-testid="metric-card"], .metric-card, table')).toHaveCount(0);

  // Every business destination is still declared as not shipped, one row each.
  await expect(page.locator('[data-surface-status="not-shipped"]')).toHaveCount(6);
  await expect(page.getByTestId('workspace-home').locator('[data-surface-status="not-shipped"][data-capability="sources"]')).toHaveCount(1);
});

test('a viewer is never offered, or shown, a platform resource total', async ({ page }) => {
  const platformReads: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/v1\/(nodes|overview|plugins|deployments)/.test(path)) platformReads.push(path);
  });

  await stubGrant(page, 'workspace');
  await signIn(page);
  await expect(page).toHaveURL(/\/app\/home$/);

  // No console entry exists to click, and no console data is requested to fill this page.
  await expect(page.getByTestId('workspace-to-admin')).toHaveCount(0);
  await expect(page.getByTestId('workspace-no-admin')).toBeVisible();
  expect(platformReads).toEqual([]);

  // The related-services area states the scope instead of a total.
  const services = page.getByTestId('home-services');
  await expect(services).toBeVisible();
  expect((await services.innerText())).not.toMatch(/[0-9]/);
});

test('the business side keeps 403 and 404 apart from empty data', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);

  // (a) The extension list answers 403: a permission wall, and no entry may be listed.
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'FORBIDDEN', message: 'forbidden' }) }));
  await page.goto('/app/home');
  const plugins = page.getByTestId('business-plugins');
  await expect(plugins).toHaveAttribute('data-state', 'forbidden');
  await expect(plugins.locator('[data-entry-plugin]')).toHaveCount(0);
  await expect(plugins.locator('[data-state="forbidden"]')).toHaveCount(1);
  await page.unroute('**/api/v1/extensions');

  // (b) The version probe answers 404: the interface does not exist on this kernel.
  await page.route('**/api/v1/version', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.goto('/app/home');
  const platform = page.getByTestId('business-platform');
  await expect(platform).toHaveAttribute('data-state', 'notFound');
  await expect(platform.locator('[data-state="notFound"]')).toHaveCount(1);
  await page.unroute('**/api/v1/version');

  // (c) An empty list is empty - a different panel from the two above.
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/app/home');
  await expect(page.getByTestId('business-plugins')).toHaveAttribute('data-state', 'empty');
});

test('a half-loaded extension list renders as partial, and lists only what really opens', async ({ page }) => {
  const PLUGIN = 'opsweave.test-notebook';
  const PAGE_PATH = `/app/ext/${PLUGIN}/board`;
  const payload = [{
    pluginId: PLUGIN,
    publisher: 'trusted-team',
    version: '0.0.1',
    activationRevision: 3,
    // A remote entry that cannot be fetched: the entry exists, its assets do not.
    assetBase: '/assets/stub/' + PLUGIN + '/does-not-exist',
    remoteEntry: 'remoteEntry.js',
    contributions: [
      { kind: 'route.page.v2', id: 'notebook-page', surface: 'workspace', path: PAGE_PATH },
      { kind: 'navigation.item.v2', id: 'notebook-nav', surface: 'workspace', path: PAGE_PATH },
    ],
    rejections: [],
  }];

  await stubGrant(page, 'admin');
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
  await signIn(page);
  await page.goto('/app/home');

  const plugins = page.getByTestId('business-plugins');
  await expect(plugins).toHaveAttribute('data-state', 'partial');
  await expect(plugins.locator('[data-state="partial"]')).toHaveCount(1);
  // The granted entry is a real route, and it is the only thing listed.
  await expect(plugins.locator('a[data-entry-plugin]')).toHaveCount(1);
  await expect(plugins.locator('a[data-entry-plugin]')).toHaveAttribute('href', PAGE_PATH);
});

test('/app/incidents shows the investigation layout as empty slots, never as events', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);
  await page.goto('/app/incidents');

  // The absence is stated before the layout is shown.
  const notYet = page.getByTestId('surface-not-yet');
  await expect(notYet).toBeVisible();
  await expect(notYet).toHaveAttribute('data-surface-status', 'not-shipped');
  await expect(notYet).toHaveAttribute('data-capability', 'incidents');

  // Three regions, in reading order, each an empty slot that says why it is empty.
  const regions = page.locator('[data-region]');
  await expect(regions).toHaveCount(3);
  expect(await regions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-region'))))
    .toEqual(['timeline', 'analysis', 'detail']);
  for (const id of ['timeline', 'analysis', 'detail']) {
    const region = page.locator(`[data-region="${id}"]`);
    await expect(region.locator('[data-slot-empty="true"]')).toHaveCount(1);
    // The slot names the interface it waits for; it never renders a sample entry.
    expect((await region.innerText()).length).toBeGreaterThan(30);
  }

  // No fabricated content of any kind: no event, no timeline point, no hypothesis, no AI text.
  await expect(page.locator('[data-testid="timeline-event"], [data-testid="hypothesis-item"], [data-testid="ai-conclusion"]')).toHaveCount(0);
  await expect(page.locator('[data-region] li, [data-region] time, [data-region] table')).toHaveCount(0);
  await expect(page.locator('table, [data-testid="metric-card"]')).toHaveCount(0);
});

test('the investigation layout is desktop-first and degrades without overflowing', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);

  // 1440: three regions side by side.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/incidents');
  const wide = await page.locator('[data-region]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(new Set(wide).size, 'all three regions share one row at 1440').toBe(1);

  // 1024: the detail region drops to its own row.
  await page.setViewportSize({ width: 1024, height: 900 });
  const medium = await page.locator('[data-region]').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  expect(medium[2], 'detail stacks below the first two at 1024').toBeGreaterThan(medium[0]);

  // 390: one column, and neither page scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/app/incidents', '/app/home']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path + ' must not scroll horizontally at 390').toBeLessThanOrEqual(1);
  }
});

test('a workspace-only account still meets the 403 wall on a console URL', async ({ page }) => {
  await stubGrant(page, 'workspace');
  await signIn(page);
  await expect(page).toHaveURL(/\/app\/home$/);

  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByTestId('forbidden-panel')).toBeVisible();
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.getByTestId('forbidden-to-workspace')).toBeVisible();
});
