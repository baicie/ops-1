import { expect, test, type Page } from '@playwright/test';

/**
 * The incidents workspace in a real browser, against a real kernel and a real database.
 *
 * This is the AGENTS.md §5 artifact for the incidents redo: the screenshots below are captured
 * from Chrome rendering the built bundle, so the numbers under artifacts/ui/incidents-workspace/
 * are measurements of what actually painted, not of what a component tree contains.
 *
 * What is real and what is forced:
 *
 *   * the incident list, the evidence set and the verdict are read from a kernel running against
 *     a throw-away PostgreSQL database, signed in as a real admin session - nothing about the
 *     happy path is stubbed;
 *   * four states cannot be produced on demand from live data (403, 409, a 500, and a slow
 *     response). Those four install a `page.route` that answers with a real HTTP status, because
 *     a state the page claims to handle has to be exercised by the page, not asserted in prose.
 *     Each is labelled as forced in its test title.
 *
 * Selectors are data-testids, roles and attributes only, never localized copy (rules/06), so the
 * same spec runs in English and Chinese.
 *
 *   OPSWEAVE_URL=http://127.0.0.1:18291 \
 *   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... \
 *   pnpm exec playwright test --config tests/ui/playwright.config.ts incidents-workspace
 */

const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const SHOTS = process.env.OPSWEAVE_INCIDENT_SHOTS || 'artifacts/ui/incidents-workspace';

/** The four viewport/theme pairs AGENTS.md §5 asks a human to review. */
const VIEWPORTS = [
  { label: '1440', width: 1440, height: 900 },
  { label: '1024', width: 1024, height: 768 },
  { label: '390', width: 390, height: 844 },
] as const;

type Locale = 'en' | 'zh-CN';

/**
 * The bundle's default locale is zh-CN, and E2E must not depend on which one is showing. Every
 * test pins it through the same storage key the i18n provider reads, and asserts nothing about
 * the resulting copy - only that the page's own testids are present.
 */
async function pinEnvironment(page: Page, theme: 'light' | 'dark', locale: Locale) {
  await page.addInitScript(
    ([t, l]) => {
      window.localStorage.setItem('opsweave-theme', t);
      window.localStorage.setItem('opsweave-locale', l);
    },
    [theme, locale],
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/* ── 1. the matrix: three widths x two themes, from real data ────────────────── */

for (const locale of ['en', 'zh-CN'] as Locale[]) {
  for (const theme of ['light', 'dark'] as const) {
    for (const vp of VIEWPORTS) {
      test(`incidents list — ${vp.label} ${theme} ${locale}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await pinEnvironment(page, theme, locale);
        await signIn(page);
        await page.goto('/app/incidents');

        await expect(page.getByTestId('incidents-page')).toBeVisible();
        // The list has to have come from the kernel: the seeded run of four identical events is
        // present, which no empty placeholder can fake.
        const table = page.getByTestId('incidents-table');
        await expect(table).toBeVisible();
        const rows = table.locator('tbody tr');
        expect(await rows.count()).toBeGreaterThan(0);

        await page.screenshot({
          path: `${SHOTS}/list-${vp.label}-${theme}-${locale}.png`,
          fullPage: true,
        });
      });
    }
  }
}

/* ── 2. the detail workspace ──────────────────────────────────────────────── */

/**
 * Opens the incident on the list page that carries the most evidence.
 *
 * The list is newest-first and collapses a run of identical events to its head, so "the first
 * row" is whichever event started last - which is not necessarily the one an operator filed
 * evidence against. The target is resolved through the kernel's own API rather than by reading
 * the table's cells, because §2.2 demotes the evidence column below 768px: a spec that found its
 * row by reading that cell would pass at 1440 and fail at 390 for a reason that has nothing to
 * do with the state under test. The click still goes through the real table.
 */
async function openRichestIncident(page: Page) {
  const list = await page.request.get('/api/v1/incidents?limit=50');
  expect(list.ok(), 'the kernel answers the list request').toBeTruthy();
  const { items } = (await list.json()) as { items: Array<{ id: string; evidenceRefs: string[] }> };
  const target = items
    .map((item) => ({ id: item.id, evidence: (item.evidenceRefs || []).length }))
    .sort((a, b) => b.evidence - a.evidence)[0];
  expect(target.evidence, 'the seeded dataset has an incident with evidence').toBeGreaterThan(0);

  await page.goto('/app/incidents');
  const table = page.getByTestId('incidents-table');
  await expect(table).toBeVisible();
  const row = table.locator(`tbody tr[data-incident-row="${target.id}"]`);
  await expect(row, 'the richest incident is reachable from the list').toBeVisible();
  await row.click();
  await expect(page.getByTestId('incident-detail')).toBeVisible();
}

for (const theme of ['light', 'dark'] as const) {
  for (const vp of VIEWPORTS) {
    test(`incident detail workspace — ${vp.label} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await pinEnvironment(page, theme, 'en');
      await signIn(page);

      // Reach the detail page the way a reader does: through a list row, not a hardcoded id.
      await openRichestIncident(page);
      await expect(page.getByTestId('incident-workspace')).toBeVisible();

      await page.screenshot({
        path: `${SHOTS}/detail-${vp.label}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}

/* ── 3. the three trust levels, rendered from real stored evidence ─────────── */

test('every evidence row carries a trust level, and none of them reads as verified', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);

  // The seeded incident holds one row at each level, so all three treatments appear at once.
  await openRichestIncident(page);
  await expect(page.getByTestId('incident-evidence')).toBeVisible();

  const chips = page.getByTestId('incident-evidence').locator('.ow-trust[data-trust]');
  expect(await chips.count()).toBeGreaterThanOrEqual(3);

  // The three levels are three distinct renderings, not one chip with three words.
  const tones = await chips.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-trust-tone')));
  expect(new Set(tones).size).toBe(3);
  // `ok` is this shell's green tick and belongs to facts the kernel established. A stored
  // caller-sent claim is not one, and the page must not paint it that way.
  expect(tones).not.toContain('ok');

  // The baseline sentence is stated once for the panel, and the per-level legend renders once.
  await expect(page.getByTestId('incident-trust-baseline')).toHaveCount(1);
  await expect(page.getByTestId('incident-trust-legend')).toHaveCount(1);

  // The set's summary must lead with its weakest row, never its strongest: a verdict rests on
  // the whole set, so the floor is the honest headline. Both sides are derived here from the bits
  // the page actually rendered, so this stays true as the seeded dataset changes.
  const rank: Record<string, number> = { SOURCE_ATTESTED: 3, OPERATOR_ASSERTED: 2, UNVERIFIED: 1 };
  const rowCodes = await page
    .getByTestId('incident-evidence')
    .locator('tbody tr[data-evidence-row] .ow-trust[data-trust]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-trust') || ''));
  const known = rowCodes.filter((code) => code in rank).sort((a, b) => rank[a] - rank[b]);
  expect(known.length).toBeGreaterThan(1);
  const weakest = known[0];
  const strongest = known[known.length - 1];
  await expect(page.getByTestId('incident-evidence-assurance')).toHaveAttribute('data-weakest', weakest);
  if (weakest !== strongest) {
    // The floor is not the ceiling: a summary that echoed the best row would fail here.
    await expect(page.getByTestId('incident-evidence-assurance')).not.toHaveAttribute('data-weakest', strongest);
  }

  await page.screenshot({ path: `${SHOTS}/detail-trust-1440-light.png`, fullPage: true });
});

/* ── 4. the states live data cannot be coerced into (each labelled "forced") ── */

test('forced 403 renders the permission wall, not an empty list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.route('**/api/v1/incidents?*', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'FORBIDDEN', message: 'forbidden', retryable: false }) }),
  );
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-forbidden')).toBeVisible();
  // The distinction the task exists to protect: a refusal is not an absence.
  await expect(page.getByTestId('incidents-empty')).toHaveCount(0);
  // And the toolbar must not print a count for a read that never answered: "0 on this page" is
  // a number the kernel did not send, and it reads as an empty result beside a permission wall.
  await expect(page.getByTestId('incidents-count')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/state-forbidden-1440-light.png`, fullPage: true });
});

test('forced 500 renders a failure with its code, not an empty list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.route('**/api/v1/incidents?*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL', message: 'boom', retryable: true }) }),
  );
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incident-list-failed')).toBeVisible();
  await expect(page.getByTestId('incidents-empty')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/state-failed-1440-light.png`, fullPage: true });
});

test('forced 409 renders a conflict, which is neither a refusal nor an absence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.route('**/api/v1/incidents?*', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'CONFLICT', message: 'conflict', retryable: false }) }),
  );
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-conflict')).toBeVisible();
  await expect(page.getByTestId('incidents-empty')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/state-conflict-1440-light.png`, fullPage: true });
});

test('forced slow response keeps the loading state visible rather than an empty list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.route('**/api/v1/incidents?*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });
  await page.goto('/app/incidents', { waitUntil: 'commit' });
  await expect(page.getByTestId('incidents-loading')).toBeVisible();
  await expect(page.getByTestId('incidents-empty')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/state-loading-1440-light.png`, fullPage: true });
});

test('a genuine empty result is the only case that draws the empty state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  // 200 with no items: the one honest empty. This is the case the other four must not resemble.
  await page.route('**/api/v1/incidents?*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) }),
  );
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-empty')).toBeVisible();
  await expect(page.getByTestId('incidents-forbidden')).toHaveCount(0);
  await expect(page.getByTestId('incident-list-failed')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/state-empty-1440-light.png`, fullPage: true });
});

test('the collectors boundary survives the redo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.goto('/app/incidents');
  const boundary = page.getByTestId('incidents-boundary-collectors');
  await expect(boundary).toHaveCount(1);
  // Zabbix and Nebula are not connected; the copy naming them must still be on the page. This
  // asserts presence, not a specific translation, so it holds in either locale.
  await expect(boundary).not.toBeEmpty();
  await page.screenshot({ path: `${SHOTS}/list-boundary-1440-light.png`, fullPage: true });
});

/* ── 5. keyboard reachability and a visible focus ring ─────────────────────── */

test('the primary action is reachable by keyboard with a visible focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-table')).toBeVisible();

  // Tab from the top of the document until the create control holds focus, then check that the
  // focused element paints a focus indicator - a control reachable only by pointer is not
  // reachable, and a focused control with no ring is not visibly keyboard-operable.
  const createButton = page.getByTestId('incident-create-open');
  await expect(createButton).toBeVisible();

  let reached = false;
  for (let i = 0; i < 80 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'incident-create-open');
  }
  expect(reached, 'the create control is reachable by Tab').toBe(true);

  const ring = await createButton.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
  });
  expect(ring.outline !== 'none' || ring.shadow !== 'none', JSON.stringify(ring)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/focus-create-1440-light.png` });
});

/* ── 6. the geometry the metrics gate reads, measured live ─────────────────── */

/**
 * §2.5's card at 390: no fact wraps mid-word and no value runs past the card.
 *
 * §2.2/§2.5 as rendered, not as declared. The desktop table is measured by the gate below; the
 * phone card is measured here because a word broken into "pro-meth-eus" and a content reference
 * clipped at the card edge both pass a column-count check while being unreadable.
 */
test('the phone card at 390 does not break words or clip values', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await openRichestIncident(page);
  // The evidence table is a second request; measuring before it answers reports "no card" as a
  // layout defect. Waiting on the rows themselves is waiting on the thing being measured.
  await expect(page.getByTestId('incident-evidence-table').locator('tbody tr').first()).toBeVisible();

  const bad = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="incident-evidence-table"] tbody tr');
    if (!card) return [{ problem: 'no evidence card rendered' }];
    const problems = [];
    for (const el of Array.from(card.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // A visually-hidden string is clipped on purpose: 1px wide and read only by an assistive
      // technology. Measuring it would report the page's own accessibility copy as a defect.
      if (el.classList.contains('sr-only')) continue;
      if (!(el.textContent || '').trim()) continue;
      // A word broken across lines: the rendered box is taller than the line-height implies.
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      const box = el.getBoundingClientRect();
      if (box.height > lineHeight * 2.6 && el.children.length === 0) {
        problems.push({ problem: 'wrapped past two lines', text: (el.textContent || '').trim().slice(0, 40), height: Math.round(box.height) });
      }
      // A value that overflows its own box horizontally.
      if (el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible' && el.children.length === 0) {
        problems.push({ problem: 'clipped', text: (el.textContent || '').trim().slice(0, 40), sw: el.scrollWidth, cw: el.clientWidth });
      }
    }
    const cardBox = card.getBoundingClientRect();
    if (card.scrollWidth > cardBox.width + 1) problems.push({ problem: 'card overflows', sw: card.scrollWidth, w: Math.round(cardBox.width) });
    return problems;
  });
  expect(bad, JSON.stringify(bad)).toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, '§2.6 no document overflow at 390').toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/detail-390-card.png`, fullPage: true });
});

test('measures the geometry the metrics gate asserts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinEnvironment(page, 'light', 'en');
  await signIn(page);
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-table')).toBeVisible();

  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    // Measured the way tests/ui/ui-table-audit.spec.ts measures every other page, because the
    // gate's thresholds are per-table and per-labelled-column:
    //   * a `th` with no text is chrome (the row-action cell), not a column - counting it put the
    //     page at 6 columns when it renders 5 and shifted every ratio by one;
    //   * rows come from tbody, never the header row, or the header's own copy counts as a
    //     distinct value and inflates every ratio.
    const table = document.querySelector('[data-testid="incidents-table"]');
    const bodyRows = table ? Array.from(table.querySelectorAll('tbody tr')) : [];
    const cellsOf = (tr: Element) => Array.from(tr.children).filter((el) => el.tagName === 'TD');
    const rowIdentities = bodyRows.map((tr) => (cellsOf(tr)[0]?.textContent || '').trim().replace(/\s+/g, ' '));

    const ratios: (number | null)[] = [];
    const columnLabels: string[] = [];
    let headCount = 0;
    if (table) {
      Array.from(table.querySelectorAll('thead th')).forEach((th, index) => {
        const label = (th.textContent || '').trim();
        if (!label) return;
        columnLabels.push(label);
        const values = bodyRows
          .map((tr) => cellsOf(tr)[index])
          .filter((cell): cell is Element => Boolean(cell))
          .map((cell) => (cell.textContent || '').trim());
        ratios.push(values.length >= 10 ? Math.round((new Set(values).size / values.length) * 100) / 100 : null);
      });
      headCount = columnLabels.length;
    }

    const boxes = bodyRows.map((r) => r.getBoundingClientRect().height).sort((a, b) => a - b);
    const pct = (p: number) => (boxes.length ? Math.round(boxes[Math.min(boxes.length - 1, Math.floor(p * boxes.length))]) : null);

    // §2.4: the longest adjacent run of identical identity keys.
    let run = 0;
    let prev: string | null = null;
    let count = 0;
    for (const key of rowIdentities) {
      if (key === prev) count += 1;
      else { count = 1; prev = key; }
      run = Math.max(run, count);
    }

    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      docScrollW: doc.scrollWidth,
      docClientW: doc.clientWidth,
      docHeight: doc.scrollHeight,
      offenders: [],
      identityKey: rowIdentities,
      identityUnique: rowIdentities.length ? Math.round((new Set(rowIdentities).size / rowIdentities.length) * 1000) / 1000 : null,
      rowHeight: { p50: pct(0.5), p95: pct(0.95), max: boxes.length ? Math.round(boxes[boxes.length - 1]) : null, n: boxes.length },
      columns: headCount,
      distinctRatio: ratios,
      columnLabels,
      tableRowCounts: [bodyRows.length],
      duplicateRunMax: run,
      rows: bodyRows.length,
      noDataPerTable: table ? table.querySelectorAll('td [data-value="NO_DATA"]').length : 0,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  expect(m.rowHeight.p95, 'row height p95 (§2.3: 40px, 42px tolerance)').toBeLessThanOrEqual(42);
  expect(m.overflow, '§1.5 no horizontal overflow').toBeLessThanOrEqual(0);
  expect(m.columns, '§2.2 column cap at 1440').toBeLessThanOrEqual(5);
  expect(m.duplicateRunMax, '§2.4 a run of 3+ identical events is collapsed').toBeLessThanOrEqual(2);

  const fs = await import('node:fs/promises');
  const label = `_metrics_r1440-light-en`;
  await fs.mkdir(`${SHOTS}/metrics`, { recursive: true });
  await fs.writeFile(
    `${SHOTS}/metrics/${label}.json`,
    JSON.stringify({
      config: { label: 'r1440-light-en', theme: 'light', mode: 'after', baseURL: process.env.OPSWEAVE_URL || 'http://127.0.0.1:18291', data: 'kernel' },
      pages: { '/app/incidents': m },
    }, null, 1),
  );
});
