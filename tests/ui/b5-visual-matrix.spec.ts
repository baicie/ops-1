import { test, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B5 visual acceptance matrix.
 *
 * One instrument for the whole grid: 3 viewports x 2 themes x 2 locales x the 14 focus pages,
 * every shot against the deployment that serves this branch (no fixtures on the happy path, so
 * every number below comes from real staging rows). Alongside each PNG it records what a human
 * eye would otherwise have to guess: the lowest WCAG ratio on the page and where it is, the text
 * that a narrower viewport loses entirely (document.body.innerText is what is actually rendered),
 * text clipped by overflow, sub-12px type and undersized hit targets.
 *
 *   B5_MODE=before B5_OUT=/tmp/opsweave-b5/before pnpm --filter @opsweave/ui-tests \
 *     exec playwright test b5-visual-matrix
 *
 * Output goes to a scratch directory: the tracked-PNG budget is full, so nothing here is
 * committed. B5_ONLY=jobs,nodes narrows the run; B5_VIEWPORT=390 narrows the widths.
 */

test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const MODE = process.env.B5_MODE === 'after' ? 'after' : 'before';
const OUT = process.env.B5_OUT || path.resolve('/tmp/opsweave-b5', MODE);
const BASE = process.env.OPSWEAVE_URL || 'http://82.156.234.84:3000';
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const ORIGIN = new URL(BASE).origin;

const JOB = 'e273620e-0580-449f-b7ee-e23e3f065b9e';
const NODE = '9b426dab-27c4-45ce-9773-b51a3db4f246';
const PLUGIN = 'dev.opsweave.hello';
const PIPELINE = 'host-metrics-pipeline';

type Target = { key: string; route: string; auth: 'yes' | 'login' };

const PAGES: Target[] = [
  { key: 'overview', route: '/admin/overview', auth: 'yes' },
  { key: 'plugins', route: '/admin/plugins', auth: 'yes' },
  { key: 'plugin-detail', route: '/admin/plugins/' + PLUGIN, auth: 'yes' },
  { key: 'nodes', route: '/admin/nodes', auth: 'yes' },
  { key: 'node-detail', route: '/admin/nodes/' + NODE, auth: 'yes' },
  { key: 'jobs', route: '/admin/jobs', auth: 'yes' },
  { key: 'job-detail', route: '/admin/jobs/' + JOB, auth: 'yes' },
  { key: 'studio', route: '/admin/pipelines/' + PIPELINE + '/editor', auth: 'yes' },
  { key: 'pipelines', route: '/admin/pipelines', auth: 'yes' },
  { key: 'activity', route: '/admin/activity', auth: 'yes' },
  { key: 'governance', route: '/admin/governance', auth: 'yes' },
  { key: 'access', route: '/admin/access', auth: 'yes' },
  { key: 'business', route: '/app/home', auth: 'yes' },
  { key: 'login', route: '/login', auth: 'login' },
  { key: 'forbidden', route: '/403', auth: 'yes' },
];

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];

const only = (process.env.B5_ONLY || '').split(',').filter(Boolean);
const vpOnly = (process.env.B5_VIEWPORT || '').split(',').filter(Boolean).map(Number);
const PAGES_RUN = only.length ? PAGES.filter((p) => only.includes(p.key)) : PAGES;
const VP_RUN = vpOnly.length ? VIEWPORTS.filter((v) => vpOnly.includes(v.w)) : VIEWPORTS;

const report: any[] = [];
const textIndex = new Map<string, string[]>();

async function signIn(browser: Browser, locale: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  const state = await ctx.storageState();
  await ctx.close();
  state.origins = [
    {
      origin: ORIGIN,
      localStorage: [
        { name: 'opsweave-locale', value: locale },
        { name: 'opsweave-theme', value: 'light' },
      ],
    },
  ];
  return state;
}

/** Everything measured on one live page. Runs in the browser, so it can only use DOM APIs. */
function probe() {
  const parse = (s: any) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
    if (p.length < 3) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const blend = (top: any, bottom: any) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 1 };
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
      a,
    };
  };
  const lum = (c: any) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a: any, b: any) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  };
  const root = document.documentElement;
  const backdrop = (el: Element) => {
    const stack: any[] = [];
    let ambiguous = false;
    let node: Element | null = el;
    while (node) {
      const cs = getComputedStyle(node);
      const bi = cs.backgroundImage;
      if (bi && bi !== 'none') ambiguous = true;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.001) stack.push(c);
      if (c && c.a >= 0.999) break;
      node = node.parentElement;
    }
    let base = stack.length ? stack[stack.length - 1] : parse(getComputedStyle(root).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    if (base.a < 0.999) base = blend(base, { r: 255, g: 255, b: 255, a: 1 });
    let acc = base;
    for (let i = stack.length - 2; i >= 0; i -= 1) acc = blend(stack[i], acc);
    return { color: acc, ambiguous };
  };
  const label = (el: Element) => {
    const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const tid = el.getAttribute('data-testid');
    const role = el.getAttribute('role');
    const chain: string[] = [];
    let n: Element | null = el;
    for (let i = 0; i < 3 && n && n !== document.body; i += 1) {
      chain.unshift(n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + (n.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 1).join('') : ''));
      n = n.parentElement;
    }
    return chain.join('>') + (tid ? '[data-testid=' + tid + ']' : '') + (role ? '[role=' + role + ']' : '') + (cls ? '.' + cls : '');
  };

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  const contrast: any[] = [];
  let textNodes = 0;
  let skippedAmbiguous = 0;
  let svgSkipped = 0;
  let minFont = 99;
  let tinyCount = 0;
  const tinySamples: string[] = [];

  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const owns = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
    if (!owns) continue;
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      svgSkipped += 1;
      continue;
    }
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const fgRaw = parse(cs.color);
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!fgRaw || !text) continue;
    if (fgRaw.a < 0.02) continue;
    textNodes += 1;
    const bg = backdrop(el);
    const fg = fgRaw.a >= 0.999 ? fgRaw : blend(fgRaw, bg.color);
    const px = parseFloat(cs.fontSize) || 16;
    if (px < minFont) minFont = px;
    if (px < 12) {
      tinyCount += 1;
      if (tinySamples.length < 5) tinySamples.push(px + 'px "' + text + '" @ ' + label(el));
    }
    if (bg.ambiguous) {
      skippedAmbiguous += 1;
      continue;
    }
    const r = ratio(fg, bg.color);
    contrast.push({
      ratio: r,
      px,
      fg: 'rgb(' + [fg.r, fg.g, fg.b].map((v) => Math.round(v)).join(',') + ')',
      bg: 'rgb(' + [bg.color.r, bg.color.g, bg.color.b].map((v) => Math.round(v)).join(',') + ')',
      text,
      where: label(el),
      large: px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700),
    });
  }
  contrast.sort((a, b) => a.ratio - b.ratio);
  const aaFails = contrast.filter((c) => c.ratio < (c.large ? 3 : 4.5));

  const clipped: any[] = [];
  const offscreen: any[] = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!visible(el)) continue;
    const owns = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
    const cs = getComputedStyle(el);
    if (owns && el.scrollWidth > el.clientWidth + 1 && ['hidden', 'clip'].includes(cs.overflowX)) {
      if (clipped.length < 12) {
        clipped.push({
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          clientWidth: el.clientWidth,
          scrollWidth: el.scrollWidth,
          where: label(el),
        });
      }
    }
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4 && r.right > vw + 1) {
      if (offscreen.length < 12) {
        offscreen.push({ right: Math.round(r.right), overflow: Math.round(r.right - vw), where: label(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
      }
    }
  }

  const taps: any[] = [];
  for (const el of Array.from(document.querySelectorAll('button, a[href], [role=button], input, select, summary, [tabindex]:not([tabindex="-1"])'))) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 24 || r.width < 24) {
      if (taps.length < 10) taps.push({ w: Math.round(r.width), h: Math.round(r.height), where: label(el), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) });
    }
  }

  const lines = (document.body.innerText || '')
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    if (texts.length < 700) texts.push(l);
  }

  const ths = Array.from(document.querySelectorAll('table thead th')).filter(visible);
  return {
    theme: root.getAttribute('data-theme'),
    lang: root.getAttribute('lang'),
    vw,
    vh,
    scrollWidth: root.scrollWidth,
    clientWidth: root.clientWidth,
    overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
    docHeight: root.scrollHeight,
    h1: (document.querySelector('h1') as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 70) || null,
    textNodes,
    contrastSampled: contrast.length,
    skippedAmbiguous,
    svgSkipped,
    minContrast: contrast[0] || null,
    bottom5: contrast.slice(0, 5),
    aaFailCount: aaFails.length,
    aaFailWorst: aaFails.slice(0, 5),
    minFont,
    tinyCount,
    tinySamples,
    clipped,
    offscreen,
    tapCount: taps.length,
    tapSamples: taps,
    tableCols: ths.length,
    tableRows: document.querySelectorAll('table tbody tr').length,
    buttons: Array.from(document.querySelectorAll('button')).filter(visible).length,
    links: Array.from(document.querySelectorAll('a[href]')).filter(visible).length,
    menuTriggers: Array.from(document.querySelectorAll('[aria-haspopup], [aria-expanded]')).filter(visible).length,
    texts,
  };
}

test('b5 matrix', async ({ browser }) => {
  test.setTimeout(60 * 60 * 1000);
  fs.mkdirSync(OUT, { recursive: true });
  const base = await signIn(browser, 'en');

  for (const vp of VP_RUN) {
    for (const theme of ['light', 'dark']) {
      for (const lang of ['en', 'zh-CN']) {
        const state = JSON.parse(JSON.stringify(base));
        state.origins[0].localStorage = [
          { name: 'opsweave-locale', value: lang },
          { name: 'opsweave-theme', value: theme },
        ];
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, storageState: state, ignoreHTTPSErrors: true });
        const page = await ctx.newPage();
        if (lang === 'en') await page.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
        for (const target of PAGES_RUN) {
          const anonState = { cookies: [], origins: state.origins };
          const ctxForPage = target.auth === 'login' ? await browser.newContext({ viewport: { width: vp.w, height: vp.h }, storageState: anonState, ignoreHTTPSErrors: true }) : ctx;
          const p: Page = target.auth === 'login' ? await ctxForPage.newPage() : page;
          if (lang === 'en' && target.auth === 'login') await p.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
          const id = 'r' + vp.w + '-' + theme + '-' + (lang === 'zh-CN' ? 'zh' : 'en') + '__' + target.key;
          try {
            await p.goto(BASE + target.route, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await p.waitForTimeout(target.auth === 'login' ? 900 : 1600);
            await p.screenshot({ path: path.join(OUT, id + '.png'), fullPage: true });
            const m = (await p.evaluate(probe)) as any;
            const key = target.key + '|' + theme + '|' + lang + '|' + vp.w;
            textIndex.set(key, m.texts);
            const lost: string[] = [];
            if (vp.w === 390) {
              const wide = textIndex.get(target.key + '|' + theme + '|' + lang + '|1440');
              if (wide) {
                const set = new Set(m.texts);
                for (const t of wide) if (!set.has(t) && t.length > 2) lost.push(t);
              }
            }
            report.push({ id, page: target.key, route: target.route, viewport: vp.w, theme, lang, lost: lost.slice(0, 60), lostCount: lost.length, ...m, texts: undefined });
          } catch (err: any) {
            report.push({ id, page: target.key, route: target.route, viewport: vp.w, theme, lang, error: String(err && err.message ? err.message : err).slice(0, 200) });
          }
          if (target.auth === 'login') await ctxForPage.close();
        }
        await ctx.close();
      }
    }
  }
  fs.writeFileSync(path.join(OUT, '_matrix.json'), JSON.stringify(report, null, 1));
});

test('b5 interaction', async ({ browser }) => {
  test.setTimeout(20 * 60 * 1000);
  fs.mkdirSync(OUT, { recursive: true });
  const base = await signIn(browser, 'en');
  const state = JSON.parse(JSON.stringify(base));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
  const page = await ctx.newPage();
  const out: any = {};

  await page.goto(BASE + '/admin/jobs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // hover: does a row visibly respond?
  const row = page.locator('table tbody tr').first();
  const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  await row.hover();
  await page.waitForTimeout(250);
  const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
  out.rowHover = { before, after, changed: before !== after };
  await page.screenshot({ path: path.join(OUT, 'ix-hover-row.png'), fullPage: false });

  // keyboard: tab order and focus visibility
  await page.goto(BASE + '/admin/jobs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const stops: any[] = [];
  for (let i = 0; i < 26; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { tag: 'BODY' };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const owns = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow && cs.boxShadow !== 'none';
      return {
        tag: el.tagName.toLowerCase(),
        label: owns,
        testid: el.getAttribute('data-testid'),
        href: el.getAttribute('href'),
        visible: r.width > 1 && r.height > 1,
        ring,
        shadow,
        outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor,
        focusVisible: (el as any).matches(':focus-visible'),
        inViewport: r.top >= -1 && r.top < window.innerHeight,
      };
    });
    stops.push(info);
  }
  out.tabStops = stops;
  out.tabStopsWithoutRing = stops.filter((s: any) => s.tag !== 'BODY' && !s.ring && !s.shadow).length;
  await page.screenshot({ path: path.join(OUT, 'ix-focus-26tabs.png'), fullPage: false });

  // keyboard task: reach the first job row link by keyboard and open it
  await page.goto(BASE + '/admin/jobs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  let opened = false;
  let tabsUsed = 0;
  for (let i = 0; i < 60 && !opened; i += 1) {
    await page.keyboard.press('Tab');
    tabsUsed = i + 1;
    const isRowLink = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest) return false;
      return Boolean(el.closest('tbody') && el.matches('a[href]'));
    });
    if (isRowLink) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      opened = /\/admin\/jobs\/[0-9a-f-]{8,}/.test(new URL(page.url()).pathname);
    }
  }
  out.keyboardTask = { opened, tabsUsed, url: page.url(), detailHeading: await page.locator('h1').first().innerText().catch(() => null) };
  await page.screenshot({ path: path.join(OUT, 'ix-keyboard-task.png'), fullPage: false });

  // 390 keyboard + focus on the drawer/nav
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: state, ignoreHTTPSErrors: true });
  await ctx2.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + '/admin/jobs', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1400);
  const stops390: any[] = [];
  for (let i = 0; i < 14; i += 1) {
    await p2.keyboard.press('Tab');
    stops390.push(
      await p2.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { tag: 'BODY' };
        const cs = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), label: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 30), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none' };
      }),
    );
  }
  out.tabStops390 = stops390;
  out.tabStops390WithoutRing = stops390.filter((s: any) => s.tag !== 'BODY' && !s.ring && !s.shadow).length;
  await p2.screenshot({ path: path.join(OUT, 'ix-390-focus.png'), fullPage: false });
  await ctx2.close();

  fs.writeFileSync(path.join(OUT, '_interaction.json'), JSON.stringify(out, null, 1));
  await ctx.close();
});

test('b5 states', async ({ browser }) => {
  test.setTimeout(20 * 60 * 1000);
  fs.mkdirSync(OUT, { recursive: true });
  const base = await signIn(browser, 'en');
  const state = JSON.parse(JSON.stringify(base));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: state, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
  const page = await ctx.newPage();
  const out: any[] = [];
  const pages = [
    { key: 'jobs', route: '/admin/jobs', api: '**/api/v1/jobs**' },
    { key: 'nodes', route: '/admin/nodes', api: '**/api/v1/nodes**' },
    { key: 'plugins', route: '/admin/plugins', api: '**/api/v1/plugins**' },
  ];
  for (const p of pages) {
    for (const kind of ['loading', 'empty', 'error']) {
      await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      if (kind === 'loading') {
        await page.route(p.api, async (route) => {
          await new Promise((r) => setTimeout(r, 9000));
          route.continue().catch(() => {});
        });
      } else if (kind === 'empty') {
        await page.route(p.api, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null, total: 0 }) }));
      } else {
        await page.route(p.api, (route) =>
          route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL', message: 'upstream unavailable', requestId: 'b5-probe', retryable: true }) }),
        );
      }
      try {
        await page.goto(BASE + p.route, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(kind === 'loading' ? 900 : 2200);
        await page.screenshot({ path: path.join(OUT, 'state-' + kind + '-' + p.key + '.png'), fullPage: true });
        const m = (await page.evaluate(probe)) as any;
        out.push({
          kind,
          page: p.key,
          h1: m.h1,
          bodyText: (m.texts || []).slice(0, 25),
          minContrast: m.minContrast,
          overflowX: m.overflowX,
          tableRows: m.tableRows,
        });
      } catch (err: any) {
        out.push({ kind, page: p.key, error: String(err && err.message ? err.message : err).slice(0, 160) });
      }
    }
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, '_states.json'), JSON.stringify(out, null, 1));
  await ctx.close();
});
