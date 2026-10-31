import { test, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B5 defect probe: the second instrument.
 *
 * The matrix measures a page as a whole; this one measures the handful of element pairs the eye
 * flagged, so a claim like "the studio action row is behind the drafts panel" arrives as a rect,
 * a stacking result (elementFromPoint) and a gap in pixels rather than as an adjective.
 */
test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const OUT = process.env.B5_OUT || '/tmp/opsweave-b5/probe';
const BASE = process.env.OPSWEAVE_URL || 'http://82.156.234.84:3000';
const EMAIL = 'admin@opsweave.local';
const PASSWORD = 'OpsWeave!2026';
const ORIGIN = new URL(BASE).origin;
const JOB = 'e273620e-0580-449f-b7ee-e23e3f065b9e';
const NODE = '9b426dab-27c4-45ce-9773-b51a3db4f246';
const PLUGIN = 'dev.opsweave.hello';
const PIPELINE = 'host-metrics-pipeline';

const viewports = (process.env.B5_PROBE_VP || '1440').split(',').map(Number);
const results: any[] = [];

async function signIn(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  const state = await ctx.storageState();
  await ctx.close();
  state.origins = [{ origin: ORIGIN, localStorage: [{ name: 'opsweave-locale', value: 'en' }, { name: 'opsweave-theme', value: 'light' }] }];
  return state;
}

/** Generic collectors, evaluated per page. */
const collectors = {
  /** Rect + stacking answer for one element and each of its descendants matching a selector. */
  rects: (args: { sel: string; child?: string }) => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height),
        right: Math.round(r.right), bottom: Math.round(r.bottom + window.scrollY),
        display: cs.display, position: cs.position, zIndex: cs.zIndex, overflow: cs.overflow,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48),
      };
    };
    const host = document.querySelector(args.sel);
    const kids = args.child ? Array.from(document.querySelectorAll(args.child)) : [];
    const hostBox = box(host);
    const hits = kids.slice(0, 14).map((kid) => {
      const r = kid.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return { ...box(kid), topAtCenter: top ? (top.getAttribute('data-testid') || top.tagName.toLowerCase() + '.' + (top.getAttribute('class') || '').split(' ').slice(0, 2).join('.')) : null, covered: Boolean(top && !kid.contains(top) && !top.contains(kid)) };
    });
    return { host: hostBox, kids: hits };
  },
  /** Horizontal whitespace at the end of a row container: how much of the row the last child leaves empty. */
  rowFill: (args: { rowSel: string; childSel: string }) => {
    const row = document.querySelector(args.rowSel);
    if (!row) return null;
    const rr = row.getBoundingClientRect();
    const kids = Array.from(row.querySelectorAll(args.childSel));
    const last = kids[kids.length - 1];
    const lr = last ? last.getBoundingClientRect() : null;
    return { row: { x: Math.round(rr.left), right: Math.round(rr.right), w: Math.round(rr.width) }, count: kids.length, lastRight: lr ? Math.round(lr.right) : null, slack: lr ? Math.round(rr.right - lr.right) : null };
  },
  /** Table header census: how many header cells carry no text, and how wide each is. */
  tableHead: () => {
    return Array.from(document.querySelectorAll('table')).map((table, index) => {
      const ths = Array.from(table.querySelectorAll('thead th'));
      return {
        index,
        cols: ths.length,
        headers: ths.map((th) => {
          const r = th.getBoundingClientRect();
          return { text: (th.textContent || '').replace(/\s+/g, ' ').trim(), w: Math.round(r.width), x: Math.round(r.left) };
        }),
        unlabeled: ths.filter((th) => !(th.textContent || '').trim() && !th.querySelector('input,svg,button')).map((th) => Math.round(th.getBoundingClientRect().width)),
        rows: table.querySelectorAll('tbody tr').length,
      };
    });
  },
  /** Text clipping: does the lede fit, and by how much does it not. */
  description: () => {
    const el = document.querySelector('.page-description') as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { text: (el.textContent || '').trim(), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, clippedBy: el.scrollWidth - el.clientWidth, whiteSpace: cs.whiteSpace, maxWidth: cs.maxWidth, fontSize: cs.fontSize };
  },
  /** Gap between two adjacent inline elements, in CSS px. */
  gap: (args: { a: string; b: string }) => {
    const A = document.querySelector(args.a);
    const B = document.querySelector(args.b);
    if (!A || !B) return null;
    const ra = A.getBoundingClientRect();
    const rb = B.getBoundingClientRect();
    return { a: { text: (A.textContent || '').trim().slice(0, 24), x: Math.round(ra.left), right: Math.round(ra.right) }, b: { text: (B.textContent || '').trim().slice(0, 24), x: Math.round(rb.left), right: Math.round(rb.right) }, gapPx: Math.round((rb.left - ra.right) * 10) / 10 };
  },
  /** First row of a table: the cells' text and their x positions, to expose a dead column. */
  firstRow: () => {
    const tds = Array.from(document.querySelectorAll('table tbody tr:first-child td'));
    return tds.map((td) => { const r = td.getBoundingClientRect(); return { text: (td.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30), x: Math.round(r.left), w: Math.round(r.width) }; });
  },
  /** Cards in a grid: their widths and the grid's own width, to expose a row that does not fill. */
  gridFill: (args: { gridSel: string }) => {
    const grid = document.querySelector(args.gridSel);
    if (!grid) return null;
    const gr = grid.getBoundingClientRect();
    const kids = Array.from(grid.children).map((k) => { const r = k.getBoundingClientRect(); return { x: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; });
    const parent = grid.parentElement;
    const pr = parent ? parent.getBoundingClientRect() : null;
    return { grid: { x: Math.round(gr.left), right: Math.round(gr.right) }, parentRight: pr ? Math.round(pr.right) : null, kids };
  },
};

async function run(page: any, route: string, label: string, probes: Array<{ name: string; fn: string; args?: any }>) {
  const row: any = { route, label };
  try {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    for (const p of probes) {
      try {
        row[p.name] = await page.evaluate(collectors[p.fn as keyof typeof collectors] as any, p.args || {});
      } catch (err: any) {
        row[p.name] = { error: String(err && err.message ? err.message : err).slice(0, 120) };
      }
    }
  } catch (err: any) {
    row.error = String(err && err.message ? err.message : err).slice(0, 160);
  }
  results.push(row);
}

test('b5 probe', async ({ browser }) => {
  test.setTimeout(20 * 60 * 1000);
  fs.mkdirSync(OUT, { recursive: true });
  const state = await signIn(browser);
  const probes = [
    {
      route: '/admin/pipelines/' + PIPELINE + '/editor',
      label: 'studio-header-actions',
      probes: [
        // The nine studio controls left .page-header for the toolbar row between header and
        // content (page-template §2.1). Reading '.page-actions > *' here returned nothing at all,
        // so the probe reported a page with no controls instead of a page whose controls moved.
        { name: 'toolbar', fn: 'rects', args: { sel: '.studio-toolbar', child: '.studio-toolbar > *' } },
        { name: 'header', fn: 'rects', args: { sel: '.page-header', child: '.page-header-meta > *' } },
        { name: 'drafts', fn: 'rects', args: { sel: '.studio-drafts', child: '.studio-drafts > strong, .draft-row > *' } },
        { name: 'draftRow', fn: 'rowFill', args: { rowSel: '.draft-row', childSel: '*' } },
        { name: 'description', fn: 'description' },
      ],
    },
    {
      route: '/admin/nodes',
      label: 'nodes-instances-cell',
      probes: [
        { name: 'instancesGap', fn: 'gap', args: { a: 'table tbody tr td:nth-child(3) strong', b: 'table tbody tr td:nth-child(3) .ow-cell-meta' } },
        { name: 'tableHead', fn: 'tableHead' },
      ],
    },
    {
      route: '/admin/jobs',
      label: 'jobs-table',
      probes: [
        { name: 'tableHead', fn: 'tableHead' },
        { name: 'firstRow', fn: 'firstRow' },
        { name: 'description', fn: 'description' },
      ],
    },
    {
      route: '/admin/governance',
      label: 'governance-table',
      probes: [
        { name: 'tableHead', fn: 'tableHead' },
        { name: 'firstRow', fn: 'firstRow' },
      ],
    },
    {
      route: '/admin/pipelines',
      label: 'pipelines-table',
      probes: [
        { name: 'tableHead', fn: 'tableHead' },
        { name: 'firstRow', fn: 'firstRow' },
        { name: 'description', fn: 'description' },
      ],
    },
    {
      route: '/admin/jobs/' + JOB,
      label: 'job-detail-kpi',
      probes: [
        { name: 'kpi', fn: 'gridFill', args: { gridSel: '.stat-strip, .ow-summary' } },
        { name: 'description', fn: 'description' },
      ],
    },
    {
      route: '/admin/overview',
      label: 'overview-kpi',
      probes: [{ name: 'kpi', fn: 'gridFill', args: { gridSel: '.stat-strip, .ow-summary' } }],
    },
    {
      route: '/403',
      label: 'forbidden',
      probes: [{ name: 'description', fn: 'description' }],
    },
    {
      route: '/app/home',
      label: 'business',
      probes: [{ name: 'description', fn: 'description' }],
    },
    {
      route: '/admin/plugins',
      label: 'plugins-table',
      probes: [{ name: 'tableHead', fn: 'tableHead' }],
    },
    {
      route: '/admin/access',
      label: 'access',
      probes: [{ name: 'tableHead', fn: 'tableHead' }],
    },
    {
      route: '/admin/activity',
      label: 'activity',
      probes: [{ name: 'tableHead', fn: 'tableHead' }, { name: 'description', fn: 'description' }],
    },
  ];

  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp, height: vp === 390 ? 844 : vp === 1024 ? 768 : 900 }, storageState: state });
    await ctx.addInitScript(() => window.localStorage.setItem('opsweave-locale', 'en'));
    const page = await ctx.newPage();
    for (const target of probes) await run(page, target.route, target.label + '@' + vp, target.probes);
    await ctx.close();
  }
  fs.writeFileSync(path.join(OUT, '_probe.json'), JSON.stringify(results, null, 1));
});
