import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The fourteen cards DS-V1-1b moved to MetricCard, measured where they render.
 *
 * IncidentDetail uses a real seeded incident; Jobs, Pipelines and Governance answer from
 * response fixtures on the endpoints the pages already read (the same technique as admin-polish:
 * the component tree, stylesheet and browser stay real). Each card is asserted to carry a value
 * state, never "NaN"/"undefined", and the band is asserted to hold its columns at 1440/1024/390
 * in both themes and both languages.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = process.env.METRIC_MATRIX_OUT || path.resolve('../../artifacts/ui/visual-v1/metric-cards');
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const PIPELINE_ID = 'metric-card-fixture-pipeline';
const NOW = new Date().toISOString();

const JOB_VIEW = {
  jobId: JOB_ID,
  pipelineId: PIPELINE_ID,
  pipelineRevision: 2,
  status: 'RUNNING',
  currentFence: 3,
  currentLeaseId: 'lease-fixture',
  attempts: 1,
  maxAttempts: 3,
  lastErrorCode: null,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  finishedAt: null,
  createdAt: new Date(Date.now() - 90_000).toISOString(),
  updatedAt: NOW,
};

const PIPELINE_DETAIL = {
  pipelineId: PIPELINE_ID,
  name: 'Metric card fixture',
  latestRevision: 2,
  createdAt: NOW,
  updatedAt: NOW,
  latest: {
    revision: 2,
    digest: 'sha256:' + 'a'.repeat(64),
    status: 'PUBLISHED',
    publishedAt: NOW,
    definition: { name: 'Metric card fixture', nodes: [{ nodeId: 'a' }, { nodeId: 'b' }], edges: [] },
  },
  revisions: [{ revision: 2, digest: 'sha256:' + 'a'.repeat(64), status: 'PUBLISHED', publishedAt: NOW }],
};

const GOVERNANCE_SUMMARY = {
  datasetCount: 0,
  datasetsWithQualityRuns: 0,
  latestQuality: { passed: 0, failed: 0, error: 0, pending: 0, unknown: 0 },
  lineageWindowCount: 0,
  lineageWindow: '24h',
  recentFailures: [],
};

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

async function login(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function columnsOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
}

async function expectCards(page: Page, count: number, label: string) {
  const cards = page.locator('.ow-metric');
  await expect(cards, label + ': card count').toHaveCount(count);
  const values = cards.locator('.ow-metric-value');
  const texts = await values.allInnerTexts();
  for (const value of texts) {
    expect(value.trim(), label + ': empty value').not.toBe('');
    expect(value, label + ': invented value').not.toMatch(/NaN|undefined/);
  }
  const states = await values.evaluateAll((els) => els.map((el) => el.getAttribute('data-metric-state')));
  expect(states.every((state) => state === 'ready' || state === 'noData' || state === 'unknown'), label + ': value state').toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, label + ': horizontal overflow').toBeLessThanOrEqual(1);
}

function stubJobs(page: Page) {
  page.route('**/api/v1/jobs/' + JOB_ID + '**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/diagnostics')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobId: JOB_ID, events: [], attempts: [], leases: [], checkpoints: [], truncated: false }) });
    }
    if (url.endsWith('/result')) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', message: 'no result yet' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JOB_VIEW) });
  });
}

function stubPipelines(page: Page) {
  page.route('**/api/v1/pipelines/' + PIPELINE_ID, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PIPELINE_DETAIL) }));
  page.route('**/api/v1/jobs?pipelineId=' + PIPELINE_ID + '**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [JOB_VIEW], nextCursor: null }) }));
}

function stubGovernance(page: Page) {
  page.route('**/api/data-catalog/**', (route) => {
    const url = route.request().url();
    const body = url.includes('governance-summary') ? GOVERNANCE_SUMMARY : { items: [] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('metric cards 1440/1024/390 x light/dark x en/zh-CN', async ({ browser }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  let incidentCombos = 0;
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const locale of LOCALES) {
        const label = `r${viewport.w}-${theme}-${locale}`;
        const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1 });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t as string);
          localStorage.setItem('opsweave-locale', l as string);
        }, [theme, locale]);
        const page = await context.newPage();
        await login(page);

        // IncidentDetail — real data. The id comes from the list the account can read.
        const list = await page.request.get('/api/v1/incidents?limit=1');
        if (list.ok()) {
          const body = await list.json();
          const incidentId = body?.items?.[0]?.id;
          if (incidentId) {
            await page.goto('/app/incidents/' + incidentId);
            await expect(page.getByTestId('incident-timeline')).toBeVisible();
            await expectCards(page, 4, label + ' incident');
            expect(await columnsOf(page, '.summary-grid'), label + ' incident columns').toBe(2);
            await page.screenshot({ path: path.join(OUT, `incident__${label}.png`), fullPage: true });
            incidentCombos += 1;
          }
        }

        stubJobs(page);
        await page.goto('/admin/jobs/' + JOB_ID);
        await expect(page.getByTestId('page-header')).toBeVisible();
        await expectCards(page, 4, label + ' job');
        expect(await columnsOf(page, '.summary-grid'), label + ' job columns').toBe(viewport.w > 768 ? 4 : 2);
        await expect(page.locator('.summary-grid')).toContainText('1 / 3');
        await page.screenshot({ path: path.join(OUT, `job__${label}.png`), fullPage: true });

        stubPipelines(page);
        await page.goto('/admin/pipelines/' + PIPELINE_ID);
        await expect(page.getByTestId('page-header')).toBeVisible();
        await expectCards(page, 4, label + ' pipeline');
        expect(await columnsOf(page, '.summary-grid'), label + ' pipeline columns').toBe(viewport.w > 768 ? 4 : 2);
        await expect(page.locator('.summary-grid')).toContainText('r2');
        await page.screenshot({ path: path.join(OUT, `pipeline__${label}.png`), fullPage: true });

        stubGovernance(page);
        await page.goto('/admin/governance');
        await expect(page.locator('.metric-grid')).toBeVisible();
        await expectCards(page, 4, label + ' governance');
        expect(await columnsOf(page, '.metric-grid'), label + ' governance columns').toBe(viewport.w > 1024 ? 4 : 2);
        await page.screenshot({ path: path.join(OUT, `governance__${label}.png`), fullPage: true });

        await context.close();
      }
    }
  }
  console.log(`metric-card-matrix: incident measured ${incidentCombos}/12 combinations`);
  expect(incidentCombos, 'a seeded incident must be readable in every combination').toBe(12);
});

test('a missing governance count is UNKNOWN, never a zero', async ({ page }) => {
  await login(page);
  await page.route('**/api/data-catalog/**', (route) => {
    const url = route.request().url();
    if (url.includes('governance-summary')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ datasetsWithQualityRuns: 0, latestQuality: GOVERNANCE_SUMMARY.latestQuality, lineageWindow: '24h', recentFailures: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
  });
  await page.goto('/admin/governance');
  const cards = page.locator('.metric-grid .ow-metric');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0).locator('.ow-metric-value')).toHaveAttribute('data-metric-state', 'unknown');
  await expect(cards.nth(2).locator('.ow-metric-value')).toHaveAttribute('data-metric-state', 'unknown');
  await expect(cards.nth(0).locator('.value-token')).toHaveAttribute('data-value', 'UNKNOWN');
  await expect(cards.nth(2).locator('.value-token')).toHaveAttribute('data-value', 'UNKNOWN');
});
