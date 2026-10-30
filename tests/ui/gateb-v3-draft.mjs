// Gate B v3 — the toolbar's worst case: a draft is open, so the row carries Save draft,
// Validate and Publish instead of Create draft (11 controls, not 9).
import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:5174';
const browser = await chromium.launch();
const report = {};
async function open(w, h, locale) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, baseURL: BASE });
  await ctx.addInitScript(([l]) => { localStorage.setItem('opsweave-theme', 'light'); localStorage.setItem('opsweave-locale', l); }, [locale]);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.fill('input[type=email]', 'admin@opsweave.local');
  await page.fill('input[type=password]', 'OpsWeave!2026');
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  await page.waitForTimeout(400);
  return { ctx, page };
}
try {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    for (const locale of ['en', 'zh']) {
      const { ctx, page } = await open(w, h, locale);
      await page.goto('/admin/pipelines/host-metrics-pipeline/editor');
      await page.waitForSelector('.studio-drafts .draft-row button', { timeout: 20000 });
      await page.waitForTimeout(600);
      // Opening an existing draft is navigation, not a write: no draft is created here.
      await page.locator('.studio-drafts .draft-row button').first().click();
      await page.waitForTimeout(1200);
      report[w + '-' + locale] = await page.evaluate(() => {
        const bar = document.querySelector('.studio-toolbar');
        if (!bar) return { missing: true, url: location.href };
        const cs = Array.from(bar.children).map((el) => { const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { text: (el.textContent || '').trim().slice(0, 18), right: Math.round(b.right), top: Math.round(b.top), inView: b.right <= window.innerWidth + 0.5, hit: !!hit && (el === hit || el.contains(hit)) }; });
        return {
          url: location.href.replace(location.origin, ''),
          n: cs.length,
          rows: new Set(cs.map((c) => c.top)).size,
          rightmost: Math.max(...cs.map((c) => c.right)),
          allInside: cs.every((c) => c.inView && c.hit),
          scrollW: bar.scrollWidth,
          clientW: bar.clientWidth,
          headerH: Math.round(document.querySelector('[data-testid=page-header]').getBoundingClientRect().height),
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          items: cs.map((c) => c.text + '[' + c.right + ']'),
        };
      });
      await page.screenshot({ path: '/tmp/gateb/evidence/studio-draft-' + w + '-' + locale + '.png', fullPage: true });
      await ctx.close();
    }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(report, null, 1));
