import { expect, test, type Page } from '@playwright/test';
import { NODES, installFixtures, login, firstIncidentId } from './support/workbench-fixtures';
import fs from 'node:fs';
import path from 'node:path';

/**
 * DS-V1-2 before/after matrix for the two workbenches.
 *
 * The Observability pages answer from fixtures so every state is on screen at once (DEGRADED,
 * UNKNOWN, NO_DATA, STALE, real readings); the Incident page uses a real seeded incident. The
 * script writes screenshots and a metrics JSON per combination; assertions about the redesign
 * live in the companion gate, not here, so the same instrument can capture "before" on the old
 * tree and "after" on the new one.
 *
 *   WORKBENCH_MODE=before pnpm exec playwright test workbench-matrix.spec.ts
 *   WORKBENCH_MODE=after  pnpm exec playwright test workbench-matrix.spec.ts
 */
const MODE = process.env.WORKBENCH_MODE === 'after' ? 'after' : 'before';
const FIXED_INCIDENT = process.env.WORKBENCH_INCIDENT_ID || '';
const OUT = process.env.WORKBENCH_OUT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../artifacts/ui/visual-v2', MODE);
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 768, h: 900 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

async function measure(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const text = (selector: string) => (document.querySelector(selector) as HTMLElement | null)?.innerText.trim() ?? '';
    const regions = Array.from(document.querySelectorAll('[data-region]')).map((el) => el.getAttribute('data-region'));
    const kpi = document.querySelector('.metric-grid, .summary-grid.incident-kpis') as HTMLElement | null;
    // A grid inside a hidden pane returns the unresolved `repeat(2, minmax(0px, 1fr))`, whose
    // three space-separated tokens are not a column count. Measure only what is laid out.
    const kpiVisible = Boolean(kpi && kpi.getClientRects().length > 0);
    const gridColumns = kpiVisible ? getComputedStyle(kpi!).gridTemplateColumns.split(' ').filter(Boolean).length : null;
    const cards = Array.from(document.querySelectorAll('.ow-metric')).map((card) => ({
      metric: card.getAttribute('data-metric'),
      state: card.querySelector('.ow-metric-value')?.getAttribute('data-metric-state') ?? null,
      value: (card.querySelector('.ow-metric-value')?.textContent || '').trim().replace(/\s+/g, ' '),
    }));
    const header = document.querySelector('[data-testid=page-header]');
    const firstPanel = document.querySelector('.page-stack > .panel, .page-stack > .metric-grid, .page-stack > .investigation-workspace');
    return {
      overflow: de.scrollWidth - de.clientWidth,
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      h1: text('h1'),
      regions,
      gridColumns,
      cards,
      panelTitles: Array.from(document.querySelectorAll('.panel-head h2')).map((el) => (el.textContent || '').trim()),
      firstContentY: firstPanel ? Math.round(firstPanel.getBoundingClientRect().top) : null,
      tabs: Array.from(document.querySelectorAll('[role=tab]')).map((el) => el.getAttribute('data-testid') || (el.textContent || '').trim()),
      visiblePane: document.querySelector('.investigation-workspace')?.getAttribute('data-active-pane') ?? null,
      rowCount: document.querySelectorAll('tbody tr').length,
      bodyText: (document.body.innerText || '').length,
    };
  });
}

test('workbench matrix 1440/1024/768/390 x light/dark x en/zh-CN', async ({ browser }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  let incidentId = '';
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
        await installFixtures(page);
        await login(page);
        if (!incidentId) incidentId = FIXED_INCIDENT || await firstIncidentId(page);

        await page.goto('/app/observability');
        await page.waitForSelector('[data-async-state]:not([data-async-state=loading])', { timeout: 20_000 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `observability__${label}.png`), fullPage: true });
        const observability = await measure(page);

        await page.goto(`/app/observability/nodes/${NODES[0].id}`);
        await page.waitForSelector('[data-testid=observability-entity] [data-async-state]:not([data-async-state=loading])', { timeout: 20_000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `observability-entity__${label}.png`), fullPage: true });
        const entity = await measure(page);

        let incident: unknown = null;
        let incidentDetailTab: unknown = null;
        if (incidentId) {
          await page.goto(`/app/incidents/${incidentId}`);
          await page.waitForSelector('[data-testid=incident-timeline]', { timeout: 20_000 });
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, `incident__${label}.png`), fullPage: true });
          incident = await measure(page);
          if (viewport.w < 1024) {
            const detailTab = page.getByTestId('investigation-tab-detail');
            if (await detailTab.count()) {
              await detailTab.click();
              await page.waitForTimeout(200);
              await page.screenshot({ path: path.join(OUT, `incident-detail-tab__${label}.png`), fullPage: true });
              incidentDetailTab = await measure(page);
            }
          }
        }

        fs.writeFileSync(
          path.join(OUT, `_metrics_${label}.json`),
          JSON.stringify({
            config: { label, viewport, theme, locale, mode: MODE, data: 'fixtures+seeded-incident' },
            pages: {
              '/app/observability': observability,
              '/app/observability/nodes/:id': entity,
              ...(incident ? { '/app/incidents/:id': incident } : {}),
              ...(incidentDetailTab ? { '/app/incidents/:id detail-tab': incidentDetailTab } : {}),
            },
          }, null, 1),
        );
        await context.close();
      }
    }
  }
  expect(incidentId, 'a seeded incident must be readable').not.toBe('');
});
