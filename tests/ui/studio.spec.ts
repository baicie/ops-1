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
  // The edit has to differ from the value that is live right now. A fixed number only differed on
  // the first run: this case publishes what it writes, so the second run found the published
  // revision already at that value, the form was not dirty, Save correctly stayed disabled, and the
  // case failed. Read the live value and write a different one, so every run makes a real edit -
  // without teaching the product to save an unchanged form.
  await expect(timeout).toBeVisible();
  const liveTimeout = Number.parseInt(await timeout.inputValue(), 10);
  const nextTimeout = (Number.isFinite(liveTimeout) && liveTimeout > 0 ? liveTimeout : 15) + 1;
  await timeout.fill(String(nextTimeout));
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await page.screenshot({ path: path.join(OUT, 'pipeline-draft-saved.png'), fullPage: true });
  await page.reload();
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue(String(nextTimeout));
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

  const panel = page.getByLabel('Preview panel');
  const summary = panel.locator('.preview-summary');

  // The summary paints catalog copy, so its text is "Completed" in en and "已完成" in zh-CN, and
  // it was never the protocol answer anyway. data-status carries the wire code (the same contract
  // Status keeps), so this asserts the real result without pinning the case to one language.
  await expect(summary).toHaveAttribute('data-status', 'COMPLETED');

  // Exact processed count, not "the word records appears": the sample this case actually submits
  // is read back, and the server's processedRecords must equal the number of rows that went in -
  // which is what "pure transforms" means. One row in, one row out.
  const sampleRows = JSON.parse(await panel.locator('textarea').inputValue()) as unknown[];
  const expected = sampleRows.length;
  expect(expected, 'the seeded sample is a non-empty array').toBeGreaterThan(0);
  await expect(summary).toHaveAttribute('data-records', String(expected));

  // Node Outputs open: the summary's node count and the number of node cards must agree, every
  // card must name its node, and every card must render a parseable payload.
  const nodes = panel.locator('.preview-node');
  await expect(nodes.first()).toBeVisible();
  const nodeCount = Number(await summary.getAttribute('data-node-count'));
  expect(nodeCount, 'the preview reports at least one node output').toBeGreaterThan(0);
  await expect(nodes).toHaveCount(nodeCount);

  for (let index = 0; index < nodeCount; index += 1) {
    const node = nodes.nth(index);
    const nodeId = await node.getAttribute('data-node-id');
    expect(nodeId, `preview node #${index} names its nodeId`).toBeTruthy();
    // The payload is rendered and parseable, which is what "the node output can be opened" means.
    const opened = JSON.parse((await node.locator('pre').first().textContent()) ?? 'null') as unknown;
    expect(Array.isArray(opened), `node ${nodeId} renders its rows as a JSON array`).toBe(true);
    // outputCount is the node's real row count, so the rows it renders can never outnumber it.
    const outputCount = Number(await node.getAttribute('data-output-count'));
    expect(Number.isInteger(outputCount), `node ${nodeId} reports an integer output-count`).toBe(true);
    expect((opened as unknown[]).length, `node ${nodeId} does not render more rows than it produced`).toBeLessThanOrEqual(outputCount);
  }

  await page.addStyleTag({ content: '.topbar{visibility:hidden}' });
  await page.locator('.studio-preview').screenshot({ path: path.join(OUT, 'pipeline-preview.png') });
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
  // Every step below is stated as the precondition the product needs instead of being left to the
  // click's own retry loop. Create draft only exists while no draft is attached, Save draft only
  // renders for a loaded draft and only enables on a dirty form, so a missing precondition used to
  // spend the whole 60s test budget inside a click that never becomes actionable - reported as
  // "Test timeout exceeded" with no indication of which state was absent.
  const createDraft = page.getByRole('button', { name: 'Create draft' });
  await expect(createDraft).toBeEnabled();
  await createDraft.click();
  await expect(page.getByRole('status')).toContainText('Draft created');
  // The second tab is pointed at this URL, so the draft id has to be in it before it is read:
  // a URL taken before the editor navigates drops the second tab on the read-only published view.
  await expect(page).toHaveURL(/[?&]draft=[0-9a-f-]{36}/);
  const draftUrl = page.url();
  const pageB = await context.newPage();
  await pageB.goto(draftUrl);
  const saveA = page.getByRole('button', { name: 'Save draft' });
  const saveB = pageB.getByRole('button', { name: 'Save draft' });
  // Save draft renders only when the editor holds a draft, so this is the proof that the second
  // tab attached to the same draft rather than to the published, read-only definition.
  await expect(saveB).toBeVisible();
  await page.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  await pageB.locator('.studio-rf-node').filter({ hasText: 'source' }).first().click();
  const timeoutA = page.locator('.studio-inspector').getByLabel('timeoutSeconds');
  const timeoutB = pageB.locator('.studio-inspector').getByLabel('timeoutSeconds');
  // A read-only inspector is the "no draft" state; filling it would wait instead of failing.
  await expect(timeoutA).toBeEnabled();
  await expect(timeoutB).toBeEnabled();
  // Same reason the case above reads the live value: 18 and 19 are only different from what is
  // published until a database has been published to a few times, and a write equal to the live
  // value leaves the form clean - Save draft then stays disabled and the click waits out the test.
  // Derive both numbers from what is live right now.
  const liveTimeout = Number.parseInt(await timeoutA.inputValue(), 10);
  const base = Number.isFinite(liveTimeout) && liveTimeout > 0 ? liveTimeout : 15;
  const savedTimeout = String(base + 1);
  const localTimeout = String(base + 2);
  await timeoutA.fill(savedTimeout);
  await timeoutB.fill(localTimeout);
  await expect(saveA).toBeEnabled();
  await saveA.click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
  await expect(saveB).toBeEnabled();
  await saveB.click();
  await expect(pageB.locator('.studio-conflict')).toContainText('DRAFT_VERSION_CONFLICT');
  await expect(timeoutB).toHaveValue(localTimeout);
  await expect(pageB.getByRole('button', { name: 'Use local & retry' })).toBeVisible();
  await expect(pageB.locator('.conflict-diff')).toContainText('timeoutSeconds');
  await expect(pageB.locator('.conflict-diff')).toContainText(localTimeout);
  await expect(pageB.locator('.conflict-diff')).toContainText(savedTimeout);
  await pageB.screenshot({ path: path.join(OUT, 'pipeline-conflict.png') });
  // G08 batch C item 1: the two overwriting writes ask through the shared ConfirmAction instead of
  // window.confirm. This is the real-draft half of that: the dialog opens idle, and the write it
  // guards is the one that actually saves over the newer draft. The pending/blocked-second-submit
  // and reload halves are pinned in g08-batch-c.spec.ts, where a delayed response makes the
  // in-flight window observable without a seeded pipeline.
  await pageB.getByRole('button', { name: 'Use local & retry' }).click();
  const overwrite = pageB.getByTestId('confirm-dialog');
  await expect(overwrite).toBeVisible();
  await expect(overwrite).toHaveAttribute('data-confirm-state', 'idle');
  const confirmOverwrite = overwrite.locator('[data-confirm-submit]');
  await expect(confirmOverwrite).toBeEnabled();
  await pageB.screenshot({ path: path.join(OUT, 'pipeline-conflict-confirm.png') });
  await confirmOverwrite.click();
  await expect(pageB.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(pageB.getByRole('status')).toContainText('Draft saved');
  await pageB.close();
});

test('mobile studio node list opens inspector at 390', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  await page.goto(`/pipelines/${PIPELINE}/editor`);
  await page.getByRole('button', { name: 'Nodes', exact: true }).click();
  await page.locator('.mobile-node-list button').filter({ hasText: 'source' }).first().click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(OUT, 'mobile-studio.png') });
  await context.close();
});
