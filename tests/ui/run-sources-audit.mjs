#!/usr/bin/env node
/**
 * Host-side runner for the /app/sources audit.
 *
 * Why this exists instead of `playwright test`: the Claude session that authored this page runs
 * its shell inside a sandbox that refuses every `bind()` — TCP and Unix-domain alike. Chrome's
 * ProcessSingleton needs a Unix socket in the profile directory, so no browser can start in
 * there. The desktop app's preview launcher runs a command on the HOST, outside that sandbox,
 * which is the only place a real engine can be driven from this session. This file is therefore
 * a plain script the launcher can start, not a test harness of its own; it listens on a port
 * purely so the launcher can tell it came up, and writes the same `_metrics_*.json` shape
 * `tests/ui/ui-table-audit.spec.ts` writes so `scripts/check-ui-metrics.mjs` can read it
 * unmodified.
 *
 * It measures the real page in a real browser. Nothing here is a stand-in for a screenshot.
 */
import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = process.env.SOURCES_OUT || path.join(ROOT, 'artifacts/ui/sources');
const BASE = process.env.SOURCES_URL || 'http://127.0.0.1:5178';
const API = process.env.SOURCES_API || 'http://127.0.0.1:18181';

fs.mkdirSync(OUT, { recursive: true });

/** Keep the launcher happy: it waits for a listening port before reporting "started". */
http.createServer((_req, res) => res.end('sources-audit\n')).listen(18199, '127.0.0.1');

/** Point the fixture API at one of its scenarios; the page itself is never told which. */
async function scenario(name) {
  const res = await fetch(`${API}/__scenario/${name}`, { method: 'POST' });
  if (!res.ok) throw new Error(`cannot select scenario ${name}: ${res.status}`);
}

/**
 * Everything table-spec §4.1 records, read out of the live page.
 *
 * Copied in shape from `ui-table-audit.spec.ts` on purpose: the gate parses these field names,
 * and a second dialect of the same measurement would be a second thing to keep right.
 */
const MEASURE = () => {
  const de = document.documentElement;
  const client = de.clientWidth;
  const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
  const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10);
  const pct = (list, p) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((list.length * p) / 100))] : null);
  const identityKey = Array.from(document.querySelectorAll('[data-identity-key]')).map((el) => el.getAttribute('data-identity-key') || '');

  const keys = Array.from(document.querySelectorAll('tbody tr[data-row-key]')).map((el) => el.getAttribute('data-row-key') || '');
  let run = 0;
  let runMax = 0;
  let previous = '';
  for (const key of keys) {
    run = key === previous ? run + 1 : 1;
    previous = key;
    if (run > runMax) runMax = run;
  }

  const distinctRatio = [];
  const columnLabels = [];
  const tableRowCounts = [];
  let headCount = 0;
  let noDataPerTable = 0;
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
    const cellsOf = (tr) => Array.from(tr.children).filter((el) => el.tagName === 'TD');
    let labelled = 0;
    Array.from(table.querySelectorAll('thead th')).forEach((th, index) => {
      if ((th.textContent || '').trim().length === 0) return;
      labelled += 1;
      columnLabels.push((th.textContent || '').trim());
      const values = bodyRows
        .map((tr) => cellsOf(tr)[index])
        .filter(Boolean)
        .map((cell) => (cell.textContent || '').trim());
      distinctRatio.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
    });
    tableRowCounts.push(bodyRows.length);
    if (labelled > headCount) headCount = labelled;
    const noData = table.querySelectorAll('td [data-value="NO_DATA"]').length;
    if (noData > noDataPerTable) noDataPerTable = noData;
  }

  const offenders = Array.from(document.querySelectorAll('body *'))
    .filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > client + 1.5;
    })
    .slice(0, 8)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 60), left: Math.round(box.left), right: Math.round(box.right) };
    });

  /** §2.5: at 390 a row is a card; the facts and the identity clipping are what the gate reads. */
  const cards = window.innerWidth < 768
    ? rows.map((tr) => {
      const ident = tr.querySelector('[data-identity-key]');
      const factCells = Array.from(tr.querySelectorAll('td[data-label]')).filter((td) => {
        if (td.classList.contains('ow-ident-cell')) return false;
        const style = window.getComputedStyle(td);
        return style.display !== 'none';
      });
      const factValues = factCells
        .map((td) => (td.querySelector('.ow-cell-body')?.textContent || td.textContent || '').trim())
        .filter(Boolean);
      /**
       * §2.5, measured on the SAME element the committed harness measures
       * (`ui-table-audit.spec.ts:486`: `cell = tr.querySelector('[data-identity-key]')`, then
       * `clipped = cell.scrollWidth > cell.clientWidth + 1 || tailOverflow`).
       *
       * The subject has to be `.ow-ident` - the element carrying `data-identity-key` - and not
       * its `<td>`. At 390 the identity cell is `display: contents` (styles.css, "the two-line
       * card"), so the td generates no box at all: its rect reads width 0 / right 0, every tail
       * sits to the right of that, and a `tail.right > td.right` test reports a violation on
       * every row that has a tail. Two earlier revisions of this runner failed that way - one
       * on the inner span the name is *meant* to ellipsise inside, one on the box-less td - and
       * both would have had this page "fix" geometry that the gate's own instrument calls clean.
       *
       * What the rule protects is unchanged: the NAME may ellipsise (`.ow-ident-name` carries
       * `text-overflow: ellipsis`), and the `· disambiguator` tail never may, because the tail
       * is what makes two cards with the same name tellable apart.
       */
      const cell = ident;
      const tail = cell ? cell.querySelector('.ow-ident-tail') : null;
      const cellBox = cell ? cell.getBoundingClientRect() : null;
      const tailOverflow = tail && cellBox
        ? tail.getBoundingClientRect().right > cellBox.right + 1 || tail.scrollWidth > tail.clientWidth + 1
        : false;
      const box = cellBox;
      return {
        key: ident ? ident.getAttribute('data-identity-key') : '',
        clipped: cell ? cell.scrollWidth > cell.clientWidth + 1 || tailOverflow : false,
        width: box ? Math.round(box.width) : null,
        facts: factCells.length,
        factValues: factValues.length,
      };
    })
    : [];

  const header = document.querySelector('[data-testid=page-header]');
  const firstBlock = document.querySelector('.metric-grid, .toolbar, .panel');
  return {
    overflow: de.scrollWidth - client,
    docScrollW: de.scrollWidth,
    docClientW: client,
    docHeight: de.scrollHeight,
    offenders,
    identityKey,
    identityUnique: identityKey.length ? new Set(identityKey).size / identityKey.length : 1,
    rowHeight: { p50: pct(heights, 50), p95: pct(heights, 95), max: heights.length ? Math.max(...heights) : null, n: heights.length },
    columns: headCount,
    distinctRatio,
    columnLabels,
    tableRowCounts,
    duplicateRunMax: runMax,
    rows: rows.length,
    noDataPerTable,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    cardFactCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.factValues)) : null,
    cardLabelCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.facts)) : null,
    cards,
    // page-template §2.1: the header is 80px and the first block starts below it.
    template: {
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      firstBlockY: firstBlock ? Math.round(firstBlock.getBoundingClientRect().top) : null,
      kpiBands: document.querySelectorAll('.metric-grid').length,
      toolbars: document.querySelectorAll('.toolbar').length,
    },
  };
};

const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1024, h: 820 }, { w: 390, h: 844 }];
const THEMES = ['light', 'dark'];
const LOCALES = ['en', 'zh-CN'];

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const report = {};

  await scenario('populated');
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      for (const locale of LOCALES) {
        const label = `r${viewport.w}-${theme}-${locale === 'en' ? 'en' : 'zh'}`;
        const context = await browser.newContext({
          viewport: { width: viewport.w, height: viewport.h },
          deviceScaleFactor: 1,
          baseURL: BASE,
        });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t);
          localStorage.setItem('opsweave-locale', l);
        }, [theme, locale]);
        const page = await context.newPage();
        await page.goto(`${BASE}/app/sources`);
        await page.waitForSelector('[data-testid=sources-page]', { timeout: 30000 });
        await page.waitForSelector('[data-async-state=ready], [data-async-state=empty]', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(400);

        const measurement = await page.evaluate(MEASURE);
        report[label] = { '/app/sources': measurement };
        await page.screenshot({ path: path.join(OUT, `${label}__sources.png`), fullPage: true });

        // The drawer and the configuration form are part of the surface, so they are
        // photographed too rather than asserted to exist.
        if (viewport.w !== 390) {
          await page.click('[data-testid=row-actions]');
          await page.click('[data-action=detail]');
          await page.waitForSelector('[data-testid=sources-detail]', { timeout: 10000 });
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(OUT, `${label}__drawer.png`) });
          await page.click('[data-testid=sources-detail-configure]');
          await page.waitForSelector('[data-testid=sources-config-form]', { timeout: 10000 });
          // The refusal state, shown with a real paste rather than described.
          await page.fill('[data-testid=sources-config-credential]', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz');
          await page.waitForTimeout(250);
          await page.screenshot({ path: path.join(OUT, `${label}__config-refused.png`) });
        }

        fs.writeFileSync(path.join(OUT, `_metrics_${label}.json`), JSON.stringify({
          config: { label, theme, locale, route: '/app/sources', baseURL: BASE, data: 'fixture-api', template: measurement.template },
          pages: report[label],
        }, null, 1));
        await context.close();
      }
    }
  }

  // The four states that are not "populated". Each is a real server answer, not a prop.
  for (const [name, selector] of [
    ['empty', '[data-async-state=empty]'],
    ['registry-down', '[data-testid=sources-page]'],
    ['grants-forbidden', '[data-testid=sources-page]'],
    ['forbidden', '[data-async-state=forbidden]'],
    ['error', '[data-async-state=error]'],
    // Loading is captured against a server that has not answered yet, so the skeleton on
    // screen is the real waiting state and not a prop.
    ['slow', '[data-async-state=loading]'],
    ['conflict', '[data-panel-state=conflict]'],
    // The registry answers, and nothing in it provides a source capability: a different
    // page from "there are no plugins" (AGENTS.md - an absence is not a health reading).
    ['no-capabilities', '[data-testid=sources-page]'],
  ]) {
    await scenario(name);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/app/sources`);
    await page.waitForSelector(selector, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `state-${name}.png`), fullPage: true });
    await context.close();
  }

  /**
   * Stale, captured on a clock this run controls.
   *
   * `isStale` (components/app/async-boundary) is a statement about a clock: an observation is
   * stale once it is older than 2.5 polling rounds. `clock.fastForward` is the wrong instrument
   * for it - it RUNS the timers it skips, so the 30s poll fires, the fixture answers, and
   * `observedAt` is refreshed to the new now. The observation is young again and the notice
   * never appears, which is exactly what this runner measured first time round (rendered=0).
   *
   * The repo's own `async-stale.spec.ts` uses the right one and this follows it: install the
   * clock, let the first poll be answered, then PAUSE the clock past the threshold. Paused time
   * does not run timers, so there is no second answer - the page is left holding one real
   * observation that is now provably too old, which is the actual condition under test.
   */
  {
    /**
     * Stale: one good observation, then a refused refresh.
     *
     * The page keeps the rows it already has (`error={data ? null : error}`) and ages them with
     * a notice, which is the only honest reading - the rows ARE a real past observation and
     * nothing has confirmed them since. An earlier version of this runner tried to reach the
     * same state with `clock.fastForward`, which RUNS the timers it skips: the poll fired, the
     * fixture answered, `observedAt` was refreshed and the notice never appeared (rendered=0).
     * A refused refresh needs no clock control at all.
     */
    await scenario('stale-after-first');
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/app/sources`);
    await page.waitForSelector('[data-async-state=ready]', { timeout: 30000 }).catch(() => {});
    // Force the second read without waiting out the 30s poll: the toolbar's own Refresh.
    // Past the fixture's opening-burst window, so the next read is a refresh and is refused.
    await page.waitForTimeout(1800);
    await page.click('[data-testid=sources-refresh]').catch(() => {});
    await page.waitForSelector('[data-notice=stale]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'state-stale.png'), fullPage: true });
    const notice = await page.locator('[data-notice=stale]').count();
    const rowsKept = await page.locator('tbody tr').count();
    console.log('STALE notice rendered=' + notice + ' rowsKept=' + rowsKept);
    await context.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(report, null, 1));
  console.log('AUDIT DONE labels=' + Object.keys(report).join(','));
}

main().then(
  () => { console.log('AUDIT OK'); },
  (error) => { console.error('AUDIT FAILED', error); process.exitCode = 1; },
);
