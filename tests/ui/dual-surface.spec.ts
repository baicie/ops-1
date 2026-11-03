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
  // Every stage carries its own name and budget, because "Test timeout of 60000ms" cannot tell a
  // slow document from a missing response from a form that never rendered. Measured on the
  // staging link (run 41632959836): the failure read `waitForResponse: Timeout 20000ms` with
  // `navigating to /login, waiting until "load"` underneath it, and the only way to tell those
  // apart was to reproduce them by hand.
  //
  // The three stages, in the order the page performs them:
  //   1. the document and its bundle load            (`goto`, default `load`)
  //   2. the bootstrap probe answers                 (registered before 1, so it cannot be missed)
  //   3. the form is usable and the session commits  (fill/click/waitForURL)
  //
  // Default `load` for stage 1 is deliberate. A `commit` + 30 s variant was measured on run
  // 41597654753 and REVERTED: it returned before the bundle executed, so stage 2 became the
  // binding constraint and three cases failed instead of two. The cost of a slow path has to be
  // paid by the step that owns the wait; moving it to a shorter budget does not shorten the path.
  const stage = (name: string, error: unknown): never => {
    throw new Error('signIn stage failed [' + name + ']: ' + String((error as Error)?.message || error).split('\n')[0]);
  };
  // The document budget must be the SHORTER of the two, or a slow document is misreported as a
  // slow probe: the probe's clock starts at registration (before the navigation), so with equal
  // budgets the probe expires first and the message blames `/auth/me` for a page that never
  // loaded. Measured on the harness itself: a document delayed 12 s under two equal 8 s budgets
  // reported `bootstrap-probe`, which is the wrong stage.
  const DOCUMENT_BUDGET_MS = 20_000;
  const PROBE_BUDGET_MS = 30_000;
  let probeError: unknown = null;
  const bootstrapProbe = page
    .waitForResponse((response) => response.url().includes('/api/v1/auth/me'), { timeout: PROBE_BUDGET_MS })
    .catch((error) => { probeError = error; });
  try {
    await page.goto('/login', { waitUntil: 'load', timeout: DOCUMENT_BUDGET_MS });
  } catch (error) {
    stage('document (/login, waitUntil load)', error);
  }
  await bootstrapProbe;
  if (probeError) stage('bootstrap-probe (/auth/me after load)', probeError);
  try {
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('[data-testid="login-submit"]');
  } catch (error) {
    stage('login-form (fill and submit)', error);
  }
  try {
    await expect(page).not.toHaveURL(/\/login/);
  } catch (error) {
    stage('session-commit (session established and routed away from /login)', error);
  }
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
    // `commit`, not the default `load`, and a per-navigation budget instead of only the test's.
    // This case asserts WHERE a legacy URL lands, which is known once the navigation commits plus
    // the client redirect; it never reads a resource whose availability `load` would report. On
    // staging the default made the whole case depend on the last subresource of every page: a
    // run that took 6.1 min wall-clock for 19 specs stalled here for the full 180 s test timeout
    // while `navigating to /access, waiting until "load"` (the document itself answers in ~90 ms;
    // measured separately), which reads as "the product hung" and is not. The budget below names
    // the leg that is slow when one is, instead of blaming whichever test happened to own it.
    await page.goto(from, { waitUntil: 'commit', timeout: 30_000 });
    // `waitForURL`, not `toHaveURL`: once the navigation waits for `commit`, the client-side
    // redirect happens after the bundle executes, and the assertion's 10 s expect budget became
    // the binding constraint on a slow path (run 41597654753: this case failed at 53 s with
    // "expect(page).toHaveURL ... Timeout: 10000ms"). The redirect is the thing under test, so it
    // gets its own named budget instead of inheriting a default meant for a rendered page.
    // A failure names the expected canonical URL and the budget it was given.
    await page.waitForURL(new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), { timeout: 30_000 });
  }

  // No open redirect: a parameter the destination does not read is dropped, not forwarded.
  await page.goto('/nodes?next=https://evil.example/steal', { waitUntil: 'commit', timeout: 30_000 });
  await page.waitForURL(/\/admin\/nodes$/, { timeout: 30_000 });
  expect(new URL(page.url()).search).toBe('');

  // A path that is not in the table stays a 404 - the compatibility layer is a closed list.
  await page.goto('/not-a-known-route', { waitUntil: 'commit', timeout: 30_000 });
  await page.waitForURL(/\/not-a-known-route$/, { timeout: 30_000 });
});

test('the workspace states what is missing instead of inventing business data', async ({ page }) => {
  await stubGrant(page, 'admin');
  await signIn(page);

  // The home page lists every capability this build does not serve end to end, each marked as
  // such. Five, not six, because `incidents` shipped with G11 D3. Note what "shipped" means here:
  // it is NOT "the route renders". `observability` and `sources` have real pages reading real
  // rows and are still counted as not shipped, because neither has a business scope an account
  // can be granted - pages/workspace.tsx states the criterion on the `shipped` field. So this
  // number is the registry's own statement (business-workspace.spec.ts asserts the same five),
  // and it moves when a scope ships - not when a page appears.
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await page.goto('/app/home');
  await expect(page.getByTestId('workspace-home')).toBeVisible();
  await expect(page.locator('[data-surface-status="not-shipped"]')).toHaveCount(5);
  await expect(page.locator('[data-surface-status="shipped"][data-capability="incidents"]')).toHaveCount(1);

  // A capability that still has no interface keeps the placeholder: it states the absence and
  // shows no fabricated business data. It used to be /app/incidents here; that route is a real
  // list now, so the assertion moved to one that is genuinely not shipped.
  await page.goto('/app/reports');
  const notYet = page.getByTestId('surface-not-yet');
  await expect(notYet).toBeVisible();
  await expect(notYet).toHaveAttribute('data-surface-status', 'not-shipped');
  await expect(notYet).toHaveAttribute('data-capability', 'reports');
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

/**
 * A hanging grant read costs a bounded budget, not the caller's whole timeout.
 *
 * `login()` posts credentials, then reads `/api/v1/auth/me` for `access` (the login body carries
 * the user and the CSRF token, not the grant). It awaits that read because the first
 * authenticated render picks the surface for `/`, but the await used to be unbounded: on the
 * staging link (~250 ms TCP connect, ~500-830 ms TTFB per request) two serial round trips ate the
 * budget, and delaying only the SECOND read by 25 s reproduced it locally - `waitForURL` timed out
 * at 20.9 s while the login POST had already returned.
 *
 * This case holds that read open for 8 s and asserts the sign-in still completes: past the
 * bounded grant budget the identity from the login body is used, and the late answer upgrades the
 * same session instead of being lost. A future refactor that drops the bound fails here.
 */
test('a hanging grant read costs a bounded budget, not the whole sign-in', async ({ page }) => {
  grantProbeCalls = 0;
  await page.route('**/api/v1/auth/me', async (route) => {
    grantProbeCalls += 1;
    // The first call is the bootstrap probe; the second is the one login() starts.
    if (grantProbeCalls === 2) await new Promise((resolve) => setTimeout(resolve, 8_000));
    const response = await route.fetch();
    const body = await response.json();
    body.access = ADMIN_GRANT;
    await route.fulfill({ response, json: body });
  });

  const started = Date.now();
  await signIn(page);
  const elapsed = Date.now() - started;
  // Signed in and routed while the second /auth/me is still held for 8 s.
  await expect(page).toHaveURL(/\/app\/home$/);
  expect(elapsed, 'sign-in waited for the held grant read instead of its own budget').toBeLessThan(7_000);
  // At least two: the bootstrap probe, then the one login() starts. Exactly three here, and the
  // third is the point of the fix - the bounded read was abandoned on its budget and re-issued,
  // so the grant still lands instead of being lost to a hung socket.
  expect(grantProbeCalls, 'the bootstrap probe and the post-login grant read both ran').toBeGreaterThanOrEqual(2);

  // The late grant upgrades the same session: the console becomes reachable without a second
  // sign-in, once the held read finally answers.
  await expect(page.getByTestId('user-menu-trigger')).toBeVisible();
  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByTestId('surface-switch-admin'), 'the late grant upgrades the same session').toBeVisible();
});

/** Counts `/auth/me` calls for the test above; declared here so the route handler can close over it. */
let grantProbeCalls = 0;
