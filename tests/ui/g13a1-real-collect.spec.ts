import { expect, test } from '@playwright/test';
import { login } from './support/workbench-fixtures';

/**
 * G13-A.1 golden path, real stack.
 *
 * Unlike g13-collect-evidence.spec.ts, nothing here is stubbed: the browser talks
 * to the Kernel Gateway, the Gateway to a real Node runtime, the Node to a real
 * OCI plugin, and the plugin to a local Zabbix JSON-RPC fixture. The incident and
 * source are created by tests/ci/g13a1_gateway_e2e.sh, which passes their ids in.
 *
 * If either id is absent the test is skipped with the reason, so running the
 * ordinary UI suite does not silently exercise a different fixture.
 */

const INCIDENT_ID = process.env.G13A1_INCIDENT_ID || '';
const SOURCE_ID = process.env.G13A1_SOURCE_ID || '';
const SKIP = !INCIDENT_ID || !SOURCE_ID
  ? 'G13A1_INCIDENT_ID and G13A1_SOURCE_ID are set by tests/ci/g13a1_gateway_e2e.sh'
  : false;

async function collectAndSave(page: import('@playwright/test').Page): Promise<number> {
  await login(page);
  await page.goto(`/app/incidents/${INCIDENT_ID}`);
  await expect(page.getByTestId('incident-evidence')).toBeVisible();
  // The panel is visible while it is still loading. Counting rows then reads 0
  // and makes the assertion race the first fetch; wait for the settled panel.
  await expect(page.getByTestId('incident-evidence')).not.toHaveAttribute('data-evidence-state', 'loading');
  await expect(page.locator('[data-evidence-row], [data-testid="incident-evidence-empty"]').first()).toBeVisible();
  const before = await page.locator('[data-evidence-row]').count();

  await page.getByTestId('incident-collect-open').click();
  await expect(page.getByTestId('incident-collect')).toBeVisible();
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await expect(page.getByTestId('incident-collect-host').locator('option[value="10084"]')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await expect(page.getByTestId('incident-collect-item-10401')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('incident-collect-item-10401').check();
  await page.getByTestId('incident-collect-run').click();
  await expect(page.getByTestId('incident-collect-result')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('incident-collect-result')).toHaveAttribute('data-outcome', 'OK');
  await expect(page.getByTestId('incident-collect-save')).toBeEnabled();
  await page.getByTestId('incident-collect-save').click();
  await expect(page.getByTestId('incident-collect-saved')).toBeVisible({ timeout: 60_000 });

  // The dialog is still open; close it and verify the re-read list contains the
  // new row rather than trusting the dialog's success sentence.
  await page.getByTestId('incident-collect-cancel').click();
  await expect(page.getByTestId('incident-collect')).toHaveCount(0);
  await expect(page.locator('[data-evidence-row]')).toHaveCount(before + 1, { timeout: 30_000 });
  return before + 1;
}

test.skip(SKIP, SKIP as string);

test('a real Gateway/Node/OCI plugin supplies a saveable collection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await collectAndSave(page);
  // The stored row must carry the Kernel's own verdict, not the submitter's claim.
  const row = page.locator('[data-evidence-row]').first();
  await expect(row).toHaveAttribute('data-trust', 'SOURCE_ATTESTED');
  await expect(row.locator('[data-testid="evidence-kernel-verified"]')).toBeVisible();
});

test('the same flow completes at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await collectAndSave(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, 'the phone layout must not scroll sideways').toBe(false);
});

test('the same flow completes at 1024px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await collectAndSave(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, 'the 1024 layout must not scroll sideways').toBe(false);
});
