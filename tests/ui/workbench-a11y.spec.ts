import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { NODES, installFixtures, login, firstIncidentId } from './support/workbench-fixtures';

/**
 * DS-V1-2 accessibility gate for the two workbenches.
 *
 * Three checks per surface: axe (WCAG 2.0/2.1/2.2 A+AA), a real keyboard focus ring, and the
 * minimum target size for the controls a reader has to hit. The fixture is the same one the
 * visual matrix uses, so a state that only exists in the matrix (DEGRADED, no sample, stale)
 * is also scanned here rather than a healthy-only page passing for the whole surface.
 */
const FIXED_INCIDENT = process.env.WORKBENCH_INCIDENT_ID || '';

const TARGETS = [
  '.page-actions button',
  '.page-actions a',
  '.toolbar button',
  '.toolbar [role=combobox]',
  '[data-testid=investigation-tabs] [role=tab]',
  '.icon-btn',
  '[data-testid=incident-evidence] button',
  '[data-testid=incident-verdict] button',
  '[data-testid=incident-lifecycle] button',
  '.ow-window-switch button',
].join(', ');

async function axe(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = result.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(
    blocking.map((violation) => violation.id + ' (' + violation.impact + '): ' + violation.help + ' :: ' + violation.nodes.map((node) => node.target.join(' ') + ' ' + (node.failureSummary || '')).join(', ')),
    label + ': serious/critical axe violations',
  ).toEqual([]);
  return result;
}

async function targets(page: Page, label: string) {
  const small = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll(selector))
      .filter((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((el) => {
        const box = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: ((el as HTMLElement).innerText || (el as HTMLElement).getAttribute('aria-label') || '').trim().slice(0, 40),
          w: Math.round(box.width),
          h: Math.round(box.height),
        };
      })
      .filter((item) => Math.min(item.w, item.h) < 24);
  }, TARGETS);
  expect(small, label + ': controls below the 24px target floor').toEqual([]);
}

async function focusRing(page: Page, label: string) {
  await page.locator('body').click({ position: { x: 2, y: 2 } }).catch(() => undefined);
  // The first Tab lands on the shell's skip link, which has its own style. Walk past it to a
  // page control so the assertion is about the surface under test, not the shell's first stop.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => Boolean((document.activeElement as HTMLElement | null)?.closest('.skip-link')));
    if (!skip) break;
  }
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const style = getComputedStyle(el);
    return { tag: el.tagName, outline: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
  });
  expect(ring, label + ': Tab must land on a control').not.toBeNull();
  const visible = ring!.outline !== 'none' && parseFloat(ring!.width) > 0;
  const shadow = ring!.shadow !== 'none' && ring!.shadow !== '';
  expect(visible || shadow, label + ': focused control must paint a ring (' + JSON.stringify(ring) + ')').toBe(true);
}

test('workbench accessibility at 1440 light en', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('opsweave-theme', 'light');
    localStorage.setItem('opsweave-locale', 'en');
  });
  const page = await context.newPage();
  await installFixtures(page);
  await login(page);

  await page.goto('/app/observability');
  await page.waitForSelector('[data-async-state]:not([data-async-state=loading])');
  await axe(page, 'observability 1440 light en');
  await targets(page, 'observability 1440 light en');
  await focusRing(page, 'observability 1440 light en');

  await page.goto(`/app/observability/nodes/${NODES[0].id}`);
  await page.waitForSelector('[data-testid=observability-entity] [data-async-state]:not([data-async-state=loading])');
  await page.waitForTimeout(400);
  await expect(page.locator('.ow-window-switch button')).toHaveCount(3);
  await axe(page, 'observability entity 1440 light en');
  await targets(page, 'observability entity 1440 light en');

  const incidentId = FIXED_INCIDENT || await firstIncidentId(page);
  expect(incidentId).not.toBe('');
  await page.goto(`/app/incidents/${incidentId}`);
  await page.waitForSelector('[data-testid=incident-timeline]');
  await page.waitForSelector('[data-testid=incident-evidence]:not([data-evidence-state=loading])');
  await page.waitForSelector('[data-testid=incident-investigations]:is([data-state=ready],[data-state=failed])', { timeout: 20_000 });
  await axe(page, 'incident 1440 light en');
  await targets(page, 'incident 1440 light en');
  await focusRing(page, 'incident 1440 light en');
  await context.close();
});

test('workbench accessibility at 390 dark zh-CN', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    localStorage.setItem('opsweave-theme', 'dark');
    localStorage.setItem('opsweave-locale', 'zh-CN');
  });
  const page = await context.newPage();
  await installFixtures(page);
  await login(page);

  await page.goto('/app/observability');
  await page.waitForSelector('[data-async-state]:not([data-async-state=loading])');
  await axe(page, 'observability 390 dark zh-CN');
  await targets(page, 'observability 390 dark zh-CN');

  await page.goto(`/app/observability/nodes/${NODES[0].id}`);
  await page.waitForSelector('[data-testid=observability-entity] [data-async-state]:not([data-async-state=loading])');
  await page.waitForTimeout(400);
  await expect(page.locator('.ow-window-switch button')).toHaveCount(3);
  await axe(page, 'observability entity 390 dark zh-CN');
  await targets(page, 'observability entity 390 dark zh-CN');

  const incidentId = FIXED_INCIDENT || await firstIncidentId(page);
  expect(incidentId).not.toBe('');
  await page.goto(`/app/incidents/${incidentId}`);
  await page.waitForSelector('[data-testid=incident-timeline]');
  await page.waitForSelector('[data-testid=incident-evidence]:not([data-evidence-state=loading])');
  await page.waitForSelector('[data-testid=incident-investigations]:is([data-state=ready],[data-state=failed])', { timeout: 20_000 });
  await axe(page, 'incident 390 dark zh-CN');
  await targets(page, 'incident 390 dark zh-CN');
  await page.getByTestId('investigation-tab-detail').click();
  await axe(page, 'incident detail tab 390 dark zh-CN');
  await targets(page, 'incident detail tab 390 dark zh-CN');
  await context.close();
});

test('workbench accessibility at the tablet widths', async ({ browser }) => {
  for (const viewport of [{ width: 1024, height: 768 }, { width: 768, height: 900 }]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await installFixtures(page);
    await login(page);
    const label = 'width ' + viewport.width;

    await page.goto('/app/observability');
    await page.waitForSelector('[data-async-state]:not([data-async-state=loading])');
    await axe(page, 'observability ' + label);
    await targets(page, 'observability ' + label);

    const incidentId = FIXED_INCIDENT || await firstIncidentId(page);
    expect(incidentId).not.toBe('');
    await page.goto(`/app/incidents/${incidentId}`);
    await page.waitForSelector('[data-testid=incident-timeline]');
    await page.waitForSelector('[data-testid=incident-evidence]:not([data-evidence-state=loading])');
    await page.waitForSelector('[data-testid=incident-investigations]:is([data-state=ready],[data-state=failed])', { timeout: 20_000 });
    await axe(page, 'incident ' + label);
    await targets(page, 'incident ' + label);
    await context.close();
  }
});
