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

test('draft edit, save, reload, validate and publish creates a revision', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft created');
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  const timeout = page.locator('.studio-inspector').getByLabel('timeoutSeconds');
  await timeout.fill('17');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.reload();
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue('17');
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByRole('status')).toContainText('Server validation passed');
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('heading', { name: 'Host Metrics Pipeline' })).toBeVisible();
  await expect(page.locator('.metric-value').first()).not.toHaveText('r1');
  await page.screenshot({ path: path.join(OUT, 'pipeline-published.png'), fullPage: true });
});
