import { test, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B1 - the evidence run for the ten-judgement visual review.
 *
 * Twelve surfaces, the two viewports a review has to look at (1440 and 390) and the dark theme,
 * captured from the real deployed app. Beside each screenshot it records the facts a screenshot
 * alone cannot settle - how many bordered containers a page paints, which headings repeat, how
 * small the smallest text doing real work is, whether the page itself scrolls sideways, and the
 * measured contrast of the muted text in the theme it was captured in.
 *
 * This is a capture harness: it asserts nothing about taste. The judgement is in the report.
 */

test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const STAGING = process.env.B1_STAGING || 'http://82.156.234.84:3000';
const LOCAL = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5173';
const OUT = process.env.B1_OUT || path.resolve('../../artifacts/ui/visual-v3/b1');
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

interface Target { key: string; label: string; path: string; base: 'staging' | 'local'; mobile?: boolean; dark?: boolean }

const TARGETS: Target[] = [
  { key: 'overview', label: 'Admin Overview', path: '/admin/overview', base: 'staging', mobile: true, dark: true },
  { key: 'plugins', label: 'Plugins', path: '/admin/plugins', base: 'staging', mobile: true },
  { key: 'plugin-detail', label: 'Plugin Detail', path: '/admin/plugins/dev.opsweave.hello', base: 'staging' },
  { key: 'nodes', label: 'Nodes', path: '/admin/nodes', base: 'staging', mobile: true, dark: true },
  { key: 'node-detail', label: 'Node Detail', path: '/admin/nodes/9b426dab-27c4-45ce-9773-b51a3db4f246', base: 'staging' },
  { key: 'jobs', label: 'Jobs', path: '/admin/jobs', base: 'staging', mobile: true },
  { key: 'job-detail', label: 'Job Detail', path: '/admin/jobs/' + (process.env.B1_JOB_ID || 'b1779a8f-018b-42c6-8cc7-c56565c98750'), base: 'local', mobile: true, dark: true },
  { key: 'studio', label: 'Pipeline Studio', path: '/admin/pipelines/host-metrics-pipeline/editor', base: 'staging' },
  { key: 'activity', label: 'Activity', path: '/admin/activity', base: 'staging', mobile: true, dark: true },
  { key: 'governance', label: 'Governance', path: '/admin/governance', base: 'staging', mobile: true },
  { key: 'access', label: 'Access', path: '/admin/access', base: 'staging', mobile: true },
  { key: 'workspace', label: 'Business Workspace', path: '/app/home', base: 'staging' },
];

async function signIn(page: Page, base: string) {
  await page.goto(base + '/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

async function context(browser: Browser, base: string, width: number, height: number, theme: 'light' | 'dark') {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, baseURL: base });
  await ctx.addInitScript((value) => {
    localStorage.setItem('opsweave-theme', value);
    localStorage.setItem('opsweave-locale', 'en');
  }, theme);
  const page = await ctx.newPage();
  await signIn(page, base);
  return { ctx, page };
}

/** The facts a screenshot cannot settle. */
async function probe(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const text = (el: Element) => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const de = document.documentElement;
    const rgb = (value: string) => {
      const hit = value.match(/rgba?\(([^)]+)\)/);
      if (!hit) return null;
      const parts = hit[1].split(/[,/]/).map((part) => parseFloat(part.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = (c: { r: number; g: number; b: number }) => {
      const channel = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };
    const backdrop = (el: Element | null) => {
      for (let node = el; node; node = node.parentElement) {
        const parsed = rgb(getComputedStyle(node).backgroundColor);
        if (parsed && parsed.a > 0.5) return parsed;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const contrast = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el || !visible(el)) return null;
      const fg = rgb(getComputedStyle(el).color);
      if (!fg) return null;
      const bg = backdrop(el);
      const light = luminance(fg);
      const dark = luminance(bg);
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
      return { selector, ratio: Math.round(ratio * 100) / 100, size: getComputedStyle(el).fontSize };
    };
    const boxed = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
    const headings = Array.from(document.querySelectorAll('#main-content h1, #main-content h2, #main-content h3')).filter(visible).map(text);
    const labels = Array.from(document.querySelectorAll('#main-content .metric-label, #main-content .ow-metric-label, #main-content .kv-label, #main-content .panel-head h2')).filter(visible).map(text);
    const statuses = Array.from(document.querySelectorAll('#main-content .status, #main-content .status-indicator')).filter(visible).map(text);
    const repeats = (list: string[]) => {
      const counts = new Map<string, number>();
      for (const item of list) if (item) counts.set(item, (counts.get(item) || 0) + 1);
      return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([value, n]) => value + ' x' + n);
    };
    // Text that is doing a job while set below the 12px reading floor.
    const smallText: { size: string; text: string; tag: string }[] = [];
    for (const el of Array.from(document.querySelectorAll('#main-content *'))) {
      if (el.children.length > 0 || !visible(el)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      const value = text(el);
      if (size < 12 && value.length > 1) smallText.push({ size: size + 'px', text: value.slice(0, 40), tag: el.tagName.toLowerCase() });
    }
    const scrollers = Array.from(document.querySelectorAll('#main-content *')).filter((el) => {
      const style = getComputedStyle(el);
      return (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    }).map((el) => ({ tag: el.tagName.toLowerCase(), className: String(el.className).slice(0, 60), hidden: el.scrollWidth - el.clientWidth }));
    const firstPanel = document.querySelector('#main-content .panel, #main-content .stat-strip, #main-content .business-state');
    const header = document.querySelector('[data-testid=page-header]');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      title: document.title,
      h1: text(document.querySelector('#main-content h1') || document.createElement('h1')),
      overflow: de.scrollWidth - de.clientWidth,
      docHeight: de.scrollHeight,
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      firstBlockY: firstPanel ? Math.round(firstPanel.getBoundingClientRect().top) : null,
      boxed: {
        panel: boxed('#main-content .panel'),
        metricCard: boxed('#main-content .metric-card'),
        statStripItem: boxed('#main-content .stat-strip > *'),
        businessCard: boxed('#main-content .business-card-slot'),
        investigation: boxed('#main-content .investigation-region'),
        table: boxed('#main-content table'),
      },
      headings,
      repeatHeadings: repeats(headings),
      repeatLabels: repeats(labels),
      statuses,
      repeatStatuses: repeats(statuses),
      smallText: smallText.slice(0, 10),
      smallTextCount: smallText.length,
      scrollers,
      contrast: [
        contrast('#main-content .page-description'),
        contrast('#main-content .panel-head h2'),
        contrast('#main-content .metric-label'),
        contrast('#main-content .kv-label'),
        contrast('#main-content table tbody td'),
      ].filter(Boolean),
      primaryActions: Array.from(document.querySelectorAll('#main-content .page-actions .btn, #main-content .page-actions button')).filter(visible).map(text),
    };
  });
}

/**
 * The 390 card, measured: where the label sits relative to the value it names.
 *
 * A stacked row is "label | value" on one line. If `gap` is 0 or negative the two run together and
 * "Created  yesterday" prints as "Createdyesterday" - a defect a screenshot shows and a
 * scrollWidth comparison cannot.
 */
async function measureCards(page: Page) {
  return page.evaluate(() => {
    const rows: { label: string; value: string; gap: number; labelAfterValue: boolean; overlap: boolean }[] = [];
    for (const cell of Array.from(document.querySelectorAll('#main-content td[data-label]'))) {
      const box = cell.getBoundingClientRect();
      if (box.width === 0) continue;
      const label = Array.from(cell.children).find((child) => getComputedStyle(child).display !== 'none' && !child.classList.contains('ow-cell-body')) as HTMLElement | undefined;
      const value = cell.querySelector('.ow-cell-body') as HTMLElement | null;
      if (!label || !value) continue;
      // .ow-cell-body is display:contents at 390 - it has no box, so the value's extent is the
      // union of its children.
      const rectOf = (el: HTMLElement) => {
        const own = el.getBoundingClientRect();
        if (own.width > 0 && own.height > 0) return own;
        const kids = Array.from(el.children).map((kid) => kid.getBoundingClientRect()).filter((rect) => rect.width > 0);
        if (!kids.length) return own;
        const left = Math.min(...kids.map((rect) => rect.left));
        const right = Math.max(...kids.map((rect) => rect.right));
        return { left, right, width: right - left, height: Math.max(...kids.map((rect) => rect.height)) } as DOMRect;
      };
      const l = rectOf(label);
      const v = rectOf(value);
      if (l.width === 0 || v.width === 0) continue;
      const order = label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING;
      rows.push({
        label: (label.textContent || '').trim().slice(0, 20),
        value: (value.textContent || '').trim().slice(0, 24),
        gap: Math.round((v.left - l.right) * 10) / 10,
        labelAfterValue: !order,
        overlap: v.left < l.right - 0.5,
      });
    }
    // The row menu rides the identity line at 390: does it land on the qualifier?
    const collisions: { identity: string; meta: string; overlapX: number; overlapY: number }[] = [];
    for (const meta of Array.from(document.querySelectorAll('#main-content .ow-ident-meta'))) {
      const menu = meta.closest('tr')?.querySelector('[data-testid=row-actions]');
      if (!menu) continue;
      const m = meta.getBoundingClientRect();
      const b = menu.getBoundingClientRect();
      const overlapX = Math.round((Math.min(m.right, b.right) - Math.max(m.left, b.left)) * 10) / 10;
      const overlapY = Math.round((Math.min(m.bottom, b.bottom) - Math.max(m.top, b.top)) * 10) / 10;
      if (overlapX > 0 && overlapY > 0) collisions.push({ identity: (meta.textContent || '').trim().slice(0, 24), meta: (meta.closest('tr')?.querySelector('.ow-ident-name')?.textContent || '').trim().slice(0, 20), overlapX, overlapY });
    }
    const glued = rows.filter((row) => row.gap < 6);
    return {
      rows: rows.slice(0, 8),
      rowCount: rows.length,
      minGap: rows.length ? Math.min(...rows.map((row) => row.gap)) : null,
      glued: glued.slice(0, 8),
      gluedCount: glued.length,
      collisions: collisions.slice(0, 4),
      collisionCount: collisions.length,
    };
  });
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });
test.setTimeout(600_000);

test('B1 capture: twelve surfaces, two viewports, both themes', async ({ browser }) => {
  const report: Record<string, unknown> = {};

  // 1440 light: the judgement surface.
  {
    const { ctx, page } = await context(browser, STAGING, 1440, 900, 'light');
    for (const target of TARGETS) {
      const base = target.base === 'local' ? LOCAL : STAGING;
      try {
        if (target.base === 'local') {
          const local = await context(browser, LOCAL, 1440, 900, 'light');
          await local.page.goto(base + target.path);
          await local.page.waitForSelector('#main-content h1', { timeout: 20000 });
          await local.page.waitForTimeout(1200);
          report[target.key + '@1440-light'] = await probe(local.page);
          await local.page.screenshot({ path: path.join(OUT, target.key + '__1440-light.png') });
          await local.ctx.close();
          continue;
        }
        await page.goto(base + target.path);
        await page.waitForSelector('#main-content h1', { timeout: 20000 });
        await page.waitForTimeout(1200);
        report[target.key + '@1440-light'] = await probe(page);
        await page.screenshot({ path: path.join(OUT, target.key + '__1440-light.png') });
      } catch (cause) {
        report[target.key + '@1440-light'] = { error: String(cause).slice(0, 200) };
      }
    }
    await ctx.close();
  }

  // 390 light: is the phone usable, not just non-overflowing.
  {
    const { ctx, page } = await context(browser, STAGING, 390, 844, 'light');
    for (const target of TARGETS.filter((entry) => entry.mobile)) {
      try {
        if (target.base === 'local') {
          const local = await context(browser, LOCAL, 390, 844, 'light');
          await local.page.goto(LOCAL + target.path);
          await local.page.waitForSelector('#main-content h1', { timeout: 20000 });
          await local.page.waitForTimeout(1200);
          report[target.key + '@390-light'] = { ...(await probe(local.page)), cards: await measureCards(local.page) };
          await local.page.screenshot({ path: path.join(OUT, target.key + '__390-light.png') });
          await local.page.screenshot({ path: path.join(OUT, target.key + '__390-light-full.png'), fullPage: true });
          await local.ctx.close();
          continue;
        }
        await page.goto(STAGING + target.path);
        await page.waitForSelector('#main-content h1', { timeout: 20000 });
        await page.waitForTimeout(1200);
        report[target.key + '@390-light'] = { ...(await probe(page)), cards: await measureCards(page) };
        await page.screenshot({ path: path.join(OUT, target.key + '__390-light.png') });
        await page.screenshot({ path: path.join(OUT, target.key + '__390-light-full.png'), fullPage: true });
      } catch (cause) {
        report[target.key + '@390-light'] = { error: String(cause).slice(0, 200) };
      }
    }
    await ctx.close();
  }

  // Dark: is the dark theme the same quality as the light one.
  {
    const { ctx, page } = await context(browser, STAGING, 1440, 900, 'dark');
    for (const target of TARGETS.filter((entry) => entry.dark)) {
      try {
        if (target.base === 'local') {
          const local = await context(browser, LOCAL, 1440, 900, 'dark');
          await local.page.goto(LOCAL + target.path);
          await local.page.waitForSelector('#main-content h1', { timeout: 20000 });
          await local.page.waitForTimeout(1200);
          report[target.key + '@1440-dark'] = await probe(local.page);
          await local.page.screenshot({ path: path.join(OUT, target.key + '__1440-dark.png') });
          await local.ctx.close();
          continue;
        }
        await page.goto(STAGING + target.path);
        await page.waitForSelector('#main-content h1', { timeout: 20000 });
        await page.waitForTimeout(1200);
        report[target.key + '@1440-dark'] = await probe(page);
        await page.screenshot({ path: path.join(OUT, target.key + '__1440-dark.png') });
      } catch (cause) {
        report[target.key + '@1440-dark'] = { error: String(cause).slice(0, 200) };
      }
    }
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(report, null, 1));
  console.log('B1 captured: ' + Object.keys(report).length + ' surfaces');
  for (const [key, value] of Object.entries(report)) {
    const facts = value as Record<string, any>;
    if (facts.error) { console.log(key, 'ERROR', facts.error); continue; }
    console.log(key, JSON.stringify({ overflow: facts.overflow, h: facts.docHeight, panels: facts.boxed?.panel, small: facts.smallTextCount, rep: facts.repeatStatuses }));
  }
});
