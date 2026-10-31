import { Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The close-out measurements for the three debts this round inherited.
 *
 * Two instruments, one file, so the before and the after run are literally the same code:
 *
 *   1. the overview census - how many times the healthy page says "this is fine", how many of
 *      those strings are distinct phrasings, and how many objects on the first screen can be
 *      operated. The review's finding is a count, so it has to be re-counted, not re-argued.
 *   2. the 390 qualifier line on /admin/activity - one line by contract (the second track of a
 *      card), and the payload field in it can be a 100-character request path. The committed
 *      audit fixture carries `details: { sequence: n }`, which is 14px wide and never wraps, so
 *      the fixture cannot reproduce the defect it is supposed to measure: this one stubs a path.
 *
 * Both payloads are stubbed on purpose. The live kernel on this host reports DEGRADED with one
 * critical deployment, so "the healthy page" is not a state the host can be asked for.
 */
test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5173';
const OUT = process.env.DEBT_OUT || path.resolve('../../artifacts/ui/visual-v3/debt');
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const HEALTHY = {
  health: 'READY',
  nodesTotal: 3,
  nodesReady: 3,
  pluginsInstalled: 11,
  pluginsAvailable: 12,
  instancesReady: 21,
  instancesTotal: 21,
  activeDeployments: 9,
  attention: [] as unknown[],
  recentEvents: [],
};

const WITH_ISSUE = {
  ...HEALTHY,
  health: 'DEGRADED',
  instancesReady: 20,
  attention: [{ severity: 'critical', title: 'Deployment dev.opsweave.hello is DEGRADED', detail: '0/1 replicas READY; 1 failed', link: '/admin/plugins/dev.opsweave.hello' }],
};

/** database: 'connected' paints the Kernel row Ready - the third of the three ready rows the
 *  review counted. The fixture describes the page, not this host. */
const DIAGNOSTICS = {
  kernel: { version: '0.0.4', apiMajor: 1, runtimeProtocol: 'http-json-v1', uptimeSeconds: 48120, database: 'connected', dataDir: '/var/lib/opsweave', webDist: '/usr/share/opsweave/web' },
};

/** The payload field DETAIL_PRIORITY puts first, at the length the CSS comment says to expect. */
const LONG_PATH = '/api/v1/pipelines/9f2c41ab-7d38-4c05-8a61-e0b93f7d5214/revisions/7/activate?scope=tenant&dry_run=false';
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const AUDIT = Array.from({ length: 8 }, (_, index) => ({
  id: 'event-' + String(index).padStart(3, '0'),
  eventType: 'pipeline.activated',
  action: 'pipeline.activate',
  subjectType: 'pipeline',
  subjectId: '9f2c41ab-7d38-4c05-8a61-e0b93f7d52' + String(10 + index),
  actorType: 'USER',
  actorId: '82475274-80eb-432e-85db-c2be567ee543',
  result: 'SUCCEEDED',
  details: { path: LONG_PATH + '&attempt=' + index, sequence: index },
  requestId: null,
  occurredAt: ago(index * 37),
}));

const CENSUS_REGION = ':is([data-testid="page-header"], .status-summary, .console-aside)';

const CENSUS = (region: string) => {
  // The five surfaces the review counted, named by class/testid, never by localized copy.
  const surfaces = [
    { id: 'band', root: document.querySelector('.health-band') },
    { id: 'counts', root: document.querySelector('.stat-block') },
    { id: 'attention', root: document.querySelector('#attention') },
    { id: 'modules', root: document.querySelector('[data-testid="overview-modules"]') },
  ];
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const leaves = (root: Element | null) =>
    root
      ? Array.from(root.querySelectorAll('*')).filter(
          (el) => el.children.length === 0 && visible(el) && (el.textContent || '').trim().length > 0,
        )
      : [];
  const healthLeaves = surfaces.flatMap((surface) =>
    leaves(surface.root).map((el) => ({
      surface: surface.id,
      text: (el.textContent || '').trim(),
      cls: (el.className || '').toString().slice(0, 40),
    })),
  );
  // A health string is a leaf that asserts the platform's state. "Installed plugins" is a count.
  const HEALTH = /ready|healthy|reachable|all clear|no open issues|no activation is blocked|desired replica|nothing stale/i;
  const healthTerm = healthLeaves.filter((leaf) => HEALTH.test(leaf.text));
  // :is() so the region is one selector list: concatenating it twice turns the bare class names
  // into selectors of their own and counts the containers as if they were links.
  const actionables = Array.from(document.querySelectorAll(region + ' a[href], ' + region + ' button'))
    .filter(visible)
    .map((el) => ({
      label: (el.getAttribute('aria-label') || (el.textContent || '')).trim().replace(/\s+/g, ' ').slice(0, 40),
      href: el.getAttribute('href'),
      // A module card is a link to a page, not a verb on this one: the review counted two verbs
      // (Refresh, Install plugin) and one dead anchor, and "4 links to /admin/nodes" is navigation.
      navigation: Boolean(el.closest('.module-strip')),
      tag: el.tagName.toLowerCase(),
    }));
  const anchors = Array.from(document.querySelectorAll(region + ' a[href^="#"]'))
    .filter(visible)
    .map((el) => {
      const href = el.getAttribute('href') || '';
      const target = href.length > 1 ? document.querySelector(href) : null;
      return {
        label: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        href,
        targetItems: target ? target.querySelectorAll('.attention-item').length : null,
      };
    });
  return {
    healthLeaves,
    healthLeafCount: healthLeaves.length,
    healthTermCount: healthTerm.length,
    phrasings: Array.from(new Set(healthTerm.map((leaf) => leaf.text.toLowerCase()))).length,
    readyWordCount: healthLeaves.filter((leaf) => /^ready$/i.test(leaf.text)).length,
    actionables,
    verbs: actionables.filter((entry) => !entry.navigation),
    verbCount: actionables.filter((entry) => !entry.navigation).length,
    anchors,
    deadAnchors: anchors.filter((entry) => entry.targetItems === 0).map((entry) => entry.label),
    moduleRows: Array.from(document.querySelectorAll('[data-module]')).map((el) => ({
      id: el.getAttribute('data-module'),
      indicator: el.getAttribute('data-indicator'),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
    })),
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

/** One card's qualifier line, read off its line boxes rather than off its height. */
const QUALIFIER = () => {
  const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
  const cards = rows.map((tr) => {
    const ident = tr.querySelector('[data-identity-key]') as HTMLElement | null;
    if (!ident) return null;
    const meta = ident.parentElement ? (ident.parentElement.querySelector('.ow-ident-meta') as HTMLElement | null) : null;
    const fact = meta ? (meta.querySelector('.event-detail-fact') as HTMLElement | null) : null;
    const code = meta ? (meta.querySelector('code') as HTMLElement | null) : null;
    return {
      key: ident.getAttribute('data-identity-key') || '',
      card: Math.round(tr.getBoundingClientRect().height * 10) / 10,
      metaHeight: meta ? Math.round(meta.getBoundingClientRect().height * 10) / 10 : null,
      metaLines: meta ? new Set(Array.from(meta.children).map((child) => Math.round(child.getBoundingClientRect().top))).size : null,
      metaOverflow: meta ? meta.scrollWidth - meta.clientWidth : null,
      codeWhiteSpace: code ? getComputedStyle(code).whiteSpace : null,
      codeLineBoxes: code ? new Set(Array.from(code.getClientRects()).map((box) => Math.round(box.top))).size : null,
      factClipped: fact ? fact.scrollWidth > fact.clientWidth + 1 : null,
    };
  }).filter(Boolean);
  // Why the line is two lines, read off the first card. Measured, not argued: the box that wraps,
  // its computed white-space, and the line boxes of the text node that dropped to the second line.
  const first = rows.map((tr) => tr.querySelector('[data-identity-key]')).filter(Boolean)[0] as HTMLElement | undefined;
  const firstMeta = first && first.parentElement ? (first.parentElement.querySelector('.ow-ident-meta') as HTMLElement | null) : null;
  const firstFact = firstMeta ? (firstMeta.querySelector('.event-detail-fact') as HTMLElement | null) : null;
  const style = (el: Element | null) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      cls: (el.className || '').toString(),
      display: cs.display,
      whiteSpace: cs.whiteSpace,
      overflow: cs.overflow,
      textOverflow: cs.textOverflow,
      maxWidth: cs.maxWidth,
      flexShrink: cs.flexShrink,
      flexBasis: cs.flexBasis,
      width: Math.round(box.width * 10) / 10,
      height: Math.round(box.height * 10) / 10,
      top: Math.round(box.top * 10) / 10,
    };
  };
  const textNodeLines = (el: Element | null) => {
    if (!el) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const out: { text: string; boxes: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      out.push({ text: node.textContent.trim().slice(0, 24), boxes: new Set(Array.from(range.getClientRects()).map((box) => Math.round(box.top))).size });
    }
    return out;
  };
  const diagnosis = {
    meta: style(firstMeta),
    metaChildren: firstMeta ? Array.from(firstMeta.children).map(style) : null,
    fact: style(firstFact),
    factInlineChildren: firstFact ? Array.from(firstFact.children).map(style) : null,
    factTextLines: textNodeLines(firstFact),
  };
  return {
    diagnosis,
    rows: cards.length,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    clientWidth: document.documentElement.clientWidth,
    cardHeights: Array.from(new Set((cards as { card: number }[]).map((entry) => entry.card))),
    metaHeights: Array.from(new Set((cards as { metaHeight: number | null }[]).map((entry) => entry.metaHeight))),
    metaLines: Array.from(new Set((cards as { metaLines: number | null }[]).map((entry) => entry.metaLines))),
    metaOverflow: Array.from(new Set((cards as { metaOverflow: number | null }[]).map((entry) => entry.metaOverflow))),
    codeWhiteSpace: Array.from(new Set((cards as { codeWhiteSpace: string | null }[]).map((entry) => entry.codeWhiteSpace))),
    codeLineBoxes: Array.from(new Set((cards as { codeLineBoxes: number | null }[]).map((entry) => entry.codeLineBoxes))),
    clippedCards: (cards as { factClipped: boolean | null }[]).filter((entry) => entry.factClipped).length,
    cards,
  };
};

async function login(page: Page) {
  await page.goto(BASE + '/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

test('overview census at 1440', async ({ browser }) => {
  test.setTimeout(150_000);
  fs.mkdirSync(OUT, { recursive: true });
  const record: Record<string, unknown> = {};
  // Two decks: hiding a dead anchor is only correct if a live one survives. The one-issue deck is
  // the control, not decoration.
  for (const deck of [
    { key: 'healthy', payload: HEALTHY },
    { key: 'oneIssue', payload: WITH_ISSUE },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await page.route('**/api/v1/overview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deck.payload) }),
    );
    await page.route('**/api/v1/diagnostics', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DIAGNOSTICS) }),
    );
    await login(page);
    await page.goto(BASE + '/admin/overview');
    await page.waitForSelector('[data-async-state="ready"]', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    record[deck.key] = await page.evaluate(CENSUS, CENSUS_REGION);
    await page.screenshot({ path: path.join(OUT, 'overview-1440-' + deck.key + '.png'), fullPage: true });
    // The first screen is what the finding is about: everything above the audit ledger.
    await page.screenshot({ path: path.join(OUT, 'overview-1440-' + deck.key + '-fold.png') });
    await context.close();
  }
  fs.writeFileSync(path.join(OUT, '_overview.json'), JSON.stringify(record, null, 1));

  // The instrument must not report a page it did not read.
  const healthy = record.healthy as { healthLeafCount: number; moduleRows: unknown[] };
  if (healthy.healthLeafCount === 0 || healthy.moduleRows.length === 0) {
    throw new Error('the overview deck did not render: ' + JSON.stringify(record.healthy).slice(0, 300));
  }
});

test('activity qualifier line at 390', async ({ browser }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(OUT, { recursive: true });
  const record: Record<string, unknown> = {};
  for (const viewport of [{ w: 390, h: 844 }, { w: 1440, h: 900 }]) {
    const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await page.route('**/api/v1/audit**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUDIT) }),
    );
    await login(page);
    await page.goto(BASE + '/admin/activity');
    await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    record['r' + viewport.w] = await page.evaluate(QUALIFIER);
    await page.screenshot({ path: path.join(OUT, 'activity-' + viewport.w + '-longpayload.png'), fullPage: true });
    await context.close();
  }
  fs.writeFileSync(path.join(OUT, '_activity390.json'), JSON.stringify(record, null, 1));
  const r390 = record.r390 as { rows: number };
  if (r390.rows === 0) throw new Error('no cards measured at 390: ' + JSON.stringify(record.r390).slice(0, 300));
});
