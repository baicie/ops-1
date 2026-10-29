import { Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * V3 flagship visual audit: the pre-flight token sweep and the before/after matrix.
 *
 * One spec for both states. MODE=before|after picks the output folder, so the two runs share
 * the same measurement code and the numbers stay comparable - a before/after pair taken by two
 * different scripts proves nothing.
 */
const MODE = process.env.V3_MODE === 'after' ? 'after' : 'before';
// V3_OUT lets a re-measurement land in a scratch directory instead of overwriting the committed
// evidence pair - a re-run that silently replaces artifacts/ui/visual-v3/flagship/{before,after}
// destroys the very comparison it is trying to check.
const OUT = process.env.V3_OUT || path.resolve('../../artifacts/ui/visual-v3/flagship', MODE);
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const FLAGSHIP = [
  { key: 'overview', route: '/admin/overview' },
  { key: 'plugins', route: '/admin/plugins' },
  { key: 'nodes', route: '/admin/nodes' },
];
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];

type Row = Record<string, unknown>;
const report: Row[] = [];
const api: Record<string, unknown> = {};

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  await page.waitForTimeout(600);
}

/** Everything the audit needs, read out of one live page. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const h1 = document.querySelector('h1') as HTMLElement | null;
    let heading: Row | null = null;
    if (h1) {
      const cs = getComputedStyle(h1);
      const box = h1.getBoundingClientRect();
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      heading = {
        text: (h1.textContent || '').trim().slice(0, 48),
        fontSize: cs.fontSize,
        height: Math.round(box.height),
        width: Math.round(box.width),
        lineHeight: Math.round(lineHeight * 10) / 10,
        lines: Math.round(box.height / lineHeight),
        clipped: h1.scrollWidth > h1.clientWidth + 1,
      };
    }
    // Font census: only elements that own a text node, so a wrapper cannot fake the number.
    const sizes: Record<string, number> = {};
    let minFont = 99;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const ownsText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
      if (!ownsText) continue;
      const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      sizes[String(size)] = (sizes[String(size)] || 0) + 1;
      if (size < minFont) minFont = size;
    }
    // Two surface vocabularies, counted apart and never summed.
    //
    // A class name is a claim; the painted frame is the fact. styles.css resets .module-card to a
    // ledger row (1304-1312) and strips the frame off every .stat-strip cell (1279-1286), so
    // after e449f3b those two classes still appear in the DOM without painting a card. A census by
    // class name therefore reports the OLD shape on the NEW page: 4 flattened metrics plus 4
    // flattened module rows were being counted as 8 more boxes than the screen actually shows.
    //
    // boxed - four borders over a non-transparent fill: a card an operator sees as a box. A box
    //         nested in a box is still a box, so nesting is reported, not subtracted.
    // flat  - an intentional frameless structural region: the health band, the count strip, the
    //         console grid, the module ledger. Separate bucket because the design's whole argument
    //         is surface moving from the first bucket to the second, and one summed number hides
    //         exactly that move.
    const BOX = ['.panel', '.ow-metric', '.ow-summary-card', '.module-card', '.callout', '.async-panel', '.attention-banner', '.notice-bar'];
    const FLAT = ['.health-band', '.stat-block', '.stat-strip', '.console-grid', '.module-strip', '.info-grid', '.toolbar'];
    const paintsFrame = (el: Element) => {
      const cs = getComputedStyle(el);
      const sides = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((v) => parseFloat(v) || 0);
      const bg = cs.backgroundColor;
      const filled = bg !== '' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
      return sides.every((w) => w > 0) && filled;
    };
    const dedupe = (selectors: string[]) => {
      const set = new Set<Element>();
      for (const sel of selectors) for (const el of Array.from(document.querySelectorAll(sel))) set.add(el);
      return Array.from(set);
    };
    const census = (selectors: string[]) => {
      const byClass: Record<string, { matched: number; boxed: number; flat: number }> = {};
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll(sel));
        if (!els.length) continue;
        const painted = els.filter(paintsFrame).length;
        byClass[sel] = { matched: els.length, boxed: painted, flat: els.length - painted };
      }
      const all = dedupe(selectors);
      return { all, byClass, painted: all.filter(paintsFrame) };
    };
    const outermost = (elements: Element[], pool: Set<Element>) =>
      elements.filter((el) => {
        for (let p = el.parentElement; p; p = p.parentElement) if (pool.has(p)) return false;
        return true;
      });

    const boxCensus = census(BOX);
    const boxedSet = new Set(boxCensus.painted);
    const flatCensus = census(FLAT);
    const flatAll = flatCensus.all.filter((el) => !paintsFrame(el));
    const flatSet = new Set(flatAll);

    // The honest "layers": what one content column actually stacks. The old regions field walked
    // .page-stack > * and stopped at AsyncBoundary's transparent wrapper div (async-boundary.tsx:142),
    // so it reported two children for every page and could not see a layer change at all.
    const region = document.querySelector('[data-async-state="ready"]') || document.querySelector('.page-stack');
    const layers = region
      ? Array.from(region.children).map((el) => ({
          cls: (el.className || el.tagName).toString().slice(0, 48),
          h: Math.round(el.getBoundingClientRect().height),
          boxed: paintsFrame(el),
        }))
      : [];
    // Drift alarm: a structural container that paints a frame without being on the vocabulary is
    // the exact failure this list has already produced once. Nested chrome inside a known box is
    // suppressed, because "a border inside a card" is not a second card.
    const unlistedBoxes: { cls: string; w: number }[] = [];
    const boxedAllSet = new Set(boxCensus.all);
    for (const el of Array.from((region || document.body).querySelectorAll('*'))) {
      if (!['DIV', 'SECTION', 'UL', 'LI', 'ARTICLE', 'ASIDE'].includes(el.tagName)) continue;
      if (boxedAllSet.has(el) || !paintsFrame(el)) continue;
      let nested = false;
      for (let p = el.parentElement; p; p = p.parentElement) if (boxedSet.has(p)) { nested = true; break; }
      const w = Math.round(el.getBoundingClientRect().width);
      if (nested || w < 160 || unlistedBoxes.some((b) => b.cls === (el.className || el.tagName).toString())) continue;
      unlistedBoxes.push({ cls: (el.className || el.tagName).toString().slice(0, 48), w });
    }
    // Legacy census, kept byte-compatible so the committed before/after JSON stays readable and
    // the distortion itself stays measurable: this is the number that read 12 -> 11.
    const SURFACES = ['.panel', '.ow-metric', '.ow-summary-card', '.module-card', '.attention-banner', '.callout', '.async-panel'];
    const surfaces: Record<string, number> = {};
    let surfacesTotal = 0;
    for (const sel of SURFACES) {
      const n = document.querySelectorAll(sel).length;
      if (n) { surfaces[sel] = n; surfacesTotal += n; }
    }
    const decorations: Record<string, { radius: string; shadow: string; border: string }> = {};
    for (const sel of BOX) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) continue;
      const cs = getComputedStyle(el);
      decorations[sel] = { radius: cs.borderRadius, shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 48), border: cs.borderTopColor };
    }
    // Table containment: a table that is wider than its panel is the classic 1024/390 defect.
    const tables = Array.from(document.querySelectorAll('table')).map((t) => {
      const el = t as HTMLElement;
      const parent = el.closest('.table-panel') as HTMLElement | null;
      const scroller = el.parentElement as HTMLElement | null;
      return {
        width: Math.round(el.scrollWidth),
        container: parent ? Math.round(parent.clientWidth) : null,
        scrollerOverflow: scroller ? Math.round(scroller.scrollWidth - scroller.clientWidth) : null,
        overflow: parent ? Math.round(el.scrollWidth - parent.clientWidth) : null,
        rows: el.querySelectorAll('tbody tr').length,
      };
    });
    const overflowing = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > de.clientWidth + 1.5;
      })
      .slice(0, 6)
      .map((el) => {
        const box = el.getBoundingClientRect();
        return { cls: (el.className || el.tagName).toString().slice(0, 60), right: Math.round(box.right) };
      });
    const regions = Array.from(document.querySelectorAll('.page-stack > *')).map((el) => ({
      cls: (el.className || el.tagName).toString().slice(0, 42),
      h: Math.round(el.getBoundingClientRect().height),
    }));
    return {
      // Where this row was actually taken. A before/after pair is only comparable if both halves
      // can prove the origin they came from - a run that silently falls back to the default
      // baseURL measures the same build twice and reports it as a comparison.
      origin: location.origin,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      innerWidth: window.innerWidth,
      docOverflow: de.scrollWidth - de.clientWidth,
      bodyOverflow: document.body.scrollWidth - de.clientWidth,
      pageHeight: de.scrollHeight,
      regions,
      heading,
      minFont,
      fonts: sizes,
      surfaces,
      surfacesTotal,
      boxed: {
        total: boxCensus.painted.length,
        topLevel: outermost(boxCensus.painted, boxedSet).length,
        flattened: boxCensus.all.length - boxCensus.painted.length,
        byClass: boxCensus.byClass,
      },
      flat: {
        total: flatAll.length,
        topLevel: outermost(flatAll, flatSet).length,
        byClass: flatCensus.byClass,
      },
      layers,
      unlistedBoxes: unlistedBoxes.slice(0, 8),
      decorations,
      tables,
      overflowing,
      panels: document.querySelectorAll('.panel').length,
      tabsOverflow: Array.from(document.querySelectorAll('.ow-filter-scroll')).map((el) => el.scrollWidth - el.clientWidth),
    };
  });
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, '_metrics.json'), JSON.stringify({ mode: MODE, report, api }, null, 2));
});

for (const viewport of VIEWPORTS) {
  for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'zh']) {
      test(`${viewport.w} ${theme} ${locale}`, async ({ browser }) => {
        test.setTimeout(180_000);
        const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1 });
        await context.addInitScript(
          ([t, l]) => {
            localStorage.setItem('opsweave-theme', t);
            localStorage.setItem('opsweave-locale', l);
          },
          [theme, locale],
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        // Control page 1: /login, measured before the session exists.
        await page.goto('/login');
        await page.waitForTimeout(400);
        report.push({ mode: MODE, route: '/login', viewport: viewport.w, theme, locale, ...(await measure(page)) });
        await page.fill('input[type=email]', ADMIN_EMAIL);
        await page.fill('input[type=password]', ADMIN_PASSWORD);
        await page.click('[data-testid=login-submit]');
        await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
        await page.waitForTimeout(700);

        if (viewport.w === 1440 && theme === 'light') {
          for (const endpoint of ['/api/v1/overview', '/api/v1/plugins', '/api/v1/nodes', '/api/v1/jobs']) {
            try {
              const res = await page.request.get(endpoint);
              api[endpoint] = { status: res.status(), body: await res.json() };
            } catch (cause) {
              api[endpoint] = { error: String(cause) };
            }
          }
        }

        // Control page 2: a real job detail, if the kernel has a job to open.
        try {
          const jobsPayload = (api['/api/v1/jobs'] as any)?.body;
          const jobs = Array.isArray(jobsPayload) ? jobsPayload : jobsPayload?.items;
          const jobId = Array.isArray(jobs) && jobs[0]?.jobId ? jobs[0].jobId : null;
          if (jobId) {
            await page.goto(`/admin/jobs/${jobId}`);
            await page.waitForTimeout(900);
            report.push({ mode: MODE, route: '/admin/jobs/:id', viewport: viewport.w, theme, locale, ...(await measure(page)) });
          }
        } catch { /* control page only */ }

        for (const target of FLAGSHIP) {
          await page.goto(target.route);
          // Wait for the boundary to settle: a skeleton measured as a page is how the last
          // audit ended up describing empty screens.
          await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 15000 });
          await page.waitForTimeout(700);
          const data = await measure(page);
          report.push({ mode: MODE, route: target.route, viewport: viewport.w, theme, locale, pageErrors: errors, ...data });
          await page.screenshot({ path: path.join(OUT, `${target.key}-${viewport.w}-${theme}-${locale}.png`), fullPage: true });
        }
        await context.close();
      });
    }
  }
}
