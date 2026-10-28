import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PARTIAL on the admin Overview (apps/platform-web/src/pages/Overview.tsx:51,99).
 *
 * The page reads two sources: /api/v1/overview (every visible number) and the admin-only
 * /api/v1/diagnostics (Kernel identity + database). PARTIAL is *not* a degraded verdict about
 * either payload — it is the statement that one of the two sources did not answer:
 *
 *   const partialSource = isAdmin && (diagnostics.error || diagnostics.data === null);
 *
 * Both claims are asserted against the live Gateway. The refusal is applied by rewriting the
 * real exchange on the wire (route.fetch() proves the kernel answers the route, then the answer
 * is replaced by a 503 refusal); no mock payload is placed in the application, and the page runs
 * its single production code path.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/overview-partial');

// playwright.config.ts pins the locale through storage state; read the same catalog the page
// renders from, so the copy assertions follow the locale instead of hardcoding English.
const LOCALE = process.env.OPSWEAVE_TEST_LOCALE || 'en';
const CATALOG: Record<string, string> = JSON.parse(
  fs.readFileSync(path.resolve('../..', 'apps/platform-web/src/i18n/catalogs', LOCALE + '.json'), 'utf8'),
);

function copy(key: string, params: Record<string, string | number> = {}): string {
  const message = CATALOG[key];
  if (!message) throw new Error('missing i18n key ' + key + ' for locale ' + LOCALE);
  return message.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined ? match : String(params[name])));
}

const PARTIAL_NOTICE = '[data-notice="partial"]';
const KERNEL_MODULE = '[data-module="kernel"]';

// The kernel binary on this host predates the `access` declaration, so the console entry would
// answer "no access declaration" and the admin routes would never mount. The declaration is
// stubbed onto the real /auth/me reply (the same contract dual-surface.spec.ts pins) - session,
// cookie, CSRF token and `user.role` stay the live ones.
const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };

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
  // The shell resumes a default surface after sign-in (not necessarily the admin one), so the
  // caller navigates to /admin/overview itself instead of relying on the landing route.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test('overview: with both sources answering there is no PARTIAL notice', async ({ page }) => {
  await login(page);
  await page.goto('/admin/overview');
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();

  // Absence must be asserted on a settled page, not on a skeleton. The kernel card only leaves
  // LOADING/UNKNOWN once the diagnostics source really answered (Overview.tsx:204-216), so its
  // state is the proof that the second source is in.
  const kernel = page.locator(KERNEL_MODULE);
  await expect(kernel).toHaveAttribute('data-indicator', /^(ready|degraded)$/);
  await expect(kernel.locator('.module-card-detail')).toContainText(/v\S+/);
  await expect(kernel.locator('.module-card-detail'), 'a missing source prints its own reason')
    .not.toContainText(copy('overview.module.kernel.error'));

  // The strip really rendered: the missing notice is not the absence of a page.
  await expect(page.locator('.module-card')).toHaveCount(4);
  await expect(page.locator(PARTIAL_NOTICE)).toHaveCount(0);
  await expect(page.locator('[data-testid="overview-modules"] ' + PARTIAL_NOTICE)).toHaveCount(0);

  await page.screenshot({ path: path.join(OUT, 'state-overview-no-partial.png'), fullPage: true });
});

test('overview: a source that does not answer raises PARTIAL naming the half answer', async ({ page }) => {
  await login(page);

  let realStatus = 0;
  let realKernelVersion = '';
  await page.route('**/api/v1/diagnostics', async (route) => {
    // Pass through to the live kernel first: this is a rewritten real exchange, not a fixture.
    const response = await route.fetch();
    realStatus = response.status();
    const body = await response.json();
    realKernelVersion = typeof body?.kernel?.version === 'string' ? body.kernel.version : '';
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE', message: 'diagnostics refused by overview-partial.spec' }),
    });
  });

  await page.goto('/admin/overview');
  const notice = page.locator(PARTIAL_NOTICE);
  await expect(notice).toBeVisible();

  expect(realStatus, 'the refusal replaced an answer the live kernel really gives').toBe(200);
  expect(realKernelVersion.length, 'the real diagnostics answer carried kernel facts').toBeGreaterThan(0);

  // The notice says which half is missing, in the locale the page renders.
  await expect(notice.locator('.status-indicator-label')).toHaveText(copy('state.partial'));
  await expect(notice.locator('.notice-detail')).toHaveText(copy('ui.partial.sources', { ok: 1, total: 2 }));
  await expect(page.locator('[data-testid="overview-modules"] ' + PARTIAL_NOTICE)).toHaveCount(1);

  // Only the diagnostics source failed: the kernel module degrades to UNKNOWN with its reason,
  // while the overview payload still paints the strip and the metrics.
  const kernel = page.locator(KERNEL_MODULE);
  await expect(kernel).toHaveAttribute('data-indicator', 'unknown');
  await expect(kernel.locator('.module-card-detail')).toHaveText(copy('overview.module.kernel.error'));
  await expect(page.locator('.module-card')).toHaveCount(4);
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();
  await expect(page.locator('[data-async-state="error"]')).toHaveCount(0);

  await page.screenshot({ path: path.join(OUT, 'state-overview-partial.png'), fullPage: true });
});
