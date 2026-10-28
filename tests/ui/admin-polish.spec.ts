import { expect, type Browser, type Page, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G08 acceptance for the remaining platform-maintenance pages (docs/04 §4.4/§4.6, docs/09 §9.1,
 * pack/prompts/09-ADMIN-POLISH.md).
 *
 * Every page is asserted against the live Gateway where the state is reachable. States the
 * running stack cannot produce on demand (a pipeline without a published revision, a kernel
 * reply with missing facts, a refused write) are produced by rewriting the *response* the page
 * already consumes — never by mock data inside the application, which keeps one code path.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/g08-admin-polish');
const BASE_URL = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';
const SHA = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
})();

const PAGES = [
  { route: '/admin/access', heading: 'Access & trust', slug: 'access' },
  { route: '/admin/settings', heading: 'Settings', slug: 'settings' },
  { route: '/admin/settings/diagnostics', heading: 'Bootstrap Diagnostics', slug: 'diagnostics' },
  { route: '/admin/activity', heading: 'Activity', slug: 'activity' },
  { route: '/admin/jobs', heading: 'Jobs', slug: 'jobs' },
  { route: '/admin/pipelines', heading: 'Pipelines', slug: 'pipelines' },
  { route: '/admin/governance', heading: 'Governance', slug: 'governance' },
] as const;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const;

const PIPELINE_ID = 'host-metrics-pipeline';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const FIXTURE_USER = 'polish-fixture-user';

const JOB_VIEW = {
  jobId: JOB_ID,
  pipelineId: PIPELINE_ID,
  pipelineRevision: 1,
  status: 'RUNNING',
  currentFence: 3,
  currentLeaseId: 'lease-fixture',
  attempts: 1,
  maxAttempts: 3,
  lastErrorCode: null,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  finishedAt: null,
  createdAt: new Date(Date.now() - 90_000).toISOString(),
  updatedAt: new Date().toISOString(),
};

const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };

/**
 * The kernel binary on the target host is not this working tree, and the console entry needs the
 * server's `access` declaration. It is stubbed onto the real `/auth/me` response - the same
 * contract dual-surface.spec.ts pins - so the session, cookie and CSRF token stay the live ones.
 */
async function stubAdminGrant(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = ADMIN_GRANT;
    await route.fulfill({ response, json: body });
  });
}

async function login(page: Page) {
  await stubAdminGrant(page);
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  // Locale-independent: the visible label is localized copy.
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function openAdmin(page: Page) {
  await page.goto('/admin/overview');
  await expect(page.getByRole('heading', { name: 'Overview', exact: true }).first()).toBeVisible();
}

function overflowOf(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

// --- 1. one header, one title -------------------------------------------------------------

test('all seven pages render exactly one PageHeader and one page title', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await login(page);
  await openAdmin(page);
  for (const target of PAGES) {
    await page.goto(target.route);
    const header = page.getByTestId('page-header');
    await expect(header, target.slug + ': one page header').toHaveCount(1);
    // The pre-polish pages repeated a hand-written title block; the shell renders exactly one
    // <h1> and it belongs to the header.
    await expect(page.locator('h1'), target.slug + ': one h1 on the page').toHaveCount(1);
    await expect(header.locator('h1'), target.slug + ': header owns the h1').toHaveCount(1);
    await expect(page.locator('.page-header'), target.slug + ': one header container').toHaveCount(1);
    await expect(header.locator('h1')).toHaveText(target.heading);
    // Every page states what it is for in one sentence, right below the title.
    await expect(header.locator('.page-description')).toHaveCount(1);
  }
  expect(pageErrors, 'page errors: ' + pageErrors.join('; ')).toEqual([]);
});

// --- 2. UNKNOWN / NO_DATA / STALE ----------------------------------------------------------

test('a pipeline without a published revision says NO_DATA instead of counting zero', async ({ page }) => {
  await login(page);
  // The target deployment has no pipeline at all, so this one detail answer is a fixture. The
  // shape is the API's own; only the answers it gives are fixed. The page cannot turn "this
  // pipeline has no published revision" into "0 nodes" and "updated never".
  const now = new Date().toISOString();
  await page.route('**/api/v1/pipelines/' + PIPELINE_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pipelineId: PIPELINE_ID,
      name: 'G08 fixture pipeline',
      latestRevision: 2,
      createdAt: now,
      updatedAt: now,
      latest: null,
      revisions: [{ revision: 2, digest: 'sha256:' + 'a'.repeat(64), status: 'PUBLISHED', publishedAt: now }],
    }),
  }));
  await page.route(/\/api\/v1\/jobs\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }));
  await page.goto('/admin/pipelines/' + PIPELINE_ID);
  const stats = page.locator('.pipeline-stats .metric-card');
  await expect(stats).toHaveCount(4);
  const nodes = stats.nth(1).locator('.metric-value');
  await expect(nodes.locator('.value-token')).toHaveAttribute('data-value', 'NO_DATA');
  expect(await nodes.innerText(), 'a missing count is never rendered as a number').not.toMatch(/\d/);
  const updated = stats.nth(3).locator('.metric-value');
  await expect(updated.locator('.value-token')).toHaveAttribute('data-value', 'NO_DATA');
  await page.screenshot({ path: path.join(OUT, 'state-pipelines-no-data.png'), fullPage: true });
});

test('diagnostics says UNKNOWN where the kernel answered with no value', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/diagnostics', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const kernel = { ...body.kernel };
    delete kernel.version;
    delete kernel.database;
    delete kernel.runtimeProtocol;
    await route.fulfill({ response, json: { ...body, kernel } });
  });
  await page.goto('/admin/settings/diagnostics');
  const strip = page.locator('.health-strip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.value-token')).toHaveCount(2);
  const tokens = page.locator('.value-token');
  expect(await tokens.count(), 'every missing kernel fact becomes a visible token').toBeGreaterThanOrEqual(4);
  for (const token of await tokens.all()) {
    await expect(token).toHaveAttribute('data-value', 'UNKNOWN');
  }
  await page.screenshot({ path: path.join(OUT, 'state-diagnostics-unknown.png'), fullPage: true });
});

test('rows kept from an older observation are labelled STALE with the moment we saw them', async ({ page }) => {
  await login(page);
  await page.goto('/admin/activity');
  await expect(page.locator('[data-async-state="ready"]')).toBeVisible();
  // The next observation is refused: the rows on screen are now older than the page's own
  // polling window, which is exactly what STALE means here.
  await page.route('**/api/v1/audit**', (route) => route.abort());
  await page.getByRole('button', { name: 'Refresh' }).first().click();
  const notice = page.locator('[data-notice="stale"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Showing the last observation');
  const observed = page.locator('[data-observed-at]');
  await expect(observed).toHaveAttribute('data-observed-at', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // The older rows are still readable; the notice ages them instead of hiding them.
  await expect(page.locator('[data-async-state="ready"]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'state-activity-stale.png'), fullPage: true });
});

// --- 3. dangerous operations ---------------------------------------------------------------

test('disabling a user confirms, blocks a second submit and offers a retry', async ({ page }) => {
  await login(page);
  let writes = 0;
  await page.route('**/api/v1/users', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const users = await response.json();
    await route.fulfill({
      response,
      json: [...users, { id: FIXTURE_USER, email: 'polish@opsweave.local', displayName: 'Polish Fixture', role: 'viewer', disabled: false, createdAt: new Date().toISOString() }],
    });
  });
  await page.route('**/api/v1/users/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FIXTURE_REFUSED', message: 'the fixture refused this write' }),
    });
  });
  await page.goto('/admin/access');
  const row = page.locator('[data-user="' + FIXTURE_USER + '"]');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Disable' }).click();

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'idle');
  await expect(dialog).toContainText('Disable Polish Fixture?');
  await page.screenshot({ path: path.join(OUT, 'state-access-confirm-idle.png'), fullPage: true });

  const confirm = dialog.locator('[data-confirm-submit]');
  await expect(confirm).toHaveText('Disable user');
  await confirm.click();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'pending');
  await expect(confirm).toBeDisabled();
  await page.screenshot({ path: path.join(OUT, 'state-access-confirm-pending.png'), fullPage: true });
  // A second click while the request is in flight must not reach the server.
  await confirm.click({ force: true }).catch(() => undefined);

  await expect(dialog).toHaveAttribute('data-confirm-state', 'error', { timeout: 15_000 });
  await expect(dialog.locator('[data-confirm-error]')).toContainText('the fixture refused this write');
  await expect(dialog.locator('[data-confirm-error]')).toContainText('FIXTURE_REFUSED');
  await expect(confirm).toHaveText('Retry');
  await expect(confirm).toBeEnabled();
  expect(writes, 'exactly one write left the page').toBe(1);
  await page.screenshot({ path: path.join(OUT, 'state-access-confirm-error.png'), fullPage: true });
});

test('cancelling a job asks first and disables the submit while it runs', async ({ page }) => {
  await login(page);
  let cancels = 0;
  await page.route('**/api/v1/jobs/' + JOB_ID + '**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/cancel')) {
      cancels += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
    }
    if (url.endsWith('/diagnostics')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: JOB_ID, events: [], attempts: [], leases: [], checkpoints: [], truncated: false }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOB_VIEW) });
  });
  await page.goto('/admin/jobs/' + JOB_ID);
  await expect(page.getByTestId('page-header')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Cancel job ' + JOB_ID.slice(0, 8) + '?');
  const confirm = dialog.locator('[data-confirm-submit]');
  await expect(confirm).toHaveText('Cancel job');
  await confirm.click();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'pending');
  await expect(confirm).toBeDisabled();
  await confirm.click({ force: true }).catch(() => undefined);
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  expect(cancels, 'exactly one cancel left the page').toBe(1);
});

// --- 4. empty list vs a filter that matches nothing ----------------------------------------

test('an empty list and a filter that matches nothing say different things', async ({ page }) => {
  await login(page);
  const LIST = /\/api\/v1\/jobs\?/;
  await page.route(LIST, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], nextCursor: null }),
  }));
  await page.goto('/admin/jobs');
  const none = page.locator('[data-empty-state="none"]');
  await expect(none).toBeVisible();
  const noneCopy = (await none.innerText()).trim();
  expect(noneCopy, 'an empty job history explains that nothing has run yet').toContain('No jobs');

  await page.unroute(LIST);
  await page.route(LIST, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [JOB_VIEW], nextCursor: null }),
  }));
  await page.goto('/admin/jobs');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search jobs' }).fill('no-such-job');
  const filtered = page.locator('[data-empty-state="filtered"]');
  await expect(filtered).toBeVisible();
  const filteredCopy = (await filtered.innerText()).trim();

  expect(filteredCopy, 'a filtered miss must not reuse the empty-log copy').not.toBe(noneCopy);
  await expect(filtered).toContainText('No jobs match this filter');
  await expect(filtered.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'state-jobs-filtered-empty.png'), fullPage: true });

  await filtered.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

// --- 6. live operations, entry through the Kernel -----------------------------------------

test('a filter is answered by the Kernel, not by the browser', async ({ page }) => {
  await login(page);

  // Batch A: the audit subject filter is one Kernel query, and the count on screen is its answer.
  await page.goto('/admin/activity');
  await expect(page.locator('[data-async-state="ready"]')).toBeVisible();
  const auditResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v1/audit?') && response.url().includes('subjectType=node') && response.request().method() === 'GET');
  await page.getByRole('combobox', { name: 'Filter subject type' }).click();
  await page.getByRole('option', { name: 'Node', exact: true }).click();
  const audit = await auditResponse;
  expect(audit.status(), 'the subject filter is one audit query').toBe(200);
  const events = await audit.json();
  expect(Array.isArray(events)).toBe(true);
  expect(events.every((event: any) => event.subjectType === 'node'), 'the server answered for that subject only').toBe(true);
  // The number on screen must be the number the Kernel just returned; the exact pluralisation is
  // a copy detail that differs by locale, and pinning it made this pass locally and fail on a
  // deployment whose audit table is longer.
  await expect(page.locator('.toolbar-count')).toContainText(new RegExp('(^|\\D)' + events.length + '(\\D|$)'));
  await page.screenshot({ path: path.join(OUT, 'op-activity-subject-filter.png'), fullPage: true });

  // Batch B: the status tab is a Kernel query as well (this deployment holds no jobs at all).
  await page.goto('/admin/jobs');
  await expect(page.locator('[data-async-state="ready"]')).toBeVisible();
  const jobsResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v1/jobs?') && response.url().includes('status=FAILED') && response.request().method() === 'GET');
  await page.getByRole('tab', { name: 'FAILED' }).click();
  const jobs = await jobsResponse;
  expect(jobs.status(), 'the status tab is one jobs query').toBe(200);
  const body = await jobs.json();
  expect(Array.isArray(body.items)).toBe(true);
  const filtered = page.locator('[data-empty-state="filtered"]');
  await expect(filtered).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'op-jobs-status-filter.png'), fullPage: true });
  await filtered.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
});

// --- 7. capture matrix ---------------------------------------------------------------------

async function captureMatrix(browser: Browser, viewport: (typeof VIEWPORTS)[number]) {
  const overflows: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      // Log in in English either way; the proof-read locale is switched below, because the
      // sign-in form is copy the shell localises too.
      storageState: {
        cookies: [],
        origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: 'opsweave-locale', value: 'en' }] }],
      },
    });
    const page = await context.newPage();
    await page.addInitScript((value) => window.localStorage.setItem('opsweave-theme', value), theme);
    await login(page);
    await openAdmin(page);
    for (const locale of ['en', 'zh-CN'] as const) {
      // The locale is read on boot, so a reload per navigation is what makes the switch real.
      await page.evaluate((value) => window.localStorage.setItem('opsweave-locale', value), locale);
      for (const target of PAGES) {
        await page.goto(target.route);
        await expect(page.getByTestId('page-header').locator('h1'), target.slug + ' @ ' + viewport.width + '/' + theme + '/' + locale).toBeVisible();
        // Screenshot only a settled boundary: ready, empty, forbidden or error, never a skeleton.
        await expect(page.locator('[data-async-state]:not([data-async-state="loading"])').first()).toBeVisible({ timeout: 20_000 });
        const measured = await overflowOf(page);
        if (measured.scrollWidth > measured.clientWidth + 1) {
          overflows.push(target.slug + ' @ ' + viewport.width + '/' + theme + '/' + locale + ': ' + measured.scrollWidth + '>' + measured.clientWidth);
        }
        await page.screenshot({
          path: path.join(OUT, 'g08-' + SHA + '-' + target.slug + '-' + viewport.width + '-' + theme + '-' + locale + '.png'),
          fullPage: true,
        });
      }
    }
    await context.close();
  }
  expect(overflows, 'horizontal overflow: ' + overflows.join('; ')).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test('screenshots at ' + viewport.width + ' for all seven pages', async ({ browser }) => {
    test.setTimeout(300_000);
    await captureMatrix(browser, viewport);
  });
}
