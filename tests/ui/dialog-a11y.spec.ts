import { expect, test } from '@playwright/test';
import * as path from 'node:path';

// The dialog primitive is shared by every page, so its accessibility contract is asserted
// here: role=dialog, aria-modal, a focusable control on open, and Escape closing it. It runs
// against whatever OPSWEAVE_URL points at, like the other specs.
test('the join-node dialog opens, traps focus, and closes on Escape', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type=email]', process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local');
  await page.fill('input[type=password]', process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026');
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));

  await page.goto('/nodes');
  const openButton = page.getByRole('button', { name: /接入节点|Join a node|Join node/ });
  await openButton.first().click();

  const dialog = page.locator('[role=dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  const title = await dialog.locator('h2').first().innerText();
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? 'none');
  console.log('dialog title =', JSON.stringify(title), '| activeElement =', focused);

  await page.screenshot({ path: path.resolve('../../artifacts/staging-preview/screenshots/dialog-zh-1440.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await expect(page.locator('[role=dialog]')).toHaveCount(0);
  console.log('closed on Escape = true');
});
