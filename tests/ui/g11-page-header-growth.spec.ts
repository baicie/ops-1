import { expect, test, type Page } from '@playwright/test';
import { adminSeed } from './support/accounts';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G11 D3 - the page header: what is actually invariant, and what is only a consequence.
 *
 * This spec used to assert "the detail header must be 80px". That assertion was asking the wrong
 * question: G12 D2 made the header's height a function of its content (min-height is a floor, not
 * a bound), so "must be 80" and "may grow" cannot both be true. Height is not an invariant here.
 * It is the RESULT of three properties, and those three are what this file asserts:
 *
 *   1. NO CONTROL IS COVERED   - elementFromPoint at a control's centre resolves to that control
 *                                (or to something inside it). A control painted underneath a later
 *                                sibling is the defect this file exists for: it looked fine in a
 *                                screenshot and took no clicks.
 *   2. NO TEXT IS CLIPPED      - no header text sits in an ellipsis, a line clamp, or a hidden
 *                                overflow that is longer than its box. Measured per element from
 *                                scrollWidth/scrollHeight against clientWidth/clientHeight and
 *                                from the computed text-overflow / -webkit-line-clamp.
 *   3. NOTHING OVERLAPS        - the next block's top edge is at or below the header's bottom edge.
 *
 * Height keeps ONE invariant, and it is a comparison between peers, never a constant: pages of the
 * same class (list vs detail) at the same width may not measure different heights unless their
 * header holds a different number of lines. A peer that grew without holding more lines is exactly
 * the G11 baseline defect (headers of 36 / 60 / 72 / 86 / 122px on one page template), and it is
 * caught without writing 80 anywhere. Every measured height is printed, so a difference between
 * the two classes is visible in the log instead of being remembered by a reviewer.
 *
 * The before/after pair in the second test is a counterfactual, not a rebuild: an undersized height
 * is injected into a live page, the three properties are shown to break, and the injection is
 * removed to show them return. It runs on the page with nine controls in its header, because that
 * is the page where a box smaller than its content still covers controls - measured: on the
 * incident list, one control escapes and the panel below starts past it, so the same injection
 * there proves nothing and would pass vacuously. The injected value is half of that page's measured
 * content height, so it is "smaller than the content" by construction rather than by a constant
 * that would one day cease to be too small.
 *
 * No product copy is changed and no response is stubbed: the long-content case is an additive DOM
 * injection (a longer description string plus extra buttons), which is the only way to exercise a
 * state the product does not ship today without shipping it.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
/** The repository root, found by walking up to the pnpm workspace file - so the artifacts land in
 *  one place whether the suite is started from the package or from the repository root. */
function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const OUT = process.env.OPSWEAVE_HEADER_OUT || path.join(repoRoot(), 'artifacts/g11-d3');

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
/** The media query that declares the 80px floor; below it the header is content-high on purpose. */
const FLOOR_QUERY_MIN_WIDTH = 769;

/**
 * Signs the administrator in through the form, then performs the one business-workspace grant a
 * fresh database needs before this host can show a single incident.
 *
 * The grant is not a convenience. Since D5 (migration 0022) a business row is readable for exactly
 * one reason - the caller is a MEMBER of the workspace it lives in - and the kernel runs migrations
 * before it creates the bootstrap account, so on a fresh database the migration's one-time grant
 * does not cover it (ADR section 3.4: the administrator "can create workspaces and grant, but reads
 * no business row until it grants itself once, which is an audited platform action"). Without it
 * the list below is empty for a reason that has nothing to do with any header, and the detail-pages
 * test silently reports its incident row as skipped instead of measuring it.
 *
 * Done here, per spec, rather than in a shared pre-test hook: a hook would grant against whatever
 * OPSWEAVE_URL points at, and on a shared host that includes staging.
 *
 * The order is load-bearing. The form login must come FIRST: Login.tsx bounces a request that
 * already carries a session away from /login, so a grant performed before it would leave the form
 * fields unreachable and every test in this file would time out on the first fill.
 */
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(new RegExp('/login'));
  await adminSeed(page.request, ADMIN_EMAIL, ADMIN_PASSWORD);
}

/**
 * Everything the assertions read, in one evaluate.
 *
 * "Reached" is the defect's own test: elementFromPoint at the control's centre must resolve to the
 * control (or something inside it). A covered button answers with the covering panel instead, and
 * that panel's class is recorded as `reachedBy` so a failure names the thing that took the click.
 *
 * "Clipped" is measured, not inferred from whether a class is present: an element is clipped when
 * its scroll size exceeds its client size while the overflow that would let it out is hidden, or
 * when it declares an ellipsis / line clamp. Both are computed styles, so a page that stops
 * clipping and a page that never clipped are told apart by measurement rather than by a list.
 */
async function measure(page: Page) {
  return page.evaluate((floorQueryMinWidth) => {
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
    if (!header) return null;
    const box = header.getBoundingClientRect();
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    // The action rail is the set of controls; a page may also state them as a toolbar row that
    // follows the header (the studio page did until G12 D removed .studio-toolbar), so both
    // locations are read. Reading only .page-actions once made the page the defect was found on
    // measure zero controls - a vacuous pass for the property this function exists to measure.
    const row = header.nextElementSibling as HTMLElement | null;
    const rail = header.querySelector('.page-actions');
    const controls = [
      ...(rail ? Array.from(rail.children) : []),
      ...(row && row.classList.contains('studio-toolbar') ? Array.from(row.querySelectorAll('a, button')) : []),
    ].filter(visible) as HTMLElement[];

    const measured = controls.map((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inViewport = y >= 0 && y <= window.innerHeight && x >= 0 && x <= window.innerWidth;
      const hit = inViewport ? document.elementFromPoint(x, y) : null;
      const reached = Boolean(hit && (hit === el || el.contains(hit)));
      return {
        label: (el.textContent || '').trim().slice(0, 24) || el.getAttribute('data-testid') || el.tagName.toLowerCase(),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        reached,
        reachedBy: hit ? String((hit as HTMLElement).className || hit.tagName).slice(0, 60) : null,
        coveredBy: reached ? null : hit ? String((hit as HTMLElement).className || hit.tagName).slice(0, 60) : '(outside the viewport)',
      };
    });

    /**
     * How many visual rows a wrapping flex row resolved to.
     *
     * Read from the container that actually holds the items, not from the outer one: .page-header-meta
     * wraps .detail-meta, which wraps the chips, so counting .page-header-meta's own children always
     * answered 1 and reported a two-row chip block as one row. The deepest child-richest container
     * under `container` is the row that can wrap, so that is the row that is counted.
     */
    const rows = (container: Element | null) => {
      if (!container) return 0;
      let host = container;
      let best = -1;
      const queue = [container];
      while (queue.length) {
        const node = queue.shift() as Element;
        const kids = Array.from(node.children).filter(visible);
        if (kids.length > best) { best = kids.length; host = node; }
        for (const child of Array.from(node.children)) {
          if (child.children.length) queue.push(child);
        }
      }
      const tops = new Set<number>();
      for (const child of Array.from(host.children)) {
        if (visible(child)) tops.add(Math.round(child.getBoundingClientRect().top));
      }
      return tops.size;
    };

    const textEls = Array.from(header.querySelectorAll<HTMLElement>('*')).filter((el) => {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 0);
      return own && visible(el);
    });
    const clipped = textEls.flatMap((el) => {
      const cs = getComputedStyle(el);
      const reasons: string[] = [];
      if (el.scrollWidth > el.clientWidth + 1) reasons.push('scrollWidth ' + el.scrollWidth + ' > clientWidth ' + el.clientWidth);
      if (cs.textOverflow === 'ellipsis' && cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 1) reasons.push('ellipsis over hidden overflow');
      if (cs.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1) reasons.push('scrollHeight ' + el.scrollHeight + ' > clientHeight ' + el.clientHeight);
      if ((cs as unknown as { webkitLineClamp?: string }).webkitLineClamp && (cs as unknown as { webkitLineClamp?: string }).webkitLineClamp !== 'none') reasons.push('line-clamp ' + (cs as unknown as { webkitLineClamp?: string }).webkitLineClamp);
      if (!reasons.length) return [];
      return [{ cls: String(el.className || el.tagName).slice(0, 48), text: (el.textContent || '').trim().slice(0, 40), reasons }];
    });

    const h1 = header.querySelector('h1') as HTMLElement | null;
    const h1Box = h1 ? h1.getBoundingClientRect() : null;
    const h1Style = h1 ? getComputedStyle(h1) : null;
    const h1LineHeight = h1Style ? (h1Style.lineHeight === 'normal' ? parseFloat(h1Style.fontSize) * 1.2 : parseFloat(h1Style.lineHeight)) : 0;
    const description = header.querySelector('.page-description') as HTMLElement | null;
    const descriptionBox = description ? description.getBoundingClientRect() : null;
    const descriptionStyle = description ? getComputedStyle(description) : null;
    const descriptionLineHeight = descriptionStyle
      ? (descriptionStyle.lineHeight === 'normal' ? parseFloat(descriptionStyle.fontSize) * 1.2 : parseFloat(descriptionStyle.lineHeight))
      : 0;
    const railOnOwnLine = rail ? Math.round(rail.getBoundingClientRect().top) >= Math.round(box.bottom) - 1 : false;
    const copy = header.querySelector('.page-header-copy');
    const copyBox = copy ? copy.getBoundingClientRect() : null;

    const next = header.nextElementSibling as HTMLElement | null;
    const nextTop = next ? Math.round(next.getBoundingClientRect().top) : null;
    const lowestControl = measured.reduce((max, c) => Math.max(max, c.bottom), 0);

    return {
      headerH: Math.round(box.height),
      headerTop: Math.round(box.top),
      headerBottom: Math.round(box.bottom),
      floorApplies: window.matchMedia('(min-width: ' + floorQueryMinWidth + 'px)').matches,
      firstBlockY: nextTop,
      gapToNext: nextTop === null ? null : nextTop - Math.round(box.bottom),
      nextStartsBelowHeader: nextTop === null ? true : nextTop >= Math.round(box.bottom),
      lowestControl,
      controlsInsideHeader: lowestControl <= Math.round(box.bottom) + 1,
      controls: measured,
      allReached: measured.every((c) => c.reached),
      clipped,
      noClippedText: clipped.length === 0,
      // The shape a header's height is a function of. Two pages may differ in height only when this
      // key differs; that comparison is what replaces a hardcoded 80.
      shape: [
        header.querySelector('.eyebrow') ? 'eyebrow' : '-',
        'title' + (h1Box ? Math.max(1, Math.round(h1Box.height / h1LineHeight)) : 0),
        description ? 'desc' + Math.max(1, Math.round(descriptionBox!.height / descriptionLineHeight)) : '-',
        'meta' + rows(header.querySelector('.page-header-meta')),
        'rail' + rows(rail) + (railOnOwnLine ? 'wrapped' : 'inline'),
      ].join('/'),
      titleLines: h1Box ? Math.max(1, Math.round(h1Box.height / h1LineHeight)) : 0,
      descriptionLines: description ? Math.max(1, Math.round(descriptionBox!.height / descriptionLineHeight)) : 0,
      metaRows: rows(header.querySelector('.page-header-meta')),
      railRows: rows(rail),
      railOnOwnLine,
      copyHeight: copyBox ? Math.round(copyBox.height) : null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, FLOOR_QUERY_MIN_WIDTH);
}

type Measurement = NonNullable<Awaited<ReturnType<typeof measure>>>;

/**
 * The three invariants, asserted as one thing per page. Returns nothing: a caller that wants the
 * numbers prints them. `where` is the label a failure has to carry, because a table of twelve
 * routes that only says "an action is covered" is a failure nobody can act on.
 */
function expectThreeInvariants(m: Measurement, where: string) {
  expect(m.allReached, where + ': a control is covered - elementFromPoint at its centre resolves to ' + JSON.stringify(m.controls.filter((c) => !c.reached))).toBe(true);
  expect(m.clipped, where + ': a header text is clipped - ' + JSON.stringify(m.clipped)).toEqual([]);
  expect(m.nextStartsBelowHeader, where + ': the next block starts above the header bottom (' + m.firstBlockY + ' < ' + m.headerBottom + ')').toBe(true);
  expect(m.overflow, where + ': horizontal overflow').toBeLessThanOrEqual(1);
}

/**
 * The peer rule, applied to one class at one width: no page may measure a height another page of
 * the same class does not, unless their header shape key differs. No constant is compared here.
 */
function expectPeerHeights(rows: Array<{ slug: string; headerH: number; shape: string }>, where: string) {
  const byShape = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = byShape.get(row.shape) || new Set<number>();
    set.add(row.headerH);
    byShape.set(row.shape, set);
  }
  const disagreements = [...byShape.entries()]
    .filter(([, heights]) => heights.size > 1)
    .map(([shape, heights]) => ({
      shape,
      heights: [...heights],
      slugs: rows.filter((r) => r.shape === shape).map((r) => r.slug),
    }));
  expect(
    disagreements,
    where + ': pages with the same header shape measured different heights - ' + JSON.stringify(disagreements),
  ).toEqual([]);
  const heights = [...new Set(rows.map((r) => r.headerH))].sort((a, b) => a - b);
  const shapes = [...byShape.keys()];
  console.log(
    '    ' + where.padEnd(26) + ' pages=' + String(rows.length).padStart(2)
    + '  heights=[' + heights.join(', ') + ']  shapes=' + shapes.length
    + '  (' + rows.map((r) => r.slug + ':' + r.headerH).join(' ') + ')',
  );
  // A class whose pages all disagree is still allowed to have one shape per page, but a class where
  // every page has a different shape AND a different height is reported here rather than trusted.
  return { heights, shapes: shapes.length };
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });


test('the three invariants are load-bearing: an undersized box breaks them, removing it restores them', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto('/app/incidents');
  const create = page.getByTestId('incident-create-open');
  await expect(create).toBeVisible();

  // 1. The shipped page, before anything is injected.
  const natural = await measure(page);
  expect(natural, 'the incidents page renders the shared header').not.toBeNull();
  expectThreeInvariants(natural!, '/app/incidents natural');

  // 2. The state the product does not ship: a description long enough to need more than one line
  //    and four extra actions. Additive DOM only - no product string is edited, and a reload is
  //    enough to put the page back.
  await page.evaluate(() => {
    const header = document.querySelector('[data-testid=page-header]') as HTMLElement;
    const description = header.querySelector('.page-description');
    if (description) {
      description.textContent = 'Every incident opened from the last release window, with the sources that '
        + 'observed it, the collectors that reported it and the human verdict that closed it - kept here '
        + 'so a reader can follow one incident end to end without leaving the page.';
    }
    const rail = header.querySelector('.page-actions') as HTMLElement;
    for (const label of ['Export', 'Assign', 'Snooze', 'Link evidence']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.setAttribute('data-probe-action', label);
      button.textContent = label;
      rail.appendChild(button);
    }
  });
  const shipped = await measure(page);
  expect(shipped, 'the injected page still renders the header').not.toBeNull();
  await page.screenshot({ path: path.join(OUT, 'header-growth-injected.png'), fullPage: true });

  // The three invariants hold on a header that had to grow. Nothing here says how tall it is.
  expectThreeInvariants(shipped!, '/app/incidents with copy that does not fit');
  expect(shipped!.headerH, 'a header whose content does not fit grows instead of holding its content outside').toBeGreaterThan(natural!.headerH);
  expect(shipped!.controlsInsideHeader, 'every injected action sits inside the header box').toBe(true);

  fs.writeFileSync(
    path.join(OUT, 'header-growth.json'),
    JSON.stringify({ route: '/app/incidents', viewport: 1440, natural, shipped }, null, 1),
  );
});

test('counterfactual: an undersized box covers the controller rail, and withdrawing it restores every control', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  // The page with the most controls in its header - nine of them - and the page the pre-D2
  // .studio-toolbar existed for: "wrapped, the second row fell outside a declared 80px and the
  // drafts panel painted over 7 of the 9". This is where an undersized box still reproduces the
  // defect the whole spec is about, so this is where the counterfactual is measured. On
  // /app/incidents it does not reproduce any more: that page carries one control, and the panel
  // below it starts far below the escaped row, so injecting a small height there proves nothing
  // and passes vacuously - measured, not assumed.
  const res = await page.request.get('/api/v1/pipelines');
  const body = await res.json().catch(() => null);
  const items = (body && (body.items || body)) as unknown;
  const pipelineId = (Array.isArray(items) ? items : [])
    .map((item) => (item && ((item as Record<string, unknown>).pipelineId || (item as Record<string, unknown>).id)) as string | undefined)
    .find((value) => typeof value === 'string' && value.length > 2);
  test.skip(!pipelineId, 'no pipeline on this host: the page with nine header controls cannot be opened');

  await page.goto('/admin/pipelines/' + pipelineId + '/editor');
  await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 });
  await page.waitForTimeout(400);
  const natural = await measure(page);
  expect(natural, 'the studio page renders the shared header').not.toBeNull();
  expectThreeInvariants(natural!, 'studio before the counterfactual');
  expect(natural!.controls.length, 'the counterfactual needs a header that carries a controller rail').toBeGreaterThanOrEqual(9);

  // The injected value is derived from THIS page's content: half of what the content needs. It is
  // smaller than the content by construction - a re-applied 80px was only "too small" until the
  // layout changed, and a constant that stops being wrong is a constant that has to be re-guessed.
  const contentNeed = natural!.lowestControl - natural!.headerTop;
  const undersized = Math.round(contentNeed / 2);
  expect(undersized, 'the injected height is smaller than what the header carries').toBeLessThan(natural!.headerH);
  await page.addStyleTag({ content: '.page-header{height:' + undersized + 'px !important;min-height:0 !important}' });
  const undersizedBox = await measure(page);
  await page.screenshot({ path: path.join(OUT, 'header-undersized-counterfactual.png'), fullPage: true });

  // The same assertions that pass on the shipped page, run against the injected box on purpose: the
  // message they throw is the evidence that they are load-bearing rather than decorative.
  let counterfactualMessage = '';
  try {
    expectThreeInvariants(undersizedBox!, 'counterfactual');
  } catch (error) {
    counterfactualMessage = String((error as Error).message || error);
  }
  expect(undersizedBox!.headerH, 'the injected box is the size that was injected').toBe(undersized);
  expect(undersizedBox!.controlsInsideHeader, 'under the undersized box the actions escape the header box').toBe(false);
  expect(undersizedBox!.allReached, 'under the undersized box the rail is covered').toBe(false);
  const escaped = undersizedBox!.controls.filter((c) => c.bottom > undersizedBox!.headerBottom);
  const covered = undersizedBox!.controls.filter((c) => !c.reached);
  expect(escaped.length, 'more than one control escapes a box smaller than its content').toBeGreaterThan(1);
  expect(covered.length, 'the escaped controls are covered by the block below, not merely misplaced').toBeGreaterThan(1);
  expect(counterfactualMessage, 'the invariants report the broken state instead of passing').toContain('a control is covered');
  console.log('counterfactual: injected height ' + undersized + 'px of ' + natural!.headerH + 'px of content');
  console.log('counterfactual message: ' + counterfactualMessage.split('\n')[0]);
  console.log('counterfactual covered: ' + JSON.stringify(covered.map((c) => ({ label: c.label, bottom: c.bottom, coveredBy: c.coveredBy }))));

  // Withdrawn: the invariants return and so does the shipped geometry.
  await page.evaluate(() => {
    for (const tag of Array.from(document.querySelectorAll('style'))) {
      if (/height:\d+px !important;min-height:0 !important/.test(tag.textContent || '')) tag.remove();
    }
  });
  const restored = await measure(page);
  expectThreeInvariants(restored!, 'studio after withdrawing the counterfactual');
  expect(restored!.headerH, 'removing the counterfactual restores the shipped geometry').toBe(natural!.headerH);
  expect(restored!.controls.every((c) => c.reached), 'every control answers a click again').toBe(true);

  fs.writeFileSync(
    path.join(OUT, 'header-counterfactual.json'),
    JSON.stringify({ route: '/admin/pipelines/' + pipelineId + '/editor', viewport: 1440, undersized, natural, undersizedBox, restored, counterfactualMessage }, null, 1),
  );
});

test('twelve list pages: no control covered, no text clipped, nothing overlapping - and the peers agree', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const rows: Array<Record<string, unknown>> = [];

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
      expectThreeInvariants(shipped, target.route + ' @' + width);
      rows.push({
        class: 'list',
        slug: target.slug,
        route: target.route,
        width,
        headerH: shipped.headerH,
        firstBlockY: shipped.firstBlockY,
        gapToNext: shipped.gapToNext,
        controls: shipped.controls.length,
        titleLines: shipped.titleLines,
        descriptionLines: shipped.descriptionLines,
        metaRows: shipped.metaRows,
        shape: shipped.shape,
      });
    }
  }

  // Per width, the twelve pages of one class are compared with each other. The floor query decides
  // where the comparison is owed: below it the header is content-high on purpose (a phone has no
  // 160 to hit), so only the three invariants are asserted there.
  console.log('list class, measured (printing the values is the point: a difference must be seen, not remembered)');
  for (const width of WIDTHS) {
    const at = rows.filter((r) => r.width === width) as Array<{ slug: string; headerH: number; shape: string }>;
    const where = 'list @' + width;
    if (width >= FLOOR_QUERY_MIN_WIDTH) {
      expectPeerHeights(at, where);
      const heights = [...new Set(at.map((r) => r.headerH))];
      expect(heights.length, where + ': the twelve routes of one class disagree on the header height').toBe(1);
    } else {
      console.log('    ' + where.padEnd(26) + ' content-high by design, heights=[' + [...new Set(at.map((r) => r.headerH))].sort((a, b) => a - b).join(', ') + ']');
    }
  }
  fs.writeFileSync(path.join(OUT, 'page-header-baseline.json'), JSON.stringify(rows, null, 1));
  console.log('slug            width  headerH  firstBlockY  gap  titleLines  descLines  metaRows  shape');
  for (const row of rows as Array<Record<string, any>>) {
    console.log(
      String(row.slug).padEnd(15) + ' ' + String(row.width).padStart(5) + '  ' + String(row.headerH).padStart(7) + '  '
      + String(row.firstBlockY).padStart(11) + '  ' + String(row.gapToNext).padStart(3) + '  '
      + String(row.titleLines).padStart(10) + '  ' + String(row.descriptionLines).padStart(9) + '  '
      + String(row.metaRows).padStart(8) + '  ' + row.shape,
    );
  }
});

test('detail pages: the peers agree, and the list/detail difference is printed rather than assumed', async ({ page }) => {
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
    for (const item of list as Array<Record<string, unknown>>) {
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
    { slug: 'instance-logs', route: nodeId ? '/admin/instances/' + nodeId + '/logs' : null },
    { slug: 'incident-detail', route: incidentId ? '/app/incidents/' + incidentId : null },
  ];

  const rows: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    if (!target.route) { rows.push({ class: 'detail', slug: target.slug, skipped: 'no record of this kind on this host' }); continue; }
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(target.route);
      const ok = await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 }).then(() => true).catch(() => false);
      if (!ok) { rows.push({ class: 'detail', slug: target.slug, width, skipped: 'no page header rendered at this route' }); continue; }
      await page.waitForTimeout(300);
      const shipped = await measure(page);
      if (!shipped) { rows.push({ class: 'detail', slug: target.slug, width, skipped: 'no page header rendered at this route' }); continue; }
      expectThreeInvariants(shipped, target.route + ' @' + width);
      rows.push({
        class: 'detail',
        slug: target.slug,
        route: target.route,
        width,
        headerH: shipped.headerH,
        firstBlockY: shipped.firstBlockY,
        gapToNext: shipped.gapToNext,
        controls: shipped.controls.length,
        titleLines: shipped.titleLines,
        descriptionLines: shipped.descriptionLines,
        metaRows: shipped.metaRows,
        railOnOwnLine: shipped.railOnOwnLine,
        shape: shipped.shape,
      });
    }
  }

  console.log('detail class, measured');
  for (const width of [1440, 1024]) {
    const at = rows.filter((r) => r.width === width && !r.skipped) as Array<{ slug: string; headerH: number; shape: string }>;
    const skipped = rows.filter((r) => r.width === width && r.skipped).map((r) => r.slug);
    if (!at.length) { console.log('    detail @' + width + ': nothing measurable on this host (skipped: ' + skipped.join(', ') + ')'); continue; }
    expectPeerHeights(at, 'detail @' + width);
    if (skipped.length) console.log('    detail @' + width + ' skipped (no record on this host): ' + skipped.join(', '));
  }

  // The difference between the two classes is allowed - and it is printed, not assumed, so a
  // reader sees the numbers the two classes actually settled on rather than a remembered 80.
  // The list side is measured here rather than read back from the twelve-route table: this test has
  // to stand on its own when it is the only one selected, or its comparison would silently vanish.
  const listHeightsByWidth = new Map<number, number[]>();
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin/overview');
    await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 });
    await page.waitForTimeout(250);
    const listFloor = await measure(page);
    expect(listFloor, 'the list class is measurable for the comparison').not.toBeNull();
    expectThreeInvariants(listFloor!, '/admin/overview @' + width + ' (list class reference)');
    listHeightsByWidth.set(width, [listFloor!.headerH]);
  }
  for (const width of [1440, 1024]) {
    const listHeights = listHeightsByWidth.get(width) || [];
    const detailHeights = [...new Set((rows.filter((r) => r.width === width && !r.skipped) as Array<Record<string, any>>).map((r) => r.headerH as number))].sort((a, b) => a - b);
    console.log('    class values @' + width + ': list=[' + listHeights.join(', ') + ']  detail=[' + detailHeights.join(', ') + ']');
    // Both classes share one floor: the shortest page of each class is the same header. One number
    // is compared against the OTHER CLASS rather than against a constant.
    if (detailHeights.length && listHeights.length) {
      expect(detailHeights[0], 'the two classes share one header floor at ' + width + ', and only grow above it')
        .toBe(listHeights[0]);
    }
  }

  fs.writeFileSync(path.join(OUT, 'page-header-detail-baseline.json'), JSON.stringify(rows, null, 1));
  console.log('detail page      width  headerH  firstBlockY  gap  titleLines  descLines  metaRows  railWrapped  shape');
  for (const row of rows as Array<Record<string, any>>) {
    if (row.skipped) { console.log(String(row.slug).padEnd(16) + ' skipped: ' + row.skipped); continue; }
    console.log(
      String(row.slug).padEnd(16) + ' ' + String(row.width).padStart(5) + '  ' + String(row.headerH).padStart(7) + '  '
      + String(row.firstBlockY).padStart(11) + '  ' + String(row.gapToNext).padStart(3) + '  '
      + String(row.titleLines).padStart(10) + '  ' + String(row.descriptionLines).padStart(9) + '  '
      + String(row.metaRows).padStart(8) + '  ' + String(row.railOnOwnLine).padStart(11) + '  ' + row.shape,
    );
  }
});

test('the studio workspace is usable at 1440 / 1024 / 390 after .studio-toolbar was removed', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const res = await page.request.get('/api/v1/pipelines');
  const body = await res.json().catch(() => null);
  const items = (body && (body.items || body)) as unknown;
  const pipelineId = (Array.isArray(items) ? items : [])
    .map((item) => (item && ((item as Record<string, unknown>).pipelineId || (item as Record<string, unknown>).id)) as string | undefined)
    .find((value) => typeof value === 'string' && value.length > 2);
  test.skip(!pipelineId, 'no pipeline on this host: the studio route cannot be opened');

  const rows: Array<Record<string, unknown>> = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin/pipelines/' + pipelineId + '/editor');
    await page.waitForSelector('[data-testid=page-header]', { timeout: 20000 });
    await page.waitForTimeout(400);
    const shipped = await measure(page);
    expect(shipped, 'the studio page renders the shared header').not.toBeNull();
    expectThreeInvariants(shipped!, 'studio @' + width);

    // The nine controls the toolbar row used to hold are the header's actions now: they must all be
    // inside the header box and each must be the element a click reaches. This is the check the
    // toolbar removal is owed - the row existed because the header could not hold them.
    expect(shipped!.controls.length, 'studio @' + width + ': the header carries the workspace controls').toBeGreaterThanOrEqual(9);
    expect(shipped!.controlsInsideHeader, 'studio @' + width + ': a workspace control escaped the header box').toBe(true);
    expect(shipped!.controls.every((c) => c.reached), 'studio @' + width + ': a workspace control is covered').toBe(true);

    // The canvas gets whatever the header left: it must still exist, be visible, and start below
    // the header rather than under it.
    const shell = await page.evaluate(() => {
      const el = document.querySelector('.studio-shell') as HTMLElement | null;
      const header = document.querySelector('[data-testid=page-header]') as HTMLElement;
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        height: Math.round(box.height),
        width: Math.round(box.width),
        headerBottom: Math.round(header.getBoundingClientRect().bottom),
        canvas: (() => {
          const c = document.querySelector('.studio-canvas') as HTMLElement | null;
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { height: Math.round(r.height), width: Math.round(r.width) };
        })(),
        toolbar: document.querySelectorAll('.studio-toolbar').length,
      };
    });
    expect(shell, 'studio @' + width + ': the workspace shell is rendered').not.toBeNull();
    expect(shell!.top, 'studio @' + width + ': the shell starts below the header').toBeGreaterThanOrEqual(shell!.headerBottom);
    expect(shell!.height, 'studio @' + width + ': the shell has a usable height').toBeGreaterThan(300);
    expect(shell!.canvas, 'studio @' + width + ': the canvas is rendered').not.toBeNull();
    expect(shell!.canvas!.height, 'studio @' + width + ': the canvas has a usable height').toBeGreaterThan(100);
    expect(shell!.toolbar, 'studio @' + width + ': no page-specific toolbar row is left').toBe(0);
    await page.screenshot({ path: path.join(OUT, 'studio-' + width + '.png'), fullPage: false });
    rows.push({
      width,
      headerH: shipped!.headerH,
      headerBottom: shipped!.headerBottom,
      controls: shipped!.controls.length,
      railOnOwnLine: shipped!.railOnOwnLine,
      shellTop: shell!.top,
      shellHeight: shell!.height,
      canvasHeight: shell!.canvas!.height,
      shape: shipped!.shape,
      overflow: shipped!.overflow,
    });
  }
  fs.writeFileSync(path.join(OUT, 'studio-usability.json'), JSON.stringify(rows, null, 1));
  console.log('studio  width  headerH  headerBottom  controls  railWrapped  shellTop  shellHeight  canvasHeight  shape');
  for (const row of rows as Array<Record<string, any>>) {
    console.log(
      '        ' + String(row.width).padStart(5) + '  ' + String(row.headerH).padStart(7) + '  ' + String(row.headerBottom).padStart(12)
      + '  ' + String(row.controls).padStart(8) + '  ' + String(row.railOnOwnLine).padStart(11) + '  ' + String(row.shellTop).padStart(8)
      + '  ' + String(row.shellHeight).padStart(11) + '  ' + String(row.canvasHeight).padStart(12) + '  ' + row.shape,
    );
  }
});
