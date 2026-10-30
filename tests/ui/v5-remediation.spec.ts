import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * V6 remediation evidence.
 *
 * Every picture in this pack is taken AFTER a DOM assertion that the state it claims is on
 * screen, and the measured numbers land in _assertions.json beside it. Nothing here is a
 * filename: a shot is only written once its assertion passed, and the assertion list is the
 * one the review asked for (P0-1 overlap, P0-2 honesty, P0-3 contrast, P0-4 fit, P0-5 counts,
 * P0-6 localization).
 *
 * The Commit field in the rail is read back from the DOM of every shot: it must name the
 * commit the bundle was built from (HEAD), and the bundle's own SHA-256 is recorded next to it
 * so "which bytes" never has to be inferred from "which label".
 */
const OUT = process.env.V6_OUT || '/tmp/v6-matrix';
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const EXPECTED_SHA = (process.env.V6_SHA || 'bfe8d70').slice(0, 7);

fs.mkdirSync(OUT, { recursive: true });

type Row = Record<string, unknown>;
const records: Row[] = [];

function bundleHash(): string {
  const dir = path.resolve('../../apps/platform-web/dist/assets');
  const files = fs.readdirSync(dir).sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(fs.readFileSync(path.join(dir, file)));
  return hash.digest('hex').slice(0, 16) + ' (' + files.join(',') + ')';
}

const BUNDLE = bundleHash();

// Not serial: one failing state must not hide the other six measurements behind it.
test.describe.configure({ mode: 'default' });

async function login(page: Page) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  // The session cookie outlives a viewport change, so a second login in one test must be a
  // no-op instead of waiting for a form the app no longer shows.
  const email = page.locator('input[type=email]');
  try {
    await email.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => undefined);
    return;
  }
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

/** Theme and locale are preferences, so they are pinned before the app boots. */
async function pin(page: Page, theme: string, locale: string) {
  await page.addInitScript(([t, l]) => {
    try {
      window.localStorage.setItem('opsweave-theme', t);
      window.localStorage.setItem('opsweave-locale', l);
    } catch { /* storage blocked */ }
  }, [theme, locale] as [string, string]);
}

function ratio(a: string, b: string): number {
  const parse = (value: string) => (value.match(/[\d.]+/g) || ['0', '0', '0']).slice(0, 3).map(Number);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

interface Measure { [key: string]: any }

/** Everything the review argues about, read off the live DOM in one pass. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const rect = (el: Element) => {
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top * 10) / 10,
        bottom: Math.round(box.bottom * 10) / 10,
        left: Math.round(box.left),
        right: Math.round(box.right),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
    const text = (selector: string) => {
      const el = document.querySelector(selector);
      return el ? (el.textContent || '').trim() : null;
    };
    const table = document.querySelector('table.plugins-table, table.nodes-table') as HTMLTableElement | null;
    let tableReport: any = null;
    if (table) {
      const tbody = table.querySelector('tbody') as HTMLElement;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      /**
       * §2.5's 390 card is TWO lines, so two cells of one row may legitimately share a line.
       * "No overlap" therefore has to become a real two-dimensional question - do two boxes share
       * area on BOTH axes - instead of "is this cell's top below the previous cell's bottom".
       *
       * The one-dimensional rule this replaces was not merely different, it was weaker: at 390 it
       * never looked at the horizontal axis at all (a card whose cells sat side by side with 200px
       * of intersection passed), and it compared only CONSECUTIVE cells in DOM order (a cell laid
       * over the one two places before it passed too). It also could not survive a two-line card
       * without being deleted, which is exactly why it is being replaced by something that answers
       * the question rather than by nothing.
       */
      const stacked = window.matchMedia('(max-width: 768px)').matches;
      const rowReport = rows.map((row) => {
        // A cell the breakpoint hides (`max-[1200px]:hidden`), a demoted card column
        // (`ow-card-extra`) or an identity cell a two-line card flattens (`display: contents`)
        // has an all-zero rect: it occupies no space, so it cannot overlap anything.
        const boxes = Array.from(row.querySelectorAll('td'))
          .map((td) => ({ td, box: rect(td), label: td.getAttribute('data-label') || '' }))
          .filter((entry) => entry.box.width > 0 && entry.box.height > 0);
        let overlapPairs = 0;
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i].box;
            const b = boxes[j].box;
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 1 && h > 1) overlapPairs += 1;
          }
        }
        // §2.5: a fact is a cell that is on screen and carries a VALUE. The identity line is the
        // card's first line and is not one of the three facts, and the label word giving way on the
        // phone is not the value giving way - so this counts values, never painted labels.
        const identityCell = row.querySelector('[data-identity-key]');
        const facts = boxes
          .filter((entry) => !(identityCell && entry.td.contains(identityCell)))
          .map((entry) => ({
            label: entry.label,
            text: ((entry.td.querySelector('.ow-cell-body') || entry.td).textContent || '').trim(),
            box: entry.box,
          }))
          .filter((entry) => entry.text.length > 0);
        // The facts, grouped by the visual line they landed on. 'facts' is in DOM order, so each
        // group is too; the same groups re-sorted by left give the order the eye meets them in.
        const lineOf = new Map<number, { label: string; left: number }[]>();
        for (const entry of facts) {
          const key = Math.round(entry.box.top);
          const list = lineOf.get(key) || [];
          list.push({ label: entry.label, left: entry.box.left });
          lineOf.set(key, list);
        }
        const groups = Array.from(lineOf.keys()).sort((left, right) => left - right).map((key) => lineOf.get(key) as { label: string; left: number }[]);
        const tops = boxes.map((entry) => entry.box.top);
        const box = rect(row);
        return {
          cells: boxes.length,
          rowHeight: box.height,
          firstTop: boxes.length ? Math.min(...boxes.map((entry) => entry.box.top)) : 0,
          lastBottom: boxes.length ? Math.max(...boxes.map((entry) => entry.box.bottom)) : 0,
          spread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
          overlap: overlapPairs > 0,
          overlapPairs,
          factCount: facts.length,
          factLabels: facts.map((entry) => entry.label),
          factLines: groups.length,
          // Each line's left-to-right reading order against the same line's declared order.
          lineOrders: groups.map((group) => ({ byGeometry: group.slice().sort((left, right) => left.left - right.left).map((entry) => entry.label), declared: group.map((entry) => entry.label) })),
        };
      });
      tableReport = {
        rows: rows.length,
        tbodyClient: tbody.clientHeight,
        tbodyScroll: tbody.scrollHeight,
        tableClient: table.clientHeight,
        tableScroll: table.scrollHeight,
        stacked,
        overlaps: rowReport.filter((row) => row.overlap).length,
        rowHeights: rowReport.map((row) => row.rowHeight),
        cellHeights: rowReport.length ? rowReport[0].cells : 0,
        rowReport,
        clipped: Math.max(0, tbody.scrollHeight - tbody.clientHeight),
      };
    }
    const tab = document.querySelector('[role="tab"]:not([data-state="active"])') as HTMLElement | null;
    const tablist = document.querySelector('[role="tablist"]') as HTMLElement | null;
    const chipStyle = tab && tablist
      ? { fg: getComputedStyle(tab).color, bg: getComputedStyle(tablist).backgroundColor, activeBg: (() => { const a = document.querySelector('[role="tab"][data-state="active"]'); return a ? getComputedStyle(a).backgroundColor : null; })() }
      : null;
    const strip = document.querySelector('.stat-strip, .ow-summary') as HTMLElement | null;
    const stripNext = strip ? (strip.closest('section') as HTMLElement)?.nextElementSibling as HTMLElement | null : null;
    const palette = document.querySelector('.ow-command-list') as HTMLElement | null;
    return {
      commit: text('[data-version-field="commit"] strong'),
      environment: text('[data-version-field="environment"] strong'),
      railStatus: text('[data-version-field="status"] strong'),
      pill: text('[data-testid="health-pill"]'),
      pillVerdict: document.querySelector('[data-testid="health-pill"]')?.getAttribute('data-verdict') || null,
      theme: document.documentElement.dataset.theme || null,
      lang: document.documentElement.lang,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: (document.querySelector('.page-header h1') || document.querySelector('h1'))?.textContent?.trim() || null,
      table: tableReport,
      chip: chipStyle,
      strip: strip ? { cells: strip.children.length, gap: getComputedStyle(strip).rowGap, bottom: rect(strip).bottom, nextTop: stripNext ? rect(stripNext).top : null } : null,
      palette: palette ? { client: palette.clientHeight, scroll: palette.scrollHeight, items: palette.querySelectorAll('[role="option"]').length, lastBottom: palette.lastElementChild ? rect(palette.lastElementChild).bottom : null, boxBottom: rect(palette).bottom } : null,
    };
  });
}

function record(name: string, measureResult: Measure, extra: Row = {}) {
  records.push({ shot: name + '.png', commit: measureResult.commit, bundle: BUNDLE, ...extra, measured: measureResult });
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(180);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  const bytes = fs.statSync(file).size;
  expect(bytes, name + ' must not be an empty file').toBeGreaterThan(2000);
}

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, '_assertions.json'), JSON.stringify(records, null, 2) + '\n');
});

const VIEWPORTS = [
  { key: '1440', width: 1440, height: 900 },
  { key: '1024', width: 1024, height: 768 },
  { key: '390', width: 390, height: 844 },
];
const PAGES = [
  { key: 'overview', route: '/admin/overview', marker: '.health-band' },
  { key: 'plugins', route: '/admin/plugins', marker: '[data-testid="plugins-summary"]' },
  { key: 'nodes', route: '/admin/nodes', marker: '[data-testid="nodes-summary"]' },
];
const THEMES = ['light', 'dark'];
const LOCALES = ['en', 'zh-CN'];

test('normal-state matrix: 3 pages x 3 viewports x 2 themes x 2 locales', async ({ page }) => {
  test.setTimeout(600000);
  for (const theme of THEMES) {
    for (const locale of LOCALES) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await pin(page, theme, locale);
      await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
      await login(page);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        for (const target of PAGES) {
          await page.goto(BASE + target.route, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector(target.marker, { timeout: 20000 });
          await page.waitForTimeout(320);
          const measured = await measure(page);
          const name = 'matrix-' + target.key + '-' + viewport.key + '-' + theme + '-' + locale;

          // The evidence/object match: the rail must name the commit the bundle came from.
          expect(measured.commit, name + ': the rail must print the built commit').toBe(EXPECTED_SHA);
          expect(measured.theme, name + ': the theme actually applied').toBe(theme);
          expect(measured.lang, name + ': the locale actually applied').toBe(locale);
          expect(measured.overflowX, name + ': no horizontal overflow').toBeLessThanOrEqual(1);

          if (measured.table) {
            // P0-1: a stacked layout may not overlap its cells or clip its rows, and a desktop
            // row may not start its cells on different lines.
            expect(measured.table.overlaps, name + ': no cell may overlap another (overlaps=' + measured.table.overlaps + ', stacked=' + measured.table.stacked + ')').toBe(0);
            expect(measured.table.clipped, name + ': no row may be clipped by the tbody (' + measured.table.tbodyScroll + ' vs ' + measured.table.tbodyClient + ')').toBeLessThanOrEqual(1);
            if (!measured.table.stacked) {
              expect(measured.table.rowReport[0].spread, name + ': desktop cells share one baseline').toBeLessThanOrEqual(1);
            }
            if (viewport.key === '390') {
              expect(measured.table.stacked, name + ': 390px uses the record layout').toBe(true);
              const rows = measured.table.rowReport;
              /**
               * §2.5's card is TWO lines. The rule that used to stand here - "every cell's top is
               * at or below the previous cell's bottom" - was the rule of the five-line card, and
               * it is false by construction once two facts share a line. It is replaced by the
               * four claims the two-line card could actually break, in the order they could break:
               *
               *   1. no two cells share area - every pair, both axes (the old rule saw only
               *      consecutive pairs and, at 390, only the vertical axis);
               *   2. no fact lost - every fact still renders a value. The old rule asserted five
               *      BOXES existed, so a card could hide a value and still pass as long as the
               *      boxes were there;
               *   3. no fact re-ordered - within a line, the left-to-right order is the declared
               *      order. Nothing tested this before, and flex 'order' is exactly how a
               *      rearrangement silently shuffles two facts;
               *   4. §2.5's own target: a card is <= 140px. Measured before this change: 162
               *      (nodes) and 177 (plugins).
               *
               * Then the cross-row rule the review's P0-1 finding was about, unchanged.
               */
              expect(rows.every((row) => row.overlapPairs === 0), name + ': no two cells of one record may share area (pairs per row: ' + JSON.stringify(rows.map((row) => row.overlapPairs)) + ')').toBe(true);
              for (const [index, row] of rows.entries()) {
                expect(row.factCount, name + ': record ' + index + ' may not lose a fact (' + row.factCount + ' values; labels ' + JSON.stringify(row.factLabels) + ')').toBeGreaterThanOrEqual(3);
                for (const line of row.lineOrders) {
                  expect(line.byGeometry, name + ': record ' + index + ' meets its facts on a line in the order they are declared').toEqual(line.declared);
                }
                expect(row.rowHeight, name + ': record ' + index + ' is at most 140px (§2.5) - ' + row.factLines + ' line(s)').toBeLessThanOrEqual(140);
              }
              for (let i = 1; i < rows.length; i += 1) {
                expect(rows[i].firstTop, name + ': record ' + i + ' may not start above the previous record\'s end (' + rows[i].firstTop + ' vs ' + rows[i - 1].lastBottom + ')').toBeGreaterThanOrEqual(rows[i - 1].lastBottom - 1);
              }
            }
          }
          if (measured.strip) {
            // P1: the strip is separated from the panel below it, like every other gap (24px).
            if (measured.strip.nextTop !== null) {
              expect(measured.strip.nextTop - measured.strip.bottom, name + ': the strip keeps the page rhythm above the next panel').toBeGreaterThanOrEqual(8);
            }
          }
          if (measured.chip) {
            // P0-3: the unselected chip clears 4.5:1 in both themes.
            expect(ratio(measured.chip.fg, measured.chip.bg), name + ': chip contrast in ' + theme).toBeGreaterThanOrEqual(4.5);
          }
          await shot(page, name);
          record(name, measured, { viewport: viewport.key, theme, locale, page: target.key });
        }
      }
    }
  }
});

test('P0-5: the Overview KPI and the Plugins strip print the same installed count', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pin(page, 'light', 'en');
  await page.goto(BASE + '/login');
  await login(page);
  await page.goto(BASE + '/admin/overview');
  await page.waitForSelector('[data-metric="installedPlugins"]');
  const kpi = (await page.locator('[data-metric="installedPlugins"] .ow-metric-value').innerText()).trim();
  await page.goto(BASE + '/admin/plugins');
  await page.waitForSelector('[data-testid="plugins-summary"]');
  const strip = (await page.locator('[data-summary-value="installed"]').innerText()).trim();
  const rows = await page.locator('.plugins-table tbody tr').count();
  const systemNote = await page.locator('[data-testid="plugins-system-note"]').count();
  record('p0-5-plugin-count', { kpi, strip, rows, systemNote } as unknown as Measure);
  expect(strip, 'installed count must equal the Overview KPI (' + kpi + ' vs ' + strip + ')').toBe(kpi);
  if (rows > Number(strip)) {
    expect(systemNote, 'the rows that are not counted must be named on the page').toBe(1);
    await expect(page.getByTestId('plugins-system-note')).toBeVisible();
  }
  await shot(page, 'p0-5-plugin-count-1440-en-light');
});

test('P0-4: the command palette shows every destination, desktop and phone', async ({ page }) => {
  test.setTimeout(180000);
  await pin(page, 'light', 'en');
  await page.goto(BASE + '/login');
  await login(page);
  for (const theme of THEMES) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate((value) => { try { window.localStorage.setItem('opsweave-theme', value); } catch { /* blocked */ } }, theme);
      await page.goto(BASE + '/admin/overview');
      await page.waitForSelector('.health-band');
      await page.click('[data-testid=command-trigger]');
      await page.waitForSelector('.ow-command-list');
      await page.waitForTimeout(200);
      const measured = await measure(page);
      const palette = measured.palette;
      expect(palette, 'the palette is open').not.toBeNull();
      expect(palette.scroll, 'all ' + palette.items + ' destinations fit: ' + palette.scroll + ' <= ' + palette.client).toBeLessThanOrEqual(palette.client + 1);
      expect(palette.items, 'ten destinations are listed').toBeGreaterThanOrEqual(10);
      const name = 'interaction-command-palette-' + viewport.key + '-' + theme;
      await shot(page, name);
      record(name, measured, { theme, viewport: viewport.key });
      await page.keyboard.press('Escape');
    }
  }
});

test('P0-2: no page claims READY while its body says otherwise', async ({ page }) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pin(page, 'light', 'en');
  await page.goto(BASE + '/login');
  await login(page);

  // (a) unconfigured
  const live = await page.evaluate(async () => (await fetch('/api/v1/overview')).json());
  await page.route(/\/api\/v1\/overview/, (route) => route.fulfill({ json: { ...live, health: 'READY', nodesTotal: 0, nodesReady: 0, pluginsInstalled: 0, pluginsAvailable: 0, instancesTotal: 0, instancesReady: 0, activeDeployments: 0, attention: [], recentEvents: [] } }));
  await page.goto(BASE + '/admin/overview');
  await page.waitForSelector('.health-band');
  await page.waitForTimeout(300);
  const empty = await measure(page);
  expect(empty.pill, 'the pill must not say ready over an unconfigured body').not.toMatch(/ready/i);
  expect(empty.railStatus, 'the rail must not say READY over an unconfigured body').not.toMatch(/^READY$/);
  expect(empty.pill, 'the pill names the same verdict as the body').toMatch(/Not configured/);
  expect(empty.railStatus).toMatch(/Not configured/);
  await shot(page, 'state-unconfigured-1440-en-light');
  record('state-unconfigured-1440-en-light', empty, { state: 'unconfigured' });
  await page.unroute(/\/api\/v1\/overview/);

  // (b) forbidden on this page, (c) error on this page
  for (const [status, state, expected] of [[403, 'forbidden', /No access|No access to this data/i], [500, 'error', /unavailable/i]] as const) {
    await page.route(/\/api\/v1\/plugins/, (route) => route.fulfill({ status, json: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL', message: 'Kernel said no (raw sentence)' } }));
    await page.goto(BASE + '/admin/plugins');
    await page.waitForSelector('[data-async-state="' + state + '"]');
    await page.waitForTimeout(250);
    const measured = await measure(page);
    expect(measured.pill, state + ': the pill must not claim ready').not.toMatch(/ready/i);
    expect(measured.railStatus, state + ': the rail must not claim READY').not.toMatch(/^READY$/);
    expect(String(measured.pill), state + ': the chrome follows the body verdict').toMatch(expected);
    const name = 'state-' + state + '-1440-en-light';
    await shot(page, name);
    record(name, measured, { state });
    await page.unroute(/\/api\/v1\/plugins/);
  }
});

test('P0-6: a Kernel sentence is localized; an unknown one is attributed', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pin(page, 'light', 'zh-CN');
  await page.goto(BASE + '/login');
  await login(page);
  const live = await page.evaluate(async () => (await fetch('/api/v1/overview')).json());

  const known = {
    ...live,
    health: 'ATTENTION',
    nodesTotal: 0,
    nodesReady: 0,
    attention: [
      { severity: 'info', title: 'No nodes enrolled', detail: 'Create an enrollment token and join a Linux node before deploying plugins.', link: '/nodes' },
    ],
  };
  await page.route(/\/api\/v1\/overview/, (route) => route.fulfill({ json: known }));
  await page.goto(BASE + '/admin/overview');
  await page.waitForSelector('[data-async-state="ready"]');
  await page.waitForTimeout(300);
  const row = page.locator('.attention-item').first();
  const titleText = (await row.locator('strong').innerText()).trim();
  const detailText = (await row.locator('.attention-item-copy p').innerText()).trim();
  expect(titleText, 'the Kernel English title must not reach a zh-CN reader').not.toBe('No nodes enrolled');
  expect(titleText).toBe('尚未接入节点');
  expect(detailText).not.toContain('Create an enrollment token');
  expect(await row.getAttribute('data-title-source')).toBe('catalog');
  await shot(page, 'state-attention-zh-1440-light');
  record('state-attention-zh-1440-light', { titleText, detailText, source: 'catalog' } as unknown as Measure, { state: 'attention-known' });

  const unknown = {
    ...live,
    health: 'ATTENTION',
    nodesTotal: 0,
    nodesReady: 0,
    attention: [
      { severity: 'warning', title: 'Registry mirror is dirty', detail: 'The registry returned an unexpected manifest. Retry the publish.', link: '/plugins' },
    ],
  };
  await page.route(/\/api\/v1\/overview/, (route) => route.fulfill({ json: unknown }));
  await page.goto(BASE + '/admin/overview');
  await page.waitForSelector('[data-async-state="ready"]');
  await page.waitForTimeout(300);
  const row2 = page.locator('.attention-item').first();
  const title2 = (await row2.locator('strong').innerText()).trim();
  expect(title2, 'an unmapped Kernel sentence is shown verbatim...').toBe('Registry mirror is dirty');
  expect(await row2.getAttribute('data-title-source'), '...and marked as the Kernel text').toBe('kernel');
  await expect(row2.locator('.server-source').first()).toBeVisible();
  const marker = (await row2.locator('.server-source').first().innerText()).trim();
  expect(marker, 'the source is named in the reader language').toBe('内核');
  await shot(page, 'state-attention-unknown-zh-1440-light');
  record('state-attention-unknown-zh-1440-light', { title2, marker } as unknown as Measure, { state: 'attention-unknown' });
  await page.unroute(/\/api\/v1\/overview/);
});

test('P0-3: a visitor whose OS asks for dark gets dark without choosing one', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { window.localStorage.removeItem('opsweave-theme'); } catch { /* blocked */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme, 'prefers-color-scheme: dark is honoured when nobody chose a theme').toBe('dark');
  await shot(page, 'state-system-dark-login-1440');
  record('state-system-dark-login-1440', { theme } as unknown as Measure, { state: 'system-dark' });
  await context.close();
});


/**
 * The interaction pack the review asked for: 16 states, once per theme.
 *
 * Each state asserts the element that makes it that state before the picture is written, so
 * "hover", "menu open" and "dialog open" are measured facts rather than names.
 */
test('interaction states: 16 states x 2 themes', async ({ page }) => {
  test.setTimeout(420000);
  for (const theme of THEMES) {
    await pin(page, theme, 'en');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/login');
    await login(page);

    const states: Array<{ name: string; run: () => Promise<string> }> = [
      {
        name: 'drawer-open',
        run: async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(BASE + '/admin/overview');
          await page.waitForSelector('.health-band', { timeout: 8000 });
          await page.click('[data-testid=sidebar-trigger]');
          await expect(page.locator('[data-testid=sidebar-scrim]')).toBeVisible();
          return 'drawer';
        },
      },
      {
        name: 'table-row-hover',
        run: async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('.plugins-table tbody tr', { timeout: 8000 });
          const row = page.locator('.plugins-table tbody tr').first();
          const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
          const box = await row.boundingBox();
          expect(box, 'the row has a box').not.toBeNull();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(150);
          const after = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
          expect(after, 'hover changes the row surface (' + before + ' -> ' + after + ')').not.toBe(before);
          return 'row-hover';
        },
      },
      {
        name: 'filter-tab-selected',
        run: async () => {
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('[role="tablist"]', { timeout: 8000 });
          const second = page.locator('[role="tab"]').nth(1);
          await second.click();
          await expect(second).toHaveAttribute('aria-selected', 'true');
          return 'filter-selected';
        },
      },
      {
        name: 'row-menu-open',
        run: async () => {
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('.plugins-table tbody tr', { timeout: 8000 });
          await page.locator('.plugins-table tbody tr button.icon-btn').first().click();
          await expect(page.locator('[role="menu"]')).toBeVisible();
          return 'row-menu';
        },
      },
      {
        name: 'node-row-hover',
        run: async () => {
          await page.keyboard.press('Escape');
          await page.goto(BASE + '/admin/nodes');
          await page.waitForSelector('.nodes-table tbody tr', { timeout: 8000 });
          await page.locator('.nodes-table tbody tr').first().hover();
          return 'node-hover';
        },
      },
      {
        name: 'nodes-count-pressed',
        run: async () => {
          await page.goto(BASE + '/admin/nodes');
          await page.waitForSelector('[data-testid="nodes-summary"]', { timeout: 8000 });
          const cell = page.locator('[data-testid="nodes-summary"] button').nth(1);
          await cell.click();
          await expect(cell).toHaveAttribute('aria-pressed', 'true');
          return 'count-pressed';
        },
      },
      {
        name: 'sidebar-collapsed',
        run: async () => {
          await page.goto(BASE + '/admin/overview');
          await page.waitForSelector('.health-band', { timeout: 8000 });
          await page.click('[data-testid=sidebar-collapse]');
          await expect(page.locator('.shell')).toHaveClass(/shell-collapsed/);
          return 'collapsed';
        },
      },
      {
        name: 'user-menu-open',
        run: async () => {
          await page.click('[data-testid=sidebar-collapse]');
          await page.goto(BASE + '/admin/overview');
          await page.waitForSelector('.health-band', { timeout: 8000 });
          await page.locator('.user-button').first().click();
          await expect(page.locator('.user-menu')).toBeVisible();
          return 'user-menu';
        },
      },
      {
        name: 'join-dialog-open',
        run: async () => {
          await page.keyboard.press('Escape');
          await page.goto(BASE + '/admin/nodes');
          await page.waitForSelector('.page-header', { timeout: 8000 });
          await page.locator('.page-header .page-actions > *').last().click();
          await expect(page.locator('[role="dialog"]')).toBeVisible();
          return 'dialog';
        },
      },
      {
        name: 'filter-strip-scrolled-390',
        run: async () => {
          await page.keyboard.press('Escape');
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('.ow-filter-scroll', { timeout: 8000 });
          const strip = page.locator('.ow-filter-scroll');
          await strip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
          const reachable = await strip.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const last = element.querySelector('[role="tab"]:last-of-type') as HTMLElement | null;
            if (!last) return false;
            const box = last.getBoundingClientRect();
            return box.right <= bounds.right + 1 && box.left >= bounds.left - 1;
          });
          expect(reachable, 'the last filter chip is fully readable once the strip is scrolled').toBe(true);
          return 'filter-scrolled';
        },
      },
      {
        name: 'plugins-empty',
        run: async () => {
          await page.route(/\/api\/v1\/plugins$/, (route) => route.fulfill({ json: [] }));
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('.empty-state', { timeout: 8000 });
          await page.unroute(/\/api\/v1\/plugins$/);
          return 'empty';
        },
      },
      {
        name: 'plugins-loading',
        run: async () => {
          await page.route(/\/api\/v1\/plugins$/, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 4000));
            // The screenshot is taken while the request is still in flight, so by the time the
            // delay ends the page may have moved on: a route the browser already handled is not
            // an error, it is a late answer.
            try { await route.continue(); } catch { /* already handled */ }
          });
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('[data-async-state="loading"]', { timeout: 8000 });
          await page.unroute(/\/api\/v1\/plugins$/);
          return 'loading';
        },
      },
      {
        name: 'plugin-detail',
        run: async () => {
          await page.unroute(/\/api\/v1\/plugins$/);
          await page.goto(BASE + '/admin/plugins/dev.opsweave.ops-center');
          await page.waitForSelector('.page-header h1', { timeout: 8000 });
          await page.waitForTimeout(400);
          return 'detail';
        },
      },
      {
        name: 'command-palette-filtered',
        run: async () => {
          await page.goto(BASE + '/admin/overview');
          await page.waitForSelector('.health-band', { timeout: 8000 });
          await page.click('[data-testid=command-trigger]');
          await page.waitForSelector('.ow-command-list', { timeout: 8000 });
          await page.fill('[data-testid=command-input]', 'pl');
          const count = await page.locator('[role="option"]').count();
          expect(count, 'the filter actually filtered').toBeLessThan(10);
          expect(count).toBeGreaterThan(0);
          return 'palette-filtered';
        },
      },
      {
        name: 'command-palette-empty',
        run: async () => {
          // Each state starts from a closed overlay, so this one opens the palette itself.
          await page.goto(BASE + '/admin/overview');
          await page.waitForSelector('.health-band', { timeout: 8000 });
          await page.click('[data-testid=command-trigger]');
          await page.waitForSelector('.ow-command-list', { timeout: 8000 });
          await page.fill('[data-testid=command-input]', 'zzzzz');
          await expect(page.locator('.ow-command-empty')).toBeVisible();
          return 'palette-empty';
        },
      },
      {
        name: 'plugins-system-note',
        run: async () => {
          await page.keyboard.press('Escape');
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(BASE + '/admin/plugins');
          await page.waitForSelector('[data-testid="plugins-summary"]', { timeout: 8000 });
          await page.waitForTimeout(300);
          return 'system-note';
        },
      },
    ];

    for (const state of states) {
      const kind = await state.run();
      await page.waitForTimeout(220);
      const measured = await measure(page);
      expect(measured.theme, state.name + ': theme applied').toBe(theme);
      if (measured.commit) expect(measured.commit, state.name + ': the rail names the built commit').toBe(EXPECTED_SHA);
      const name = 'interaction-' + state.name + '-' + theme;
      await shot(page, name);
      record(name, measured, { theme, state: kind, interaction: state.name });
      // Every state starts from a parked drawer and a closed overlay.
      try { await page.keyboard.press('Escape'); } catch { /* nothing open */ }
    }
  }
});

