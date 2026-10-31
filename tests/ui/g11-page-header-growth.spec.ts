import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G11 D3-follow-up - .page-header must be able to grow.
 *
 * The defect this spec exists for was measured, not predicted: at >=769px .page-header declared
 * `height: 80px`, so a header whose copy and actions do not share one line wrapped its actions
 * to a second flex line that fell OUTSIDE the declared box, and the next section - a later sibling
 * in normal flow, therefore painted on top of those escaped pixels - took the click. Playwright
 * reported "incidents-boundary subtree intercepts pointer events" on the create button.
 *
 * The fix is one property: `min-height` instead of `height`. Two things must be true afterwards, and
 * both are asserted here rather than argued:
 *
 *   1. a header whose content does NOT fit grows, so its actions stay inside its own box;
 *   2. a header whose content DOES fit is still exactly 80px with the first block at the same y -
 *      on all twelve pages, at 1440/1024/390. This is the visual baseline that must not move.
 *
 * The "before" side of both tables is measured in the same run by re-applying the previous
 * declaration to the live page (`height:80px; min-height:0` in an injected style element). That is a
 * counterfactual, not a rebuild: it is labelled as such wherever it is reported, and it exists so
 * the before/after pair comes from one DOM at one instant instead of from two commits the reader
 * has to trust.
 *
 * No product copy is changed and no response is stubbed: the long-content case is an additive DOM
 * injection (a longer description string plus extra buttons), which is the only way to exercise a
 * state the product does not ship today without shipping it.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = process.env.OPSWEAVE_HEADER_OUT || 'artifacts/g11-d3';

/** The declaration this spec is about, re-applied to a live page to measure the "before" side. */
const PREVIOUS_RULE = '.page-header{height:80px !important;min-height:0 !important}';

/** Twelve pages that render the shared header: the whole admin surface plus the workspace list. */
const PAGES = [
  { slug: 'overview', route: '/admin/overview' },
  { slug: 'nodes', route: '/admin/nodes' },
  { slug: 'plugins', route: '/admin/plugins' },
  { slug: 'plugins-install', route: '/admin/plugins/install' },
  { slug: 'pipelines', route: '/admin/pipelines' },
  { slug: 'jobs', route: '/admin/jobs' },
  { slug: 'governance', route: '/admin/governance' },
  { slug: 'activity', route: '/admin/activity' },
  { slug: 'access', route: '/admin/access' },
  { slug: 'settings', route: '/admin/settings' },
  { slug: 'diagnostics', route: '/admin/settings/diagnostics' },
  { slug: 'incidents', route: '/app/incidents' },
];
const WIDTHS = [1440, 1024, 390];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(new RegExp('/login'));
}

/**
 * Everything the two tables read, in one evaluate: the header's own box, the first block below it,
 * and - for every visible control in the action row - whether the pointer reaches that control.
 * "Reached" is the defect's own test: elementFromPoint at the control's centre must resolve to the
 * control (or something inside it). A covered button answers with the covering panel instead.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
    if (!header) return null;
    const box = header.getBoundingClientRect();
    const actions = Array.from(header.querySelectorAll('.page-actions > *')) as HTMLElement[];
    const controls = actions
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        const inside = y >= 0 && y <= window.innerHeight && x >= 0 && x <= window.innerWidth;
        return {
          label: (el.textContent || '').trim().slice(0, 24) || el.getAttribute('data-testid') || el.tagName.toLowerCase(),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          inViewport: inside,
          reached: Boolean(hit && (hit === el || el.contains(hit) || (hit as HTMLElement).closest('[data-testid=page-header] .page-actions') === el.parentElement)),
          reachedBy: hit ? String(hit.className || hit.tagName).slice(0, 60) : null,
        };
      });
    const next = header.nextElementSibling as HTMLElement | null;
    const nextTop = next ? Math.round(next.getBoundingClientRect().top) : null;
    const lowestControl = controls.reduce((max, c) => Math.max(max, c.bottom), 0);
    return {
      headerH: Math.round(box.height),
      headerTop: Math.round(box.top),
      headerBottom: Math.round(box.bottom),
      firstBlockY: nextTop,
      gap: nextTop === null ? null : nextTop - Math.round(box.bottom),
      lowestControl,
      actionsInsideHeader: lowestControl <= Math.round(box.bottom) + 1,
      nextCoversActions: nextTop !== null && lowestControl > nextTop,
      controls,
      allReached: controls.every((c) => c.reached),
      actions: (header.querySelector('.page-actions') as HTMLElement | null)
        ? Math.round((header.querySelector('.page-actions') as HTMLElement).getBoundingClientRect().height)
        : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

test('a header whose copy and actions do not fit grows instead of painting its actions under the next section', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto('/app/incidents');
  const create = page.getByTestId('incident-create-open');
  await expect(create).toBeVisible();

  // 1. The shipped state of the page, before anything is injected: this is the geometry the
  //    twelve-page baseline depends on, so it is measured here as well as in the table below.
  const natural = await measure(page);
  expect(natural, 'the incidents page renders the shared header').not.toBeNull();
  expect(natural!.headerH, 'a header that fits is still exactly 80px').toBe(80);
  expect(natural!.allReached, 'the shipped create button is the element a click reaches').toBe(true);

  // 2. Inject the state the product does not ship: a description long enough to need more than one
  //    line and four extra actions. Additive DOM only - no product string is edited, and a reload
  //    is enough to put the page back.
  await page.evaluate(() => {
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement;
    const description = header.querySelector('.page-description');
    if (description) {
      description.textContent = 'Every incident opened from the last release window, with the sources that '
        + 'observed it, the collectors that reported it and the human verdict that closed it - kept here '
        + 'so a reader can follow one incident end to end without leaving the page.';
    }
    const row = header.querySelector('.page-actions') as HTMLElement;
    for (const label of ['Export', 'Assign', 'Snooze', 'Link evidence']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.setAttribute('data-probe-action', label);
      button.textContent = label;
      row.appendChild(button);
    }
  });
  const shipped = await measure(page);
  expect(shipped, 'the injected page still renders the header').not.toBeNull();
  await page.screenshot({ path: path.join(OUT, 'header-growth-injected.png'), fullPage: true });

  // 3. The same packaged DOM with the PREVIOUS declaration re-applied. This is the counterfactual:
  //    if 80px was only ever a floor this changes nothing, and if it was a bound it puts the defect
  //    back. Measured, never assumed.
  await page.addStyleTag({ content: PREVIOUS_RULE });
  const previous = await measure(page);
  await page.screenshot({ path: path.join(OUT, 'header-growth-injected-previous-rule.png'), fullPage: true });
  const styleHandles = await page.evaluateHandle(() => document.querySelectorAll('style'));
  await page.evaluate(() => {
    for (const tag of Array.from(document.querySelectorAll('style'))) {
      if (/height:80px !important;min-height:0 !important/.test(tag.textContent || '')) tag.remove();
    }
  });
  void styleHandles;
  const restored = await measure(page);

  fs.writeFileSync(
    path.join(OUT, 'header-growth.json'),
    JSON.stringify({ route: '/app/incidents', viewport: 1440, natural, shipped, previous, restored }, null, 1),
  );

  // The claims, in the order the defect states them.
  expect(shipped!.headerH, 'with content that does not fit, the header must be taller than 80px').toBeGreaterThan(80);
  expect(shipped!.actionsInsideHeader, 'every action sits inside the header box, not past its bottom edge').toBe(true);
  expect(shipped!.nextCoversActions, 'no following section may start above the last action').toBe(false);
  expect(shipped!.allReached, 'every header action, injected or shipped, is the element a click reaches').toBe(true);
  expect(restored!.headerH, 'removing the counterfactual restores the shipped geometry').toBe(shipped!.headerH);

  // The counterfactual is what the old rule did. If this ever reads true, the defect was not the
  // declared height and this spec's premise is wrong - fail loudly instead of reporting a fix.
  expect(previous!.headerH, 'the previous declaration still pins the box at 80px').toBe(80);
  expect(previous!.actionsInsideHeader, 'under the previous declaration the actions escaped the header box').toBe(false);
  expect(previous!.allReached, 'under the previous declaration at least one action is covered').toBe(false);
});

test('twelve pages: the header height and the first block do not move, at 1440 / 1024 / 390', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const rows: Record<string, unknown>[] = [];

  for (const target of PAGES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(target.route);
      await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 });
      // The async panels settle on their own; the header is not one of them, but the first block
      // below it can be a loading placeholder that is replaced - measure after it has been replaced.
      await page.waitForSelector('[data-async-state="ready"], [data-async-state="empty"]', { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(250);
      const shipped = await measure(page);
      if (!shipped) throw new Error(target.route + ': no shared page header');
      // The 80px declaration only exists at >=769 (§ media query). Below 769 the header has always
      // been content-high, so there is no "before" to compare against there - only the shipped
      // numbers are recorded, and the phone row is asserted on reachability instead.
      let previous = null;
      if (width >= 769) {
        await page.addStyleTag({ content: PREVIOUS_RULE });
        previous = await measure(page);
        await page.evaluate(() => {
          for (const tag of Array.from(document.querySelectorAll('style'))) {
            if (/height:80px !important;min-height:0 !important/.test(tag.textContent || '')) tag.remove();
          }
        });
      }
      const row = {
        slug: target.slug,
        route: target.route,
        width,
        headerH: shipped.headerH,
        previousHeaderH: previous ? previous.headerH : null,
        firstBlockY: shipped.firstBlockY,
        previousFirstBlockY: previous ? previous.firstBlockY : null,
        gap: shipped.gap,
        actionsInsideHeader: shipped.actionsInsideHeader,
        previousActionsInsideHeader: previous ? previous.actionsInsideHeader : null,
        allReached: shipped.allReached,
        previousAllReached: previous ? previous.allReached : null,
        controls: shipped.controls.length,
        overflow: shipped.overflow,
      };
      rows.push(row);
      expect(shipped.actionsInsideHeader, target.route + ' @' + width + ': an action escaped the header box').toBe(true);
      expect(shipped.allReached, target.route + ' @' + width + ': an action is covered').toBe(true);
      expect(shipped.overflow, target.route + ' @' + width + ': horizontal overflow').toBeLessThanOrEqual(1);
      if (width >= 769) {
        // A page may only be taller than before if it was ALREADY overflowing its declared box -
        // i.e. the previous state had a control below the header's bottom edge. Any other growth is
        // a baseline regression on a page that used to fit, and fails here.
        const wasAlreadyOverflowing = previous ? previous.actionsInsideHeader === false : false;
        if (!wasAlreadyOverflowing) {
          expect(row.headerH, target.route + ' @' + width + ': the 80px baseline moved on a page that used to fit').toBe(80);
          expect(row.previousHeaderH, target.route + ' @' + width + ': the previous declaration measured differently').toBe(80);
          expect(row.firstBlockY, target.route + ' @' + width + ': the first block moved').toBe(row.previousFirstBlockY);
        } else {
          expect(row.headerH, target.route + ' @' + width + ': a header that overflowed must now be taller').toBeGreaterThan(80);
        }
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'page-header-baseline.json'), JSON.stringify(rows, null, 1));
  console.log('slug            width  headerH  prevH  firstBlockY  prevFirstBlockY  gap  allReached');
  for (const row of rows as Record<string, any>[]) {
    console.log(
      String(row.slug).padEnd(15) + ' ' + String(row.width).padStart(5) + '  ' + String(row.headerH).padStart(7) + '  '
      + String(row.previousHeaderH).padStart(5) + '  ' + String(row.firstBlockY).padStart(11) + '  '
      + String(row.previousFirstBlockY).padStart(15) + '  ' + String(row.gap).padStart(3) + '  ' + String(row.allReached),
    );
  }
});
test('detail pages: the pages the twelve-route table cannot reach, measured the same way', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);

  // The ids come from the API the page itself reads, so this list is whatever this host actually
  // has - no fixture, no invented uuid. A route with no record behind it is reported as skipped
  // rather than measured against an error panel and called a result.
  const firstId = async (endpoint: string, keys: string[]) => {
    const res = await page.request.get(endpoint);
    if (!res.ok()) return null;
    const body = await res.json().catch(() => null);
    const items = (body && (body.items || body)) as unknown;
    const list = Array.isArray(items) ? items : [];
    for (const item of list as Record<string, unknown>[]) {
      for (const key of keys) {
        const value = item && item[key];
        if (typeof value === 'string' && value.length > 2) return value;
      }
    }
    return null;
  };

  const [nodeId, pluginId, jobId, pipelineId, incidentId] = await Promise.all([
    firstId('/api/v1/nodes', ['nodeId', 'id']),
    firstId('/api/v1/plugins', ['pluginId', 'id']),
    firstId('/api/v1/jobs', ['jobId', 'id']),
    firstId('/api/v1/pipelines', ['pipelineId', 'id']),
    firstId('/api/v1/incidents', ['incidentId', 'id']),
  ]);

  const targets = [
    { slug: 'node-detail', route: nodeId ? '/admin/nodes/' + nodeId : null },
    { slug: 'plugin-detail', route: pluginId ? '/admin/plugins/' + pluginId : null },
    { slug: 'job-detail', route: jobId ? '/admin/jobs/' + jobId : null },
    { slug: 'pipeline-detail', route: pipelineId ? '/admin/pipelines/' + pipelineId : null },
    // The page that already worked around this defect once, by moving nine controls into a toolbar
    // row: its header is the one most likely to be affected by a height that can now grow.
    { slug: 'studio-editor', route: pipelineId ? '/admin/pipelines/' + pipelineId + '/editor' : null },
    { slug: 'instance-logs', route: nodeId ? '/admin/instances/' + nodeId + '/logs' : null },
    { slug: 'incident-detail', route: incidentId ? '/app/incidents/' + incidentId : null },
  ];

  const rows: Record<string, unknown>[] = [];
  for (const target of targets) {
    if (!target.route) { rows.push({ slug: target.slug, skipped: 'no record of this kind on this host' }); continue; }
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(target.route);
      const ok = await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!ok) { rows.push({ slug: target.slug, width, skipped: 'no page header rendered at this route' }); continue; }
      await page.waitForTimeout(250);
      const shipped = await measure(page);
      if (!shipped) { rows.push({ slug: target.slug, width, skipped: 'no page header rendered at this route' }); continue; }
      await page.addStyleTag({ content: PREVIOUS_RULE });
      const previous = await measure(page);
      await page.evaluate(() => {
        for (const tag of Array.from(document.querySelectorAll('style'))) {
          if (/height:80px !important;min-height:0 !important/.test(tag.textContent || '')) tag.remove();
        }
      });
      const row = {
        slug: target.slug, route: target.route, width,
        headerH: shipped.headerH, previousHeaderH: previous ? previous.headerH : null,
        firstBlockY: shipped.firstBlockY, previousFirstBlockY: previous ? previous.firstBlockY : null,
        actionsInsideHeader: shipped.actionsInsideHeader,
        previousActionsInsideHeader: previous ? previous.actionsInsideHeader : null,
        allReached: shipped.allReached, controls: shipped.controls.length, overflow: shipped.overflow,
      };
      rows.push(row);
      expect(shipped.allReached, target.route + ' @' + width + ': an action is covered').toBe(true);
      expect(shipped.overflow, target.route + ' @' + width + ': horizontal overflow').toBeLessThanOrEqual(1);
      const wasAlreadyOverflowing = previous ? previous.actionsInsideHeader === false : false;
      if (!wasAlreadyOverflowing) {
        expect(row.headerH, target.route + ' @' + width + ': a page that used to fit must still be 80px').toBe(80);
        expect(row.firstBlockY, target.route + ' @' + width + ': the first block moved on a page that used to fit').toBe(row.previousFirstBlockY);
      } else {
        expect(row.headerH, target.route + ' @' + width + ': a header whose controls escaped must now be taller').toBeGreaterThan(80);
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'page-header-detail-baseline.json'), JSON.stringify(rows, null, 1));
  console.log('detail page      width  headerH  prevH  firstBlockY  prevY  insideHeader  prevInside  grew?');
  for (const row of rows as Record<string, any>[]) {
    if (row.skipped) { console.log(String(row.slug).padEnd(16) + ' skipped: ' + row.skipped); continue; }
    console.log(
      String(row.slug).padEnd(16) + ' ' + String(row.width).padStart(5) + '  ' + String(row.headerH).padStart(7) + '  '
      + String(row.previousHeaderH).padStart(5) + '  ' + String(row.firstBlockY).padStart(11) + '  '
      + String(row.previousFirstBlockY).padStart(5) + '  ' + String(row.actionsInsideHeader).padStart(12) + '  '
      + String(row.previousActionsInsideHeader).padStart(10) + '  ' + (row.headerH !== row.previousHeaderH),
    );
  }
});
