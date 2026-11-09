import { expect, test, type Page } from '@playwright/test';

/**
 * Which boundary owns the chrome verdict, and when it lets go.
 *
 * These are the DS-V1-1c regressions: a plugin that crashed once used to leave the topbar
 * saying "unavailable" after it had recovered, because every AsyncBoundary wrote one shared
 * body state and nothing withdrew it. The store now keeps one claim per boundary id; these
 * tests drive the real Kernel (or a stubbed response on its real route) and read the same
 * `data-verdict` the topbar prints.
 *
 * The plugin cases serve a real remote-entry script through route interception: the extension
 * loader, the contribution filter, the error boundary and the retry path all execute.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const EXTENSION = [{
  pluginId: 'acme.fixture',
  publisher: 'acme',
  version: '1.0.0',
  activationRevision: 1,
  assetBase: '/plugin-fixture',
  remoteEntry: 'remote.js',
  contributions: [{ kind: 'route.page.v2', id: 'page', path: '/admin/ext/acme.fixture/page', surface: 'admin' }],
}];

const OVERVIEW = { health: 'READY', nodesTotal: 1, nodesReady: 1, pluginsInstalled: 1, pluginsAvailable: 0, instancesReady: 1, instancesTotal: 1, activeDeployments: 1, attention: [], recentEvents: [] };

async function login(page: Page) {
  await page.route('**/api/v1/overview', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OVERVIEW) }));
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => localStorage.setItem('opsweave-locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !/\/login$/.test(url.pathname));
}

const verdict = (page: Page) => page.getByTestId('health-pill').getAttribute('data-verdict');

test('a 503 body marks the chrome unavailable, and a route change releases it', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/nodes*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FIXTURE_DOWN', message: 'fixture kernel down' }) }));
  await page.goto('/admin/nodes');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('unavailable');
  await page.unroute('**/api/v1/nodes*');
  await page.goto('/admin/overview');
  await expect(page.getByTestId('page-header')).toBeVisible();
  await expect.poll(() => verdict(page)).not.toBe('unavailable');
});

test('a plugin load failure is attention, not a kernel outage', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EXTENSION) }));
  await page.route('**/plugin-fixture/remote.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/admin/ext/acme.fixture/page');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect(page.getByTestId('server-message')).toHaveAttribute('data-source', 'plugin');
  await expect.poll(() => verdict(page)).toBe('attention');
});

test('a recovered plugin releases its chrome claim', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EXTENSION) }));
  await page.route('**/plugin-fixture/remote.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `window.__OPSWEAVE_REMOTES__ = window.__OPSWEAVE_REMOTES__ || {};
window.__OPSWEAVE_REMOTES__['acme.fixture'] = { register: function () {
  return { components: { page: function Page() {
    if (!window.__PLUGIN_RECOVER__) throw new Error('fixture render failure');
    return window.React.createElement('div', { 'data-testid': 'plugin-recovered' }, 'Recovered');
  } } };
} };`,
  }));
  await page.goto('/admin/ext/acme.fixture/page');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('attention');
  await page.evaluate(() => { (window as any).__PLUGIN_RECOVER__ = true; });
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('plugin-recovered')).toBeVisible();
  await expect.poll(() => verdict(page)).not.toBe('attention');
});

test('a 403 body is a permission wall on page and chrome', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/nodes*', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'FORBIDDEN', message: 'fixture refusal' }) }));
  await page.goto('/admin/nodes');
  await expect(page.locator('[data-async-state="forbidden"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('forbidden');
});

test('signing out and back in does not inherit the previous body verdict', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/nodes*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FIXTURE_DOWN', message: 'fixture kernel down' }) }));
  await page.goto('/admin/nodes');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('unavailable');
  await page.unroute('**/api/v1/nodes*');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem').last().click();
  await page.waitForURL((url) => url.pathname.startsWith('/login'));
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !/\/login$/.test(url.pathname));
  await page.goto('/admin/overview');
  await expect(page.getByTestId('page-header')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('ready');
});

test('a failed upload inside the wizard does not mark the platform unavailable', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/plugins/packages', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'FIXTURE_UPLOAD', message: 'fixture refused the upload' }) }));
  await page.goto('/admin/plugins/install');
  await expect(page.getByTestId('page-header')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('ready');
  await page.locator('input[type=file]').setInputFiles({ name: 'fixture.zip', mimeType: 'application/zip', buffer: Buffer.from('PK fixture') });
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('ready');
});

test('client-side navigation keeps the destination boundary claim', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/nodes*', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'FIXTURE_DOWN', message: 'fixture kernel down' }),
  }));
  await page.goto('/admin/nodes');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('unavailable');
  // Client-side link, not a document load: the shell's reset must not erase the report the
  // destination boundary made after it.
  await page.getByRole('link', { name: 'Overview' }).first().click();
  await expect(page.getByTestId('page-header')).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('unavailable');
});

test('a cached plugin failure survives leaving and returning by history', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/extensions', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EXTENSION) }));
  await page.route('**/plugin-fixture/remote.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/admin/ext/acme.fixture/page');
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('attention');
  await page.getByRole('link', { name: 'Overview' }).first().click();
  await expect(page.getByTestId('page-header')).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-async-state="error"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('attention');
});

test('a section refusal stays in its panel and leaves the chrome alone', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/settings/runtime-policies', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'FORBIDDEN', message: 'fixture section refusal' }),
  }));
  await page.goto('/admin/settings');
  await expect(page.locator('[data-async-state="forbidden"]')).toBeVisible();
  await expect.poll(() => verdict(page)).toBe('ready');
});
