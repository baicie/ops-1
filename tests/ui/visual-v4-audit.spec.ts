import { Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * V4 visual audit: one spec for the before and after states.
 *
 * V4_TAG names the output folder and V4_OUT overrides where it lands, so the same measurement
 * code produces both halves of the pair. It writes:
 *   - the page matrix (3 surfaces x 3 viewports x 2 themes x 2 locales),
 *   - interaction states (hover, focus-visible, command palette, dialog, form error),
 *   - component states (loading, empty, error, forbidden) on the local harness,
 *   - _metrics.json: type ladder, tone census and block geometry read from the live DOM.
 *
 * It asserts nothing. Screenshots are evidence for a human review, and a pass/fail assertion
 * here would only prove the elements exist.
 */
const TAG = process.env.V4_TAG || 'before';
const OUT = process.env.V4_OUT || path.resolve('/tmp/v4-matrix', TAG);
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const HARNESS = process.env.V4_HARNESS === '1';

const VIEWPORTS = [
  { key: '1440', w: 1440, h: 900 },
  { key: '1024', w: 1024, h: 768 },
  { key: '390', w: 390, h: 844 },
];
const PAGES = [
  { key: 'overview', route: '/admin/overview' },
  { key: 'plugins', route: '/admin/plugins' },
  { key: 'nodes', route: '/admin/nodes' },
];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;
const DETAIL = { key: 'plugin-detail', route: '/admin/plugins/dev.opsweave.hello' };

type Row = Record<string, unknown>;
const metrics: Row[] = [];

fs.mkdirSync(OUT, { recursive: true });

async function pin(page: Page, theme: string, locale: string) {
  await page.addInitScript(([t, l]) => {
    try {
      window.localStorage.setItem('opsweave-theme', t);
      window.localStorage.setItem('opsweave-locale', l);
    } catch { /* storage blocked */ }
  }, [theme, locale] as [string, string]);
}

async function shot(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage, animations: 'disabled' });
}

async function login(page: Page) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
  await page.waitForTimeout(400);
}

/** Everything a design review needs to argue about, read off the live DOM. */
async function measure(page: Page): Promise<Row> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const sizes: Record<string, number> = {};
    const weights: Record<string, number> = {};
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!visible(el)) continue;
      const ownsText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
      if (!ownsText) continue;
      const cs = getComputedStyle(el);
      const size = (Math.round(parseFloat(cs.fontSize) * 10) / 10).toFixed(1);
      sizes[size] = (sizes[size] || 0) + 1;
      weights[cs.fontWeight] = (weights[cs.fontWeight] || 0) + 1;
    }
    // Painted tone census: which semantic colours actually reach the screen.
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const token = (name: string) => {
      probe.style.color = '';
      probe.style.color = 'var(' + name + ')';
      return getComputedStyle(probe).color;
    };
    const ok = token('--ow-ok'), warn = token('--ow-warn'), danger = token('--ow-danger'), info = token('--ow-info');
    probe.remove();
    const tone: Record<string, number> = { ok: 0, warn: 0, danger: 0, info: 0 };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const paints = [cs.color, cs.backgroundColor, cs.borderTopColor].join('|');
      if (paints.includes(ok)) tone.ok += 1;
      else if (paints.includes(warn)) tone.warn += 1;
      else if (paints.includes(danger)) tone.danger += 1;
      else if (paints.includes(info)) tone.info += 1;
    }
    const main = document.querySelector('.main-content');
    const blocks: Row[] = [];
    let deadGap = 0;
    if (main) {
      const top = main.getBoundingClientRect().top + window.scrollY;
      const stack = main.querySelector('.page-stack') || main;
      let cursor = top;
      for (const child of Array.from(stack.children)) {
        const r = child.getBoundingClientRect();
        if (r.height === 0) continue;
        const absoluteTop = r.top + window.scrollY;
        const gap = Math.round(absoluteTop - cursor);
        if (gap > deadGap) deadGap = gap;
        blocks.push({
          cls: (child.className || child.tagName).toString().split(' ').slice(0, 2).join('.'),
          top: Math.round(absoluteTop),
          height: Math.round(r.height),
          width: Math.round(r.width),
          gapBefore: gap,
        });
        cursor = absoluteTop + r.height;
      }
    }
    const pills = document.querySelectorAll('.status, .status-indicator, [data-indicator]').length;
    const rows = Array.from(document.querySelectorAll('tbody tr, .event-list li, .module-card')).slice(0, 40).map((el) => Math.round(el.getBoundingClientRect().height));
    return {
      sizes,
      weights,
      tone,
      pills,
      colorPainted: Object.entries(tone).filter(([, v]) => v > 0).length,
      blocks,
      deadGap,
      rowHeights: rows,
      docHeight: Math.round(document.documentElement.scrollHeight),
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      fonts: getComputedStyle(document.body).fontFamily,
    };
  });
}

test.describe.configure({ mode: 'serial' });

test('page matrix + states', async ({ page, browser }) => {
  test.setTimeout(13 * 60 * 1000);
  await login(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.w, height: viewport.h });
    for (const theme of THEMES) {
      for (const locale of LOCALES) {
        // Full matrix only at the two review widths; 1024 keeps one theme/locale pair because it is
        // a layout check, not a colour check.
        if (viewport.key === '1024' && (theme === 'dark' || locale === 'zh-CN')) continue;
        await pin(page, theme, locale);
        for (const target of [...PAGES, DETAIL]) {
          await page.goto(BASE + target.route, { waitUntil: 'networkidle' });
          await page.waitForTimeout(320);
          const name = 'v4-' + target.key + '-' + viewport.key + '-' + theme + '-' + locale;
          await shot(page, name);
          if (locale === 'en' && target.key !== DETAIL.key) {
            metrics.push({ page: target.key, viewport: viewport.key, theme, ...(await measure(page)) });
          }
        }
      }
    }
  }

  // ── interaction states, captured at 1440 light en and 390 light en ─────────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await pin(page, 'light', 'en');
  await page.goto(BASE + '/admin/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid=command-palette]', { timeout: 5000 });
  await page.waitForTimeout(200);
  await shot(page, 'v4-state-command-open', false);
  await page.keyboard.type('node');
  await page.waitForTimeout(200);
  await shot(page, 'v4-state-command-filtered', false);
  await page.keyboard.press('Escape');

  // Hover: the first navigation row and the first activity row.
  const navLink = page.locator('.nav-link').nth(1);
  await navLink.hover();
  await page.waitForTimeout(120);
  await shot(page, 'v4-state-hover-nav', false);

  await page.goto(BASE + '/admin/plugins', { waitUntil: 'networkidle' });
  const firstRow = page.locator('tbody tr').first();
  if (await firstRow.count()) {
    await firstRow.hover();
    await page.waitForTimeout(150);
    const box = await page.locator('.table-panel').first().boundingBox();
    await page.screenshot({ path: path.join(OUT, 'v4-state-hover-row.png'), clip: box ?? undefined, animations: 'disabled' });
    await page.locator('tbody tr').first().locator('button[aria-label]').first().click();
    await page.waitForTimeout(250);
    await shot(page, 'v4-state-row-menu', false);
    await page.keyboard.press('Escape');
  }

  // Focus-visible: tab until a nav link owns focus, then photograph the rail.
  await page.goto(BASE + '/admin/overview', { waitUntil: 'networkidle' });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  let focused = '';
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.className || el.tagName) + ' :: ' + (el.textContent || '').trim().slice(0, 24) : 'none';
    });
    if (focused.startsWith('nav-link')) break;
  }
  await page.waitForTimeout(120);
  const rail = await page.locator('.sidebar').first().boundingBox();
  await page.screenshot({ path: path.join(OUT, 'v4-state-focus-nav.png'), clip: rail ?? undefined, animations: 'disabled' });
  metrics.push({ page: 'focus', focused });

  // Dialog: the deploy form on the plugin detail page (opened, then cancelled - nothing is sent).
  await page.goto(BASE + DETAIL.route, { waitUntil: 'networkidle' });
  const deployButton = page.locator('button:has-text("Deploy")').last();
  if (await deployButton.count()) {
    await deployButton.click();
    await page.waitForTimeout(400);
    await shot(page, 'v4-state-dialog', false);
    await page.keyboard.press('Escape');
  }

  // Form error: a fresh context with no session, wrong password.
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE });
  const loginPage = await anon.newPage();
  await loginPage.addInitScript(() => { try { window.localStorage.setItem('opsweave-locale', 'en'); window.localStorage.setItem('opsweave-theme', 'light'); } catch { /* noop */ } });
  await loginPage.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await shot(loginPage, 'v4-login-1440-light-en');
  await loginPage.fill('input[type=email]', ADMIN_EMAIL);
  await loginPage.fill('input[type=password]', 'wrong-password-for-review');
  await loginPage.click('[data-testid=login-submit]');
  await loginPage.waitForSelector('.inline-error', { timeout: 10000 });
  await shot(loginPage, 'v4-state-form-error-1440', false);
  await loginPage.setViewportSize({ width: 390, height: 844 });
  await loginPage.reload({ waitUntil: 'networkidle' });
  await shot(loginPage, 'v4-login-390-light-en');
  await anon.close();

  // Mobile drawer: the 390 navigation, opened from the header trigger.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/admin/overview', { waitUntil: 'networkidle' });
  await page.click('[data-testid=sidebar-trigger]');
  await page.waitForTimeout(350);
  await shot(page, 'v4-state-drawer-390', false);
  await page.keyboard.press('Escape');

  // Mobile command palette renders as a sheet.
  await page.keyboard.press('Meta+k');
  await page.waitForSelector('[data-testid=command-palette]', { timeout: 5000 });
  await page.waitForTimeout(300);
  await shot(page, 'v4-state-command-390', false);
  await page.keyboard.press('Escape');

  // ── component states: only meaningful against the harness, which can answer on demand ──
  if (HARNESS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await pin(page, 'light', 'en');
    const states: Array<{ m: string; route: string; name: string; wait: number }> = [
      { m: 'slow', route: '/admin/overview', name: 'v4-state-loading-1440', wait: 350 },
      { m: 'empty', route: '/admin/overview', name: 'v4-state-empty-overview-1440', wait: 700 },
      { m: 'empty', route: '/admin/plugins', name: 'v4-state-empty-plugins-1440', wait: 700 },
      { m: 'error', route: '/admin/overview', name: 'v4-state-error-1440', wait: 700 },
      { m: 'forbidden', route: '/admin/nodes', name: 'v4-state-forbidden-1440', wait: 700 },
    ];
    for (const state of states) {
      await page.goto(BASE + '/__mode?m=' + state.m + '&next=' + state.route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(state.wait);
      await shot(page, state.name, false);
    }
    await page.goto(BASE + '/__mode?m=normal&next=/admin/overview', { waitUntil: 'domcontentloaded' });
  }

  fs.writeFileSync(path.join(OUT, '_metrics.json'), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(OUT, '_files.txt'), fs.readdirSync(OUT).sort().join('\n'));
});
