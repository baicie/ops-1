import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Overview flagship's twelve combinations, as a PR gate.
 *
 * `visual.spec.ts` already captures a light/dark matrix, but that file also drives plugin
 * instances and logs, so it cannot run in the deterministic harness (which has no Docker and no
 * plugin). This spec is the part that belongs in CI: the page rendered from the kernel the
 * harness started, at 1440/1024/390 x light/dark x en/zh-CN, with no horizontal overflow and no
 * page errors. It writes its screenshots under the untracked visual-v1 directory; the PNG budget
 * has no file headroom and the evidence path is the Playwright artifact.
 *
 * It asserts structure and geometry, never localized copy: the same spec runs in both locales.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = process.env.OVERVIEW_MATRIX_OUT
  || path.resolve('../../artifacts/ui/visual-v1/gate');

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  const email = page.locator('input[type=email]');
  // A storage state from an earlier session can already be signed in; accept that rather than
  // waiting for a form the app will not draw.
  if (await email.count()) {
    await email.fill(ADMIN_EMAIL);
    await page.fill('input[type=password]', ADMIN_PASSWORD);
    await page.click('[data-testid=login-submit]');
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

test('overview matrix 1440/1024/390 x light/dark x en/zh-CN', async ({ browser }) => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const locale of LOCALES) {
        const label = `r${viewport.w}-${theme}-${locale}`;
        const context = await browser.newContext({
          viewport: { width: viewport.w, height: viewport.h },
          deviceScaleFactor: 1,
        });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t);
          localStorage.setItem('opsweave-locale', l);
        }, [theme, locale]);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));

        await login(page);
        await page.goto('/admin/overview');
        // The boundary is only ready once the overview payload answered; the module ledger is
        // the page's own proof that the data path completed, not a skeleton.
        await page.waitForSelector('[data-testid="overview-modules"]', { timeout: 20_000 });

        await expect(page.getByTestId('page-header'), label).toBeVisible();
        await expect(page.locator('[data-health]'), label).toHaveCount(1);
        await expect(page.getByTestId('overview-sources'), label).toBeVisible();
        await expect(page.getByTestId('overview-audit'), label).toBeVisible();

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);

        if (viewport.w >= 769) {
          const headerHeight = await page.getByTestId('page-header').evaluate(
            (element) => Math.round(element.getBoundingClientRect().height),
          );
          expect(headerHeight, `${label} header height`).toBe(80);
        }

        await page.screenshot({ path: path.join(OUT, `overview__${label}.png`), fullPage: true });
        expect(errors, `${label} page errors`).toEqual([]);
        await context.close();
      }
    }
  }
});
