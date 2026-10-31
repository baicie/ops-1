import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

/**
 * V6 acceptance: the console as a control surface.
 *
 * The three rounds before this one fixed visual defects and the pages still read as a status
 * snapshot. These tests assert the verbs instead: what a row can do, that a count is the
 * filter that selects its own rows, that a status is a navigable entity, and that the three
 * named layout defects are gone at their exact boundary.
 *
 * Every screenshot is paired with a DOM assertion and is only taken after the sidebar has
 * printed the deployed commit, so a picture can never prove a state the DOM did not have.
 */
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
/** The commit the staging deployment reports at /api/v1/version. */
const DEPLOYED = process.env.OPSWEAVE_COMMIT || '689ba57';
const OUT = path.resolve('../../artifacts/ui-verbs-v6');

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function useLocale(page: Page, locale: 'en' | 'zh-CN') {
  await page.selectOption('[data-testid="language-switcher"]', locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function useTheme(page: Page, theme: 'light' | 'dark') {
  if ((await page.locator('html').getAttribute('data-theme')) === theme) return;
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * The served-SHA self-proof, asserted before every screenshot.
 *
 * /403 is deliberately shell-less (no sidebar, no navigation into the console), so that one
 * page has nowhere to print the badge. It is proved from the same origin it loaded from
 * instead: the browser asks GET /api/v1/version and the answer has to be the deployed commit.
 * Both branches assert the same fact - what build the browser is actually running.
 */
async function assertDeployedCommit(page: Page) {
  const sha = page.locator('.sidebar-meta-sha').first();
  if ((await sha.count()) > 0) {
    // The badge fills in from GET /api/v1/version after the shell mounts, so UNKNOWN is a
    // "not yet", not a verdict: wait for the fetch to land before reading it.
    await expect(sha).not.toHaveText('UNKNOWN', { timeout: 15000 });
    const text = (await sha.innerText()).trim();
    expect(text, 'the sidebar must print the deployed commit, not a local build').toBe(DEPLOYED);
    return;
  }
  const served = await page.evaluate(async () => {
    const response = await fetch('/api/v1/version', { credentials: 'same-origin' });
    return (await response.json()) as { commitSha?: string };
  });
  expect(served.commitSha ?? '', 'this page has no sidebar; its build is the origin\'s build').toMatch(new RegExp('^' + DEPLOYED));
}

async function shot(page: Page, name: string) {
  await assertDeployedCommit(page);
  await page.screenshot({ path: path.join(OUT, name + '.png'), animations: 'disabled', fullPage: true });
}

async function noPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow at ' + label).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: 'serial' });

test('overview: every module card is a door, and the band hands off the repair', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/overview');
  await expect(page.getByTestId('overview-modules')).toBeVisible();

  // Four modules, four doors. Before this round the kernel and catalog rows were plain text:
  // a state with nowhere to go is the "status snapshot" the review named.
  const modules = page.locator('[data-module]');
  await expect(modules).toHaveCount(4);
  for (const module of await modules.all()) {
    expect(await module.evaluate((el) => el.tagName), 'every module card must be a link').toBe('A');
    expect(await module.getAttribute('href')).toBeTruthy();
  }

  // The page-level primary action is a verb, and an empty platform is offered the node step
  // rather than a plugin install it cannot complete.
  await expect(page.locator('.page-actions a[href="/admin/plugins/install"], a[href="/admin/plugins/install"]').first()).toBeVisible();

  await useTheme(page, 'light');
  await shot(page, 'overview-1440-en-light');
  await useTheme(page, 'dark');
  await shot(page, 'overview-1440-en-dark');
});

test('plugins: a row carries the verbs the Kernel accepts, gated by state and role', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr');

  // Every row has a verb menu, and it offers Stop / Start / Rollback / Uninstall - the four
  // the Kernel already answers at /disable, /enable, /rollback and /uninstall.
  const rows = page.locator('.plugins-table tbody tr');
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  await expect(page.locator('.plugins-table [data-testid="row-actions"]')).toHaveCount(rowCount);

  const first = rows.first();
  await first.locator('[data-testid="row-actions"]').click();
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  for (const verb of ['disable', 'enable', 'rollback', 'uninstall']) {
    await expect(menu.locator('[data-action="' + verb + '"]'), verb + ' must be offered on a row').toHaveCount(1);
  }

  // Ineligible is not the same as absent: the item is drawn disabled and states why, so
  // "there is no Stop here" becomes a fact the operator can read instead of a dead end.
  const disable = menu.locator('[data-action="disable"]');
  const disabled = await disable.getAttribute('aria-disabled');
  if (disabled === 'true') {
    expect((await disable.getAttribute('title')) ?? '', 'a refused verb states its reason').not.toBe('');
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The one verb that is enabled on a staged, non-system plugin opens its confirmation; the
  // dialog is cancelled, so this asserts the click path without mutating the deployment.
  let acted = false;
  for (const row of await rows.all()) {
    await row.locator('[data-testid="row-actions"]').click();
    const item = page.locator('[role="menu"] [data-action="uninstall"]');
    if ((await item.getAttribute('aria-disabled')) !== 'true') {
      await item.click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Uninstall');
      await page.getByRole('button', { name: /cancel/i }).click();
      await expect(dialog).toBeHidden();
      acted = true;
      break;
    }
    await page.keyboard.press('Escape');
  }
  expect(acted, 'at least one non-system plugin must expose an enabled verb').toBe(true);
});

test('plugins: the attention count is the filter that selects its own rows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr');

  const card = page.locator('[data-summary-key="abnormal"]');
  await expect(card).toBeVisible();
  // The card is a control, not a card: it is a button and it states its pressed state.
  expect(await card.evaluate((el) => el.tagName)).toBe('BUTTON');
  await expect(card).toHaveAttribute('aria-pressed', 'false');

  const declared = Number((await card.locator('.ow-summary-value').innerText()).trim());
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');

  // The count and the filtered rows are the same set, by construction and by measurement.
  const bar = page.getByTestId('plugins-quick-filter');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('data-quick-filter', 'abnormal');
  const shown = await page.locator('.plugins-table tbody tr').count();
  expect(shown, 'clicking the count must select exactly the rows it counted').toBe(declared);
  for (const row of await page.locator('.plugins-table tbody tr').all()) {
    await expect(row.locator('[data-abnormal="true"]')).toHaveCount(0);
  }

  // And the filter is removable in one click.
  await bar.getByRole('button').click();
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('plugins-quick-filter')).toHaveCount(0);
});

test('plugins: a deployment state is an entity, not a word', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr');

  // Every status pill that describes an entity is a link to that entity - no exceptions,
  // because a status that looks the same whether it navigates or not is the defect itself.
  const pills = await page.locator('.plugins-table tbody .status-indicator').count();
  const linked = await page.locator('.plugins-table tbody a[data-status-entity] .status-indicator').count();
  expect(pills, 'the table must render at least one status pill').toBeGreaterThan(0);
  expect(linked, 'every status pill in a row must be inside its entity link').toBe(pills);
  const entities = page.locator('.plugins-table tbody [data-status-entity]');
  expect(await entities.count()).toBeGreaterThan(0);
  const href = await entities.first().getAttribute('href');
  expect(href).toBeTruthy();
  expect(href).toMatch(/^\/admin\/(plugins|ops-center)/);

  await useTheme(page, 'light');
  await shot(page, 'plugins-1440-en-light');
  await useTheme(page, 'dark');
  await shot(page, 'plugins-1440-en-dark');
});

test('nodes: the state count filters, and a row can revoke and open instances', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/nodes');
  await page.waitForSelector('.nodes-table tbody tr');

  const total = await page.locator('.nodes-table tbody tr').count();

  // The state cells select the state they count. They used to set an UPPER-CASED key while
  // the filter compared the lower-cased IndicatorState, so a click emptied the table.
  const readyCell = page.locator('[data-testid="nodes-summary"] button').nth(1);
  await readyCell.click();
  await expect(readyCell).toHaveAttribute('aria-pressed', 'true');
  const readyRows = await page.locator('.nodes-table tbody tr').count();
  const readyCount = Number((await readyCell.locator('.ow-summary-value').innerText()).trim());
  expect(readyRows, 'the READY cell must show the READY nodes').toBe(readyCount);
  expect(readyRows).toBeLessThanOrEqual(total);
  // And it toggles off rather than trapping the operator in a filter.
  await readyCell.click();
  await expect(page.locator('.nodes-table tbody tr')).toHaveCount(total);

  // Row verbs: open, instances, copy, revoke.
  const row = page.locator('.nodes-table tbody tr').first();
  await row.locator('[data-testid="row-actions"]').click();
  const menu = page.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  for (const verb of ['details', 'instances', 'copy', 'revoke']) {
    await expect(menu.locator('[data-action="' + verb + '"]'), verb + ' must be offered on a node row').toHaveCount(1);
  }
  // Revoking is a real verb now: it opens its confirmation straight from the row.
  await menu.locator('[data-action="revoke"]').click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();

  // A node's state opens the node.
  expect(await page.locator('.nodes-table tbody [data-status-entity]').count()).toBeGreaterThan(0);

  await useTheme(page, 'light');
  await shot(page, 'nodes-1440-en-light');
  await useTheme(page, 'dark');
  await shot(page, 'nodes-1440-en-dark');
});

test('390: the category strip scrolls to its selection and fades only over hidden content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr');

  const scroller = page.getByTestId('plugins-filter-scroll');
  await expect(scroller).toBeVisible();
  await noPageOverflow(page, 'plugins at 390');

  // The last chip must be reachable. Either it fits, or the scroller really does hide
  // something - and then a fade element exists to say so. The old build carried a permanent
  // mask, which is a fade that lies whenever the strip already fits.
  const last = page.getByRole('tab').last();
  await last.click();
  await expect(last).toHaveAttribute('data-state', 'active');

  const metrics = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  const hiddenRight = metrics.sw > metrics.cw + 1;
  const fadeEnd = page.getByTestId('plugins-filter-fade-end');
  if (hiddenRight) await expect(fadeEnd).toBeVisible();
  else await expect(fadeEnd).toHaveCount(0);

  // Whatever the width, the selected chip is fully inside the visible window.
  const box = (await last.boundingBox())!;
  const view = (await scroller.boundingBox())!;
  expect(box.x, 'the selected chip starts inside the strip').toBeGreaterThanOrEqual(view.x - 1);
  expect(box.x + box.width, 'the selected chip ends inside the strip').toBeLessThanOrEqual(view.x + view.width + 1);

  await useTheme(page, 'light');
  await shot(page, 'plugins-390-en-light');
  await useTheme(page, 'dark');
  await shot(page, 'plugins-390-en-dark');
  await useLocale(page, 'zh-CN');
  await useTheme(page, 'light');
  await shot(page, 'plugins-390-zh-CN-light');
});

test('the record layout and the card CSS switch at the same 768px', async ({ page }) => {
  await page.setViewportSize({ width: 769, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr');

  // 769: a table with a header.
  await expect(page.locator('.plugins-table thead')).toBeVisible();

  // 768: a record - stacked AND labelled. Between 761 and 768 the old build was stacked with
  // no labels at all, which is what printed bare values with no column names.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('.plugins-table thead')).toBeHidden();
  const firstRow = page.locator('.plugins-table tbody tr').first();
  const label = firstRow.locator('[data-label] span').first();
  await expect(label, 'a stacked cell must still print its column label').toBeVisible();
  expect((await label.innerText()).trim().length).toBeGreaterThan(0);

  // Same boundary on the nodes table.
  await page.goto('/admin/nodes');
  await page.waitForSelector('.nodes-table tbody tr');
  await expect(page.locator('.nodes-table thead')).toBeHidden();
  await expect(page.locator('.nodes-table tbody tr').first().locator('[data-label] span').first()).toBeVisible();
});

test('/403 is a wall with a door: three recovery paths and no write verb', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await useLocale(page, 'en');
  await page.goto('/403');
  // /403 is rendered behind the session bootstrap, which asks the Kernel over the internet:
  // give the "establishing authorized session" splash room to resolve before judging the page.
  await expect(page.getByTestId('forbidden-panel')).toBeVisible({ timeout: 30000 });

  // Three stated steps, in the order an operator would take them.
  const steps = page.getByTestId('forbidden-recovery').locator('li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('data-step', 'ask');
  await expect(steps.nth(1)).toHaveAttribute('data-step', 'retry');
  await expect(steps.nth(2)).toHaveAttribute('data-step', 'session');
  // The missing capability is named, so the request to the administrator is actionable.
  await expect(page.getByTestId('forbidden-recovery')).toContainText('platform:access');

  // A page that says "you may not" must not offer a mutation.
  const writeButtons = page.locator('a[href*="plugins/install"], button:has-text("Install")');
  await expect(writeButtons, 'no write action may appear on a permission wall').toHaveCount(0);

  const panel = (await page.getByTestId('forbidden-panel').boundingBox())!;
  expect(panel.height, 'the panel must carry the recovery paths, not be a stub').toBeGreaterThan(300);

  await shot(page, 'forbidden-1440-en-light');

  // Retry is a real verb: it re-reads the session from the Kernel. Two honest outcomes, and
  // the page must reach one of them - either the grant is visible and it enters the console,
  // or it says the session still does not hold the capability. A button that silently does
  // nothing would fail both.
  const retry = page.getByTestId('forbidden-retry');
  await expect(retry).toBeVisible();
  await retry.click();
  const outcome = await expect.poll(async () => {
    if (page.url().includes('/admin')) return 'granted';
    if (await page.getByTestId('forbidden-retry-result').count()) return 'denied';
    return 'pending';
  }, { timeout: 15000, message: 'Retry must resolve to a visible outcome' }).not.toBe('pending');
  if (await page.getByTestId('forbidden-retry-result').count()) {
    await expect(page.getByTestId('forbidden-retry-result')).toHaveAttribute('data-still-denied', 'true');
  } else {
    expect(page.url()).toContain('/admin');
  }
});

test('the screenshot matrix: three pages at 1440 and 390, both themes, both locales', async ({ page }) => {
  await login(page);
  const pages = [
    { name: 'overview', path: '/admin/overview', ready: '[data-module]' },
    { name: 'plugins', path: '/admin/plugins', ready: '.plugins-table tbody tr' },
    { name: 'nodes', path: '/admin/nodes', ready: '.nodes-table tbody tr' },
  ];
  for (const target of pages) {
    for (const viewport of [{ w: 1440, h: 900, tag: '1440' }, { w: 390, h: 844, tag: '390' }]) {
      await page.setViewportSize({ width: viewport.w, height: viewport.h });
      await page.goto(target.path);
      await page.waitForSelector(target.ready, { timeout: 30000 });
      await noPageOverflow(page, target.name + ' at ' + viewport.tag);
      for (const theme of ['light', 'dark'] as const) {
        await useTheme(page, theme);
        await useLocale(page, 'en');
        await shot(page, target.name + '-' + viewport.tag + '-en-' + theme);
      }
    }
  }
  // The product default locale is zh-CN: one dark desktop page proves the strings and the
  // theme tokens survive translation on the page that carries the most new verbs.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/plugins');
  await page.waitForSelector('.plugins-table tbody tr', { timeout: 30000 });
  await useLocale(page, 'zh-CN');
  await useTheme(page, 'dark');
  await shot(page, 'plugins-1440-zh-CN-dark');
});

