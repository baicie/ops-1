#!/usr/bin/env node
/**
 * Phase 0 baseline capture for OpsWeave Visual System V1.
 *
 * The design pack requires a before image and a layout measurement for each flagship page,
 * at 1440/1024/390 x light/dark x en/zh-CN. This script drives the built bundle in a real
 * Chromium against the kernel that serves it, signs in once through the public login route,
 * and records the pixels together with the numbers a reviewer can check without opening an
 * image: document overflow, the page header box, computed type styles, and table row heights.
 *
 * Why a dedicated script rather than a spec: the existing specs each own one page and one
 * assertion surface. This one is the baseline instrument for the round; it asserts nothing, so
 * it cannot turn a visual regression into a green test. It also refuses to invent data - every
 * number on the page comes from the kernel it points at, and the manifest records that URL and
 * the build SHA.
 *
 *   CAPTURE_URL=http://127.0.0.1:18291 \
 *   CAPTURE_INCIDENT=<incident id> \
 *   CAPTURE_OUT=artifacts/ui/visual-v1/before \
 *   node tests/ui/visual-v1-capture.mjs
 *
 * The output directory is untracked (see .gitignore): the full 36-image matrix belongs in a
 * CI artifact, not in the repository's PNG budget. Representative images can be promoted
 * deliberately, with tests/ci/tracked-png-budget.json updated in the same review.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.CAPTURE_URL || 'http://127.0.0.1:18291';
const OUT = process.env.CAPTURE_OUT || path.resolve('artifacts/ui/visual-v1/before');
const EMAIL = process.env.CAPTURE_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.CAPTURE_PASSWORD || 'OpsWeave!2026';
const INCIDENT = process.env.CAPTURE_INCIDENT || '';
const SHA = process.env.CAPTURE_SHA || 'unknown';

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'];
const LOCALES = ['en', 'zh-CN'];

const PAGES = [
  { id: 'overview', route: '/admin/overview', wait: '[data-testid="overview-modules"]' },
  { id: 'observability', route: '/app/observability', wait: '[data-testid="observability-page"]' },
  ...(INCIDENT
    ? [{ id: 'incident', route: `/app/incidents/${INCIDENT}`, wait: '[data-testid="incident-evidence-table"]' }]
    : []),
];

/**
 * The same measurement the table gate reads, plus the type styles this round is deciding about.
 * It runs in the page, so every value is what painted - not what a component tree contains.
 */
const MEASURE = () => {
  const de = document.documentElement;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const style = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      fontWeight: s.fontWeight,
      color: s.color,
      fontFamily: s.fontFamily.slice(0, 80),
    };
  };
  const rows = Array.from(document.querySelectorAll('table tbody tr')).map((tr) =>
    Math.round(tr.getBoundingClientRect().height),
  );
  const pct = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };
  const regions = {};
  for (const sel of [
    '.page-header',
    '.health-band',
    '.stat-strip',
    '.console-grid',
    '.console-aside',
    '.console-main',
    '.metric-grid',
    '[data-testid="overview-modules"]',
    '[data-testid="overview-audit"]',
    '[data-testid="observability-filters"]',
    '[data-region="fleet"]',
    '[data-testid="incident-workspace"]',
    '[data-testid="incident-evidence"]',
    '[data-testid="incident-verdict"]',
  ]) {
    const el = document.querySelector(sel);
    if (el) regions[sel] = box(el);
  }
  return {
    viewport: { w: innerWidth, h: innerHeight },
    title: document.title,
    overflow: de.scrollWidth - de.clientWidth,
    docScrollW: de.scrollWidth,
    docClientW: de.clientWidth,
    header: box(document.querySelector('.page-header')),
    h1: style('h1'),
    h2: style('h2'),
    body: style('body'),
    metricValue: style('.ow-metric-value'),
    metricLabel: style('.ow-metric-label'),
    statusLabel: style('.status-indicator-label'),
    tableCell: style('table tbody td'),
    tableRows: {
      n: rows.length,
      p50: pct(rows, 50),
      p95: pct(rows, 95),
      max: rows.length ? Math.max(...rows) : null,
    },
    regions,
  };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const login = await browser.newContext({ baseURL: BASE });
  const response = await login.request.post('/api/v1/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!response.ok()) throw new Error(`login failed: ${response.status()} ${await response.text()}`);
  const storage = await login.storageState();
  await login.close();

  const manifest = {
    base: BASE,
    sha: SHA,
    capturedAt: new Date().toISOString(),
    browser: browser.version(),
    account: EMAIL,
    note: 'Data comes from the kernel named by base; no API payload is stubbed by this script.',
    pages: [],
  };

  for (const pageDef of PAGES) {
    const metrics = { page: pageDef.id, route: pageDef.route, combos: [] };
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const locale of LOCALES) {
          const label = `r${viewport.w}-${theme}-${locale === 'en' ? 'en' : 'zh-CN'}`;
          const context = await browser.newContext({
            viewport: { width: viewport.w, height: viewport.h },
            deviceScaleFactor: 1,
            baseURL: BASE,
            storageState: storage,
          });
          await context.addInitScript(
            ([t, l]) => {
              localStorage.setItem('opsweave-theme', t);
              localStorage.setItem('opsweave-locale', l);
            },
            [theme, locale],
          );
          const page = await context.newPage();
          await page.goto(pageDef.route, { waitUntil: 'load' });
          let waitState = 'ready';
          try {
            await page.waitForSelector(pageDef.wait, { timeout: 20_000 });
          } catch {
            waitState = 'selector-timeout';
          }
          await page.waitForTimeout(600);
          const facts = await page.evaluate(MEASURE);
          const file = `${pageDef.id}__${label}.png`;
          await page.screenshot({ path: path.join(OUT, file), fullPage: true });
          metrics.combos.push({ label, viewport, theme, locale, waitState, file, facts });
          console.log(
            pageDef.id,
            label,
            JSON.stringify({
              waitState,
              overflow: facts.overflow,
              headerH: facts.header?.h ?? null,
              rows: facts.tableRows,
            }),
          );
          await context.close();
        }
      }
    }
    fs.writeFileSync(path.join(OUT, `_metrics_${pageDef.id}.json`), JSON.stringify(metrics, null, 2) + '\n');
    manifest.pages.push({ id: pageDef.id, route: pageDef.route, metrics: `_metrics_${pageDef.id}.json` });
  }

  fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
