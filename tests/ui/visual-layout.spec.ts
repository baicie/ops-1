import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('../../artifacts/ui/studio');
const PIPELINE = 'host-metrics-pipeline';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local');
  await page.fill('input[type=password]', process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function noPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('pipeline detail stats are separated and do not collide', async ({ page }) => {
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}`);
  const cards = page.locator('.pipeline-stats .metric-card');
  await expect(cards).toHaveCount(4);
  const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  boxes.forEach((box) => expect(box.height).toBeGreaterThan(70));
  for (const card of await cards.all()) {
    const label = await card.locator('.metric-label').boundingBox();
    const value = await card.locator('.metric-value').boundingBox();
    expect(label && value && label.y + label.height <= value.y + 1).toBeTruthy();
  }
  expect(await page.locator('.metric-card', { hasText: 'Latest revisionr' }).count()).toBe(0);
  await noPageOverflow(page);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'redesign-pipeline-detail.png'), fullPage: true });
});

test('job UUIDs stay single-line and the page has no horizontal overflow', async ({ page }) => {
  await login(page);
  await page.goto('/jobs');
  const ids = page.locator('.job-id-cell .truncate');
  const count = await ids.count();
  if (count > 0) {
    const box = await ids.first().boundingBox();
    expect(box && box.height).toBeLessThan(32);
  }
  await noPageOverflow(page);
  await page.screenshot({ path: path.join(OUT, 'redesign-job-history.png'), fullPage: true });
});

test('studio gives the canvas the primary workspace at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  const canvas = page.getByLabel('Pipeline canvas');
  const box = await canvas.boundingBox();
  expect(box && box.width).toBeGreaterThan(700);
  expect(box && box.height).toBeGreaterThan(480);
  await expect(page.locator('.studio-rf-node').first()).toBeVisible();
  await noPageOverflow(page);
  await page.screenshot({ path: path.join(OUT, 'redesign-studio.png'), fullPage: true });
});

test('mobile lists do not create page-level horizontal overflow', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  for (const route of ['/pipelines', '/jobs']) {
    await page.goto(route);
    await noPageOverflow(page);
  }
  await context.close();
});
