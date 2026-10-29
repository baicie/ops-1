import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The admin Overview's two-source honesty (apps/platform-web/src/pages/Overview.tsx:71-80,99).
 *
 * The page reads two sources: /api/v1/overview (every visible number) and the admin-only
 * /api/v1/diagnostics (Kernel identity + database). PARTIAL is *not* a degraded verdict about
 * either payload - it is the statement that a source settled without answering:
 *
 *   const sourceStates = isAdmin ? [overviewSource, kernelSource] : [overviewSource];
 *   const sourcesAnswered = sourceStates.filter((state) => state === 'answered').length;
 *   const partialSource = sourceStates.includes('missing');           // 'pending' is not a verdict
 *   ... t('ui.partial.sources', { ok: sourcesAnswered, total: sourceStates.length })
 *
 * Four claims are pinned here against the live Gateway:
 *   1. both sources answering -> no notice, and the Kernel card has really left LOADING;
 *   2. a source that refuses (503) -> PARTIAL whose count follows the sources that answered;
 *   3. a source still being asked -> no PARTIAL at any moment of the wait (the reported false alarm);
 *   4. a source that answers 200 with an empty body -> still PARTIAL, because "no payload" is
 *      judged on the data, not on whether something threw.
 * Two more pin the state machine itself: DEGRADED (a module reports it) and ATTENTION (a warning
 * severity item, Overview.tsx:22/145).
 *
 * Every rewrite is applied to the real exchange: route.fetch() proves the kernel answers the
 * route, then the answer is replaced. No payload is placed inside the application, and the page
 * runs its single production code path.
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

/**
 * ok/total as the page counts it: one entry per source this view asked, `true` meaning that
 * source answered. The expectation is computed from the two outcomes instead of repeating the
 * literal the component used to print, so the assertion follows the sources rather than the copy.
 */
function sourceCount(answered: { overview: boolean; diagnostics: boolean }): { ok: number; total: number } {
  const states = Object.values(answered);
  return { ok: states.filter(Boolean).length, total: states.length };
}

const PARTIAL_NOTICE = '[data-notice="partial"]';
const KERNEL_MODULE = '[data-module="kernel"]';
const NODES_MODULE = '[data-module="nodes"]';
const RUNTIME_MODULE = '[data-module="runtime"]';
// "Settled with a payload": the Kernel card has left LOADING/UNKNOWN behind.
const KERNEL_ANSWERED = /^(ready|degraded)$/;

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
  // LOADING/UNKNOWN once the diagnostics source really answered (Overview.tsx:234-248), so its
  // state is the proof that the second source is in.
  const kernel = page.locator(KERNEL_MODULE);
  await expect(kernel).toHaveAttribute('data-indicator', KERNEL_ANSWERED);
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

  // The notice says which half is missing, in the locale the page renders. The count is the two
  // sources' real outcome: overview answered and painted the strip, diagnostics settled as an error.
  const counted = sourceCount({ overview: true, diagnostics: false });
  await expect(notice.locator('.status-indicator-label')).toHaveText(copy('state.partial'));
  await expect(notice.locator('.notice-detail')).toHaveText(copy('ui.partial.sources', counted));
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

test('overview: a healthy load never flashes PARTIAL while a source is still being asked', async ({ page }) => {
  await login(page);

  // The real diagnostics answer is fetched and then held open, so the page sits in exactly the
  // state the reported bug mis-read - overview in, diagnostics not answered *yet*. Holding it
  // makes the window as long as this spec needs instead of racing a fast localhost reply.
  let releaseDiagnostics: () => void = () => {};
  const diagnosticsHeld = new Promise<void>((resolve) => { releaseDiagnostics = resolve; });
  await page.route('**/api/v1/diagnostics', async (route) => {
    const response = await route.fetch();
    await diagnosticsHeld;
    await route.fulfill({ response });
  });

  await page.goto('/admin/overview');
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();

  const kernel = page.locator(KERNEL_MODULE);
  // Proof that the second source is being asked rather than failing: an unanswered source keeps
  // the LOADING indicator and states no observation time (Overview.tsx:237-241).
  await expect(kernel).toHaveAttribute('data-indicator', 'loading');
  await expect(kernel.locator('.module-card-detail')).toHaveText(copy('ui.notObserved'));

  // A flash is transient, so sample the whole pending window: every sample must be empty while the
  // kernel card still reads LOADING. One instantaneous check could miss a paint-driven flicker.
  for (let sample = 1; sample <= 5; sample += 1) {
    await expect(kernel, 'sample ' + sample + ' is still inside the pending window').toHaveAttribute('data-indicator', 'loading');
    expect(await page.locator(PARTIAL_NOTICE).count(), 'sample ' + sample + ' of the pending window').toBe(0);
    await page.waitForTimeout(100);
  }

  // Captured before the release: the artifact has to show the state under test - the Kernel card
  // still LOADING with no PARTIAL notice - not the settled page it turns into.
  await page.screenshot({ path: path.join(OUT, 'state-overview-first-frame-no-partial.png'), fullPage: true });

  releaseDiagnostics();

  await expect(kernel).toHaveAttribute('data-indicator', KERNEL_ANSWERED);
  await expect(page.locator(PARTIAL_NOTICE)).toHaveCount(0);
});

test('overview: a source that answers 200 with an empty body is still MISSING', async ({ page }) => {
  await login(page);

  let realStatus = 0;
  await page.route('**/api/v1/diagnostics', async (route) => {
    const response = await route.fetch();
    realStatus = response.status();
    // Same status, no payload. api.ts:42-45 turns an empty body into `null` without throwing, so an
    // error-only PARTIAL test would call this half answer healthy.
    await route.fulfill({ status: response.status(), body: '' });
  });

  await page.goto('/admin/overview');
  const notice = page.locator(PARTIAL_NOTICE);
  await expect(notice).toBeVisible();

  expect(realStatus, 'the empty body replaced an answer the live kernel really gives').toBe(200);

  const counted = sourceCount({ overview: true, diagnostics: false });
  await expect(notice.locator('.notice-detail')).toHaveText(copy('ui.partial.sources', counted));

  // And the module card agrees that the source settled without answering: UNKNOWN with no
  // observation time, not a LOADING spinner the page would show forever.
  const kernel = page.locator(KERNEL_MODULE);
  await expect(kernel).toHaveAttribute('data-indicator', 'unknown');
  await expect(kernel.locator('.module-card-detail')).toHaveText(copy('ui.notObserved'));

  await page.screenshot({ path: path.join(OUT, 'state-overview-empty-body-partial.png'), fullPage: true });
});

test('overview: DEGRADED renders when a module reports it - and it is not PARTIAL', async ({ page }) => {
  await login(page);

  let realDatabase = '';
  let realVersion = '';
  let forcedNodes = { ready: 0, total: 0 };
  let forcedReplicas = { ready: 0, total: 0, deployments: 0 };

  await page.route('**/api/v1/diagnostics', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    realDatabase = String(body?.kernel?.database ?? '');
    realVersion = String(body?.kernel?.version ?? '');
    // 'unavailable' is the kernel's own sentinel for a failed database probe
    // (apps/kernel/src/diagnostics.rs:30); the Kernel card turns it into DEGRADED (Overview.tsx:212).
    await route.fulfill({ response, json: { ...body, kernel: { ...body.kernel, database: 'unavailable' } } });
  });

  await page.route('**/api/v1/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    // Built from the live counts: one enrolled node that is not READY and one desired replica that
    // is not READY (Overview.tsx:224/236). Every other field is the kernel's own answer.
    const nodesTotal = Math.max(Number(body.nodesTotal) || 0, 1);
    const replicasTotal = Math.max(Number(body.instancesTotal) || 0, 1);
    forcedNodes = { ready: 0, total: nodesTotal };
    forcedReplicas = { ready: 0, total: replicasTotal, deployments: Number(body.activeDeployments) || 0 };
    await route.fulfill({
      response,
      json: { ...body, nodesTotal, nodesReady: 0, instancesTotal: replicasTotal, instancesReady: 0 },
    });
  });

  await page.goto('/admin/overview');
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();

  // Causality first: the live diagnostics answer really said something else before this rewrite.
  expect(realDatabase, 'the live answer was replaced by the kernel sentinel').not.toBe('unavailable');
  expect(realVersion.length, 'the live diagnostics answer carried the kernel version').toBeGreaterThan(0);

  const kernel = page.locator(KERNEL_MODULE);
  await expect(kernel).toHaveAttribute('data-indicator', 'degraded');
  await expect(kernel.locator('.module-card-detail')).toHaveText(
    copy('overview.module.kernel.detail', { version: realVersion, database: copy('overview.module.kernel.dbUnavailable') }),
  );

  const nodes = page.locator(NODES_MODULE);
  await expect(nodes).toHaveAttribute('data-indicator', 'degraded');
  await expect(nodes.locator('.module-card-detail')).toHaveText(copy('overview.module.nodes.detail', forcedNodes));

  const runtime = page.locator(RUNTIME_MODULE);
  await expect(runtime).toHaveAttribute('data-indicator', 'degraded');
  await expect(runtime.locator('.module-card-detail')).toHaveText(copy('overview.module.runtime.detail', forcedReplicas));

  // The strip and the KPI agree because both read the payload that really rendered.
  await expect(page.locator('a[data-metric-card][data-metric-href="/admin/nodes"] .ow-metric-value'))
    .toHaveText(forcedNodes.ready + ' / ' + forcedNodes.total);

  // DEGRADED is an answer, not a missing source: no PARTIAL notice rides along with it.
  await expect(page.locator(PARTIAL_NOTICE)).toHaveCount(0);

  await page.screenshot({ path: path.join(OUT, 'state-overview-degraded.png'), fullPage: true });
});

test('overview: a warning attention item renders the ATTENTION indicator, not a permission wall', async ({ page }) => {
  await login(page);

  let realAttentionCount = -1;
  // The kernel raises a WARNING for a node whose heartbeat is stale (apps/kernel/src/plugins.rs:543-559)
  // and calls health ATTENTION when nothing is critical (plugins.rs:600-606). This item is that
  // shape; injecting it is what makes the state reachable on a host whose nodes are all healthy.
  const stale = {
    severity: 'warning',
    title: 'Node node-1 heartbeat is stale',
    detail: 'Last observed 5 minutes ago. State is UNREACHABLE, not STOPPED.',
    link: '/admin/nodes',
  };

  await page.route('**/api/v1/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    realAttentionCount = Array.isArray(body.attention) ? body.attention.length : -1;
    await route.fulfill({ response, json: { ...body, health: 'ATTENTION', attention: [stale] } });
  });

  await page.goto('/admin/overview');
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();

  expect(realAttentionCount, 'the live overview answer carried a real attention array').toBeGreaterThanOrEqual(0);

  const row = page.locator('#attention .attention-item');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-severity', 'warning');
  // Overview.tsx:22 maps warning -> the ATTENTION indicator, and :145 labels it with severity copy.
  await expect(row.locator('.status-indicator').first()).toHaveAttribute('data-indicator', 'attention');
  await expect(row.locator('.status-indicator-label').first()).toHaveText(copy('overview.severity.warning'));
  await expect(row.locator('.attention-item-copy strong')).toHaveText(stale.title);
  await expect(row.locator('.attention-item-copy p')).toHaveText(stale.detail);

  // The panel count is the array length, and the list really replaced the empty state.
  await expect(page.locator('#attention .panel-count')).toHaveText(copy('overview.attention.count', { count: 1 }));
  await expect(page.locator('#attention')).not.toContainText(copy('overview.attention.empty.title'));

  // health=ATTENTION drives Layer 1's verdict band - the same three facts the old .attention-banner
  // carried (state, headline copy, link to the list), now framed by .health-band (Overview.tsx:118-138).
  const band = page.locator('section.health-band[data-health="ATTENTION"]');
  await expect(band).toHaveClass(/tone-warn/);
  await expect(band.locator('h2')).toHaveText(copy('overview.health.attention'));
  await expect(band.locator('a[href="#attention"]')).toHaveCount(1);

  await page.screenshot({ path: path.join(OUT, 'state-overview-attention.png'), fullPage: true });
});
