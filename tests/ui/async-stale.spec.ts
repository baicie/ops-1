import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * STALE is a statement about a clock: components/app/async-boundary.tsx marks an observation stale
 * once it is older than 2.5 polling rounds (`isStale`), and Activity/Diagnostics also mark it stale
 * when a refresh was refused while older rows are still on screen (`error && data`). Waiting 20 real
 * seconds for that would be a race, so the clock itself is controlled: `page.clock` freezes
 * `Date.now()` and `setInterval` before the page boots, the first poll is answered by the live
 * Gateway, and time is then jumped past the threshold in one step.
 *
 * The two ways to reach STALE are asserted in separate tests because they are different claims:
 *   1. a poll answered 5xx while the previous payload stays on screen;
 *   2. time alone moving past 2.5 x 8000ms, with no answer arriving at all.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/g08-admin-polish');

/** Activity and Diagnostics both poll at 8000ms; STALE starts once 2.5 rounds have passed. */
const POLL_INTERVAL_MS = 8000;
const STALE_AFTER_MS = POLL_INTERVAL_MS * 2.5;

/** The console entry needs the server's access declaration; stubbed onto the real /auth/me reply. */
const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };

const STALE_NOTICE = '[data-notice="stale"]';
const OBSERVED_AT = '[data-observed-at]';
const ERROR_PANEL = '[data-async-state="error"]';

async function login(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = ADMIN_GRANT;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * Install the fake clock and stop it before the page under test boots, so the first poll and every
 * timestamp the page writes happen at one instant instead of "whenever the request came back".
 * pauseAt() only moves forward (the clock runs between the two calls), hence the +2s landing spot.
 */
async function freezeClock(page: Page, at: Date) {
  await page.clock.install({ time: at });
  await page.clock.pauseAt(at.getTime() + 2000);
}

/**
 * Read the page's own clock and prove it is standing still. If the fake clock silently did not take
 * effect in this document, every assertion below would be measuring real time and would pass or fail
 * by luck, so this guard fails loudly instead.
 */
async function frozenNow(page: Page): Promise<number> {
  const first = await page.evaluate(() => Date.now());
  await page.waitForTimeout(120);
  const second = await page.evaluate(() => Date.now());
  expect(second, 'the page clock must be frozen for this spec to be deterministic').toBe(first);
  return first;
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

// --- 1. a refused poll past the threshold ---------------------------------------------------

test('diagnostics: a refused poll past 2.5 x the interval keeps the strip and pins data-observed-at', async ({ page }) => {
  await login(page);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  await freezeClock(page, at);
  await page.goto('/admin/settings/diagnostics');

  // First observation: served by the live Gateway, rendered under the frozen clock.
  const ready = page.locator('[data-async-state="ready"]');
  await expect(ready).toBeVisible();
  const health = page.locator('.health-strip');
  await expect(health).toBeVisible();
  const payloadBefore = await health.innerText();
  expect(payloadBefore.trim().length, 'the first observation actually carried facts').toBeGreaterThan(0);

  const frozenAt = await frozenNow(page);
  const observedIso = new Date(frozenAt).toISOString();
  // Negative case: fresh data is never labelled STALE, and nothing claims an observation time.
  await expect(page.locator(STALE_NOTICE)).toHaveCount(0);
  await expect(page.locator(OBSERVED_AT)).toHaveCount(0);

  // Every later poll is refused with the code the kernel answers when it cannot read itself.
  let refusedPolls = 0;
  await page.route('**/api/v1/diagnostics', (route) => {
    refusedPolls += 1;
    return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'poll refused by async-stale.spec' } });
  });

  // Two polling rounds plus a millisecond: the observation is now older than 2.5 x the interval.
  await page.clock.fastForward(STALE_AFTER_MS + 1);

  const notice = page.locator(STALE_NOTICE);
  await expect(notice).toBeVisible();
  expect(refusedPolls, 'the notice follows a real refused poll, not a bare timer').toBeGreaterThan(0);
  await expect(notice).toContainText('Showing the last observation');

  // The stamped moment is the first success, not "now": the clock moved, the observation did not.
  const now = await page.evaluate(() => Date.now());
  expect(now - frozenAt, 'the clock really moved past the threshold').toBeGreaterThan(STALE_AFTER_MS);
  await expect(page.locator(OBSERVED_AT)).toHaveAttribute('data-observed-at', observedIso);

  // The older payload is still what is on screen: no error wall replaced it.
  await expect(ready).toBeVisible();
  await expect(page.locator(ERROR_PANEL)).toHaveCount(0);
  await expect(health).toBeVisible();
  expect(await health.innerText(), 'the strip still shows the payload seen at first success').toBe(payloadBefore);

  await page.screenshot({ path: path.join(OUT, 'state-diagnostics-stale-clock.png'), fullPage: true });
});

// --- 2. time alone, with nothing failing -----------------------------------------------------

test('activity: age past 2.5 x the interval alone marks the rows STALE, with no answer arriving', async ({ page }) => {
  await login(page);
  const at = new Date(Math.floor(Date.now() / 1000) * 1000);
  await freezeClock(page, at);
  await page.goto('/admin/activity');

  const ready = page.locator('[data-async-state="ready"]');
  await expect(ready).toBeVisible();
  const rows = page.locator('[data-async-state="ready"] tbody tr');
  const rowsBefore = await rows.count();
  expect(rowsBefore, 'the live audit log is on screen before the clock moves').toBeGreaterThan(0);
  const firstCellBefore = await rows.first().locator('td').first().innerText();

  const frozenAt = await frozenNow(page);
  const observedIso = new Date(frozenAt).toISOString();
  await expect(page.locator(STALE_NOTICE)).toHaveCount(0);

  // The next poll is never answered. Nothing fails, so the `error && data` branch stays false and
  // the only thing that can mark this view STALE is the interval arithmetic itself.
  await page.route('**/api/v1/audit**', () => new Promise<void>(() => { /* never answers */ }));

  // Below the threshold first: one polling round plus a millisecond is not STALE. The row opens
  // (`.expanded-row`) to prove a render really happened at that instant, so the absence checked
  // next is about `isStale` returning false, not about the page not having re-rendered yet.
  await page.clock.fastForward(POLL_INTERVAL_MS + 1);
  await rows.first().click();
  await expect(page.locator('.expanded-row'), 'a render happened below the threshold').toHaveCount(1);
  await expect(page.locator(STALE_NOTICE)).toHaveCount(0);

  // Now cross 2.5 x the interval. The tick only starts another unanswered request, so the notice
  // cannot be an echo of a failed refresh; the collapse re-renders at the advanced clock.
  await page.clock.fastForward(STALE_AFTER_MS + 1 - (POLL_INTERVAL_MS + 1));
  await rows.first().click();
  await expect(page.locator('.expanded-row')).toHaveCount(0);
  const notice = page.locator(STALE_NOTICE);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Showing the last observation');

  const now = await page.evaluate(() => Date.now());
  expect(now - frozenAt, 'the clock really moved past the threshold').toBeGreaterThan(STALE_AFTER_MS);
  await expect(page.locator(OBSERVED_AT)).toHaveAttribute('data-observed-at', observedIso);

  // The rows from the first observation are still rendered, unchanged.
  await expect(page.locator(ERROR_PANEL)).toHaveCount(0);
  expect(await rows.count(), 'the rows kept from the first observation are still on screen').toBeGreaterThanOrEqual(rowsBefore);
  expect(await rows.first().locator('td').first().innerText(), 'the first row is still the one we observed').toBe(firstCellBefore);

  await page.screenshot({ path: path.join(OUT, 'state-activity-stale-clock.png'), fullPage: true });
});