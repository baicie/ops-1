import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * B4 "carry the four" harness: one run writes every number the brief asks for.
 *
 * Local source (vite dev on 5174, tests/ui/vite.staging.config.mjs) against the STAGING
 * kernel, so the rows are the ones the review measured (14 jobs / 1 node / 4 plugins) and no
 * fixture stands between the code and the number.
 *
 *   B4_MODE=before pnpm --filter @opsweave/ui-tests exec playwright test b4-remaining
 *   B4_MODE=after  pnpm --filter @opsweave/ui-tests exec playwright test b4-remaining
 */

test.use({ channel: process.env.V3_CHANNEL || 'chrome', actionTimeout: 20_000, navigationTimeout: 60_000 });

const MODE = process.env.B4_MODE === 'after' ? 'after' : 'before';
const OUT = path.resolve('../../artifacts/ui/visual-v3/b4-remaining', MODE);
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5174';
const EMAIL = 'admin@opsweave.local';
const PASSWORD = 'OpsWeave!2026';
const PLUGIN = 'dev.opsweave.hello';
const PIPELINE = 'host-metrics-pipeline';

async function signIn(page: Page) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

/** Everything the four findings need, measured from the DOM and nowhere else. */
function probe(page: Page) {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const cls = (el: Element | null) => (el && typeof el.className === 'string' ? el.className : null);
    const inner = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? null;

    /* ── 4. every word that says READY, with the element that says it ───────────── */
    const readyNodes: unknown[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const raw = (node.textContent || '').trim();
      if (/ready/i.test(raw)) {
        const el = node.parentElement as HTMLElement | null;
        if (el) {
          const cs = getComputedStyle(el);
          readyNodes.push({
            text: raw.slice(0, 90),
            rendered: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90),
            tag: el.tagName.toLowerCase(),
            cls: cls(el),
            transform: cs.textTransform,
            section: cls(el.closest('section')),
            testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
            box: rect(el),
          });
        }
      }
      node = walker.nextNode();
    }
    const flat = document.body.innerText.replace(/\s+/g, ' ');
    const count = (needle: string) => flat.split(needle).length - 1;

    /* ── 1. the Instances panel and the table inside it ─────────────────────────── */
    const grid = document.querySelector('.plugin-detail-grid') as HTMLElement | null;
    const instancePanel = document.querySelector('.plugin-detail-grid > .panel:has(.instance-compact)') as HTMLElement | null;
    const scroller = document.querySelector('.instance-compact') as HTMLElement | null;
    const table = document.querySelector('.instance-compact table') as HTMLElement | null;
    const thead = document.querySelector('.instance-compact thead') as HTMLElement | null;
    const firstRow = document.querySelector('.instance-compact tbody tr') as HTMLElement | null;
    const gridPanels = grid ? Array.from(grid.children).map((child) => ({
      cls: cls(child),
      heading: child.querySelector('h2')?.textContent?.trim() || null,
      box: rect(child),
      column: (() => {
        const cs = getComputedStyle(child as HTMLElement);
        return { start: cs.gridColumnStart, end: cs.gridColumnEnd };
      })(),
    })) : [];
    const instances = {
      panel: rect(instancePanel),
      panelColumn: instancePanel ? { start: getComputedStyle(instancePanel).gridColumnStart, end: getComputedStyle(instancePanel).gridColumnEnd } : null,
      gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
      scrollerClientW: scroller ? scroller.clientWidth : null,
      scrollerScrollW: scroller ? scroller.scrollWidth : null,
      needsHorizontalScroll: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : null,
      tableW: table ? Math.round(table.getBoundingClientRect().width) : null,
      theadH: thead ? Math.round(thead.getBoundingClientRect().height) : null,
      headFirstRowSqueeze: thead && firstRow ? Math.round((thead.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top) * 10) / 10 : null,
      firstRowH: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : null,
      rows: document.querySelectorAll('.instance-compact tbody tr').length,
      panels: gridPanels,
      // A hole is a grid cell no panel covers: the row's used width against the panels on it.
      rowHoles: gridPanels.map((p, i) => {
        const next = gridPanels[i + 1];
        const sameRow = next && p.box && next.box && Math.abs(p.box.top - next.box.top) < 2;
        return sameRow && p.box && next.box ? { top: p.box.top, gap: next.box.left - (p.box.left + p.box.width) } : null;
      }).filter(Boolean),
    };

    /* ── 3. the job detail title and the cards under it ────────────────────────── */
    const h1 = document.querySelector('[data-testid=page-header] h1') as HTMLElement | null;
    const h1Text = (h1?.textContent || '').trim();
    const cards = Array.from(document.querySelectorAll('.job-stats .metric-card')).map((card) => ({
      label: (card.querySelector('.metric-label')?.textContent || '').trim(),
      value: (card.querySelector('.metric-value')?.textContent || '').replace(/\s+/g, ' ').trim(),
      box: rect(card),
    }));
    const duplicate = h1Text ? {
      h1: h1Text,
      h1TextCountOnPage: document.body.innerText.split(h1Text).length - 1,
      h1Box: rect(h1),
      cardsWithH1Text: cards.filter((c) => c.value.includes(h1Text) || c.label.includes(h1Text)),
      cardsWithH1TextOld: Array.from(document.querySelectorAll('.metric-card')).filter((el) => (el.textContent || '').includes(h1Text)).map((el) => ({ text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), top: rect(el)?.top })),
    } : null;

    /* ── 2. the deployment block in the rail ──────────────────────────────────── */
    const sidebar = document.querySelector('.sidebar') as HTMLElement | null;
    const block = document.querySelector('.sidebar-meta-block') as HTMLElement | null;
    const rows = document.querySelector('.sidebar-meta-rows') as HTMLElement | null;
    const trigger = document.querySelector('[data-testid=version-rail-trigger]') as HTMLElement | null;
    const sidebarBox = sidebar ? sidebar.getBoundingClientRect() : null;
    const side = {
      sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : null,
      block: rect(block),
      rows: rows ? { ...rect(rows), visibility: getComputedStyle(rows).visibility, opacity: getComputedStyle(rows).opacity, open: rows.getAttribute('data-open') } : null,
      trigger: trigger ? {
        ...rect(trigger),
        ariaLabel: trigger.getAttribute('aria-label'),
        title: trigger.getAttribute('title'),
        ariaExpanded: trigger.getAttribute('aria-expanded'),
        ariaControls: trigger.getAttribute('aria-controls'),
        text: (trigger.innerText || '').replace(/\s+/g, ' ').trim(),
      } : null,
      fields: rows ? Array.from(rows.querySelectorAll('[data-version-field]')).map((field) => {
        const el = field as HTMLElement;
        const value = el.querySelector('strong');
        const r = el.getBoundingClientRect();
        return {
          field: el.getAttribute('data-version-field'),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          valueText: (value?.textContent || '').trim(),
          valueWidth: value ? Math.round(value.getBoundingClientRect().width) : 0,
          valueScrollW: value ? value.scrollWidth : 0,
          clipped: el.scrollWidth > el.clientWidth + 1 || (value ? value.scrollWidth > value.clientWidth + 1 : false),
          insideRail: sidebarBox ? r.right <= sidebarBox.right + 0.5 : null,
          outsideViewport: r.right > window.innerWidth + 0.5,
        };
      }) : [],
    };

    return {
      url: location.pathname,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      readyNodes,
      readyCounts: { platformReady: count('Platform ready'), upperReady: count('READY'), platformIsReady: count('Platform is ready'), anyReady: (flat.match(/ready/gi) || []).length },
      instances,
      duplicate,
      jobCards: Array.from(document.querySelectorAll('.job-stats .metric-card')).map((card) => ({
        label: (card.querySelector('.metric-label')?.textContent || '').trim(),
        value: (card.querySelector('.metric-value')?.textContent || '').replace(/\s+/g, ' ').trim(),
        top: Math.round(card.getBoundingClientRect().top),
      })),
      sidebar: side,
      bodyText: flat.slice(0, 400),
      headerDescription: inner('[data-testid=page-header] .page-description'),
    };
  });
}

test('b4 remaining four', async ({ page }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(OUT, { recursive: true });
  await page.context().clearCookies();
  await page.addInitScript(() => {
    try { window.localStorage.setItem('opsweave-locale', 'en'); } catch { /* storage blocked */ }
  });
  await signIn(page);
  const results: Record<string, unknown> = {};

  // A real job id, so the run measures the row the review measured even after a redeploy.
  await page.goto(BASE + '/admin/jobs', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const jobRow = page.locator('[data-job-row]').first();
  const jobId = (await jobRow.getAttribute('data-job-row', { timeout: 20_000 }).catch(() => null)) || '';
  const jobHref = jobId ? '/admin/jobs/' + jobId : null;
  results.jobHref = jobHref;

  const only = (process.env.B4_TARGETS || '').split(',').filter(Boolean);
  const all: { name: string; path: string; width: number; shot?: boolean }[] = [
    { name: 'plugin-detail@1440', path: '/admin/plugins/' + PLUGIN, width: 1440, shot: true },
    { name: 'job-detail@1440', path: jobHref || '/admin/jobs', width: 1440, shot: true },
    { name: 'overview@1440', path: '/admin/overview', width: 1440, shot: true },
    { name: 'studio@1440', path: '/admin/pipelines/' + PIPELINE + '/editor', width: 1440, shot: true },
    { name: 'studio@1024', path: '/admin/pipelines/' + PIPELINE + '/editor', width: 1024 },
  ];

  const targets = only.length ? all.filter((t) => only.some((o) => t.name.startsWith(o))) : all;

  const t0 = Date.now();
  const lap = (label: string) => console.log('[b4] ' + label + ' ' + (Date.now() - t0) + 'ms');

  for (const target of targets) {
    await page.setViewportSize({ width: target.width, height: 900 });
    lap(target.name + ' viewport');
    await page.goto(BASE + target.path, { waitUntil: 'domcontentloaded' });
    lap(target.name + ' goto');
    await page.waitForTimeout(1800);
    await probe(page).then(() => undefined).catch(() => undefined);
    lap(target.name + ' probe');
    results[target.name] = await probe(page).catch((cause) => ({ error: String(cause) }));
    lap(target.name + ' probe2');
    if (target.shot) await page.screenshot({ path: path.join(OUT, target.name + '.png'), fullPage: true });

    // 2. the rail has to hand its four facts back on request, not only on load.
    if (target.name.startsWith('studio')) {
      const trigger = page.locator('[data-testid=version-rail-trigger]');
      const open: Record<string, unknown> = { triggerCount: await trigger.count() };
      if (await trigger.count()) {
        await trigger.first().focus();
        await page.waitForTimeout(350);
        open.afterFocus = await probe(page).then((p) => (p as any).sidebar).catch((cause) => ({ error: String(cause) }));
        await page.screenshot({ path: path.join(OUT, target.name + '__rail-focus.png') });
        await trigger.first().press('Enter');
        await page.waitForTimeout(350);
        open.afterEnter = await probe(page).then((p) => (p as any).sidebar).catch((cause) => ({ error: String(cause) }));
        await page.screenshot({ path: path.join(OUT, target.name + '__rail-open.png') });

        // Keyboard reachability of the panel itself: the trigger is focused, Tab moves into it.
        await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        open.afterTab = await page.evaluate(() => ({
          active: (document.activeElement as HTMLElement | null)?.className || null,
          activeText: (document.activeElement as HTMLElement | null)?.textContent?.replace(/\s+/g, ' ').trim() || null,
        }));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
      results[target.name + '__rail'] = open;
    }

  }

  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(results, null, 1));
  expect(Object.keys(results).length).toBeGreaterThan(0);
});