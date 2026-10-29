import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

// Locale acceptance for the shell.
//
// The product default is Chinese. playwright.config.ts pins opsweave-locale=en through
// storage state so the older specs keep asserting English copy; this file is the one
// place that proves the default itself, so it opens a bare context (no storage state)
// for the default check and uses the pinned one for the switching check.
//
// Selectors never rely on localised copy: the switcher is addressed by data-testid and
// nav items by href.
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/staging-preview/screenshots');

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function shoot(page: Page, name: string, theme: 'light' | 'dark') {
  await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, `i18n-${name}-${theme}.png`), fullPage: true });
}

function navItem(page: Page) {
  // G04 moved the platform console under /admin; the href is the stable, language-free handle.
  return page.locator('a[href="/admin/nodes"]:visible').first();
}

test.describe.configure({ mode: 'serial' });

test('a visitor with no stored preference lands on Chinese', async ({ browser }) => {
  // Playwright merges the config's `use` into browser.newContext(), so an "empty"
  // context still carries the pinned storage state. Clear it explicitly: that is what a
  // first-time visitor actually gets.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await login(page);

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(navItem(page)).toContainText('节点');
  await shoot(page, 'zh-1440', 'light');
  await shoot(page, 'zh-1440', 'dark');

  // Switching to English must work and must persist across a reload.
  await page.selectOption('[data-testid="language-switcher"]', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(navItem(page)).toContainText('Nodes');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await context.close();
});

test('the pinned English locale is what the older specs see, and it switches back', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // playwright.config.ts pins en; assert that pin actually took effect.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(navItem(page)).toContainText('Nodes');
  await shoot(page, 'en-1440', 'light');
  await shoot(page, 'en-1440', 'dark');

  await page.selectOption('[data-testid="language-switcher"]', 'zh-CN');
  await expect(navItem(page)).toContainText('节点');

  // Leave the stored preference in English for any later spec in the same context.
  await page.selectOption('[data-testid="language-switcher"]', 'en');
  await expect(navItem(page)).toContainText('Nodes');
});

test('both locales stay inside a 390px viewport', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await login(page);

  // Default at 390 too.
  await expect(navItem(page)).toContainText('节点');
  await shoot(page, 'zh-390', 'light');
  await shoot(page, 'zh-390', 'dark');

  await page.selectOption('[data-testid="language-switcher"]', 'en');
  await expect(navItem(page)).toContainText('Nodes');
  await shoot(page, 'en-390', 'light');
  await shoot(page, 'en-390', 'dark');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await context.close();
});
