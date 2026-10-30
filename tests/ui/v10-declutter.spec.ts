import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * V10: the two questions this run exists to answer, with one instrument on both sides of the
 * change so the before and the after are comparable.
 *
 *   1. /admin/plugins/{id} at 390 overflows horizontally. Why - and after the fix, is every
 *      chip still ON SCREEN (not merely "not overflowing", which a clip would also report).
 *   2. Does any OTHER page hide the same shape of overflow behind a clip? A page whose
 *      documentElement.scrollWidth equals its clientWidth has not proved that nothing is
 *      hidden: overflow:hidden and overflow-x:clip make that number true by deleting the
 *      evidence. So the scan below reads element scrollWidth, which a clip cannot touch.
 *
 * This host has no Playwright-managed Chromium (the browser download is not part of the repo);
 * the installed Chrome is a real engine. Same input as ui-table-audit.spec.ts.
 */
test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const MODE = process.env.V3_MODE === 'after' ? 'after' : 'before';
const OUT = process.env.V3_OUT || path.resolve('../../artifacts/ui/visual-v3/v10', MODE);
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5173';
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

type Row = Record<string, unknown>;
const report: Row = {};

fs.mkdirSync(OUT, { recursive: true });

async function login(page: Page) {
  await page.goto(BASE + '/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

async function ready(page: Page) {
  await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(350);
}

/**
 * The header, read as a reader reads it: the document overflow number, the reason it happens
 * (the meta row's own flex contract and its scrollWidth), and then every chip with its box and
 * the ancestor that would cut it. "No overflow" and "nothing lost" are two different claims and
 * only the second one is the requirement.
 */
const HEADER = () => {
  const de = document.documentElement;
  const meta = document.querySelector('.page-header-meta') as HTMLElement | null;
  const sub = document.querySelector('.page-header-sub') as HTMLElement | null;
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
  };
  const flexOf = (el: HTMLElement | null) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { display: cs.display, flex: cs.flex, flexWrap: cs.flexWrap, minWidth: cs.minWidth, overflowX: cs.overflowX, overflowY: cs.overflowY };
  };
  /**
   * Is this element's painted box cut by an ancestor that clips? Walk up; the first ancestor
   * whose overflow is not visible AND whose content box does not contain the element's box is
   * the clipper. This is the check that a scrollWidth comparison would miss, because a clip
   * makes the clipped area disappear from the scrollWidth of everything under it.
   */
  const clipperOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    let node: Element | null = el.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (clips) {
        const pr = node.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) {
          return { tag: node.tagName.toLowerCase(), cls: (node.className || '').toString().slice(0, 60), overflowX: cs.overflowX, nodeRight: Math.round(pr.right) };
        }
      }
      node = node.parentElement;
    }
    return null;
  };
  const chips = meta
    ? Array.from(meta.querySelectorAll('.meta-chip, .status-indicator, .value-token, [data-value]')) as HTMLElement[]
    : [];
  const chipsRead = chips.map((el) => {
    const r = box(el);
    return {
      cls: (el.className || '').toString().slice(0, 50),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      right: r.right,
      width: r.width,
      onScreen: r.left >= -1 && r.right <= de.clientWidth + 1,
      clippedBy: clipperOf(el),
    };
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docOverflow: de.scrollWidth - de.clientWidth,
    docScrollW: de.scrollWidth,
    docClientW: de.clientWidth,
    meta: meta ? { ...box(meta), scrollWidth: meta.scrollWidth, clientWidth: meta.clientWidth, overflowPx: meta.scrollWidth - meta.clientWidth, style: flexOf(meta) } : null,
    sub: sub ? { ...box(sub), style: flexOf(sub) } : null,
    detailMeta: (() => {
      const dm = document.querySelector('.detail-meta') as HTMLElement | null;
      return dm ? { ...box(dm), scrollWidth: dm.scrollWidth, clientWidth: dm.clientWidth, style: flexOf(dm) } : null;
    })(),
    chipCount: chipsRead.length,
    chips: chipsRead,
    chipsOnScreen: chipsRead.filter((c) => c.onScreen && !c.clippedBy).length,
    chipsAtRisk: chipsRead.filter((c) => !c.onScreen || c.clippedBy),
  };
};

/**
 * The masking scan: an element that clips (overflow hidden/clip) while its content is wider
 * than its box is holding back content that is not reachable by scrolling. A deliberate
 * ellipsis is reported separately - it has a textOverflow and a title carrying the full value,
 * which is a different contract from a naked clip.
 */
const MASKED = () => {
  const out: Row[] = [];
  const all = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
  for (const el of all) {
    const cs = getComputedStyle(el);
    const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    if (!clipsX && !clipsY) continue;
    const dx = el.scrollWidth - el.clientWidth;
    const dy = el.scrollHeight - el.clientHeight;
    const horizontal = clipsX && dx > 1;
    const vertical = clipsY && dy > 1 && cs.overflowY === 'clip';
    if (!horizontal && !vertical) continue;
    const title = el.getAttribute('title') || (el.querySelector('[title]') ? 'descendant' : null);
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 70),
      hiddenPx: horizontal ? dx : dy,
      axis: horizontal ? 'x' : 'y',
      overflowX: cs.overflowX,
      textOverflow: cs.textOverflow,
      hasTitle: Boolean(title),
      deliberateEllipsis: cs.textOverflow === 'ellipsis' && Boolean(title),
      childCount: el.children.length,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
    });
  }
  return { docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, candidates: out };
};

/** The card at 390: height, how many values it actually renders, and whether anything overlaps. */
const CARDS = () => {
  const rows = Array.from(document.querySelectorAll('table tbody tr')) as HTMLElement[];
  const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10);
  const pct = (list: number[], p: number) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((list.length * p) / 100))] : null);
  const rectOf = (el: Element) => el.getBoundingClientRect();
  const cards = rows.map((tr) => {
    const tds = Array.from(tr.querySelectorAll('td[data-label]')) as HTMLElement[];
    // Two counts, on purpose: the label count is what the page paints, the value count is what
    // the card actually carries. A layout that hides the label word may not reduce the second.
    const painted = tds.filter((td) => {
      const label = td.querySelector('span');
      return Boolean(label && label.getBoundingClientRect().width > 0);
    }).length;
    const values = tds.map((td) => {
      const body = td.querySelector('.ow-cell-body');
      const text = ((body ? body.textContent : td.textContent) || '').trim().replace(/\s+/g, ' ');
      return { label: td.getAttribute('data-label'), text, empty: text.length === 0, box: rectOf(td).width > 0 && rectOf(td).height > 0 };
    }).filter((v) => v.box);
    // Real 2-D overlap between flow cells: the check the strict-vertical rule could not make.
    const flow = (Array.from(tr.children) as HTMLElement[]).filter((el) => {
      if (el.tagName !== 'TD') return false;
      const cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    let pairs = 0;
    for (let i = 0; i < flow.length; i += 1) {
      for (let j = i + 1; j < flow.length; j += 1) {
        const a = rectOf(flow[i]);
        const b = rectOf(flow[j]);
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) pairs += 1;
      }
    }
    const lines = new Set(flow.map((el) => Math.round(rectOf(el).top))).size;
    return { height: Math.round(rectOf(tr).height * 10) / 10, paintedLabels: painted, valueCount: values.length, emptyValues: values.filter((v) => v.empty).length, values: values.map((v) => v.label + '=' + v.text.slice(0, 24)), overlapPairs: pairs, lines, flowCells: flow.length };
  });
  const visible = rows.filter((tr) => { const r = rectOf(tr); return r.top >= 0 && r.bottom <= window.innerHeight; }).length;
  return {
    rows: rows.length,
    p50: pct(heights, 50),
    p95: pct(heights, 95),
    max: heights.length ? Math.max(...heights) : null,
    fullCardsOnFirstScreen: visible,
    paintedLabels: cards.length ? cards[0].paintedLabels : 0,
    valueCounts: Array.from(new Set(cards.map((c) => c.valueCount))),
    emptyValues: cards.reduce((sum, c) => sum + c.emptyValues, 0),
    overlapPairs: cards.reduce((sum, c) => sum + c.overlapPairs, 0),
    lines: Array.from(new Set(cards.map((c) => c.lines))),
    firstCard: cards[0] || null,
  };
};

const ROUTES = [
  '/admin/overview',
  '/admin/jobs',
  '/admin/nodes',
  '/admin/plugins',
  '/admin/plugins/dev.opsweave.hello',
  '/admin/activity',
  '/admin/governance',
  '/admin/access',
  '/admin/settings/diagnostics',
];

for (const locale of ['en', 'zh-CN']) {
  const label = locale === 'en' ? 'en' : 'zh';

  test('header at 390 ' + label, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript((l) => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', l);
    }, locale);
    const page = await context.newPage();
    await login(page);
    await page.goto(BASE + '/admin/plugins/dev.opsweave.hello');
    await ready(page);
    const measured = await page.evaluate(HEADER);
    report['header-' + label] = measured;
    await page.screenshot({ path: path.join(OUT, 'plugin-detail-390-' + label + '-fold.png') });
    await page.screenshot({ path: path.join(OUT, 'plugin-detail-390-' + label + '.png'), fullPage: true });
    // The instrument must not report a header it did not find.
    expect(measured.chipCount, 'the detail header must render chips to measure').toBeGreaterThan(2);
    await context.close();
  });

  test('masking scan at 390 ' + label, async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript((l) => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', l);
    }, locale);
    const page = await context.newPage();
    await login(page);
    const pages: Row = {};
    for (const route of ROUTES) {
      await page.goto(BASE + route);
      await ready(page);
      pages[route] = { ...(await page.evaluate(MASKED)), cards: await page.evaluate(CARDS) };
      await page.screenshot({ path: path.join(OUT, 'scan-' + route.replace(/\//g, '_') + '-390-' + label + '.png'), fullPage: true });
    }
    report['scan-' + label] = pages;
    await context.close();
  });
}

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, '_declutter_' + MODE + '.json'), JSON.stringify({ mode: MODE, base: BASE, report }, null, 1) + '\n');
});
