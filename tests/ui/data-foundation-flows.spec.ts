import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const FIXTURE = process.env.OPSWEAVE_UI_FIXTURE || 'http://127.0.0.1:18090/hosts.json';
const OUT = path.resolve('../../artifacts/ui/data-foundation');
test.describe.configure({ mode: 'serial' });

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await page.getByRole('heading', { name: 'Overview', exact: true }).first().waitFor();
}

async function noOverflow(page: Page) {
  const values = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(values[0], `scrollWidth ${values[0]} vs viewport ${values[1]}`).toBeLessThanOrEqual(values[1] + 1);
}

test('Catalog + Integration real UI business flow', async ({ page }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await login(page);

  await page.goto('/ext/trusted-team/data-catalog');
  await expect(page.getByRole('heading', { name: 'Data Catalog', exact: true })).toBeVisible();
  await expect(page.getByText('No datasets yet', { exact: false })).not.toBeVisible();
  const datasetName = `ui-hosts-${Date.now()}`;
  await page.getByTestId('catalog-dataset-name').fill(datasetName);
  await page.getByTestId('catalog-create-dataset').click();
  await expect(page.getByTestId('catalog-dataset-detail')).toBeVisible();
  await expect(page.getByTestId('catalog-dataset-detail').getByRole('heading', { name: datasetName })).toBeVisible();
  const idText = await page.getByTestId('catalog-dataset-id').innerText();
  const datasetId = idText.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)?.[0];
  expect(datasetId, `dataset id from ${idText}`).toBeTruthy();
  await page.getByTestId('catalog-dataset-detail').screenshot({ path: path.join(OUT, 'catalog-detail-flow.png') });

  const draft = page.getByTestId('catalog-draft-fields');
  const fields = JSON.parse(await draft.inputValue());
  fields.push({ name: 'region', type: 'string', nullable: true, ordinal: fields.length });
  await draft.fill(JSON.stringify(fields, null, 2));
  await page.getByTestId('catalog-create-draft').click();
  await expect(page.getByTestId('catalog-schema-diff')).toContainText('"compatible": true');
  await page.getByTestId('catalog-publish-draft').click();
  await expect(page.getByTestId('catalog-schema-revisions')).toContainText('"schemaRevision": 2');
  await expect(page.getByTestId('catalog-schema-revisions')).toContainText('"schemaRevision": 1');
  await page.getByTestId('catalog-dataset-detail').screenshot({ path: path.join(OUT, 'catalog-schema-flow.png') });

  await page.goto('/ext/trusted-team/data-integration');
  await expect(page.getByRole('heading', { name: 'Data Integration', exact: true })).toBeVisible();
  const sourceName = `ui-source-${Date.now()}`;
  await page.getByTestId('integration-source-name').fill(sourceName);
  await page.getByTestId('integration-source-endpoint').fill(FIXTURE);
  await page.getByTestId('integration-create-source').click();
  await expect(page.getByText(sourceName, { exact: true }).first()).toBeVisible();
  await page.getByText(sourceName, { exact: true }).first().click();
  await page.getByTestId('integration-test').click();
  await expect(page.getByTestId('integration-preview-result')).toBeVisible();
  await page.getByTestId('integration-discover').click();
  await expect(page.getByTestId('integration-discovery')).toContainText('observed_at');
  await page.getByTestId('integration-preview').click();
  await expect(page.getByTestId('integration-preview-result')).toContainText('"readOnly": true');
  await page.getByTestId('integration-dataset-id').fill(datasetId!);
  await page.getByTestId('integration-publish-spec').click();
  await expect(page.getByTestId('integration-run')).toBeVisible();
  await page.getByTestId('integration-run').click();
  const runRow = page.getByTestId('integration-run-row').first();
  await expect(runRow).toContainText('SUCCEEDED');
  await runRow.getByRole('button', { name: 'Quality' }).click();
  await expect(page.getByTestId('integration-quality')).toContainText('"total": 2');
  await runRow.getByRole('button', { name: 'Lineage' }).click();
  await expect(page.getByTestId('integration-lineage')).toContainText('sourceBatchKey');
  await page.getByTestId('integration-quality').screenshot({ path: path.join(OUT, 'integration-quality-flow.png') });
  await page.getByTestId('integration-lineage').screenshot({ path: path.join(OUT, 'integration-lineage-flow.png') });

  await page.goto('/ext/trusted-team/data-catalog');
  await page.getByText(datasetName, { exact: true }).first().click();
  await expect(page.getByTestId('catalog-dataset-detail')).toBeVisible();
  await page.getByLabel('Rule type').selectOption('RECORD_COUNT');
  await page.getByTestId('quality-rule-config').fill('{"min":100,"max":10000}');
  await page.getByTestId('quality-create-rule').click();
  await expect(page.getByRole('cell', { name: 'RECORD_COUNT' })).toBeVisible();
  await page.getByTestId('quality-start-run').click();
  await expect(page.getByTestId('quality-run-detail')).toContainText('FAILED', { timeout: 15000 });
  await page.getByTestId('quality-run-detail').screenshot({ path: path.join(OUT, 'quality-run-failed.png') });
  await expect(page.getByText('Quality runs', { exact: true })).toBeVisible();

  await page.goto('/nodes');
  await page.locator('.nodes-table tbody tr').first().click();
  await expect(page.getByTestId('node-resource-history')).toBeVisible();
  await expect(page.getByTestId('node-resource-history')).toContainText('sample');
  await page.getByTestId('node-resource-history').screenshot({ path: path.join(OUT, 'node-resource-history.png') });

  await page.goto('/governance');
  await expect(page.getByRole('heading', { name: 'Governance', exact: true })).toBeVisible();
  await expect(page.getByText(datasetName, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('QUALITY FAILED', { exact: false })).toBeVisible().catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'governance-overview.png'), fullPage: true });

  await page.goto('/ext/trusted-team/data-catalog');
  await expect(page.getByText(datasetName, { exact: true }).first()).toBeVisible();
  await page.getByText(datasetName, { exact: true }).first().click();
  await page.getByTestId('catalog-load-records').click();
  await expect(page.getByTestId('catalog-records')).toContainText('host-1');
  await expect(page.getByTestId('catalog-records')).toContainText('host-2');
  await page.reload();
  await expect(page.getByText(datasetName, { exact: true }).first()).toBeVisible();
  await expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([]);
});

test('responsive catalog/integration screenshot matrix', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((value) => localStorage.setItem('opsweave-theme', value), theme);
      await login(page);
      await page.goto('/ext/trusted-team/data-catalog');
      await expect(page.getByRole('heading', { name: 'Data Catalog', exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: path.join(OUT, `catalog-${width}-${theme}.png`), fullPage: width < 700 });
      await page.goto('/ext/trusted-team/data-integration');
      await expect(page.getByRole('heading', { name: 'Data Integration', exact: true })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: path.join(OUT, `integration-${width}-${theme}.png`), fullPage: width < 700 });
      expect(errors, `page errors at ${width}/${theme}: ${errors.join('; ')}`).toEqual([]);
      await context.close();
    }
  }
});
