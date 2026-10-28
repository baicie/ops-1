import { expect, test, type Page } from '@playwright/test';

// G06 acceptance: a plugin contribution is scoped to one surface.
//
// Every scenario below is built by intercepting `/api/v1/extensions` and the stub remote
// entries it points at - the application is never modified for a test, and the payload has
// exactly the shape the server contract defines (`navigation.item.v2` / `route.page.v2`,
// with `navigation.item.v1` kept in the same response). Selectors are hrefs and
// data-testids only, never localized copy (rules/06).

const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
const VIEWER_GRANT = { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] };

/** One plugin per rule the contract states; the ids only exist inside this spec. */
const CATALOG = 'opsweave.test-catalog';   // surface "admin", well formed
const NOTEBOOK = 'opsweave.test-notebook'; // surface "workspace", well formed
const LEGACY = 'dev.opsweave.test-legacy'; // navigation.item.v1 / route.page.v1
const ESCAPER = 'opsweave.test-escaper';   // v2 path inside another plugin's namespace
const GHOST = 'opsweave.test-ghost';       // v2 with a surface the platform does not have
const RUDE = 'opsweave.test-rude';         // v2 on the bare /admin root
const FLAGGED = 'opsweave.test-flagged';   // well formed, but the server rejected it

const CATALOG_PAGE = `/admin/ext/${CATALOG}/manage`;
const NOTEBOOK_PAGE = `/app/ext/${NOTEBOOK}/board`;
const GHOST_PAGE = `/app/ext/${GHOST}/board`;
const FLAGGED_PAGE = `/admin/ext/${FLAGGED}/manage`;
const LEGACY_CLAIM = '/ext/trusted-team/legacy';
const LEGACY_PAGE = `/admin${LEGACY_CLAIM}`;

function extension(pluginId: string, contributions: unknown[], rejections: unknown[] = []) {
  return {
    pluginId,
    publisher: 'trusted-team',
    version: '0.0.1',
    activationRevision: 7,
    assetBase: `/assets/stub/${pluginId}/0.0.1`,
    remoteEntry: 'remoteEntry.js',
    contributions,
    rejections,
  };
}

/**
 * What the stubbed server ships. Two of the six entries are deliberately out of contract,
 * and the viewer test reuses this same body: a server that forgets to filter must still not
 * hand the console to a user without `platform:access`.
 */
const PAYLOAD = [
  extension(CATALOG, [
    { kind: 'route.page.v2', id: 'catalog-page', surface: 'admin', path: CATALOG_PAGE, requiredCapabilities: ['platform:access'] },
    { kind: 'navigation.item.v2', id: 'catalog-nav', surface: 'admin', path: CATALOG_PAGE, titleKey: 'plugin.catalog.title', requiredCapabilities: ['platform:access'] },
  ]),
  extension(NOTEBOOK, [
    { kind: 'route.page.v2', id: 'notebook-page', surface: 'workspace', path: NOTEBOOK_PAGE },
    { kind: 'navigation.item.v2', id: 'notebook-nav', surface: 'workspace', path: NOTEBOOK_PAGE },
  ]),
  // The server stamps `surface` on a v1 contribution too; the client must still treat it as v1.
  extension(LEGACY, [
    { kind: 'route.page.v1', id: 'legacy-page', path: LEGACY_CLAIM, surface: 'admin' },
    { kind: 'navigation.item.v1', id: 'legacy-nav', path: LEGACY_CLAIM, surface: 'admin' },
  ]),
  // Well-formed, but the server refused it: the server's verdict wins over the payload.
  extension(FLAGGED, [
    { kind: 'route.page.v2', id: 'flagged-page', surface: 'admin', path: FLAGGED_PAGE, titleKey: 'plugin.flagged.title' },
    { kind: 'navigation.item.v2', id: 'flagged-nav', surface: 'admin', path: FLAGGED_PAGE },
  ], [
    { code: 'UNEXPECTED_FIELD', pluginId: FLAGGED, contributionId: 'flagged-page', kind: 'route.page.v2', detail: 'titleKey' },
    { code: 'UNEXPECTED_FIELD', pluginId: FLAGGED, contributionId: 'flagged-nav', kind: 'navigation.item.v2', detail: 'titleKey' },
  ]),
  extension(ESCAPER, [
    { kind: 'route.page.v2', id: 'escaper-page', surface: 'admin', path: CATALOG_PAGE },
  ]),
  extension(GHOST, [
    { kind: 'route.page.v2', id: 'ghost-page', surface: 'ops', path: GHOST_PAGE },
  ]),
  extension(RUDE, [
    { kind: 'navigation.item.v2', id: 'rude-nav', surface: 'admin', path: '/admin' },
  ]),
];

/** A remote entry that registers exactly what the host contract asks a plugin for. */
function remoteEntry(pluginId: string, pages: Record<string, string>, navigation: Record<string, string>): string {
  const components = Object.entries(pages)
    .map(([id, heading]) =>
      `        ${JSON.stringify(id)}: function () { return window.React.createElement('h1', { 'data-testid': 'plugin-page' }, ${JSON.stringify(heading)}); }`)
    .join(',\n');
  return `window.__OPSWEAVE_REMOTES__ = window.__OPSWEAVE_REMOTES__ || {};
window.__OPSWEAVE_REMOTES__[${JSON.stringify(pluginId)}] = {
  register: function () {
    return {
      navigation: ${JSON.stringify(navigation)},
      components: {
${components}
      },
    };
  },
};
`;
}

const REMOTE_ENTRIES: Record<string, string> = {
  [CATALOG]: remoteEntry(CATALOG, { 'catalog-page': 'Catalog sheet' }, { 'catalog-nav': { label: 'Catalog sheet' } }),
  [NOTEBOOK]: remoteEntry(NOTEBOOK, { 'notebook-page': 'Notebook board' }, { 'notebook-nav': { label: 'Notebook board' } }),
  [LEGACY]: remoteEntry(LEGACY, { 'legacy-page': 'Legacy page' }, { 'legacy-nav': { label: 'Legacy page' } }),
  [ESCAPER]: remoteEntry(ESCAPER, { 'escaper-page': 'Escaper page' }, {}),
  [GHOST]: remoteEntry(GHOST, { 'ghost-page': 'Ghost page' }, {}),
  [RUDE]: remoteEntry(RUDE, {}, { 'rude-nav': { label: 'Rude item' } }),
};

type Harness = { pageErrors: string[]; warnings: string[] };

/** Interception only: the session grant, the extension list and its stub remotes. */
async function harness(page: Page, grant: 'admin' | 'viewer'): Promise<Harness> {
  const pageErrors: string[] = [];
  const warnings: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'warning') warnings.push(message.text()); });

  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = grant === 'admin' ? ADMIN_GRANT : VIEWER_GRANT;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/extensions', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) });
  });
  await page.route('**/assets/stub/**', async (route) => {
    const url = route.request().url();
    const pluginId = Object.keys(REMOTE_ENTRIES).find((id) => url.includes(`/assets/stub/${id}/`));
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: pluginId ? REMOTE_ENTRIES[pluginId] : '' });
  });
  return { pageErrors, warnings };
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function switchSurface(page: Page, target: 'admin' | 'workspace') {
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('user-menu-trigger')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId(`surface-switch-${target}`).click();
  await expect(page.locator('.user-menu')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test('an admin contribution reaches the console navigation and its own outlet only', async ({ page }) => {
  const seen = await harness(page, 'admin');
  await signIn(page);

  // The console rail is mounted (the workspace rail is the only other one, and it is not).
  await expect(page.getByTestId('workspace-sidebar')).toHaveCount(0);
  await expect(page.locator(`a[href="${CATALOG_PAGE}"]`)).toBeVisible();
  // The workspace contribution is not mirrored into the console rail.
  await expect(page.locator(`a[href="${NOTEBOOK_PAGE}"]`)).toHaveCount(0);

  await page.locator(`a[href="${CATALOG_PAGE}"]`).click();
  await expect(page).toHaveURL((url) => url.pathname === CATALOG_PAGE);
  await expect(page.getByTestId('plugin-page')).toHaveText('Catalog sheet');
  expect(seen.pageErrors).toEqual([]);
});

test('a workspace contribution reaches the workspace navigation and the /app/ext outlet', async ({ page }) => {
  const seen = await harness(page, 'admin');
  await signIn(page);
  await switchSurface(page, 'workspace');

  const workspaceNav = page.getByTestId('workspace-sidebar');
  await expect(workspaceNav).toBeVisible();
  await expect(workspaceNav.locator(`a[href="${NOTEBOOK_PAGE}"]`)).toBeVisible();
  // The admin contribution is not mirrored into the workspace rail.
  await expect(page.locator(`a[href="${CATALOG_PAGE}"]`)).toHaveCount(0);
  await expect(page.getByTestId('extension-nav-catalog-nav')).toHaveCount(0);

  await workspaceNav.locator(`a[href="${NOTEBOOK_PAGE}"]`).click();
  await expect(page).toHaveURL((url) => url.pathname === NOTEBOOK_PAGE);
  await expect(page.getByTestId('plugin-page')).toHaveText('Notebook board');
  expect(seen.pageErrors).toEqual([]);
});

test('a signed v1 contribution still loads and keeps the legacy /ext URL working', async ({ page }) => {
  const seen = await harness(page, 'admin');
  await signIn(page);

  // v1 keeps its old path shape in the manifest and is still mounted under the /admin guard.
  await expect(page.locator('.admin-sidebar').locator(`a[href="${LEGACY_PAGE}"]`)).toBeVisible();
  await page.goto(LEGACY_CLAIM);
  await expect(page).toHaveURL((url) => url.pathname === LEGACY_PAGE);
  await expect(page.getByTestId('plugin-page')).toHaveText('Legacy page');
  expect(seen.pageErrors).toEqual([]);
});

test('out-of-contract contributions are dropped, logged, and never answer a host path', async ({ page }) => {
  const seen = await harness(page, 'admin');
  await signIn(page);

  // (a) Escaping into another plugin's namespace is rejected: the legitimate owner still wins.
  await page.goto(CATALOG_PAGE);
  await expect(page.getByTestId('plugin-page')).toHaveText('Catalog sheet');
  await expect(page.getByTestId('extension-rejected')).toHaveCount(0);

  // (b) A contribution claiming the bare /admin root cannot take the console: the host route wins.
  await page.goto('/admin');
  await expect(page).toHaveURL((url) => url.pathname === '/admin/overview');
  await expect(page.getByTestId('extension-rejected')).toHaveCount(0);
  await expect(page.locator('a[href="/admin/nodes"]')).toBeVisible();

  // (c) A contribution the server rejected is never mounted, even though it arrived well formed.
  await expect(page.locator(`a[href="${FLAGGED_PAGE}"]`)).toHaveCount(0);
  await page.goto(FLAGGED_PAGE);
  await expect(page.getByTestId('extension-rejected')).toHaveAttribute('data-rejection-code', 'UNEXPECTED_FIELD');
  await expect(page.getByTestId('plugin-page')).toHaveCount(0);

  // (d) An unknown surface is answered with the reason instead of a blank screen.
  await switchSurface(page, 'workspace');
  await page.goto(GHOST_PAGE);
  await expect(page.getByTestId('extension-rejected')).toHaveAttribute('data-rejection-code', 'surface');
  await expect(page.getByTestId('plugin-page')).toHaveCount(0);
  await expect(page.getByTestId('workspace-sidebar')).toBeVisible();

  // Dropped, but recorded: the shell logged every rejection instead of throwing.
  await expect.poll(() => seen.warnings.filter((line) => line.includes('[extensions] contribution rejected')).length)
    .toBeGreaterThanOrEqual(3);
  await expect.poll(() => seen.warnings.filter((line) => line.includes('[extensions] server rejected contribution')).length)
    .toBeGreaterThanOrEqual(2);
  expect(seen.pageErrors).toEqual([]);
});

test('a viewer without platform:access never receives an admin contribution', async ({ page }) => {
  const seen = await harness(page, 'viewer');
  await signIn(page);

  // The grant routes the session into the workspace, not the console.
  await expect(page).toHaveURL((url) => url.pathname === '/app/home');
  const workspaceNav = page.getByTestId('workspace-sidebar');
  await expect(workspaceNav.locator(`a[href="${NOTEBOOK_PAGE}"]`)).toBeVisible();

  // The payload carried the admin contribution; the client dropped it as well.
  await expect(page.locator(`a[href="${CATALOG_PAGE}"]`)).toHaveCount(0);
  await expect(page.locator(`a[href="${LEGACY_PAGE}"]`)).toHaveCount(0);

  // Proof it was never even fetched: only the reachable plugin injected a remote entry.
  await expect(page.locator(`script[data-opsweave-remote*="${NOTEBOOK}"]`)).toHaveCount(1);
  await expect(page.locator(`script[data-opsweave-remote*="${CATALOG}"]`)).toHaveCount(0);

  // A hand-typed admin URL meets the guard, never the plugin.
  await page.goto(CATALOG_PAGE);
  await expect(page).toHaveURL((url) => url.pathname === '/403');
  await expect(page.getByTestId('forbidden-panel')).toBeVisible();
  await page.goto(LEGACY_CLAIM);
  await expect(page).toHaveURL((url) => url.pathname === '/403');
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  expect(seen.pageErrors).toEqual([]);
});
