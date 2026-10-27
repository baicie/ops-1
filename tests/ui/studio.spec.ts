import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/studio');
const PIPELINE = 'host-metrics-pipeline';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test('pipeline list and detail render real published data', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto('/pipelines');
  await expect(page.getByRole('heading', { name: 'Pipelines', exact: true })).toBeVisible();
  const row = page.getByRole('link', { name: new RegExp(PIPELINE) });
  await expect(row).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'pipeline-list.png'), fullPage: true });
  await row.click();
  await expect(page.getByRole('heading', { name: 'Host Metrics Pipeline' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest revision' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'pipeline-detail.png'), fullPage: true });
});

test('studio renders published nodes and inspector selection', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  await expect(page.getByRole('heading', { name: 'Host Metrics Pipeline' })).toBeVisible();
  await expect(page.getByLabel('Pipeline canvas')).toBeVisible();
  await expect(page.locator('.studio-rf-node').first()).toBeVisible();
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await expect(page.locator('.studio-inspector')).toContainText('http_json');
  await expect(page.getByRole('heading', { name: 'Inspector' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'pipeline-canvas.png'), fullPage: true });
});
