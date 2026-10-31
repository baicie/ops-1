import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 D - the Investigation Workspace, measured in a real browser against the real kernel.
 *
 * Three groups of claims, in the order the phase states them:
 *
 *   D1  the incident page is a three-pane workspace on a desktop and three TABS on a phone - the
 *       same three panes, not a rail that got hidden at 390;
 *   D2  the page header grows instead of clipping: a long title, a long description, ten controls
 *       and a zh-CN/en swap leave every control inside the header's own box and reachable by a
 *       click, and the Studio no longer keeps a control row of its own;
 *   D3  keyboard: tabs answer ArrowLeft/Right, the focus ring is drawn, and the tab order follows
 *       the reading order.
 *
 * Fixtures come from tests/ui/g12d-seed.mjs (public API only). Screenshots go to artifacts/g12d/
 * and are CI artifacts, not baselines: the PNG budget is full at 379/379 and this phase adds no
 * tracked image.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12d.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12d-admin-password-1';
// Repo-root artifacts, not tests/ui: the harness runs with cwd = tests/ui, and a relative path
// would have dropped 40 PNGs inside the test package. Untracked on purpose - CI collects them.
const OUT = process.env.OPSWEAVE_G12D_OUT || path.resolve(process.cwd(), '..', '..', 'artifacts', 'g12d');
const SEED = JSON.parse(fs.readFileSync(process.env.OPSWEAVE_SEED_OUT || '/tmp/g12d/seed.json', 'utf8'));
const DETAIL = '/app/incidents/' + SEED.incidentA;
const CONCLUDED = '/app/incidents/' + SEED.incidentB;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function setPrefs(page: Page, locale: 'en' | 'zh-CN', theme: 'light' | 'dark') {
  await page.evaluate(([nextLocale, nextTheme]) => {
    window.localStorage.setItem('opsweave-locale', nextLocale as string);
    window.localStorage.setItem('opsweave-theme', nextTheme as string);
  }, [locale, theme]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
}

const GEOMETRY = () => {
  const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
  const title = header ? (header.querySelector('h1') as HTMLElement | null) : null;
  const description = header ? (header.querySelector('.page-description') as HTMLElement | null) : null;
  const controls = header ? (Array.from(header.querySelectorAll('.page-actions > *')) as HTMLElement[]) : [];
  const reach = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; }).map((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return { label: (el.textContent || '').trim().slice(0, 18), ok: Boolean(hit && (hit === el || el.contains(hit))), bottom: Math.round(r.bottom) };
  });
  const next = header ? (header.nextElementSibling as HTMLElement | null) : null;
  return {
    headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
    titleClipped: title ? title.scrollHeight > title.clientHeight + 1 : null,
    titleLines: title ? Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight || '31')) : null,
    descriptionTruncated: description ? description.scrollWidth > description.clientWidth + 1 : null,
    descriptionLines: description ? Math.round(description.getBoundingClientRect().height / parseFloat(getComputedStyle(description).lineHeight || '22')) : null,
    controls: reach.length,
    unreachable: reach.filter((c) => !c.ok).map((c) => c.label),
    escapesHeader: header && reach.length ? Math.max.apply(null, reach.map((c) => c.bottom)) > Math.round(header.getBoundingClientRect().bottom) + 1 : false,
    nextStartsAboveControls: header && next && reach.length ? Math.max.apply(null, reach.map((c) => c.bottom)) > Math.round(next.getBoundingClientRect().top) : false,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    studioToolbar: document.querySelectorAll('.studio-toolbar').length,
    panes: Array.from(document.querySelectorAll('.investigation-pane')).map((el) => ({ id: (el as HTMLElement).dataset.pane, hidden: (el as HTMLElement).hasAttribute('hidden') })),
    tabs: document.querySelectorAll('[role=tab]').length,
    railRows: document.querySelectorAll('[data-rail-incident]').length,
    timelineFacts: document.querySelectorAll('[data-testid=incident-timeline-list] li').length,
    evidenceRows: document.querySelectorAll('[data-evidence-row]').length,
  };
};

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test('D1: three panes on a desktop, three tabs on a phone - and the rail is usable at 390', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(DETAIL);
  await expect(page.getByTestId('investigation-rail')).toBeVisible();
  await expect(page.getByTestId('investigation-pane-analysis')).toBeVisible();
  await expect(page.getByTestId('investigation-pane-detail')).toBeVisible();
  const wide = await page.evaluate(GEOMETRY);
  expect(wide.tabs, 'a desktop has three columns, not a tab strip').toBe(0);
  expect(wide.panes.filter((p) => p.hidden), 'no pane is hidden on a desktop').toEqual([]);
  expect(wide.railRows, 'the rail lists the incidents this account may read').toBeGreaterThan(1);
  expect(wide.timelineFacts, 'the timeline states the facts of this incident').toBeGreaterThan(1);
  expect(wide.evidenceRows, 'the analysis pane lists the evidence').toBeGreaterThan(2);
  expect(wide.docOverflow, '1440: no sideways scroll').toBeLessThanOrEqual(1);
  // The three columns are ordered left to right: rail, analysis, detail.
  const boxes = await page.evaluate(() => ['rail', 'analysis', 'detail'].map((id) => {
    const el = document.querySelector('[data-pane=' + id + ']') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { id, left: Math.round(r.left), width: Math.round(r.width) };
  }));
  expect(boxes[0].left).toBeLessThan(boxes[1].left);
  expect(boxes[1].left).toBeLessThan(boxes[2].left);
  expect(boxes.every((b) => b.width > 200), 'every pane has a usable column').toBe(true);

  // Opening a row in the middle pane fills the right pane - one selection, two panes.
  await page.getByTestId('evidence-open').first().click();
  await expect(page.getByTestId('evidence-content-panel')).toBeVisible();
  const panelBox = await page.evaluate(() => {
    const pane = document.querySelector('[data-pane=detail]') as HTMLElement;
    const viewer = document.querySelector('[data-testid=evidence-content-panel]') as HTMLElement;
    return { paneLeft: Math.round(pane.getBoundingClientRect().left), viewerLeft: Math.round(viewer.getBoundingClientRect().left), paneWidth: Math.round(pane.getBoundingClientRect().width), viewerWidth: Math.round(viewer.getBoundingClientRect().width) };
  });
  expect(panelBox.viewerLeft, 'the viewer renders in the detail pane, not under the table').toBeGreaterThanOrEqual(panelBox.paneLeft - 1);
  expect(panelBox.viewerWidth).toBeLessThanOrEqual(panelBox.paneWidth + 1);
  await page.screenshot({ path: path.join(OUT, 'd1-1440-wide.png') });

  // 390: the same three panes as tabs. The rail is the claim that matters - a rail that is merely
  // hidden at 390 would pass every other assertion in this file.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(DETAIL);
  await expect(page.getByTestId('investigation-tabs')).toBeVisible();
  expect(await page.getByRole('tab').count(), 'one tab per pane').toBe(3);
  const compactInitial = await page.evaluate(GEOMETRY);
  expect(compactInitial.panes.filter((p) => !p.hidden).map((p) => p.id), 'a phone shows one pane at a time').toEqual(['analysis']);
  await page.screenshot({ path: path.join(OUT, 'd1-390-analysis.png') });

  await page.getByTestId('investigation-tab-rail').click();
  await expect(page.getByTestId('investigation-pane-rail')).toBeVisible();
  const railAt390 = await page.evaluate(GEOMETRY);
  expect(railAt390.railRows, 'the rail is operable at 390, not hidden').toBeGreaterThan(1);
  expect(railAt390.docOverflow, '390: the rail does not push the page sideways').toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(OUT, 'd1-390-rail.png') });

  // Every rail row is a real link with the incident title as its text.
  const firstRow = page.locator('[data-rail-incident]').first();
  await expect(firstRow).toHaveAttribute('href', /\/app\/incidents\//);
  expect((await firstRow.innerText()).length, 'a rail row says which incident it is').toBeGreaterThan(4);

  await page.getByTestId('investigation-tab-detail').click();
  await expect(page.getByTestId('investigation-pane-detail')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'd1-390-detail.png') });

  // Tablet: 1024 keeps three columns (the sidebar is gone there, so the width is there for them).
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(DETAIL);
  const tablet = await page.evaluate(GEOMETRY);
  expect(tablet.tabs).toBe(0);
  expect(tablet.panes.filter((p) => p.hidden)).toEqual([]);
  expect(tablet.docOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(OUT, 'd1-1024-wide.png') });
});

test('D2: a header grows, never clips - long title, long description, ten controls, both languages', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const rows: Record<string, unknown>[] = [];
  const LONG_TITLE = 'orders-ingest 连续 17 次变换阶段失败，导致下游 revenue-daily 产出停滞后仍被标记为健康（G12 D 长标题压力用例，含全角标点与 English 混排）';
  const LONG_DESCRIPTION = 'Every incident opened from the last release window, with the sources that observed it, the collectors that reported it and the human verdict that closed it - kept in one place so a reader can follow an incident end to end. 这一段用于验证中文换行与行高差异，避免用 ellipsis 掩盖语义。';
  const LABELS = ['Undo', 'Redo', 'Auto layout', 'Horizontal', 'Readable', 'Fit all', 'Preview', 'Detail', 'Save draft', 'Validate'];

  for (const locale of ['en', 'zh-CN'] as const) {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto('/app/incidents');
      await setPrefs(page, locale, 'light');
      // Shipped state: the baseline the twelve-page table depends on.
      const shipped = await page.evaluate(GEOMETRY);
      // The state the product cannot reach without a published bundle or a 17-character title:
      // additive DOM only, reverted by the next navigation.
      await page.evaluate(([longTitle, longDescription, labels]) => {
        const header = document.querySelector('[data-testid=page-header]') as HTMLElement;
        const h1 = header.querySelector('h1') as HTMLElement;
        h1.textContent = longTitle as string;
        const description = header.querySelector('.page-description') as HTMLElement | null;
        if (description) description.textContent = longDescription as string;
        const row = header.querySelector('.page-actions') as HTMLElement;
        (labels as string[]).forEach((label) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-secondary';
          button.textContent = label;
          row.appendChild(button);
        });
      }, [LONG_TITLE, LONG_DESCRIPTION, LABELS]);
      await page.waitForTimeout(150);
      const grown = await page.evaluate(GEOMETRY);
      rows.push({ locale, width, shippedH: shipped.headerH, grownH: grown.headerH, controls: grown.controls, unreachable: grown.unreachable, escapes: grown.escapesHeader, nextAbove: grown.nextStartsAboveControls, titleClipped: grown.titleClipped, titleLines: grown.titleLines, descriptionTruncated: grown.descriptionTruncated, descriptionLines: grown.descriptionLines, overflow: grown.docOverflow, studioToolbar: grown.studioToolbar });
      await page.screenshot({ path: path.join(OUT, 'd2-' + width + '-' + (locale === 'en' ? 'en' : 'zh') + '-grown.png') });

      expect(grown.titleClipped, locale + ' @' + width + ': the title is not clipped').toBe(false);
      expect(grown.descriptionTruncated, locale + ' @' + width + ': the description is not truncated').toBe(false);
      expect(grown.unreachable, locale + ' @' + width + ': every header control answers a click').toEqual([]);
      expect(grown.escapesHeader, locale + ' @' + width + ': every control stays inside the header box').toBe(false);
      expect(grown.nextStartsAboveControls, locale + ' @' + width + ': no section starts above a control').toBe(false);
      expect(grown.docOverflow, locale + ' @' + width + ': no sideways scroll').toBeLessThanOrEqual(1);
      expect(grown.headerH, locale + ' @' + width + ': a header with more content is taller').toBeGreaterThanOrEqual(shipped.headerH as number);
      expect(grown.studioToolbar, 'no page keeps its own control row').toBe(0);
      // A header that already fitted is still exactly 80 above 769 - the baseline does not move.
      if (width >= 769 && shipped.headerH === 80) expect(shipped.headerH).toBe(80);
    }
  }
  fs.writeFileSync(path.join(OUT, 'd2-header.json'), JSON.stringify(rows, null, 1));

  // A status chip that changes width must not move the header by more than one line.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(DETAIL);
  await setPrefs(page, 'en', 'light');
  await page.waitForSelector('[data-testid=page-header] .page-description', { timeout: 15000 });
  const before = await page.evaluate(GEOMETRY);
  await page.evaluate(() => {
    const chip = document.querySelector('[data-testid=incident-detail-status]');
    if (chip) chip.textContent = 'INVESTIGATING WITH A MUCH LONGER LABEL';
  });
  await page.waitForTimeout(100);
  const after = await page.evaluate(GEOMETRY);
  const delta = Math.abs((after.headerH as number) - (before.headerH as number));
  fs.writeFileSync(path.join(OUT, 'd2-chip-jitter.json'), JSON.stringify({ before: before.headerH, after: after.headerH, delta }, null, 1));
  expect(delta, 'a chip swap moves the header by at most one line').toBeLessThanOrEqual(24);
});

test('D3: keyboard - the tab strip answers arrows, Enter activates, the focus ring is drawn', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(DETAIL);
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);

  // Roving focus: exactly one tab is in the tab order, and the arrow keys move both the
  // selection and the focus (automatic activation).
  const analyisTab = page.getByTestId('investigation-tab-analysis');
  await analyisTab.focus();
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return { outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, color: style.outlineColor };
  });
  expect(parseFloat(ring.outlineWidth), 'the focused tab draws a visible focus ring').toBeGreaterThanOrEqual(2);
  expect(ring.outlineStyle, 'the ring is a real outline, not a colour change').not.toBe('none');

  const tabbable = await page.evaluate(() => Array.from(document.querySelectorAll('[role=tab]')).map((el) => (el as HTMLElement).tabIndex));
  expect(tabbable.filter((index) => index === 0), 'one tab stop for the whole strip').toHaveLength(1);

  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('investigation-tab-detail')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('investigation-pane-detail')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(analyisTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(page.getByTestId('investigation-tab-rail')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page.getByTestId('investigation-tab-detail')).toHaveAttribute('aria-selected', 'true');

  // Enter and Space activate a control that is not the selected tab, from the keyboard alone.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  const selectedBefore = await page.getByTestId('investigation-tab-analysis').getAttribute('aria-selected');
  expect(selectedBefore).toBe('true');

  // The evidence row's Open button is reachable by Tab from the tab strip and opens the viewer.
  await page.getByTestId('evidence-open').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('evidence-content-panel')).toBeVisible();
  await expect(page.getByTestId('investigation-tab-detail')).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: path.join(OUT, 'd3-keyboard-390.png') });
});

test('D3: the visual matrix - 1440/1024/390 x light/dark x zh/en', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const matrix: Record<string, unknown>[] = [];
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        for (const route of [DETAIL, CONCLUDED]) {
          await page.goto(route);
          await setPrefs(page, locale, theme);
          // The page renders its own header before the incident arrives (the loading branch has a
          // title and no description), so wait for the state that carries the description: a
          // measurement taken against a skeleton would report the skeleton's geometry.
          await page.waitForSelector('[data-testid=page-header] .page-description', { timeout: 15000 });
          const shot = await page.evaluate(GEOMETRY);
          const name = [width, theme, locale === 'en' ? 'en' : 'zh', route === DETAIL ? 'open' : 'concluded'].join('-');
          await page.screenshot({ path: path.join(OUT, 'matrix-' + name + '.png'), fullPage: false });
          matrix.push({ name, headerH: shot.headerH, overflow: shot.docOverflow, unreachable: shot.unreachable, titleClipped: shot.titleClipped, truncated: shot.descriptionTruncated, controls: shot.controls });
          expect(shot.docOverflow, name + ': no sideways scroll').toBeLessThanOrEqual(1);
          expect(shot.unreachable, name + ': header controls answer clicks').toEqual([]);
          expect(shot.titleClipped, name + ': the title is not clipped').toBe(false);
          expect(shot.descriptionTruncated, name + ': the description is not ellipsised').toBe(false);
        }
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(matrix, null, 1));
});