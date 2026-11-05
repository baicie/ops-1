import { expect, test, type Page } from '@playwright/test';
import { login } from './support/workbench-fixtures';

/**
 * DS-V1-2.1: the Incident Evidence KPI state machine, in a real browser.
 *
 * The page has four different facts to keep apart, and the card is the one place a reader sees
 * the answer before opening the evidence panel:
 *
 *   * a read in flight                     -> NO_DATA (no answer yet);
 *   * the kernel answered with zero rows   -> Evidence 0 is real; Kernel verified stays NO_DATA;
 *   * the kernel refused the sub-resource  -> UNKNOWN (403 is an answer, not an empty set);
 *   * the sub-resource could not be read   -> UNKNOWN (503/network is the absence of an answer).
 *
 * The bug this spec pins: the verified card used `evidence.length === 0 ? noData : ...`, so a
 * 403 with no rows painted NO_DATA on the card whose answer was actually unknown. The Evidence
 * card already said UNKNOWN, which made the strip contradict itself. These tests fail on the
 * pre-fix component and pass only when both cards read the same evidence state.
 */

const FIXED_INCIDENT = process.env.WORKBENCH_INCIDENT_ID || '';

async function incidentId(page: Page, withEvidence = false): Promise<string> {
  if (FIXED_INCIDENT) return FIXED_INCIDENT;
  const response = await page.request.get('/api/v1/incidents?limit=100');
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  const items = Array.isArray(body.items) ? body.items : [];
  const found = withEvidence
    ? items.find((item: { evidenceRefs?: unknown[] }) => Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0)
    : items[0];
  return found?.id ?? '';
}

async function open(page: Page, id: string, state: 'present' | 'missing' | 'unavailable' | 'forbidden' | 'loading') {
  await page.goto(`/app/incidents/${id}`);
  await expect(page.getByTestId('incident-timeline')).toBeVisible();
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', state);
}

function kpi(page: Page, metricId: 'incidentEvidence' | 'incidentVerified') {
  return page.locator(`[data-metric="${metricId}"]`);
}

async function expectKpiState(page: Page, metricId: 'incidentEvidence' | 'incidentVerified', state: string, text: string) {
  const card = kpi(page, metricId);
  await expect(card.locator('.ow-metric-value')).toHaveAttribute('data-metric-state', state);
  await expect(card.locator('.ow-metric-value')).toContainText(text);
}

test('a refused evidence read reports UNKNOWN on both KPI cards', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  await page.route('**/api/v1/incidents/*/evidence', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'FORBIDDEN', message: 'evidence is outside this grant' }),
  }));
  await open(page, id, 'forbidden');
  // The panel says a grant is what fixes it; both cards must say the same thing, not NO_DATA.
  await expect(page.getByTestId('incident-evidence-forbidden')).toBeVisible();
  await expectKpiState(page, 'incidentEvidence', 'unknown', 'UNKNOWN');
  await expectKpiState(page, 'incidentVerified', 'unknown', 'UNKNOWN');
  await expect(kpi(page, 'incidentVerified')).not.toContainText('NO_DATA');
});

test('a 503 evidence read reports UNKNOWN on both KPI cards', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  await page.route('**/api/v1/incidents/*/evidence', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ code: 'UNAVAILABLE', message: 'the evidence store is unavailable' }),
  }));
  await open(page, id, 'unavailable');
  await expect(page.getByTestId('incident-evidence-unavailable')).toBeVisible();
  await expectKpiState(page, 'incidentEvidence', 'unknown', 'UNKNOWN');
  await expectKpiState(page, 'incidentVerified', 'unknown', 'UNKNOWN');
  await expect(kpi(page, 'incidentVerified')).not.toContainText('NO_DATA');
});

test('a network failure reports UNKNOWN on both KPI cards', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  await page.route('**/api/v1/incidents/*/evidence', (route) => route.abort('failed'));
  await open(page, id, 'unavailable');
  await expectKpiState(page, 'incidentEvidence', 'unknown', 'UNKNOWN');
  await expectKpiState(page, 'incidentVerified', 'unknown', 'UNKNOWN');
});

test('an in-flight evidence read paints NO_DATA, never zero', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  await page.route('**/api/v1/incidents/*/evidence', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.goto(`/app/incidents/${id}`);
  await expect(page.getByTestId('incident-timeline')).toBeVisible();
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'loading');
  await expectKpiState(page, 'incidentEvidence', 'noData', 'NO_DATA');
  await expectKpiState(page, 'incidentVerified', 'noData', 'NO_DATA');
  // Let the delayed answer land so the fixture does not outlive the test.
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'missing');
});

test('a successful empty read is a real zero for Evidence and NO_DATA for verified', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  await page.route('**/api/v1/incidents/*/evidence', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [] }),
  }));
  await open(page, id, 'missing');
  await expect(page.getByTestId('incident-evidence-empty')).toBeVisible();
  // "The kernel answered and there are no rows" is a fact: zero, not an absent answer.
  await expectKpiState(page, 'incidentEvidence', 'ready', '0');
  // There is no denominator to verify against, so the verified card is NO_DATA, not 0/0.
  await expectKpiState(page, 'incidentVerified', 'noData', 'NO_DATA');
  await expect(kpi(page, 'incidentVerified').locator('.ow-metric-den')).toHaveCount(0);
});

test('a failed refresh over an empty successful read reports UNKNOWN, not a fake zero', async ({ page }) => {
  await login(page);
  const id = await incidentId(page);
  expect(id).not.toBe('');
  let calls = 0;
  await page.route('**/api/v1/incidents/*/evidence', (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    }
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE', message: 'the evidence store is unavailable' }),
    });
  });
  await open(page, id, 'missing');
  await expectKpiState(page, 'incidentEvidence', 'ready', '0');
  await page.getByTestId('incident-refresh').click();
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'unavailable');
  await expect(page.getByTestId('incident-evidence-unavailable')).toBeVisible();
  await expectKpiState(page, 'incidentEvidence', 'unknown', 'UNKNOWN');
  await expectKpiState(page, 'incidentVerified', 'unknown', 'UNKNOWN');
});

test('a successful read with rows shows the verified/total ratio', async ({ page }) => {
  await login(page);
  const id = await incidentId(page, true);
  expect(id, 'the seed must contain an incident with evidence').not.toBe('');
  await page.goto(`/app/incidents/${id}`);
  await expect(page.getByTestId('incident-timeline')).toBeVisible();
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'present');
  const rows = await page.locator('[data-evidence-row]').count();
  expect(rows).toBeGreaterThan(0);
  const verified = await page.getByTestId('incident-evidence-trusted').getAttribute('data-kernel-verified-count');
  expect(verified, 'the page must state its kernel-verified numerator').not.toBeNull();
  await expectKpiState(page, 'incidentEvidence', 'ready', String(rows));
  // Assert the numerator as well as the denominator: an empty substring check would pass even
  // if the card printed the row count instead of the kernel-verified count.
  await expectKpiState(page, 'incidentVerified', 'ready', `${verified}/${rows}`);
  await expect(kpi(page, 'incidentVerified').locator('.ow-metric-den')).toHaveText(`/${rows}`);
});
