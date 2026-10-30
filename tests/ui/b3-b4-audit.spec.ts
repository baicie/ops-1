
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B3 + B4 review harness: one run writes every number the brief asks for.
 *
 * Local source (vite dev on 5174) against the STAGING kernel, so the rows are the ones the
 * review measured (14 jobs / 1 node / 4 plugins) and no fixture stands between the code and
 * the number. Every probe is read-only: it measures the DOM, it does not click a verb.
 *
 *   B34_MODE=before pnpm --filter @opsweave/ui-tests exec playwright test b3-b4-audit
 *   B34_MODE=after  pnpm --filter @opsweave/ui-tests exec playwright test b3-b4-audit
 */

test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const MODE = process.env.B34_MODE === 'after' ? 'after' : 'before';
const OUT = path.resolve('../../artifacts/ui/visual-v3/b3b4', MODE);
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5174';
const EMAIL = 'admin@opsweave.local';
const PASSWORD = 'OpsWeave!2026';

const PLUGIN = 'dev.opsweave.hello';
const NODE = '9b426dab-27c4-45ce-9773-b51a3db4f246';
const JOB = 'e273620e-0580-449f-b7ee-e23e3f065b9e';
const PIPELINE = 'host-metrics-pipeline';

type Target = { name: string; path: string; vp: number[] };

const TARGETS: Target[] = [
  { name: 'jobs', path: '/admin/jobs', vp: [390, 1440] },
  { name: 'nodes', path: '/admin/nodes', vp: [390, 1440] },
  { name: 'plugins', path: '/admin/plugins', vp: [390, 1440] },
  { name: 'activity', path: '/admin/activity', vp: [390, 1440] },
  { name: 'access', path: '/admin/access', vp: [1440] },
  { name: 'governance', path: '/admin/governance', vp: [1440] },
  { name: 'overview', path: '/admin/overview', vp: [1440] },
  { name: 'job-detail', path: '/admin/jobs/' + JOB, vp: [390, 1440] },
  { name: 'plugin-detail', path: '/admin/plugins/' + PLUGIN, vp: [1440] },
  { name: 'node-detail', path: '/admin/nodes/' + NODE, vp: [1440] },
  { name: 'studio', path: '/admin/pipelines/' + PIPELINE + '/editor', vp: [1280, 1440] },
];

async function signIn(page: Page) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

/** Every character box of a line, so "the menu covers the text" becomes a number. */
function probe(page: Page) {
  return page.evaluate(() => {
    type Box = { left: number; right: number; top: number; bottom: number };
    const union = (boxes: Box[]) => {
      if (!boxes.length) return null;
      const left = Math.min(...boxes.map((b) => b.left));
      const right = Math.max(...boxes.map((b) => b.right));
      const top = Math.min(...boxes.map((b) => b.top));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      return { left, right, top, bottom, width: right - left, height: bottom - top };
    };
    const inter = (a: Box | null, b: Box | null) => {
      if (!a || !b) return { w: 0, h: 0 };
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
    };
    const charBoxes = (root: Element) => {
      const out: Box[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent || '';
        for (let i = 0; i < text.length; i += 1) {
          if (!text[i].trim()) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.2 && r.height > 0.2);
          for (const r of rects) out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        }
        node = walker.nextNode();
      }
      return out;
    };
    const box = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };

    const de = document.documentElement;
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
    const headerParent = header?.parentElement || null;
    let firstBlockY: number | null = null;
    if (headerParent) {
      const siblings = Array.from(headerParent.children) as HTMLElement[];
      const at = siblings.indexOf(header as HTMLElement);
      const next = at >= 0 ? siblings[at + 1] : null;
      if (next) firstBlockY = Math.round(next.getBoundingClientRect().top * 10) / 10;
    }

    const h1 = document.querySelector('[data-testid=page-header] h1') as HTMLElement | null;
    const actions = document.querySelector('[data-testid=page-header] .page-actions') as HTMLElement | null;
    const headerInfo = {
      height: header ? Math.round(header.getBoundingClientRect().height * 10) / 10 : null,
      title: h1?.innerText || null,
      titleCentre: h1 ? Math.round((h1.getBoundingClientRect().top + h1.getBoundingClientRect().height / 2) * 10) / 10 : null,
      actionCentre: actions ? Math.round((actions.getBoundingClientRect().top + actions.getBoundingClientRect().height / 2) * 10) / 10 : null,
      eyebrow: !!document.querySelector('[data-testid=page-header] .eyebrow'),
      descriptionLines: (() => {
        const p = document.querySelector('[data-testid=page-header] .page-description') as HTMLElement | null;
        if (!p) return 0;
        const range = document.createRange();
        range.selectNodeContents(p);
        return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
      })(),
      metaRows: document.querySelectorAll('[data-testid=page-header] .page-header-meta').length,
    };

    const rows = Array.from(document.querySelectorAll('table tbody tr')) as HTMLTableRowElement[];
    const rowProbe = rows.slice(0, 40).map((tr) => {
      const menu = tr.querySelector('[data-testid=row-actions]') as HTMLElement | null;
      const menuBox = box(menu);
      const qualifier = tr.querySelector('.ow-ident-meta') as HTMLElement | null;
      const ident = tr.querySelector('.ow-ident') as HTMLElement | null;
      const qChars = qualifier ? charBoxes(qualifier) : [];
      const iChars = ident ? charBoxes(ident) : [];
      const qBox = box(qualifier);
      const under = (chars: Box[]) => chars.filter((c) => menuBox && c.right > menuBox.left + 0.5 && c.left < menuBox.right - 0.5 && c.bottom > menuBox.top + 0.5 && c.top < menuBox.bottom - 0.5).length;
      const clear = (chars: Box[], own: Box | null) => chars.filter((c) => (!menuBox || c.right <= menuBox.left + 0.5) && (!own || c.right <= own.right + 0.5)).length;
      const rowBox = box(tr);
      const cell = tr.querySelector('td.ow-ident-cell') as HTMLElement | null;
      return {
        height: Math.round(tr.getBoundingClientRect().height * 10) / 10,
        row: rowBox ? { top: Math.round(rowBox.top), left: Math.round(rowBox.left), right: Math.round(rowBox.right) } : null,
        identBox: ident ? { top: Math.round(ident.getBoundingClientRect().top), right: Math.round(ident.getBoundingClientRect().right), height: Math.round(ident.getBoundingClientRect().height * 10) / 10 } : null,
        qualifierBox: qualifier ? { top: Math.round(qualifier.getBoundingClientRect().top), right: Math.round(qualifier.getBoundingClientRect().right), height: Math.round(qualifier.getBoundingClientRect().height * 10) / 10 } : null,
        cellBox: cell ? { left: Math.round(cell.getBoundingClientRect().left), right: Math.round(cell.getBoundingClientRect().right) } : null,
        identBoxOverlap: inter(box(ident), menuBox),
        qualifierBoxOverlap: inter(box(qualifier), menuBox),
        menu: menuBox ? { left: Math.round(menuBox.left), right: Math.round(menuBox.right), top: Math.round(menuBox.top), height: Math.round(menuBox.height) } : null,
        qualifierText: (qualifier?.innerText || '').replace(/\s+/g, ' ').trim(),
        qualifierChars: qChars.length,
        qualifierUnderMenu: under(qChars),
        qualifierClear: clear(qChars, qBox),
        qualifierOverlap: inter(union(qChars), menuBox),
        identText: (ident?.innerText || '').replace(/\s+/g, ' ').trim(),
        identUnderMenu: under(iChars),
        identOverlap: inter(union(iChars), menuBox),
        qualifierFont: qualifier ? getComputedStyle(qualifier).fontSize : null,
        qualifierChildFont: qualifier ? Array.from(qualifier.querySelectorAll('span')).map((s) => getComputedStyle(s).fontSize) : [],
        tailColor: (() => {
          const tail = tr.querySelector('.ow-ident-tail') as HTMLElement | null;
          const name = tr.querySelector('.ow-ident-name') as HTMLElement | null;
          return { tail: tail ? getComputedStyle(tail).color : null, name: name ? getComputedStyle(name).color : null };
        })(),
        tags: tr.querySelectorAll('.tag').length,
        pills: tr.querySelectorAll('.status').length,
      };
    });

    const heights = rows.map((tr) => tr.getBoundingClientRect().height).sort((a, b) => a - b);
    const pct = (p: number) => (heights.length ? Math.round(heights[Math.min(heights.length - 1, Math.floor(p * heights.length))] * 10) / 10 : null);

    const tables = Array.from(document.querySelectorAll('table'));
    const columnLabels = tables.map((table) => Array.from(table.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim()));
    const headerCells = tables.map((table) => table.querySelectorAll('thead th').length);
    const bodyCells = tables.map((table) => {
      const first = table.querySelector('tbody tr');
      return first ? first.children.length : 0;
    });

    const breadcrumb = document.querySelector('.admin-breadcrumb') as HTMLElement | null;
    const crumbTexts = breadcrumb ? Array.from(breadcrumb.querySelectorAll('li')).map((li) => (li as HTMLElement).innerText.trim()) : [];
    const crumbClipped = breadcrumb ? Array.from(breadcrumb.querySelectorAll('li, a, span')).some((el) => el.scrollWidth > el.clientWidth + 1) : false;

    const svgCharts = Array.from(document.querySelectorAll('.main-content svg')).filter((s) => s.closest('.panel, section') && s.getAttribute('role') === 'img');
    const chartText = svgCharts.map((s) => Array.from(s.querySelectorAll('text')).map((t) => t.textContent));

    const metricCards = Array.from(document.querySelectorAll('.metric-card')).map((card) => ({
      label: (card.querySelector('.metric-label')?.textContent || '').trim(),
      value: (card.querySelector('.metric-value')?.textContent || '').trim(),
    }));

    const sidebarMeta = document.querySelector('.sidebar-meta-block') as HTMLElement | null;
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const sidebarInfo = {
      width: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
      hasMetaBlock: !!sidebarMeta,
      blockVisible: sidebarMeta ? sidebarMeta.getBoundingClientRect().height > 0 : false,
      fields: sidebarMeta ? Array.from(sidebarMeta.querySelectorAll('[data-version-field]')).map((field) => {
        const el = field as HTMLElement;
        const value = el.querySelector('strong');
        const r = el.getBoundingClientRect();
        const sr = sidebar ? sidebar.getBoundingClientRect() : null;
        return {
          field: el.getAttribute('data-version-field'),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          clipped: el.scrollWidth > el.clientWidth + 1,
          clippedByRail: sr ? (r.right > sr.right + 0.5 || r.left < sr.left - 0.5) : false,
          valueWidth: value ? Math.round(value.getBoundingClientRect().width) : 0,
        };
      }) : [],
    };

    // B4.3 - the studio's saved-draft strip.
    const draftButtons = Array.from(document.querySelectorAll('.draft-row button')) as HTMLElement[];
    const draftSection = document.querySelector('.studio-drafts') as HTMLElement | null;
    const drafts = {
      count: draftButtons.length,
      sectionHeight: draftSection ? Math.round(draftSection.getBoundingClientRect().height) : null,
      sectionTop: draftSection ? Math.round(draftSection.getBoundingClientRect().top) : null,
      inFirstScreen: draftSection ? draftSection.getBoundingClientRect().top < window.innerHeight : false,
      texts: draftButtons.slice(0, 4).map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
      widths: draftButtons.slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().width)),
      versionAligned: draftButtons.length > 0,
    };

    // B4.2 - does the history chart carry any ink that states a scale?
    const charts = Array.from(document.querySelectorAll('.main-content svg[role=img]')).map((svg) => ({
      label: svg.getAttribute('aria-label'),
      viewBox: svg.getAttribute('viewBox'),
      height: Math.round(svg.getBoundingClientRect().height),
      texts: Array.from(svg.querySelectorAll('text')).map((t) => (t.textContent || '').trim()),
      axisLines: svg.querySelectorAll('line, .chart-axis, .tick').length,
      paths: svg.querySelectorAll('path').length,
    }));

    // B4.1 - table header against its first row, and any panel body that is mostly empty.
    const tableStack = Array.from(document.querySelectorAll('.main-content table')).map((table) => {
      const head = table.querySelector('thead') as HTMLElement | null;
      const firstRow = table.querySelector('tbody tr') as HTMLElement | null;
      const panel = table.closest('.panel') as HTMLElement | null;
      const heading = panel?.querySelector('h2, h3')?.textContent?.trim() || null;
      const headRect = head?.getBoundingClientRect();
      const rowRect = firstRow?.getBoundingClientRect();
      const scroller = table.parentElement as HTMLElement | null;
      return {
        heading,
        headHeight: headRect ? Math.round(headRect.height) : null,
        firstRowHeight: rowRect ? Math.round(rowRect.height) : null,
        squeeze: headRect && rowRect ? Math.round((headRect.bottom - rowRect.top) * 10) / 10 : null,
        scrollerHeight: scroller ? Math.round(scroller.getBoundingClientRect().height) : null,
        tableWidth: Math.round(table.getBoundingClientRect().width),
        scrollerScrollW: scroller ? scroller.scrollWidth : null,
        scrollerClientW: scroller ? scroller.clientWidth : null,
        panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      };
    });

    // B4.5/B4.7 - is one string printed twice inside one screen?
    const h1Text = (document.querySelector('[data-testid=page-header] h1')?.textContent || '').trim();
    const duplicateHits = h1Text ? {
      h1: h1Text,
      countOnPage: (document.body.innerText.split(h1Text).length - 1),
      cards: Array.from(document.querySelectorAll('.metric-card, .ow-metric, .panel-head')).map((el) => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        top: Math.round(el.getBoundingClientRect().top),
      })).filter((c) => c.text.includes(h1Text)),
    } : null;

    const nav = document.querySelector('.admin-breadcrumb') as HTMLElement | null;
    const crumbClip = nav ? {
      navScrollW: nav.scrollWidth,
      navClientW: nav.clientWidth,
      items: Array.from(nav.querySelectorAll('li')).map((li) => ({
        text: (li as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
        clientW: (li as HTMLElement).clientWidth,
        scrollW: (li as HTMLElement).scrollWidth,
        title: (li.querySelector('[title]') as HTMLElement | null)?.getAttribute('title') || null,
      })),
    } : null;

    const text = document.body.innerText.replace(/\s+/g, ' ');
    const count = (needle: string) => text.split(needle).length - 1;

    return {
      url: location.pathname,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      lang: document.documentElement.lang,
      storedLocale: (() => { try { return window.localStorage.getItem('opsweave-locale'); } catch { return 'unavailable'; } })(),
      overflow: de.scrollWidth - de.clientWidth,
      docScrollW: de.scrollWidth,
      docClientW: de.clientWidth,
      header: headerInfo,
      firstBlockY,
      rows: rows.length,
      rowHeights: { p50: pct(0.5), p95: pct(0.95), max: heights.length ? Math.round(heights[heights.length - 1] * 10) / 10 : null },
      rowProbe,
      columnLabels,
      headerCells,
      bodyCells,
      identityKeys: Array.from(document.querySelectorAll('[data-identity-key]')).map((el) => el.getAttribute('data-identity-key')),
      breadcrumb: { texts: crumbTexts, clipped: crumbClipped, width: breadcrumb ? Math.round(breadcrumb.getBoundingClientRect().width) : null },
      chart: { count: svgCharts.length, text: chartText, labels: svgCharts.map((s) => s.getAttribute('aria-label')) },
      metricCards,
      sidebar: sidebarInfo,
      drafts,
      charts,
      tableStack,
      duplicateHits,
      crumbClip,
      tagCount: document.querySelectorAll('tbody .tag').length,
      pillCount: document.querySelectorAll('tbody .status').length,
      repeats: {
        platformReady: count('Platform ready'),
        ready: count('READY'),
        platformIsReady: count('Platform is ready'),
      },
    };
  });
}

test('b3-b4 audit', async ({ page }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(OUT, { recursive: true });
  await page.context().clearCookies();
  // The product default is zh-CN; this audit compares against the review's English numbers, so
  // the locale is pinned before the app boots on every navigation.
  await page.addInitScript(() => {
    try { window.localStorage.setItem('opsweave-locale', 'en'); } catch { /* storage blocked */ }
  });
  await signIn(page);
  const results: Record<string, unknown> = {};
  for (const target of TARGETS) {
    for (const width of target.vp) {
      const key = target.name + '@' + width;
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(BASE + target.path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2200);
      try {
        results[key] = await probe(page);
      } catch (cause) {
        results[key] = { error: String(cause) };
      }
      await page.screenshot({ path: path.join(OUT, key + '.png'), fullPage: true });
    }
  }
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(results, null, 1));
  expect(Object.keys(results).length).toBeGreaterThan(0);
});
