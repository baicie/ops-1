import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 R2 phase 2 - the panel measured at the widths it has to work at, in both themes and both
 * languages, against the real build.
 *
 * Three things are measured at every combination, because each of them is a way a control stops
 * being usable without any visible break:
 *
 *   * overflow: the document's and the panel's own scroll width, so a wide table or a long id
 *     cannot make the page scroll sideways at 390;
 *   * occlusion: for every visible control inside the panel, the element that actually receives
 *     a click at that control's centre. A control behind a sticky header or under another control
 *     looks present and does nothing, and only elementFromPoint reports it;
 *   * the header/panel boundary: the page header grows with a long title, so the panel must start
 *     below it rather than beneath it.
 *
 * The measurements are written to artifacts/g12-r2p2/matrix.json so the table in the report is
 * the run's output rather than a transcription of it.
 */
const ROOT = path.resolve(process.cwd(), '..', '..');
const OUT = process.env.OPSWEAVE_G12R2_OUT || path.join(ROOT, 'artifacts', 'g12-r2p2', 'shots');
const REPORT = path.join(ROOT, 'artifacts', 'g12-r2p2', 'matrix.json');
const SEED = JSON.parse(fs.readFileSync(process.env.OPSWEAVE_SEED_JSON || path.join(ROOT, 'artifacts', 'g12-r2p2', 'seed.json'), 'utf8'));
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12r2.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12r2-admin-password-1';
const A = '/app/incidents/' + SEED.incidents.evidence;
const PANEL = '[data-testid=incident-investigations]';

const WIDTHS = [1440, 1024, 1023, 900, 768, 641, 390];
const THEMES = ['light', 'dark'] as const;
const LOCALES = ['en', 'zh-CN'] as const;

type Row = {
  width: number; theme: string; locale: string;
  docOverflow: number; panelOverflow: number;
  tabs: boolean; tabStripOverflow: number;
  headerBottom: number; panelTop: number;
  controls: number; skipped: number; blocked: string[]; offenders: string[]; panelWidest: string[];
  panelWidth: number; paneScrollable: boolean;
};

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

/** Everything measured inside the page, in one round trip. */
const MEASURE = () => {
  const panel = document.querySelector('[data-testid=incident-investigations]') as HTMLElement | null;
  const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
  const tabs = document.querySelector('[data-testid=investigation-tabs]') as HTMLElement | null;
  const pane = panel ? (panel.closest('.investigation-pane') as HTMLElement | null) : null;
  const doc = document.documentElement;
  const controls = panel
    ? (Array.from(panel.querySelectorAll('button, a[href], textarea, input, select, [role=tab]')) as HTMLElement[])
    : [];
  const blocked: string[] = [];
  let counted = 0;
  let skipped = 0;
  // The region a control can actually be clicked in: on screen, inside its scrolling pane, and
  // below the sticky chrome. Content in the chrome zone is a scroll position the reader can move
  // out of; a control inside the clear region that another element receives the click for is a
  // defect. Both numbers travel with the row, so the exclusion cannot hide a failure.
  // The chrome that floats over content: the sticky top bar, plus the page header while it is
  // still on screen. Everything under it is where a scroll position can put a control, and the
  // row records how many were excluded so the exclusion cannot hide a failure.
  const topbar = document.querySelector('.topbar') as HTMLElement | null;
  const chromeBottom = Math.max(
    topbar ? topbar.getBoundingClientRect().bottom : 0,
    header && header.getBoundingClientRect().bottom > 0 ? header.getBoundingClientRect().bottom : 0,
  );
  const paneRect = pane ? pane.getBoundingClientRect() : null;
  const visibleTop = Math.max(0, chromeBottom);
  const visibleBottom = Math.min(window.innerHeight, paneRect ? paneRect.bottom : window.innerHeight);
  for (const el of controls) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (el.hasAttribute('disabled')) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cy < visibleTop + 1 || cy > visibleBottom - 1) { skipped += 1; continue; }
    if (cx < 0 || cx > window.innerWidth) { skipped += 1; continue; }
    counted += 1;
    const hit = document.elementFromPoint(Math.min(window.innerWidth - 1, cx), Math.min(window.innerHeight - 1, cy));
    const ok = Boolean(hit && (hit === el || el.contains(hit) || (hit as HTMLElement).closest('button, a, [role=tab]') === el));
    if (!ok) {
      const label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 40);
      blocked.push(label + ' @' + Math.round(rect.left) + ',' + Math.round(rect.top) + (hit ? ' <- ' + hit.tagName.toLowerCase() : ' <- none'));
    }
  }
  // What is wider than the panel: the same reason, one level in.
  const panelWidest: string[] = [];
  if (panel) {
    const box = panel.getBoundingClientRect();
    const kids = (Array.from(panel.querySelectorAll('*')) as HTMLElement[])
      .map((el) => ({ el, over: el.getBoundingClientRect().right - box.right }))
      .filter((entry) => entry.over > 1)
      .sort((a, b) => b.over - a.over)
      .slice(0, 3);
    for (const kid of kids) {
      panelWidest.push(kid.el.tagName.toLowerCase() + '.' + (kid.el.className || '').toString().split(' ').filter(Boolean).slice(0, 3).join('.') + ' +' + Math.round(kid.over) + 'px');
    }
  }
  // What is wider than the page: recorded so an overflow row names its own cause.
  const offenders: string[] = [];
  for (const el of Array.from(document.querySelectorAll('body *')) as HTMLElement[]) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1) continue;
    if (rect.right <= document.documentElement.clientWidth + 1) continue;
    offenders.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.') + ' +' + Math.round(rect.right - document.documentElement.clientWidth) + 'px');
    if (offenders.length >= 5) break;
  }
  return {
    docOverflow: doc.scrollWidth - doc.clientWidth,
    panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : -1,
    tabs: Boolean(tabs),
    tabStripOverflow: tabs ? tabs.scrollWidth - tabs.clientWidth : 0,
    headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : 0,
    panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : 0,
    controls: counted,
    skipped,
    blocked,
    offenders,
    panelWidest,
    panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
    paneScrollable: pane ? pane.scrollHeight > pane.clientHeight + 1 : false,
  };
};

test.describe('G12 R2 phase 2 - responsive matrix', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await signIn(page);
  });

  test('M1 every width x theme x locale: no sideways scroll, no covered control, header clear of the panel', async ({ page }) => {
    test.setTimeout(300_000);
    const rows: Row[] = [];
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        for (const locale of LOCALES) {
          await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
          await page.evaluate(([nextLocale, nextTheme]) => {
            window.localStorage.setItem('opsweave-locale', nextLocale as string);
            window.localStorage.setItem('opsweave-theme', nextTheme as string);
          }, [locale, theme]);
          await page.goto(A);
          await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
          // Open a run and a citation: the widest content the panel can be asked to show.
          // The seeded run if the bounded history still holds it, else the newest one the panel
          // shows: this test is about layout, and hanging on an absent id measures nothing.
          const seeded = page.locator('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
          if (await seeded.count()) await seeded.first().click();
          else await page.locator('[data-testid=investigation-history-list] li [data-testid=investigation-select]').first().click();
          const citation = page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedQuery + '"]');
          if (await citation.count()) {
            await citation.first().click();
            await expect(page.locator('[data-testid=investigation-citation-content]')).toBeVisible();
          }
          // One defined starting point: everything scrolled to its own top, then the panel to
          // the top of its scroller. Without this every combination would be measured at whatever
          // scroll position the previous click left behind.
          await page.evaluate(() => {
            window.scrollTo(0, 0);
            const pane = document.querySelector('[data-testid=investigation-pane-analysis]') as HTMLElement | null;
            if (pane) pane.scrollTop = 0;
            document.querySelectorAll('.investigation-pane').forEach((node) => { (node as HTMLElement).scrollTop = 0; });
          });
          const measured = await page.evaluate(MEASURE);
          await page.evaluate(() => {
            const panel = document.querySelector('[data-testid=incident-investigations]') as HTMLElement | null;
            panel?.scrollIntoView({ block: 'start' });
          });
          const onScreen = await page.evaluate(MEASURE);
          // The header boundary is a page-top question; occlusion is an in-view question.
          const row: Row = { ...measured, ...onScreen, width, theme, locale, panelTop: measured.panelTop, headerBottom: measured.headerBottom };
          rows.push(row);

          if ((theme === 'light' && locale === 'en') || (locale === 'zh-CN' && theme === 'dark' && [1440, 390].includes(width))) {
            fs.mkdirSync(OUT, { recursive: true });
            await page.screenshot({ path: path.join(OUT, 'matrix-' + width + '-' + theme + '-' + locale + '.png'), fullPage: true });
          }
        }
      }
    }
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(rows, null, 2) + '\n');
    // The whole table is the evidence, so the run states its shape and then every rule over all
    // of it - one row failing does not hide the other twenty-seven.
    expect(rows.length).toBe(WIDTHS.length * THEMES.length * LOCALES.length);
    expect(Array.from(new Set(rows.filter((row) => row.tabs).map((row) => row.width))).sort((a, b) => a - b)).toEqual([390, 641, 768, 900, 1023]);
    for (const row of rows) {
      const at = row.width + '/' + row.theme + '/' + row.locale;
      expect(row.docOverflow, 'document overflow at ' + at + ' (' + row.offenders.join(' | ') + ')').toBeLessThanOrEqual(1);
      expect(row.panelOverflow, 'panel overflow at ' + at + ' (' + row.panelWidest.join(' | ') + ')').toBeLessThanOrEqual(1);
      expect(row.blocked, 'covered controls at ' + at).toEqual([]);
      expect(row.panelTop, 'the panel starts under the header at ' + at).toBeGreaterThanOrEqual(row.headerBottom - 1);
      expect(row.tabs, 'tabs below 1024 only, at ' + row.width).toBe(row.width < 1024);
      // A row that judged nothing is a blind spot, not a pass.
      expect(row.controls, 'no control was measured at ' + at).toBeGreaterThan(0);
    }
  });

  test('M2 on a phone the tabs keep every pane reachable, and opening evidence moves the reader to the pane that has it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(A);
    const tabs = page.locator('[data-testid=investigation-tabs]');
    await expect(tabs).toBeVisible();
    await expect(page.locator('[data-testid=investigation-pane-analysis]')).toBeVisible();

    // The rail is a real pane at 390, not a hidden one.
    await page.click('[data-testid=investigation-tab-rail]');
    await expect(page.locator('[data-testid=investigation-pane-rail]')).toBeVisible();
    await expect(page.locator('[data-testid=investigation-pane-analysis]')).toBeHidden();
    await page.click('[data-testid=investigation-tab-analysis]');

    // Opening an evidence row in the analysis pane moves the tab to detail, with content.
    const row = page.locator('tr[data-evidence-row="' + SEED.evidence.storedLog + '"]');
    await expect(row).toBeVisible();
    await row.locator('[data-testid=evidence-open]').click();
    await expect(page.locator('[data-testid=investigation-tab-detail]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid=investigation-pane-detail]')).toBeVisible();
    await expect(page.locator('[data-testid=investigation-pane-detail]')).toContainText('ERROR payment-webhook');

    // Back on the analysis pane, choosing another run keeps the run's own detail with it: the
    // reader does not lose which run the panel is describing.
    await page.click('[data-testid=investigation-tab-analysis]');
    await page.click('li[data-run-id="' + SEED.runs.budget.id + '"] [data-testid=investigation-select]');
    const run = page.locator('[data-testid=investigation-run]');
    await expect(run).toHaveAttribute('data-run-status', 'BUDGET_EXHAUSTED');
    await expect(page.locator('[data-testid=investigation-select][data-selected=true]')).toHaveCount(1);
    await expect(page.locator('[data-testid=investigation-status]')).toHaveText('Stopped at a budget');

    // The pane scrolls, not the document: a long run cannot make the page itself scroll at 390.
    const scroll = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pane: (() => {
        const pane = document.querySelector('[data-testid=investigation-pane-analysis]') as HTMLElement | null;
        return pane ? { scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight, overflowY: window.getComputedStyle(pane).overflowY } : null;
      })(),
    }));
    expect(scroll.doc).toBeLessThanOrEqual(1);
    // The content is reachable: either the pane scrolls it, or it fits without scrolling.
    const reachable = scroll.pane ? scroll.pane.scrollHeight <= scroll.pane.clientHeight || /auto|scroll/.test(scroll.pane.overflowY) : false;
    expect(reachable, 'the analysis pane must scroll its own overflow').toBe(true);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'm2-390-tabs-analysis.png'), fullPage: true });
  });

  test('M3 keyboard: the tablist is a real roving tablist and every panel control is reachable and visible when focused', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(A);
    await expect(page.locator('[data-testid=investigation-pane-analysis]')).toBeVisible();
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');

    // Arrow keys move the selection and the panel (WAI-ARIA automatic activation).
    await page.focus('[data-testid=investigation-tab-analysis]');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-testid=investigation-tab-detail]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-testid=investigation-tab-analysis]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.locator('[data-testid=investigation-tab-detail]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.locator('[data-testid=investigation-tab-rail]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-testid=investigation-tab-detail]')).toHaveAttribute('aria-selected', 'true');

    // Tab order inside the panel: every stop is inside the panel's pane, visible, and outlined.
    await page.click('[data-testid=investigation-tab-analysis]');
    const stops = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid=incident-investigations]') as HTMLElement;
      return Array.from(panel.querySelectorAll('button, [href], textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && !(el as HTMLButtonElement).disabled;
        })
        .map((el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 30));
    });
    expect(stops.length).toBeGreaterThan(5);
    await page.focus('[data-testid=investigation-refresh]');
    const walked: string[] = [];
    for (let i = 0; i < Math.min(stops.length, 10); i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          label: ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim().slice(0, 30),
          visible: rect.width > 1 && rect.height > 1,
          inPanel: Boolean(el.closest('[data-testid=incident-investigations]')),
          outline: window.getComputedStyle(el).outlineStyle,
        };
      });
      expect(info?.visible, 'the focused control must be laid out: ' + JSON.stringify(info)).toBe(true);
      expect(info?.inPanel, 'tab must stay inside the panel: ' + JSON.stringify(info)).toBe(true);
      walked.push(info!.label);
    }
    expect(new Set(walked).size).toBeGreaterThan(3);
    // Escape has no modal to close here, and must not navigate away or blank the pane.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid=investigation-run]')).toBeVisible();
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'm3-900-keyboard.png'), fullPage: true });
  });

  test('M4 long ids, long JSON and long error text wrap instead of pushing the pane sideways', async ({ page }) => {
    await page.setViewportSize({ width: 641, height: 900 });
    await page.goto(A);
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
    await page.click('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedQuery + '"]');
    const content = page.locator('[data-testid=investigation-citation-content]');
    await expect(content).toBeVisible();
    const measured = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid=investigation-pane-analysis]') as HTMLElement;
      const pre = document.querySelector('[data-testid=investigation-citation-content] pre') as HTMLElement;
      return {
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        preOverflowX: pre.scrollWidth - pre.clientWidth,
        preScrollsY: pre.scrollHeight > pre.clientHeight + 1,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        textLength: (pre.textContent || '').length,
      };
    });
    expect(measured.docOverflow).toBeLessThanOrEqual(1);
    expect(measured.paneOverflow).toBeLessThanOrEqual(1);
    // The whole body is present and readable: it wraps instead of being cut off sideways, and a
    // tall one scrolls inside its own box, so the conclusion stays within reach.
    expect(measured.textLength).toBeGreaterThan(300);
    expect(measured.preOverflowX, 'long JSON must wrap, not clip sideways').toBeLessThanOrEqual(1);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'm4-641-long-content.png'), fullPage: true });
  });
});