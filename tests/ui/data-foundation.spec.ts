import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/data-foundation');

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await page.waitForTimeout(800);
}

test('data catalog remote extension loads from its signed bundle', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.goto('/ext/trusted-team/data-catalog');
  await expect(page.getByRole('heading', { name: 'Data Catalog', exact: true })).toBeVisible();
  await expect(page.getByText('Datasets', { exact: true }).first()).toBeVisible();
  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
  await page.screenshot({ path: path.join(OUT, 'data-catalog.png'), fullPage: true });
});

test('data integration remote extension loads from its signed bundle', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.goto('/ext/trusted-team/data-integration');
  await expect(page.getByRole('heading', { name: 'Data Integration', exact: true })).toBeVisible();
  await expect(page.getByText('Sources', { exact: true }).first()).toBeVisible();
  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
  await page.screenshot({ path: path.join(OUT, 'data-integration.png'), fullPage: true });
});
