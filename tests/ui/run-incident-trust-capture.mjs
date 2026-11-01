#!/usr/bin/env node
/**
 * Capture the incident detail surface after G12 made evidenceTrust a Kernel verdict.
 *
 * The change is copy plus one extra line per row (the verification method), and the thing a
 * unit test cannot show is whether that line survives at 390 and in the dark theme. So this
 * drives a real Chrome against a real kernel with real attested evidence and records the
 * 3 widths x 2 themes x 2 locales matrix AGENTS.md requires.
 *
 * Auth is a real login: the page under test reads its own cookie, so a fixture token would
 * prove nothing about what an operator actually sees.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = process.env.CAPTURE_OUT || path.join(ROOT, 'artifacts/ui/incident-trust');
const BASE = process.env.CAPTURE_URL || 'http://127.0.0.1:5179';
const API = process.env.CAPTURE_API || 'http://127.0.0.1:18199';
const EMAIL = process.env.CAPTURE_EMAIL || 'n8@opsweave.local';
const PASSWORD = process.env.CAPTURE_PASSWORD || 'n8-Admin-Pass-123!';
const INCIDENT = process.env.CAPTURE_INCIDENT;
if (!INCIDENT) throw new Error('CAPTURE_INCIDENT is required');

fs.mkdirSync(OUT, { recursive: true });


/**
 * The table-spec §4.1 measurement, in the shape `scripts/check-ui-metrics.mjs` parses.
 *
 * Copied in intent from `run-sources-audit.mjs`: the gate reads these field names, and a second
 * dialect would be a second thing to keep right. The trust-specific fields are recorded beside
 * them so the gate is not the only consumer of this file.
 */
const MEASURE = () => {
  const de = document.documentElement;
  const client = de.clientWidth;
  const pct = (values, p) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  };
  const rows = Array.from(document.querySelectorAll('table tbody tr'));
  const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10);

  const distinctRatio = [];
  const columnLabels = [];
  let headCount = 0;
  let noDataPerTable = 0;
  let duplicateRunMax = 0;
  const identityKey = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const cellsOf = (tr) => Array.from(tr.children).filter((el) => el.tagName === 'TD');
    let labelled = 0;
    Array.from(table.querySelectorAll('thead th')).forEach((th, index) => {
      if ((th.textContent || '').trim().length === 0) return;
      labelled += 1;
      columnLabels.push((th.textContent || '').trim());
      const values = bodyRows.map((tr) => cellsOf(tr)[index]).filter(Boolean).map((c) => (c.textContent || '').trim());
      distinctRatio.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
    });
    if (labelled > headCount) headCount = labelled;
    const noData = table.querySelectorAll('td [data-value="NO_DATA"]').length;
    if (noData > noDataPerTable) noDataPerTable = noData;

    // §2.4: the longest run of identical keys, read off the evidence rows themselves.
    let run = 0;
    let previous = null;
    for (const tr of bodyRows) {
      const key = (tr.querySelector('[data-identity-key]')?.getAttribute('data-identity-key')) || '';
      if (key) identityKey.push(key);
      run = key === previous ? run + 1 : 1;
      previous = key;
      if (run > duplicateRunMax) duplicateRunMax = run;
    }
  }

  const offenders = Array.from(document.querySelectorAll('body *'))
    .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > client + 1.5; })
    .slice(0, 8)
    .map((el) => { const b = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), right: Math.round(b.right) }; });

  // §2.5: at 390 a row is a card, and the card's facts are what the gate counts.
  const cards = window.innerWidth < 768
    ? rows.map((tr) => {
      // A cell that is display:none at this width is not a fact on the card. The reference
      // harness (run-sources-audit.mjs) filters on computed style and the gate was built against
      // that reading; counting hidden cells here reported 4 facts on a 3-fact card.
      const factCells = Array.from(tr.querySelectorAll('td[data-label]')).filter((td) => {
        if (td.classList.contains('ow-ident-cell')) return false;
        return window.getComputedStyle(td).display !== 'none';
      });
      const ident = tr.querySelector('[data-identity-key]');
      return {
        key: ident ? ident.getAttribute('data-identity-key') : '',
        clipped: false,
        width: null,
        facts: factCells.length,
        factValues: factCells.map((td) => (td.textContent || '').trim()).filter(Boolean).length,
      };
    })
    : [];

  const evidenceRows = Array.from(document.querySelectorAll('[data-evidence-row]'));
  return {
    overflow: de.scrollWidth - client,
    docScrollW: de.scrollWidth,
    docClientW: client,
    offenders,
    identityKey,
    identityUnique: identityKey.length ? new Set(identityKey).size / identityKey.length : 1,
    rowHeight: { p50: pct(heights, 50), p95: pct(heights, 95), max: heights.length ? Math.max(...heights) : null, n: heights.length },
    columns: headCount,
    distinctRatio,
    columnLabels,
    duplicateRunMax,
    rows: rows.length,
    noDataPerTable,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    cardFactCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.factValues)) : null,
    cardLabelCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.facts)) : null,
    cards,
    // What this surface's own change is about, recorded next to the generic measurements.
    evidence: {
      rows: evidenceRows.length,
      trusts: evidenceRows.map((r) => r.getAttribute('data-trust')),
      tones: evidenceRows.map((r) => r.querySelector('[data-trust-tone]')?.getAttribute('data-trust-tone') ?? null),
      gapRows: document.querySelectorAll('[data-testid=incident-evidence-trust-gap]').length,
      legend: !!document.querySelector('[data-testid=incident-trust-legend]'),
    },
  };
};

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 800 },
  { w: 390, h: 844 },
];
const THEMES = ['light', 'dark'];
const LOCALES = ['en', 'zh-CN'];

async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const shots = [];
  const overflowLabels = [];

  // One real login, reused by every context through the same storage state.
  const loginCtx = await browser.newContext({ baseURL: API });
  const loginRes = await loginCtx.request.post('/api/v1/auth/login', {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!loginRes.ok()) throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  const storage = await loginCtx.storageState();
  await loginCtx.close();

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
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t);
          localStorage.setItem('opsweave-locale', l);
        }, [theme, locale]);
        const page = await context.newPage();
        await page.goto(`${BASE}/app/incidents/${INCIDENT}`);
        await page.waitForSelector('[data-testid=incident-detail][data-incident-id]', { timeout: 30000 });
        await page.waitForSelector('[data-testid=incident-evidence-table]', { timeout: 30000 });
        await page.waitForTimeout(500);

        const facts = await page.evaluate(MEASURE);

        const file = `${label}__incident-trust.png`;
        await page.screenshot({ path: path.join(OUT, file), fullPage: true });
        shots.push({ label, file });
        if (facts.overflow > 1) overflowLabels.push(`${label} (+${facts.overflow}px)`);
        // One file per theme+locale, holding one key per measured route - the shape
        // scripts/check-ui-metrics.mjs reads (`doc.pages[route]`). A second width is the same
        // route measured again, so it is folded into the same entry rather than a separate one:
        // the gate scopes its own assertions by the viewport recorded IN the measurement.
        const metricsFile = path.join(OUT, `_metrics_${theme}-${locale}.json`);
        const metrics = fs.existsSync(metricsFile)
          ? JSON.parse(fs.readFileSync(metricsFile, 'utf8'))
          : { config: { label: `incident-trust ${theme}-${locale}` }, pages: {} };
        metrics.pages = metrics.pages || {};
        // One entry per width: the gate scopes its assertions by `viewport.w` inside each
        // measurement, so folding three widths into one key would silently keep only the last.
        metrics.pages[`/app/incidents/{id}@${viewport.w}`] = facts;
        fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2) + '\n');
        await context.close();
        console.log(label, JSON.stringify({ overflow: facts.overflow, p95: facts.rowHeight.p95, cols: facts.columns, evidence: facts.evidence }));
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify({ incident: INCIDENT, shots }, null, 2) + '\n');
  await browser.close();
  const overflow = overflowLabels;
  console.log(overflow.length === 0 ? 'CAPTURE_OK no horizontal overflow' : `CAPTURE_OVERFLOW on ${overflow.join(', ')}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
