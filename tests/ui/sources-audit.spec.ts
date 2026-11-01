import { Page, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * /app/sources — the measurement half of the UI spec gate, for the connector surface.
 *
 * Same instrument as `ui-table-audit.spec.ts` (§4.1 of table-spec.md): the geometry readout
 * below is copied from it deliberately rather than refactored into a shared module, because
 * the committed harness is the reference the existing artifacts were measured with and a
 * change there would re-open every page's numbers.
 *
 * Why this spec stubs the session as well as the data: the committed harness logs in against a
 * live kernel, and this host has none running. Auth is therefore answered here with the
 * documented `access` payload (`apps/platform-web/src/surface.ts`) so the workspace shell
 * mounts; the fixtures below then answer only the five routes the Sources page reads. Nothing
 * is faked about the page itself — the component tree, the stylesheet and the browser are real,
 * which is what the measurement is of.
 */
test.use({ channel: process.env.V3_CHANNEL || 'chrome' });

const OUT = process.env.SOURCES_OUT || path.resolve('../../artifacts/ui/sources');
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:5178';

const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();

/**
 * Twelve connectors, which is the shape the gate needs: §2.2's distinct-ratio rule only applies
 * at n >= 10, so a shorter fixture would let every column through unmeasured.
 *
 * The spread is deliberate. Status, reach and trust each vary (so each earns its column), while
 * `publisher` is held at two values across twelve rows — ratio 0.17, below §2.2's 0.2 floor — so
 * the page's own degradation has something real to drop. Two rows share the name "Zabbix" to
 * exercise the §2.1 disambiguator, and one has no signature state at all so UNKNOWN appears as
 * a measured value rather than a hypothetical.
 */
const PLUGINS = [
  { id: 'acme.zabbix', name: 'Zabbix', publisher: 'acme', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 2, total: 2 },
  { id: 'beta.zabbix', name: 'Zabbix', publisher: 'beta-labs', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 1, total: 1 },
  { id: 'acme.prometheus', name: 'Prometheus scrape', publisher: 'acme', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 3, total: 3 },
  { id: 'acme.snmp', name: 'SNMP walk', publisher: 'acme', state: 'ACTIVE', signatureState: 'UNSIGNED', ready: 1, total: 1 },
  { id: 'acme.syslog', name: 'Syslog tap', publisher: 'acme', state: 'ACTIVE', signatureState: null, ready: 1, total: 2 },
  { id: 'acme.cloudwatch', name: 'CloudWatch', publisher: 'acme', state: 'INSTALLED', signatureState: 'VERIFIED', ready: 0, total: 0 },
  { id: 'beta.otel', name: 'OpenTelemetry', publisher: 'beta-labs', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 2, total: 4 },
  { id: 'beta.jmx', name: 'JMX poller', publisher: 'beta-labs', state: 'DISABLED', signatureState: 'VERIFIED', ready: 0, total: 1 },
  { id: 'acme.netflow', name: 'NetFlow', publisher: 'acme', state: 'FAILED', signatureState: 'VERIFIED', ready: 0, total: 2 },
  { id: 'acme.winevent', name: 'Windows events', publisher: 'acme', state: 'ACTIVE', signatureState: 'VERIFIED', ready: 1, total: 1 },
  { id: 'beta.kafka', name: 'Kafka ingest', publisher: 'beta-labs', state: 'STAGED', signatureState: 'VERIFIED', ready: 0, total: 0 },
  { id: 'opsweave.data-integration', name: 'Data integration', publisher: 'trusted-team', state: 'ACTIVE', signatureState: 'SYSTEM', ready: 1, total: 1 },
];

const plugins = PLUGINS.map((row, index) => ({
  id: row.id,
  name: row.name,
  publisher: row.publisher,
  latestVersion: '1.' + index + '.0',
  activeVersion: '1.' + index + '.0',
  state: row.state,
  signatureState: row.signatureState,
  hasFrontend: index % 4 === 0,
  hasBackend: true,
  desiredReplicas: row.total,
  readyInstances: row.ready,
  totalInstances: row.total,
  updatedAt: ago(1 + index * 3),
  isSystem: row.id.startsWith('opsweave.'),
}));

/** Every connector PROVIDES a source-family capability; one REQUIRES one nothing provides. */
const capabilities = [
  ...PLUGINS.map((row, index) => ({
    pluginId: row.id,
    version: '1.' + index + '.0',
    name: index % 3 === 0 ? 'telemetry.metrics.v1' : 'data.source.v1',
    major: 1,
    direction: 'PROVIDES',
    activationRevision: index + 1,
  })),
  // A consumer waiting on a provider that does not exist: its own fact, not a broken row.
  { pluginId: 'acme.dashboards', version: '2.0.0', name: 'telemetry.traces.v1', major: 1, direction: 'REQUIRES', activationRevision: 4 },
  // A non-source capability: proves the page classifies by family instead of listing every plugin.
  { pluginId: 'acme.reporting', version: '1.0.0', name: 'report.render.v1', major: 1, direction: 'PROVIDES', activationRevision: 2 },
];

/** Grants vary so `reach` earns its column: granted, expired, revoked and absent all appear. */
const grants = [
  { id: 'g1', name: 'data.source.v1', major: 1, consumerPluginId: 'acme.dashboards', providerPluginId: 'beta.zabbix', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: null, createdAt: ago(40) },
  { id: 'g2', name: 'telemetry.metrics.v1', major: 1, consumerPluginId: 'acme.dashboards', providerPluginId: 'acme.zabbix', scope: ['data.source.read'], state: 'ACTIVE', expiresAt: null, createdAt: ago(38) },
  { id: 'g3', name: 'telemetry.metrics.v1', major: 1, consumerPluginId: 'acme.reporting', providerPluginId: 'acme.snmp', scope: ['data.source.read'], state: 'EXPIRED', expiresAt: ago(2), createdAt: ago(60) },
  { id: 'g4', name: 'data.source.v1', major: 1, consumerPluginId: 'acme.reporting', providerPluginId: 'acme.syslog', scope: ['data.source.read'], state: 'REVOKED', expiresAt: null, createdAt: ago(70) },
];

const publishers = [
  { publisherId: 'acme', fingerprint: 'ab'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: ago(900), revokedAt: null },
  // Verified bytes from a revoked key: must read OPERATOR_ASSERTED, never attested.
  { publisherId: 'beta-labs', fingerprint: 'cd'.repeat(16), trustState: 'REVOKED', note: null, createdAt: ago(800), revokedAt: ago(10) },
  { publisherId: 'trusted-team', fingerprint: 'ef'.repeat(16), trustState: 'TRUSTED', note: null, createdAt: ago(950), revokedAt: null },
];

const extensions = [
  {
    pluginId: 'acme.zabbix',
    publisher: 'acme',
    version: '1.0.0',
    activationRevision: 1,
    assetBase: '/assets/acme/acme.zabbix/1.0.0',
    remoteEntry: 'remoteEntry.js',
    contributions: [{ kind: 'route.page.v1', id: 'cfg', path: '/ext/acme/zabbix', surface: 'workspace' }],
  },
];

const SESSION = {
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'operator@opsweave.local', role: 'operator', displayName: 'Operator' },
  csrfToken: 'test-csrf',
  access: { allowedSurfaces: ['admin', 'workspace'], capabilities: ['platform:access', 'workspace:access'] },
};

/** Fixtures for exactly the routes the page reads, plus the session. */
const FIXTURES: [RegExp, unknown][] = [
  [/\/api\/v1\/auth\/me$/, SESSION],
  [/\/api\/v1\/plugins$/, plugins],
  [/\/api\/v1\/capabilities$/, capabilities],
  [/\/api\/v1\/capability-grants$/, grants],
  [/\/api\/v1\/publishers$/, publishers],
  [/\/api\/v1\/extensions$/, extensions],
];

async function stub(page: Page, options: { grantsForbidden?: boolean; capabilitiesDown?: boolean; empty?: boolean } = {}) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (options.grantsForbidden && /capability-grants/.test(url.pathname)) {
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'FORBIDDEN', message: 'operator role required' }) });
    }
    if (options.capabilitiesDown && /\/capabilities$/.test(url.pathname)) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: 'registry unavailable' }) });
    }
    if (options.empty && /\/capabilities$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    const hit = FIXTURES.find(([pattern]) => pattern.test(url.pathname));
    if (!hit) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit[1]) });
  });
}

/* ── the §4.1 readout, same instrument as the committed harness ─────────────── */

async function measure(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const client = de.clientWidth;
    const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
    const heights = rows.map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10);
    const pct = (list: number[], p: number) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor((list.length * p) / 100))] : null);
    const identity = Array.from(document.querySelectorAll('[data-identity-key]')).map((el) => el.getAttribute('data-identity-key') || '');
    const keys = Array.from(document.querySelectorAll('tbody tr[data-row-key]')).map((el) => el.getAttribute('data-row-key') || '');
    let run = 0;
    let runMax = 0;
    let previous = '';
    for (const key of keys) {
      run = key === previous ? run + 1 : 1;
      previous = key;
      if (run > runMax) runMax = run;
    }
    const ratios: (number | null)[] = [];
    const columnLabels: string[] = [];
    const tableRowCounts: number[] = [];
    let headCount = 0;
    let noDataPerTable = 0;
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const bodyRows = Array.from(table.querySelectorAll('tbody tr')).filter((tr) => !tr.classList.contains('expanded-row'));
      const cellsOf = (tr: Element) => (Array.from(tr.children) as HTMLElement[]).filter((el) => el.tagName === 'TD');
      let labelled = 0;
      Array.from(table.querySelectorAll('thead th')).forEach((th, index) => {
        if ((th.textContent || '').trim().length === 0) return;
        labelled += 1;
        columnLabels.push((th.textContent || '').trim());
        const values = bodyRows
          .map((tr) => cellsOf(tr)[index])
          .filter((cell): cell is HTMLElement => Boolean(cell))
          .map((cell) => (cell.textContent || '').trim());
        ratios.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
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

    /** §2.5: the 390 card — its identity line, its facts, and whether the key was clipped. */
    const cards = window.innerWidth < 768
      ? Array.from(document.querySelectorAll('tbody tr')).map((tr) => {
        const ident = tr.querySelector('[data-identity-key]') as HTMLElement | null;
        const identBox = ident?.getBoundingClientRect();
        const factCells = Array.from(tr.querySelectorAll('td[data-label]')) as HTMLElement[];
        const visibleFacts = factCells.filter((td) => {
          const style = window.getComputedStyle(td);
          if (style.display === 'none') return false;
          return !td.classList.contains('ow-ident-cell');
        });
        const factValues = visibleFacts
          .map((td) => (td.querySelector('.ow-cell-body')?.textContent || td.textContent || '').trim())
          .filter(Boolean);
        return {
          key: ident?.getAttribute('data-identity-key') || '',
          // The identity line must not be cut: §2.5 keeps name·disambiguator legible.
          clipped: ident ? ident.scrollWidth > ident.clientWidth + 1 : false,
          width: identBox ? Math.round(identBox.width) : 0,
          facts: visibleFacts.length,
          factValues: factValues.length,
        };
      })
      : [];

    const tableRect = (document.querySelector('table') as HTMLElement | null)?.getBoundingClientRect();
    return {
      overflow: de.scrollWidth - client,
      docScrollW: de.scrollWidth,
      docClientW: client,
      docHeight: de.scrollHeight,
      offenders,
      identityKey: identity,
      identityUnique: identity.length ? new Set(identity).size / identity.length : 1,
      rowHeight: { p50: pct(heights, 50), p95: pct(heights, 95), max: heights.length ? Math.max(...heights) : null, n: heights.length },
      columns: headCount,
      distinctRatio: ratios,
      columnLabels,
      tableRowCounts,
      duplicateRunMax: runMax,
      rows: rows.length,
      noDataPerTable,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      cardFactCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.factValues)) : null,
      cardLabelCount: window.innerWidth < 768 && cards.length ? Math.max(...cards.map((c) => c.facts)) : null,
      cards,
      tableWidth: tableRect ? Math.round(tableRect.width) : null,
      tablePanelWidth: (document.querySelector('.table-panel') as HTMLElement | null)?.clientWidth ?? null,
    };
  });
}

const ROUTE = '/app/sources';
const VIEWPORTS = [{ w: 1440, h: 900 }, { w: 1024, h: 800 }, { w: 390, h: 844 }];

for (const viewport of VIEWPORTS) {
  for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'zh-CN']) {
      // The gate reads one artifact per label; the matrix below is the one the task asks to
      // review by hand (1440/1024/390 x light/dark), with zh-CN measured at every width
      // because the §1.5 overflow reading is locale-sensitive.
      const label = 'r' + viewport.w + '-' + theme + '-' + (locale === 'en' ? 'en' : 'zh');
      test(label, async ({ browser }) => {
        test.setTimeout(120_000);
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, baseURL: BASE });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem('opsweave-theme', t as string);
          localStorage.setItem('opsweave-locale', l as string);
        }, [theme, locale]);
        const page = await context.newPage();
        await stub(page);
        await page.goto(BASE + ROUTE);
        await page.waitForSelector('[data-testid=sources-table-panel], [data-async-state=empty]', { timeout: 20000 });
        await page.waitForTimeout(400);

        const metrics = await measure(page);
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(
          path.join(OUT, '_metrics_' + label + '.json'),
          JSON.stringify({ config: { label, theme, locale, route: ROUTE, data: 'fixtures' }, pages: { [ROUTE]: metrics } }, null, 1),
        );
        await page.screenshot({ path: path.join(OUT, label + '__sources.png'), fullPage: true });

        // The drawer is part of the page's state matrix, so it is captured too.
        if (theme === 'light' && locale === 'en') {
          await page.click('tbody tr:first-child [data-testid=row-actions]');
          await page.click('[data-action=inspect]');
          await page.waitForSelector('[data-testid=sources-detail]', { timeout: 10000 });
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(OUT, label + '__sources-drawer.png'), fullPage: true });
        }
        await context.close();
      });
    }
  }
}

/** The three degraded states, measured rather than asserted from the component tree. */
const STATES: Array<{ key: string; options: Parameters<typeof stub>[1] }> = [
  { key: 'grants-forbidden', options: { grantsForbidden: true } },
  { key: 'registry-down', options: { capabilitiesDown: true } },
  { key: 'empty', options: { empty: true } },
];

for (const state of STATES) {
  test('state-' + state.key, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, baseURL: BASE });
    await context.addInitScript(() => {
      localStorage.setItem('opsweave-theme', 'light');
      localStorage.setItem('opsweave-locale', 'en');
    });
    const page = await context.newPage();
    await stub(page, state.options);
    await page.goto(BASE + ROUTE);
    await page.waitForSelector('[data-testid=sources-table-panel], [data-async-state=empty], [data-async-state=error], [data-async-state=forbidden]', { timeout: 20000 });
    await page.waitForTimeout(400);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'state-' + state.key + '.png'), fullPage: true });

    // A withheld grants list must never read as "nothing may call this": the page says so.
    if (state.key === 'grants-forbidden') {
      await expect(page.locator('[data-notice]').first()).toBeVisible();
      const reach = await page.locator('tbody tr').first().innerText();
      expect(reach).toContain('Unknown');
    }
    // The capability registry is what classifies a plugin as a source; without it the page
    // must state that, not render an empty table that reads as "no connectors installed".
    if (state.key === 'registry-down') {
      const body = await page.locator('body').innerText();
      expect(body).not.toContain('No connectors installed');
    }
    await context.close();
  });
}

/** Security: the credential field is a reference field, and the page prints no secret. */
test('credential-field-refuses-secrets', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, baseURL: BASE });
  await context.addInitScript(() => {
    localStorage.setItem('opsweave-theme', 'light');
    localStorage.setItem('opsweave-locale', 'en');
  });
  const page = await context.newPage();
  await stub(page);
  await page.goto(BASE + ROUTE);
  await page.waitForSelector('[data-testid=sources-table-panel]', { timeout: 20000 });
  await page.click('tbody tr:first-child [data-testid=row-actions]');
  await page.click('[data-action=configure]');
  await page.waitForSelector('[data-testid=sources-config-form]', { timeout: 10000 });

  const PASTED = 'Bearer eyJhbGciOiJIUzI1NiJ9.super-secret-value';
  await page.fill('[data-testid=sources-credential-input]', PASTED);
  await page.click('[data-testid=sources-config-submit]');
  const error = page.locator('[data-testid=sources-credential-error]');
  await expect(error).toBeVisible();

  // The refusal must not quote what was refused: that would put the token in the DOM.
  const errorText = await error.innerText();
  expect(errorText).not.toContain('super-secret-value');
  expect(errorText).not.toContain('eyJhbGciOiJIUzI1NiJ9');

  // And nothing anywhere on the page may echo it, including a preview block.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('super-secret-value');

  // The input is deliberately not a password field: this is where a NAME goes, not a secret.
  await expect(page.locator('[data-testid=sources-credential-input]')).toHaveAttribute('type', 'text');

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'state-credential-refused.png'), fullPage: true });
  await context.close();
});
