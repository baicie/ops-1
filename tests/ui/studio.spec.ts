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
  await page.screenshot({ path: path.join(OUT, 'pipeline-canvas.png') });
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
  await page.screenshot({ path: path.join(OUT, 'pipeline-draft-saved.png'), fullPage: true });
  await page.reload();
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue('17');
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Server validation passed');
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled();
  await page.screenshot({ path: path.join(OUT, 'pipeline-validated.png'), fullPage: true });
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('heading', { name: 'Host Metrics Pipeline' })).toBeVisible();
  await expect(page.locator('.metric-value').first()).not.toHaveText('r1');
  await page.screenshot({ path: path.join(OUT, 'pipeline-published.png'), fullPage: true });
});

test('submit a published revision and open real job detail', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/run`);
  await expect(page.getByRole('heading', { name: 'Host Metrics Pipeline' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit job' }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+/);
  await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();
  await expect(page.locator('.metric-value').first()).toContainText(/Succeeded|SUCCEEDED/i, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timeline' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'job-detail.png'), fullPage: true });
  await page.goto('/jobs');
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'job-history.png'), fullPage: true });
});

test('server preview runs pure transforms and reports node outputs', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.getByRole('button', { name: 'Run preview' }).click();
  await expect(page.getByLabel('Preview panel')).toContainText('COMPLETED');
  await expect(page.getByLabel('Preview panel')).toContainText('records');
  await expect(page.locator('.preview-node').first()).toBeVisible();
  await page.locator('.studio-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'pipeline-preview.png') });
});

test('pipeline list remains usable at laptop, mobile and dark mode', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [width, height, name] of [[1024, 768, 'laptop'], [390, 844, 'mobile']]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await login(page);
    await page.goto('/pipelines');
    await expect(page.getByRole('heading', { name: 'Pipelines', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `pipeline-list-${name}.png`), fullPage: true });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('opsweave-theme', 'dark'));
  const page = await context.newPage();
  await login(page);
  await page.goto('/pipelines');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'pipeline-list-dark.png'), fullPage: true });
  await context.close();
});

test('draft conflict preserves local edits and offers resolution', async ({ page, context }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft created');
  const draftUrl = page.url();
  const pageB = await context.newPage();
  await pageB.goto(draftUrl);
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await pageB.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await page.locator('.studio-inspector').getByLabel('timeoutSeconds').fill('18');
  await pageB.locator('.studio-inspector').getByLabel('timeoutSeconds').fill('19');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await pageB.getByRole('button', { name: 'Save draft' }).click();
  await expect(pageB.locator('.studio-conflict')).toContainText('DRAFT_VERSION_CONFLICT');
  await expect(pageB.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue('19');
  await expect(pageB.getByRole('button', { name: 'Use local & retry' })).toBeVisible();
  await expect(pageB.locator('.conflict-diff')).toContainText('timeoutSeconds');
  await expect(pageB.locator('.conflict-diff')).toContainText('19');
  await expect(pageB.locator('.conflict-diff')).toContainText('18');
  await pageB.screenshot({ path: path.join(OUT, 'pipeline-conflict.png') });
  await pageB.close();
});
