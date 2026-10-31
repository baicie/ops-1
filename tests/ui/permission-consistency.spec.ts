import { test as base, expect, type Page } from '@playwright/test';

// G10 / Phase C2: login and surface switching against the *real* kernel.
//
// dual-surface.spec.ts stubs the grant and thereby pins the frontend contract. This file
// deliberately does the opposite: it signs in once against the running kernel, reuses that
// cookie for every test, and asserts the behaviour of the session itself - one cookie, one
// login, a revocation that is obeyed, a surface that is refused before it fetches, and the
// fact (recorded, not blessed) that a refused surface is still a readable API.
//
// Selectors are roles and data-testids only - never localized copy (rules/06).
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

// Role fixtures for the C1 assertions. Absent credentials mean the column is skipped,
// never faked: this file does not create users and never writes to the environment.
const OPERATOR_EMAIL = process.env.OPSWEAVE_OPERATOR_EMAIL || '';
const OPERATOR_PASSWORD = process.env.OPSWEAVE_OPERATOR_PASSWORD || '';
const VIEWER_EMAIL = process.env.OPSWEAVE_VIEWER_EMAIL || '';
const VIEWER_PASSWORD = process.env.OPSWEAVE_VIEWER_PASSWORD || '';

const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
const WORKSPACE_GRANT = { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] };

interface Session {
  cookie: { name: string; value: string; domain: string; path: string; httpOnly: boolean; sameSite: 'Strict' };
  csrf: string;
  userId: string;
}

// One sign-in for the whole worker: every test reuses the cookie, so the limiter and the
// "never signed in twice" claim stay true across the file.
const test = base.extend<{}, { adminSession: Session }>({
  adminSession: [async ({ playwright }, use) => {
    const api = await playwright.request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    const response = await api.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } });
    expect(response.status(), 'the admin fixture must be able to sign in').toBe(200);
    const body = await response.json();
    const header = response.headers()['set-cookie'] || '';
    const match = /opsweave_session=([^;]+)/.exec(header);
    expect(match, 'login must set the session cookie').not.toBeNull();
    await api.dispose();
    await use({
      cookie: { name: 'opsweave_session', value: String(match && match[1]), domain: new URL(BASE).hostname, path: '/', httpOnly: true, sameSite: 'Strict' },
      csrf: body.csrfToken,
      userId: body.user.id,
    });
  }, { scope: 'worker' }],
});

// Hand the browser the one authorised cookie; nothing else about the session is stubbed.
async function useAdminSession(page: Page, session: Session) {
  await page.context().addCookies([session.cookie]);
}

// Replaces only the access field on the live payload: the session, the cookie and every
// other field stay the server's, so the guard is tested against a real session.
async function stubAccess(page: Page, grant: 'admin' | 'workspace' | 'absent') {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (grant === 'absent') delete body.access;
    else body.access = grant === 'admin' ? ADMIN_GRANT : WORKSPACE_GRANT;
    await route.fulfill({ response, json: body });
  });
}

// Every main-frame navigation, so "never signed in twice" is an assertion, not a hope.
function trackNavigations(page: Page): string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
  });
  return seen;
}

// Every /api/v1 request path, so "the shell never mounted" can be proven by traffic.
function trackApiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) seen.push(url.pathname);
  });
  return seen;
}

// Signs a specific account in through the form; the bootstrap probe is awaited first so a
// cold 401 cannot wipe the session the login just established.
async function signInAs(page: Page, email: string, password: string) {
  const probe = page.waitForResponse((response) => response.url().includes('/api/v1/auth/me'), { timeout: 20_000 });
  await page.goto('/login');
  await probe;
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// --- C2.1 / C2.6: one session, no second sign-in -------------------------------

test('one cookie session reaches the console without a login form', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  const navigations = trackNavigations(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.locator('.admin-sidebar')).toBeVisible();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  expect(navigations.filter((path) => path.startsWith('/login'))).toEqual([]);
});

test('switching surfaces reuses the same session and the same document', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/overview$/);
  const navigations = trackNavigations(page);

  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('surface-switch-workspace').click();
  await expect(page).toHaveURL(/\/app\/home$/);
  await expect(page.getByTestId('workspace-sidebar')).toBeVisible();

  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('surface-switch-admin').click();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.locator('.admin-sidebar')).toBeVisible();

  expect(navigations.filter((path) => path.startsWith('/login'))).toEqual([]);
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
});

// --- C2.5: default entry, pinned as it is (the product decision is still open) --

test('the default entry for an admin with no remembered state is the console', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/overview$/);
  // Pinned, not endorsed: docs/design/g10-closure/permission-adr.md D2 records the open
  // question "should the business workspace be the default entry instead?".
  expect(await page.evaluate(() => window.localStorage.getItem('opsweave-surface'))).toBe('admin');
});

// --- C2.3: one account owns its own remembered location ------------------------

test('surface memory is discarded when the browser is handed to another account', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/admin\/nodes$/);

  // Same identity: the remembered path is honoured.
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/nodes$/);

  // A different account on the same browser must not inherit it.
  await page.evaluate(() => window.localStorage.setItem('opsweave-surface-owner', '00000000-0000-0000-0000-000000000000'));
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin\/overview$/);
  expect(await page.evaluate(() => window.localStorage.getItem('opsweave-surface-owner'))).toBe(adminSession.userId);
  // The foreign entry is gone; what is left is this identity's own first recorded location.
  expect(await page.evaluate(() => window.localStorage.getItem('opsweave-surface-path:admin'))).toBe('/admin/overview');
});

// --- C2.2: a refused surface is refused before it renders or fetches -----------

test('a workspace-only grant is refused before the console shell renders or fetches', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await stubAccess(page, 'workspace');
  const api = trackApiRequests(page);

  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByTestId('forbidden-panel')).toBeVisible();
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  // The URL itself is a plain SPA shell for everyone; what must not happen is a console
  // data request. Traffic proves the shell never mounted.
  expect(api.filter((path) => path === '/api/v1/nodes')).toEqual([]);
});

// --- C1 Q3: the surface refusal does not cross into the data layer -------------

test('a refused surface keeps its API readable (recorded structural gap, not a licence)', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await stubAccess(page, 'workspace');
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);

  // Same cookie, real server: the console is denied by the declaration, while the
  // resource layer answers 200 because it never reads that declaration.
  expect((await page.request.get('/api/v1/nodes')).status()).toBe(200);
  expect((await page.request.get('/api/v1/settings/runtime-policies')).status()).toBe(200);
});

// --- C2.4a: a grant that appears while the tab is open -------------------------

test('a grant acquired while the tab is open is picked up by the retry on /403', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await stubAccess(page, 'workspace');
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);

  await page.unroute('**/api/v1/auth/me');
  await page.getByTestId('forbidden-retry').click();
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.locator('.admin-sidebar')).toBeVisible();
});

// --- C2.4b / C2.2: a revoked session cannot be re-entered by URL ---------------

test('a revoked session presented through a stale cookie is sent to /login', async ({ page, adminSession }) => {
  await useAdminSession(page, adminSession);
  await page.goto('/');
  await expect(page.locator('.admin-sidebar')).toBeVisible();

  const stale = await page.context().cookies();
  const revoked = await page.request.post('/api/v1/auth/logout', { headers: { 'x-csrf-token': adminSession.csrf } });
  expect(revoked.status()).toBe(200);

  // Put the pre-revocation cookie back: the session is gone, the browser does not know.
  await page.context().clearCookies();
  await page.context().addCookies(stale);
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('login-submit')).toBeVisible();
});

// --- C1 Q1 / Q2: the real role columns (skipped when no fixture credentials) ---

test('an operator is refused the console while its management APIs still answer', async ({ page }) => {
  test.skip(!OPERATOR_EMAIL || !OPERATOR_PASSWORD, 'set OPSWEAVE_OPERATOR_EMAIL / OPSWEAVE_OPERATOR_PASSWORD');
  await signInAs(page, OPERATOR_EMAIL, OPERATOR_PASSWORD);
  // No console surface: the entry lands in the workspace, the console URL is refused.
  await expect(page).toHaveURL(/\/app\/home$/);
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  // Same session: operator-gated and ungated resources are still readable.
  expect((await page.request.get('/api/v1/nodes')).status()).toBe(200);
  expect((await page.request.get('/bootstrap')).status()).toBe(200);
  // Admin-only resources are not.
  expect((await page.request.get('/api/v1/settings/runtime-policies')).status()).toBe(403);
});

test('a viewer reads the ungated platform endpoints while the console refuses the page', async ({ page }) => {
  test.skip(!VIEWER_EMAIL || !VIEWER_PASSWORD, 'set OPSWEAVE_VIEWER_EMAIL / OPSWEAVE_VIEWER_PASSWORD');
  await signInAs(page, VIEWER_EMAIL, VIEWER_PASSWORD);
  await expect(page).toHaveURL(/\/app\/home$/);
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  expect((await page.request.get('/api/v1/nodes')).status()).toBe(200);
  expect((await page.request.get('/api/v1/audit')).status()).toBe(200);
  expect((await page.request.get('/api/v1/settings/runtime-policies')).status()).toBe(403);
});
