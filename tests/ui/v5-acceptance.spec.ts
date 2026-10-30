import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * V5 acceptance: every interaction state is captured WITH the assertion that proves it.
 *
 * The V4 evidence pack was rejected because two screenshots shared one MD5 and one "dialog"
 * image contained no dialog. A file name is not evidence, so nothing here is written without
 * an assertion that would fail if the state were absent: the shot is taken after the DOM
 * proves it, and the measured numbers land in _measurements.json.
 */
const OUT = path.resolve('../../artifacts/ui/v5');
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const PLUGIN_ID = 'dev.opsweave.hello';
const OVERVIEW = /\/api\/v1\/overview/;
const metrics: Array<Record<string, unknown>> = [];

fs.mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function shot(page: Page, name: string, fullPage = true) {
  await page.waitForTimeout(140);
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage, animations: 'disabled' });
  const bytes = fs.statSync(file).size;
  expect(bytes, name + ' must not be an empty file').toBeGreaterThan(2000);
  metrics.push({ shot: name + '.png', bytes });
}

function record(name: string, value: unknown) {
  metrics.push({ measure: name, value });
}

test.afterAll(() => {
  fs.writeFileSync(path.join(OUT, '_measurements.json'), JSON.stringify(metrics, null, 2) + '\n');
});

// ── component states ────────────────────────────────────────────────────────────────────

test('state: error - the kernel does not answer', async ({ page }) => {
  await login(page);
  await page.route(OVERVIEW, (route) => route.abort('failed'));
  await page.goto('/admin/overview');
  const panel = page.locator('[data-async-state="error"]');
  await expect(panel, 'an unanswered source must render the error panel').toBeVisible();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.locator('h2')).toBeVisible();
  await expect(page.locator('[data-async-state="ready"]')).toHaveCount(0);
  await shot(page, 'state-error-1440');
});

test('state: loading - the first answer has not settled', async ({ page }) => {
  await login(page);
  await page.route(OVERVIEW, () => new Promise<void>(() => { /* never answers */ }));
  await page.goto('/admin/overview');
  const loading = page.locator('[data-async-state="loading"]');
  await expect(loading, 'a pending source is LOADING, never empty and never healthy').toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-health]')).toHaveCount(0);
  await shot(page, 'state-loading-1440');
});

test('state: empty - an unconfigured platform is neutral, with three steps and one CTA', async ({ page }) => {
  await login(page);
  const live = await page.evaluate(async () => (await fetch('/api/v1/overview')).json());
  await page.route(OVERVIEW, (route) => route.fulfill({
    json: { ...live, health: 'READY', nodesTotal: 0, nodesReady: 0, pluginsInstalled: 0, pluginsAvailable: 0, instancesTotal: 0, instancesReady: 0, activeDeployments: 0, attention: [], recentEvents: [] },
  }));
  await page.goto('/admin/overview');

  const band = page.locator('section.health-band[data-health="NOT_CONFIGURED"]');
  await expect(band, 'READY with 0 nodes and 0 plugins must not claim health').toBeVisible();
  await expect(band).toHaveClass(/tone-neutral/);
  // V5 printed "Not configured yet" twice on this band (the state chip and the headline), so
  // the phrase said nothing new the second time. The chip carries the verdict word once; the
  // headline now says what the verdict means, and the assertion forbids them being the same.
  const verdictWord = (await band.locator('.status-indicator').innerText()).trim();
  expect(verdictWord, 'the chip carries the verdict word').toBe('Not configured');
  const headline = (await band.locator('h2').innerText()).trim();
  expect(headline, 'the headline explains the verdict instead of repeating it').toBe('Nothing is observed yet: no node, no plugin');
  expect(headline, 'the verdict word must not be printed twice').not.toBe(verdictWord);
  await expect(band.locator('h2')).not.toHaveText('Platform is ready');
  await expect(band.locator('.status-indicator')).toHaveAttribute('data-indicator', 'notConfigured');

  const setup = page.locator('[data-testid="overview-setup"]');
  await expect(setup).toBeVisible();
  await expect(setup.locator('.setup-step')).toHaveCount(3);
  await expect(setup.locator('.setup-actions a'), 'one primary action, not two').toHaveCount(1);

  // P0-2: the topbar pill and the rail read the body's verdict, so an unconfigured platform
  // cannot be announced as "Platform ready" in the chrome above it.
  await expect(page.getByTestId('health-pill'), 'the pill follows the body verdict').toHaveAttribute('data-verdict', 'not-configured');
  await expect(page.getByTestId('health-pill')).toHaveText(/Not configured/);
  await expect(page.getByTestId('health-pill')).not.toHaveText(/ready/i);
  await expect(page.locator('[data-version-field="status"] strong'), 'the rail cannot say READY here').toHaveText('Not configured');

  const values = page.locator('.stat-strip .ow-metric-value');
  await expect(values.nth(0), '0/0 is not a ratio').toHaveText('—');
  await expect(values.nth(2)).toHaveText('—');
  await expect(page.locator('.stat-strip')).not.toContainText('0/0');

  // 1440px is where the rail is narrowest (240px): a truncated value here turns the
  // served-SHA self-proof back into an unlabelled hex string.
  const railFit = await page.locator('[aria-label="Deployment version"]').evaluate((footer) => {
    return Array.from(footer.querySelectorAll('[data-version-field] > strong')).map((node) => {
      const element = node as HTMLElement;
      return { field: element.parentElement?.getAttribute('data-version-field'), text: element.textContent, scroll: element.scrollWidth, client: element.clientWidth };
    });
  });
  for (const field of railFit) {
    expect(field.scroll, 'the value of ' + field.field + ' is fully rendered: ' + field.text).toBeLessThanOrEqual(field.client + 1);
  }
  record('empty: rail fields', railFit);
  record('empty: verdict', await band.getAttribute('data-health'));
  record('empty: metric[0]', (await values.nth(0).innerText()).trim());
  await shot(page, 'state-empty-1440');
});

test('state: forbidden - a 403 is a wall, not an error and not a retry', async ({ page }) => {
  await login(page);
  await page.route(OVERVIEW, (route) => route.fulfill({ status: 403, json: { code: 'FORBIDDEN', message: 'refused by v5-acceptance.spec' } }));
  await page.goto('/admin/overview');
  const wall = page.locator('[data-async-state="forbidden"]');
  await expect(wall).toBeVisible();
  await expect(wall.locator('.status-indicator')).toHaveAttribute('data-indicator', 'forbidden');
  await expect(wall.locator('.btn'), 'a permission wall offers no retry').toHaveCount(0);
  await shot(page, 'state-forbidden-1440');
});

test('state: dialog - a real modal with a real scrim', async ({ page }) => {
  await login(page);
  await page.goto('/admin/nodes');
  // The dialog is the same whether or not a node is enrolled, so open it from the page's one
  // primary action instead of assuming this fixture has an empty node list.
  await page.locator('.page-header .page-actions > *').last().click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog, 'the state is a dialog, so a dialog element must exist').toBeVisible();
  const overlay = page.locator('.ow-dialog-overlay');
  await expect(overlay).toHaveCount(1);
  const alpha = await overlay.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(alpha, 'the page behind a modal is not readable at full contrast').toBe('rgba(0, 0, 0, 0.6)');
  const box = await dialog.boundingBox();
  expect(box && box.width > 320).toBeTruthy();
  record('dialog: overlay', alpha);
  await shot(page, 'state-dialog-1440', false);
});

test('state: form-error - a rejected sign-in says so in place', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', 'not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const alert = page.locator('[role="alert"]');
  await expect(alert, 'a failed sign-in must be announced, not silent').toBeVisible();
  await expect(alert).not.toBeEmpty();
  await expect(page).toHaveURL(/\/login/);
  await shot(page, 'state-form-error-1440');
});

// ── overlay states at phone width ───────────────────────────────────────────────────────

test('state: drawer - the off-canvas rail covers the page with a scrim', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/admin/overview');
  await page.locator('[data-testid="sidebar-trigger"]').click();
  const rail = page.locator('.admin-sidebar[data-open="true"]');
  await expect(rail, 'the drawer is open, not parked').toBeVisible();
  const scrim = page.locator('[data-testid="sidebar-scrim"]');
  await expect(scrim).toHaveCount(1);
  const colour = await scrim.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(colour, 'a drawer without a scrim leaves the page readable').toBe('rgba(0, 0, 0, 0.4)');
  const box = await scrim.boundingBox();
  // scrollbar-gutter: stable reserves the rail on <html>, so a fixed inset:0 scrim is the
  // viewport minus that gutter; it must still span the full visible height.
  expect(box && box.width >= 374, 'the scrim spans the viewport width').toBeTruthy();
  expect(box && box.height >= 842, 'the scrim spans the viewport height').toBeTruthy();
  record('drawer: scrim', { colour, box });
  await shot(page, 'state-drawer-390', false);
});

test('state: command palette - one entry list, anchored at 20vh, full width on a phone', async ({ page }) => {
  await login(page);
  await page.goto('/admin/overview');
  await page.locator('[data-testid="command-trigger"]').click();
  const palette = page.locator('[data-testid="command-palette"]');
  await expect(palette).toBeVisible();
  const desktopItems = await page.locator('[data-testid="command-option"]').count();
  const desktopBox = await page.locator('.ow-command-dialog').boundingBox();
  expect(desktopBox && Math.abs(desktopBox.y - 180) <= 12, 'desktop palette sits at 20vh').toBeTruthy();
  const overlay = await page.locator('.ow-dialog-overlay').evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(overlay).toBe('rgba(0, 0, 0, 0.6)');
  record('command: desktop items', desktopItems);
  record('command: desktop top', desktopBox?.y);
  await shot(page, 'state-command-1440', false);

  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="command-trigger"]').click();
  await expect(palette).toBeVisible();
  const mobileItems = await page.locator('[data-testid="command-option"]').count();
  expect(mobileItems, 'the phone palette must list the same destinations as the desktop one').toBe(desktopItems);
  const mobileBox = await page.locator('.ow-command-sheet').boundingBox();
  // scrollbar-gutter: stable reserves the rail on <html>; full width is the visible viewport.
  expect(mobileBox && mobileBox.width >= 374, 'the phone palette is full width').toBeTruthy();
  expect(mobileBox && mobileBox.y <= 1, 'the phone palette is top aligned').toBeTruthy();
  record('command: mobile items', mobileItems);
  await shot(page, 'state-sheet-390', false);
});

test('state: hover and focus are two different signals', async ({ page }) => {
  await login(page);
  await page.goto('/admin/overview');
  const link = page.locator('.admin-sidebar a[href="/admin/nodes"]');
  await link.hover();
  // The hover wash is transitioned (100ms); measuring mid-flight reports the interpolated
  // colour, not the one a reader ends up seeing.
  await page.waitForTimeout(300);
  const hovered = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });
  expect(hovered.background, 'hover must be visible, not a 2% wash').toBe('rgb(240, 242, 245)');
  expect(hovered.shadow).toContain('rgb(52, 87, 213)');
  record('hover: nav background', hovered.background);
  await shot(page, 'state-hover-1440', false);

  await page.mouse.move(600, 600);
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return { tag: element.tagName, cls: element.className, width: style.outlineWidth, offset: style.outlineOffset, colour: style.outlineColor, style: style.outlineStyle };
  });
  expect(ring.width, 'focus is an outline, never a border').toBe('2px');
  expect(ring.offset).toBe('2px');
  expect(ring.colour).toBe('rgb(52, 87, 213)');
  expect(ring.style).toBe('solid');
  record('focus: ring', ring);
  await shot(page, 'state-focus-1440', false);
});

// ── measured defects ───────────────────────────────────────────────────────────────────

test('table rows share one baseline: every cell starts on the same line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/admin/plugins');
  const row = page.locator('.plugins-table tbody tr').first();
  await expect(row).toHaveCount(1);
  // Every value cell reserves the same two rows, so the first line of each starts at one y.
  const tops = await row.evaluate((tr) => Array.from(tr.querySelectorAll('td .ow-cell > *:first-child')).map((element) => {
    const box = (element as HTMLElement).getBoundingClientRect();
    return { tag: (element as HTMLElement).className || (element as HTMLElement).tagName, top: Math.round(box.top * 100) / 100 };
  }));
  expect(tops.length, 'the row carries the two-row cells').toBeGreaterThanOrEqual(6);
  const offsets = tops.map((entry) => entry.top);
  const spread = Math.max(...offsets) - Math.min(...offsets);
  record('table: cell top offsets', tops);
  record('table: baseline spread', spread);
  expect(spread, 'cells must not start ' + spread + 'px apart').toBeLessThanOrEqual(1);
  const height = await row.evaluate((tr) => Math.round(tr.getBoundingClientRect().height));
  expect([56, 60], 'one row height for every table row, not a per-row 44/52/61').toContain(height);
  record('table: row height', height);
  await shot(page, 'state-table-baseline-1440');
});

test('plugin detail fills three columns and keeps every hash on one line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/admin/plugins/' + PLUGIN_ID);
  await expect(page.locator('.page-header h1')).toBeVisible();
  const panels = page.locator('.plugin-detail-grid > .panel');
  await expect(panels).toHaveCount(3);
  const boxes = await panels.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width) };
  }));
  expect(new Set(boxes.map((box) => box.y)).size, 'the three columns start on one line').toBe(1);
  const widths = boxes.map((box) => box.w);
  expect(Math.max(...widths) - Math.min(...widths), 'three equal columns').toBeLessThanOrEqual(2);
  record('detail: columns', boxes);

  const chips = page.locator('.detail-meta .meta-chip');
  // How many chips exist depends on the served activation, but their shape may not.
  expect(await chips.count()).toBeGreaterThan(0);
  await expect(chips.first()).toBeVisible();
  const chip = await chips.evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return [style.paddingLeft, style.fontSize, style.borderRadius].join('|');
  }));
  expect(new Set(chip).size, 'five siblings, one recipe: ' + chip.join(' / ')).toBe(1);
  record('detail: chip recipe', chip[0]);

  const hashes = page.locator('.kv').filter({ has: page.locator('.kv-hash') });
  const hashCount = await hashes.count();
  expect(hashCount).toBeGreaterThan(0);
  for (let index = 0; index < hashCount; index += 1) {
    // One line box, not two: a wrapped hash would report two client rects.
    const hash = await hashes.nth(index).locator('.kv-hash').evaluate((node) => {
      const element = node as HTMLElement;
      return { height: Math.round(element.getBoundingClientRect().height), lines: element.getClientRects().length };
    });
    expect(hash.lines, 'a hash and its copy control stay on one line').toBe(1);
    expect(hash.height).toBeLessThanOrEqual(20);
  }
  record('detail: hash rows', hashCount);
  await shot(page, 'state-plugin-detail-1440');
});

test('390: breadcrumb, tabs, panel head, separator and the odd summary cell', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await page.goto('/admin/plugins');
  await expect(page.locator('.plugins-table')).toBeVisible();
  const crumbs = page.locator('.admin-breadcrumb .breadcrumb-item:visible');
  expect(await crumbs.count(), 'a phone breadcrumb is one title, not "P... / O..."').toBe(1);

  const strip = page.locator('.ow-filter-scroll');
  const tabs = await strip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, mask: style.maskImage || style.webkitMaskImage || 'none' };
  });
  expect(tabs.mask, 'a clipped tab fades out instead of being cut in half').toContain('gradient');
  // "Avai" was a cut label: prove the last tab can be brought fully into view instead of
  // asserting a width that only happens to overflow on one machine.
  await strip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  const reachable = await strip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const last = element.querySelector('[role="tab"]:last-of-type') as HTMLElement | null;
    if (!last) return false;
    const box = last.getBoundingClientRect();
    return box.right <= bounds.right + 1 && box.left >= bounds.left - 1;
  });
  expect(reachable, 'the last filter tab is fully readable once the strip is scrolled').toBe(true);
  record('390: tab strip', tabs);

  const badge = page.locator('[aria-label="Deployment version"]');
  const badgeText = await badge.innerText();
  expect(badgeText, 'no interpunct may hang at a line end').not.toContain('·');
  expect(badgeText).toContain('Commit');

  // "Commit" only counts if the value beside it is legible: at 240px the environment used
  // to render as "STAGI...", which is not a served-SHA self-proof.
  const envFit = await page.locator('[data-version-field="environment"] strong').evaluate((element) => {
    const node = element as HTMLElement;
    return { text: node.textContent, scroll: node.scrollWidth, client: node.clientWidth };
  });
  expect(envFit.scroll, 'the environment value is not truncated: ' + envFit.text).toBeLessThanOrEqual(envFit.client + 1);
  const crumbFit = await page.locator('.admin-breadcrumb .breadcrumb-item span[aria-current="page"]').evaluate((element) => {
    const node = element as HTMLElement;
    return { text: node.textContent, scroll: node.scrollWidth, client: node.clientWidth };
  });
  expect(crumbFit.scroll, 'the phone title is readable, not "Overvi...": ' + crumbFit.text).toBeLessThanOrEqual(crumbFit.client + 1);
  record('390: deployment block', badgeText.replace(/\n/g, ' / '));
  record('390: truncated?', { env: envFit, crumb: crumbFit });

  // Measured, not read off a declaration: "grid-column: span 2" computes grid-column-START,
  // so the honest check is that the odd last cell is as wide as its row.
  const summary = page.locator('.ow-summary-card');
  const span = await summary.last().evaluate((element) => {
    const row = (element.parentElement as HTMLElement).getBoundingClientRect();
    const card = element.getBoundingClientRect();
    return { card: Math.round(card.width), row: Math.round(row.width), columns: getComputedStyle(element.parentElement as HTMLElement).gridTemplateColumns };
  });
  expect(Math.abs(span.card - span.row), 'the odd last cell spans the row instead of leaving a bare divider').toBeLessThanOrEqual(2);
  expect(span.columns.split(' ').length, 'the strip itself is two columns at this width').toBe(2);
  record('390: odd summary cell', span);

  // With no node enrolled the Nodes page renders its empty state and has no panel head at
  // all, so the header contract is measured where one is always rendered: Overview's work queue.
  await page.goto('/admin/overview');
  const overviewHead = page.locator('#attention .panel-head');
  await expect(overviewHead).toBeVisible();
  const headStyle = await overviewHead.evaluate((element) => {
    const style = getComputedStyle(element);
    const title = element.querySelector('h2') as HTMLElement;
    const count = element.querySelector('.panel-count, .text-link, .btn') as HTMLElement | null;
    return {
      wrap: style.flexWrap,
      titleY: title ? Math.round(title.getBoundingClientRect().top) : null,
      countY: count ? Math.round(count.getBoundingClientRect().top) : null,
    };
  });
  expect(headStyle.wrap, 'a count that drops to its own line is not a heading').toBe('nowrap');
  if (headStyle.countY !== null && headStyle.titleY !== null) {
    expect(Math.abs(headStyle.countY - headStyle.titleY)).toBeLessThanOrEqual(6);
  }
  record('390: panel head', headStyle);
  await shot(page, 'state-390-defects');
});

test('contrast: the status word, the tertiary label and canvas captions clear 4.5:1', async ({ page }) => {
  await login(page);
  await page.goto('/admin/overview');
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return {
      okInk: read('--ow-ok-ink'), okSoft: read('--ow-ok-soft'),
      tertiary: read('--ow-text-tertiary'), surface: read('--ow-surface'),
      canvasText: read('--ow-canvas-text'), canvas: read('--ow-canvas-bg'),
      readyColor: getComputedStyle(document.createElement('span')).color,
    };
  });
  function luminance(hex: string) {
    const value = hex.replace('#', '');
    const parts = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
    const linear = parts.map((channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }
  function ratio(a: string, b: string) {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  }
  const measured = {
    statusOnSoft: ratio(tokens.okInk, tokens.okSoft),
    tertiaryOnSurface: ratio(tokens.tertiary, tokens.surface),
    canvasText: ratio(tokens.canvasText, tokens.canvas),
  };
  record('contrast', measured);
  expect(tokens.okInk).toBe('#0a6b49');
  expect(tokens.tertiary).toBe('#6b7380');
  expect(tokens.canvasText).toBe('#4b5563');
  expect(measured.statusOnSoft).toBeGreaterThanOrEqual(4.5);
  expect(measured.tertiaryOnSurface).toBeGreaterThanOrEqual(4.5);
  expect(measured.canvasText).toBeGreaterThanOrEqual(4.5);
});

test('attention: the count has a referent - a 3px tone rule and a pill on every row', async ({ page }) => {
  await login(page);
  // One attention row, injected: a seeded platform may legitimately have none, and this test
  // is about the row the count refers to, not about which warning the fixture happens to hold.
  const live = await page.evaluate(async () => (await fetch('/api/v1/overview')).json());
  await page.route(OVERVIEW, (route) => route.fulfill({
    json: {
      ...live,
      health: 'ATTENTION',
      attention: [{ severity: 'warning', title: 'Node lab-node-1 heartbeat is stale', detail: 'Node lab-node-1 has not sent a heartbeat for longer than the stale threshold.', link: '/nodes' }],
    },
  }));
  await page.goto('/admin/overview');
  // Wait for the panel to paint before counting: reading rows straight after goto measured
  // whatever had rendered so far, not what the page shows.
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();
  const rows = page.locator('#attention .attention-item');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count, 'the seeded kernel carries at least one attention row').toBeGreaterThan(0);
  const style = await rows.first().evaluate((element) => {
    const computed = getComputedStyle(element);
    return { width: computed.borderLeftWidth, pill: Boolean(element.querySelector('.status-indicator')) };
  });
  expect(style.width, 'the row the count refers to must be visibly marked').toBe('3px');
  expect(style.pill).toBeTruthy();
  const heading = await page.locator('#attention .panel-count').innerText();
  record('attention', { rows: count, marker: style.width, count: heading.trim() });
  await shot(page, 'state-attention-1440');
});

test('zh-CN: CJK copy keeps its own line height and loses uppercase tracking', async ({ page }) => {
  await login(page);
  await page.evaluate(() => window.localStorage.setItem('opsweave-locale', 'zh-CN'));
  await page.goto('/admin/overview');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const zh = await page.evaluate(() => {
    const label = document.querySelector('.nav-section-label') as HTMLElement;
    const style = getComputedStyle(label);
    return {
      bodyLineHeight: getComputedStyle(document.body).lineHeight,
      transform: style.textTransform,
      tracking: style.letterSpacing,
    };
  });
  // Dates follow the console language: Intl with an explicit locale, not the browser default
  // that printed "Oct 30, 01:24:35 PM" inside a Chinese page.
  await expect(page.locator('[data-async-state="ready"]').first()).toBeVisible();
  const observed = await page.locator('[data-testid="overview-observed"]').innerText();
  expect(observed, 'a zh-CN page formats its dates in zh-CN: ' + observed).toMatch(/月/);
  expect(zh.transform, 'uppercase is a Latin device').toBe('none');
  expect(zh.tracking === 'normal' || parseFloat(zh.tracking) === 0, 'no positive tracking on CJK: ' + zh.tracking).toBe(true);
  expect(parseFloat(zh.bodyLineHeight), 'CJK needs more air than 1.36').toBeGreaterThanOrEqual(1.55 * 14);
  record('zh-CN', zh);
  await shot(page, 'state-zh-1440');
  await page.evaluate(() => window.localStorage.setItem('opsweave-locale', 'en'));
});
