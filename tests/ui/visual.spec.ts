import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui');

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await page.waitForTimeout(1200);
}

async function expectNoHorizontalOverflow(page: Page) {
  const values = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(values[0], `scrollWidth ${values[0]} vs viewport ${values[1]}`).toBeLessThanOrEqual(values[1] + 1);
}

test('responsive overview matrix 1440/1024/390 light/dark', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1440, 1000], [1024, 900], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((value) => localStorage.setItem('opsweave-theme', value), theme);
      await login(page);
      await expect(page.getByRole('heading', { name: 'Overview', exact: true }).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: path.join(OUT, `overview-${width}-${theme}.png`), fullPage: true });
      expect(errors, `page errors at ${width}/${theme}`).toEqual([]);
      await context.close();
    }
  }
});

test('core operator pages render and do not overflow at 1440', async ({ page }) => {
  await login(page);
  for (const [route, heading] of [
    ['/plugins', 'Plugins'],
    ['/nodes', 'Nodes'],
    ['/activity', 'Activity'],
    ['/access', 'Access & trust'],
    ['/settings', 'Settings'],
    ['/settings/diagnostics', 'Bootstrap Diagnostics'],
    ['/ops-center', 'Ops Center'],
  ] as const) {
    await page.goto(route);
    await page.waitForTimeout(900);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(OUT, `${route.replaceAll('/', '_').replace(/^_/, '') || 'root'}.png`), fullPage: true });
  }
});

test('plugin detail and install wizard are usable', async ({ page }) => {
  await login(page);
  await page.goto('/plugins/dev.opsweave.hello');
  await expect(page.getByRole('heading', { name: /Hello/ }).first()).toBeVisible();
  await expect(page.getByText('Artifact trust')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'plugin-detail.png'), fullPage: true });
  await page.getByRole('tab', { name: /Deployments/ }).click();
  await expect(page.getByText('Deployment ID').first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'plugin-deployments.png'), fullPage: true });
  await page.goto('/plugins/install');
  await expect(page.getByRole('heading', { name: 'Install signed plugin' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'install-wizard.png'), fullPage: true });
});

test('dynamic remote extension loads and calls the Gateway', async ({ page }) => {
  await login(page);
  await page.goto('/ext/trusted-team/hello');
  await expect(page.getByRole('heading', { name: /A full-stack plugin/ })).toBeVisible();
  await expect(page.getByText('Hello from OpsWeave', { exact: false })).toBeVisible();
  await expect(page.locator('.ow-hello-card-value', { hasText: 'TypeScript / Node.js' })).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'hello-extension.png'), fullPage: true });
});

test('instance log viewer connects and shows a log line', async ({ page }) => {
  await login(page);
  const detail = await page.evaluate(async () => {
    const response = await fetch('/api/v1/plugins/dev.opsweave.hello');
    return response.json();
  });
  const instance = detail.deployments.flatMap((deployment: any) => deployment.instances).find((item: any) => item.state === 'READY');
  expect(instance).toBeTruthy();
  await page.goto(`/instances/${instance.id}/logs`);
  await expect(page.getByRole('heading', { name: 'Instance logs' })).toBeVisible();
  await expect(page.locator('.log-line').first()).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'instance-logs.png'), fullPage: true });
});
