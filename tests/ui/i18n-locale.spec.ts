import { expect, test, type Page } from '@playwright/test';
import * as path from 'node:path';

// Locale acceptance for the shell: the default locale stays English (existing specs
// assert English copy), a switch persists across reloads, <html lang> follows, and
// every locale gets its own screenshot baseline. Selectors never rely on localised
// copy: the switcher is addressed by data-testid and nav items by their href.
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/staging-preview/screenshots');

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function shoot(page: Page, name: string, theme: 'light' | 'dark') {
  await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, `i18n-${name}-${theme}.png`), fullPage: true });
}

test.describe.configure({ mode: 'serial' });

test('default locale is English and the switcher localises the shell permanently', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Default must stay English so the rest of the suite keeps passing.
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('a[href="/nodes"]')).toContainText('Nodes');
  await shoot(page, 'en-1440', 'light');
  await shoot(page, 'en-1440', 'dark');

  // Switch through the UI, not by writing localStorage directly.
  await page.selectOption('[data-testid="language-switcher"]', 'zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('a[href="/nodes"]')).toContainText('节点');
  await shoot(page, 'zh-1440', 'light');
  await shoot(page, 'zh-1440', 'dark');

  // A reload must keep the chosen locale.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('a[href="/nodes"]')).toContainText('节点');

  // Reset so the persisted choice cannot leak into a developer's next run.
  await page.selectOption('[data-testid="language-switcher"]', 'en');
  await expect(page.locator('a[href="/nodes"]')).toContainText('Nodes');
});

test('both locales stay inside a 390px viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);

  await expect(page.locator('a[href="/nodes"]')).toContainText('Nodes');
  await shoot(page, 'en-390', 'light');
  await shoot(page, 'en-390', 'dark');

  await page.selectOption('[data-testid="language-switcher"]', 'zh-CN');
  await expect(page.locator('a[href="/nodes"]')).toContainText('节点');
  await shoot(page, 'zh-390', 'light');
  await shoot(page, 'zh-390', 'dark');

  // No page-level horizontal overflow in either locale.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await context.close();
});
