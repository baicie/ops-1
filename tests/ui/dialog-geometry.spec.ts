import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The shared dialog frame at 1440/1024/768/390, light/dark, en/zh-CN.
 *
 * Three frame users are reachable without Docker: ConfirmAction (Access, with one fixture user),
 * the create-incident Modal, and the command palette (centre above 1024, sheet below). The two
 * Sources sheets are measured by sources-audit.spec.ts, which owns their fixture.
 *
 * The assertions are geometry a reviewer can re-derive: the box stays inside the viewport, the
 * head/body/foot are present, the footer is not cut off, one close control exists, Escape closes,
 * and the scroll lock is released. Screenshots go to the untracked visual-v1 directory.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const FIXTURE_USER = 'dialog-geometry-user';
const OUT = process.env.DIALOG_GEOMETRY_OUT || path.resolve('../../artifacts/ui/visual-v1/dialogs');

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 768, h: 900 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

async function login(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function expectInViewport(page: Page, selector: string, label: string) {
  const box = await page.locator(selector).last().boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, label + ': box').not.toBeNull();
  expect(box!.x, label + ': left').toBeGreaterThanOrEqual(-1);
  expect(box!.y, label + ': top').toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, label + ': right').toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height, label + ': bottom').toBeLessThanOrEqual(viewport.height + 1);
}

async function expectNoPageOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, label + ': horizontal overflow').toBeLessThanOrEqual(1);
}

async function expectScrollReleased(page: Page, label: string) {
  // Radix releases the lock on the close tick; poll instead of reading once.
  await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-scroll-locked')), { timeout: 5_000 })
    .toBe(false);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).pointerEvents), { timeout: 5_000 })
    .not.toBe('none');
}

async function assertFrame(page: Page, label: string) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').last();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.ow-dialog-head')).toBeVisible();
  await expect(dialog.locator('.ow-dialog-title')).not.toBeEmpty();
  await expect(dialog.locator('.ow-dialog-head button')).toHaveCount(1);
  const body = dialog.locator('.ow-dialog-body');
  if (await body.count()) {
    await expect(body).toBeVisible();
    const scrolls = await body.evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(scrolls);
  }
  const footer = dialog.locator('.ow-dialog-foot');
  if (await footer.count()) await expectInViewport(page, '[role="dialog"] .ow-dialog-foot', label + ' footer');
  await expectInViewport(page, '[role="dialog"][aria-modal="true"]', label + ' frame');
  await expectNoPageOverflow(page, label);
}

async function openConfirm(page: Page) {
  await page.route('**/api/v1/users', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const users = await response.json();
    await route.fulfill({
      response,
      json: [...users, { id: FIXTURE_USER, email: 'geometry@opsweave.local', displayName: 'Geometry Fixture', role: 'viewer', disabled: false, createdAt: new Date().toISOString() }],
    });
  });
  await page.goto('/admin/access');
  const row = page.locator('[data-user="' + FIXTURE_USER + '"]');
  await expect(row).toBeVisible();
  await row.locator('button').last().click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
}

async function tryOpenModal(page: Page): Promise<boolean> {
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  const gate = page.locator('[data-testid="incident-create-open"], [data-testid="incident-create-blocked"]').first();
  await expect(gate).toBeVisible({ timeout: 15_000 });
  const open = page.getByTestId('incident-create-open');
  if (await open.count() === 0 || !(await open.isEnabled())) return false;
  await open.click();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
  return true;
}

async function openPalette(page: Page) {
  await page.goto('/admin/overview');
  await expect(page.getByTestId('page-header')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.locator('[role="dialog"]')).toBeVisible();
}

test('dialog geometry 1440/1024/768/390 x light/dark x en/zh-CN', async ({ browser }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  let skippedModal = 0;
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const locale of LOCALES) {
        const label = `r${viewport.w}-${theme}-${locale}`;
        const context: BrowserContext = await browser.newContext({
          viewport: { width: viewport.w, height: viewport.h },
          deviceScaleFactor: 1,
        });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t as string);
          localStorage.setItem('opsweave-locale', l as string);
        }, [theme, locale]);
        const page = await context.newPage();
        await login(page);

        await openConfirm(page);
        await assertFrame(page, label + ' confirm');
        await page.screenshot({ path: path.join(OUT, `confirm__${label}.png`), fullPage: false });
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
        await expectScrollReleased(page, label + ' confirm');

        if (await tryOpenModal(page)) {
          await assertFrame(page, label + ' modal');
          await page.screenshot({ path: path.join(OUT, `modal__${label}.png`), fullPage: false });
          await page.keyboard.press('Escape');
          await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
          await expectScrollReleased(page, label + ' modal');
        } else {
          skippedModal += 1;
        }

        await openPalette(page);
        const dialog = page.locator('[role="dialog"]').last();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId('command-input')).toBeFocused();
        await expectInViewport(page, '[role="dialog"]', label + ' palette');
        await expectNoPageOverflow(page, label + ' palette');
        await page.screenshot({ path: path.join(OUT, `palette__${label}.png`), fullPage: false });
        await page.keyboard.press('Escape');
        await expect(page.locator('[role="dialog"]')).toHaveCount(0);
        await expectScrollReleased(page, label + ' palette');

        await context.close();
      }
    }
  }
  // A closed create gate is a data fact of the run, not a geometry pass: a run that could not
  // open the modal is red, not a green log line. Every combination is required.
  console.log(`dialog-geometry: modal measured ${16 - skippedModal}/16 combinations`);
  expect(skippedModal, 'the create-incident modal must open for every combination').toBe(0);
});
