import { expect, test, type Page } from '@playwright/test';

// G04 acceptance: one session, two shells.
//
// The server grant is *stubbed onto the real response*: this spec pins the frontend contract
// from the G04 brief for every grant shape (both surfaces / workspace only / no `access` at
// all) without depending on which kernel binary the target host happens to run. `/auth/me`
// is re-fetched for real, so the cookie session and the CSRF token are the live ones and a
// re-login would show up as an extra `/login` navigation.
//
// Selectors are roles, hrefs and data-testids only - never localized copy (rules/06).
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
const WORKSPACE_GRANT = { allowedSurfaces: ['workspace'], capabilities: ['workspace:access'] };

type Grant = 'admin' | 'workspace' | 'absent';

/** Replaces only `access` on the live payload; every other field stays the server's. */
async function stubGrant(page: Page, grant: Grant) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (grant === 'absent') delete body.access;
    else body.access = grant === 'admin' ? ADMIN_GRANT : WORKSPACE_GRANT;
    await route.fulfill({ response, json: body });
  });
}

/** Every main-frame navigation, so "never signed in twice" is an assertion, not a hope. */
function trackNavigations(page: Page): string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(new URL(frame.url()).pathname);
  });
  return seen;
}

/**
 * Signs in through the form and waits for the app to leave /login.
 *
 * The bootstrap session probe is awaited *before* the credentials are typed. A cold
 * `/auth/me` answers 401, and `api.ts` turns any 401 into `opsweave:unauthorized`, which
 * clears the user again - so a probe that is still in flight when the login lands wipes the
 * session that was just established and the app returns to /login with an empty form and no
 * error. That is exactly what failed here on staging (run 40809470709): the stub's extra round
 * trip put the 401 at 1289 ms, i.e. behind the login POST. What the probe answers is
 * irrelevant to this file; only that it is over before a second session starts.
 */
async function signIn(page: Page) {
  // Registered before the navigation: the probe fires while the bundle is still executing.
  const bootstrapProbe = page.waitForResponse((response) => response.url().includes('/api/v1/auth/me'), { timeout: 20_000 });
  await page.goto('/login');
  await bootstrapProbe;
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

// Deliberately not a serial file: every test below stubs its own grant and signs in on a fresh
// context, so under serial one real failure turns its siblings into "did not run" and the run
// stops saying anything about them. Ordering is already the config's (workers: 1,
// fullyParallel: false); handlers here outlive the test - one can still be awaiting route.fetch
// when the context tears down - so leftovers are ignored instead of blamed on the next test.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('an admin moves between the console and the workspace on one session', async ({ page }) => {
  const navigations = trackNavigations(page);
  await stubGrant(page, 'admin');
  await signIn(page);
  // Everything after this point is the same signed-in session; a re-login would add /login.
  const signedInAt = navigations.length;

  // Entry: / decides for an admin, and the console chrome is what renders.
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.locator('.admin-sidebar')).toBeVisible();

  await switchSurface(page, 'workspace');
  await expect(page).toHaveURL(/\/app\/home$/);
  await expect(page.getByTestId('workspace-sidebar')).toBeVisible();
  await expect(page.getByTestId('workspace-home')).toBeVisible();

  // And back - the switcher is bidirectional, still inside the same document session.
  await switchSurface(page, 'admin');
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.locator('.admin-sidebar')).toBeVisible();

  // Switching surfaces never re-authenticates, and no login form is on screen at the end.
  expect(navigations.slice(signedInAt).filter((pathname) => pathname.startsWith('/login'))).toEqual([]);
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
});

test('a response without access denies the console before any admin content renders', async ({ page }) => {
  await stubGrant(page, 'absent');
  await signIn(page);

  // The documented fallback: workspace surface only, so / never routes into the console.
  await expect(page).toHaveURL(/\/app\/home$/);
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('surface-switch-admin')).toHaveCount(0);
  await expect(page.getByTestId('workspace-no-admin')).toBeVisible();
  await page.keyboard.press('Escape');

  // A hand-typed admin URL is answered by the guard, not by a rendered-then-redirected page.
  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByTestId('forbidden-panel')).toBeVisible();
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.getByTestId('forbidden-to-workspace')).toBeVisible();
  // "No declaration at all" is an operational signal (client/kernel versions out of step),
  // and this page is the only place that says so.
  await expect(page.getByTestId('forbidden-access-missing')).toBeVisible();
  await expect(page.getByTestId('forbidden-access-missing')).toHaveAttribute('data-access-source', 'missing');
});

test('a declared workspace-only grant is denied without the version-mismatch hint', async ({ page }) => {
  await stubGrant(page, 'workspace');
  await signIn(page);
  await expect(page).toHaveURL(/\/app\/home$/);

  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
  await expect(page.getByTestId('forbidden-panel')).toBeVisible();
  // Same page, different story: the server did answer, and the answer excludes this user.
  await expect(page.getByTestId('forbidden-access-missing')).toHaveCount(0);
  await expect(page.locator('.admin-sidebar')).toHaveCount(0);
});

test('the legacy URLs land on their canonical /admin path and drop unlisted query keys', async ({ page }) => {
  // Budget matched to this test's work, scoped to this test alone: the case is 21 cold full-page
  // loads wide (sign-in, the 18 table entries, the open-redirect probe, the unknown-route probe),
  // while the file-wide 60 s is a single-render budget. It measured 24.8 / 24.9 / 37.3 / 33.2 /
  // 27.6 s on the reporting workstation (5/5 green), and CI run 40814575863 hit 60 s on a slower
  // runner and timed out on the last entry. 180 s = 21 loads at a pessimistic 8 s each plus slack,
  // ~4.8x the worst local run; a genuinely slow case elsewhere in this file still fails at 60 s.
  // Not test.slow(): its 3x is derived from the global timeout, so a later global change would
  // move this budget silently instead of breaking here loudly.
  test.setTimeout(180_000);

  await stubGrant(page, 'admin');
  await signIn(page);
  await expect(page).toHaveURL(/\/admin\/overview$/);

  const cases: Array<[string, string]> = [
    ['/plugins', '/admin/plugins'],
    ['/plugins/install', '/admin/plugins/install'],
    ['/plugins/dev.opsweave.hello', '/admin/plugins/dev.opsweave.hello'],
    ['/nodes', '/admin/nodes'],
    ['/nodes/node-1', '/admin/nodes/node-1'],
    ['/pipelines', '/admin/pipelines'],
    ['/pipelines/pipe-1', '/admin/pipelines/pipe-1'],
    ['/pipelines/pipe-1/editor?draft=draft-9', '/admin/pipelines/pipe-1/editor?draft=draft-9'],
    ['/jobs', '/admin/jobs'],
    ['/jobs/job-1', '/admin/jobs/job-1'],
    ['/governance', '/admin/governance'],
    ['/activity', '/admin/activity'],
    ['/access', '/admin/access'],
    ['/settings', '/admin/settings'],
    ['/settings/diagnostics', '/admin/settings/diagnostics'],
    ['/ops-center', '/admin/ops-center'],
    ['/instances/inst-1/logs', '/admin/instances/inst-1/logs'],
    ['/ext/trusted-team/data-catalog', '/admin/ext/trusted-team/data-catalog'],
  ];
  for (const [from, to] of cases) {
    await page.goto(from);
    await expect(page, from + ' -> ' + to).toHaveURL(new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  }

  // No open redirect: a parameter the destination does not read is dropped, not forwarded.
  await page.goto('/nodes?next=https://evil.example/steal');
  await expect(page).toHaveURL(/\/admin\/nodes$/);
  expect(new URL(page.url()).search).toBe('');

  // A path that is not in the table stays a 404 - the compatibility layer is a closed list.
  await page.goto('/not-a-known-route');
  await expect(page).toHaveURL(/\/not-a-known-route$/);
});

test('the workspace states what is missing instead of inventing business data', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);

  // The home page lists every unshipped capability, each marked as such.
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await page.goto('/app/home');
  await expect(page.getByTestId('workspace-home')).toBeVisible();
  await expect(page.locator('[data-surface-status="not-shipped"]')).toHaveCount(6);

  await page.goto('/app/incidents');
  const notYet = page.getByTestId('surface-not-yet');
  await expect(notYet).toBeVisible();
  await expect(notYet).toHaveAttribute('data-surface-status', 'not-shipped');
  await expect(notYet).toHaveAttribute('data-capability', 'incidents');
  expect((await page.getByTestId('surface-not-yet-status').textContent())?.trim().length ?? 0).toBeGreaterThan(0);
  // No fabricated list, table or metric anywhere on the page.
  await expect(page.locator('table, [data-testid="metric-card"], .metric-card')).toHaveCount(0);
});

test('a workspace-only account never sees the console entry', async ({ page }) => {
  await stubGrant(page, 'workspace');
  await signIn(page);
  await expect(page).toHaveURL(/\/app\/home$/);

  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('current-surface')).toBeVisible();
  await expect(page.getByTestId('surface-switch-admin')).toHaveCount(0);
  await expect(page.getByTestId('surface-switch-workspace')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.user-menu')).toHaveCount(0);

  await page.goto('/admin/nodes');
  await expect(page).toHaveURL(/\/403$/);
});

test('the switcher is usable at 390px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubGrant(page, 'admin');
  await signIn(page);
  await expect(page).toHaveURL(/\/admin\/overview$/);

  await switchSurface(page, 'workspace');
  await expect(page).toHaveURL(/\/app\/home$/);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // The workspace rail is a drawer here; the switcher lives in the topbar menu either way.
  await expect(page.getByTestId('workspace-sidebar')).toHaveAttribute('data-drawer', 'true');
  await switchSurface(page, 'admin');
  await expect(page).toHaveURL(/\/admin\/overview$/);
});
