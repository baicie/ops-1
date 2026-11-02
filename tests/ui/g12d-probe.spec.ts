import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 D - a measurement pass, not an assertion pass.
 *
 * It replaces guesses about the header with numbers from the shipped build before any CSS is
 * touched: every page's header height, whether its description is truncated by the
 * text-overflow:ellipsis rule, whether the action rail escapes the header box, and whether a
 * click reaches each control. Output: /tmp/g12d/before/before.json plus screenshots.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12d.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12d-admin-password-1';
const OUT = process.env.OPSWEAVE_PROBE_OUT || '/tmp/g12d/before';
const SEED = JSON.parse(fs.readFileSync('/tmp/g12d/seed.json', 'utf8'));

const ROUTES = [
  { slug: 'overview', route: '/admin/overview' },
  { slug: 'nodes', route: '/admin/nodes' },
  { slug: 'plugins', route: '/admin/plugins' },
  { slug: 'jobs', route: '/admin/jobs' },
  { slug: 'activity', route: '/admin/activity' },
  { slug: 'access', route: '/admin/access' },
  { slug: 'settings', route: '/admin/settings' },
  { slug: 'incidents', route: '/app/incidents' },
  { slug: 'incident-detail', route: '/app/incidents/' + SEED.incidentA },
  { slug: 'incident-concluded', route: '/app/incidents/' + SEED.incidentB },
  { slug: 'studio', route: '/admin/pipelines/orders-ingest/editor' },
];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}
const MEASURE = () => {
  const header = document.querySelector('[data-testid=page-header]') as HTMLElement | null;
  if (!header) return { missing: true };
  const box = header.getBoundingClientRect();
  const desc = header.querySelector('.page-description') as HTMLElement | null;
  const next = header.nextElementSibling as HTMLElement | null;
  const visible = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const controls = (Array.from(header.querySelectorAll('.page-actions > *')) as HTMLElement[]).filter(visible);
  const reached = controls.map((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return { label: (el.textContent || '').trim().slice(0, 20), h: Math.round(r.height), ok: Boolean(hit && (hit === el || el.contains(hit))) };
  });
  const bottoms = controls.map((el) => Math.round(el.getBoundingClientRect().bottom));
  const lowest = bottoms.length ? Math.max.apply(null, bottoms) : 0;
  const title = header.querySelector('h1') as HTMLElement | null;
  const lineHeight = title ? parseFloat(getComputedStyle(title).lineHeight || '31') : 31;
  const meta = header.querySelector('.page-header-meta') as HTMLElement | null;
  const actions = header.querySelector('.page-actions') as HTMLElement | null;
  return {
    headerH: Math.round(box.height),
    headerBottom: Math.round(box.bottom),
    firstBlockY: next ? Math.round(next.getBoundingClientRect().top) : null,
    titleLines: title ? Math.round(title.getBoundingClientRect().height / lineHeight) : null,
    descClamped: desc ? desc.scrollWidth > desc.clientWidth + 1 : null,
    descH: desc ? Math.round(desc.getBoundingClientRect().height) : null,
    metaH: meta ? Math.round(meta.getBoundingClientRect().height) : null,
    actionsH: actions ? Math.round(actions.getBoundingClientRect().height) : null,
    controls: reached,
    lowestControlBottom: lowest,
    escapesHeader: lowest > Math.round(box.bottom) + 1,
    nextCoversControls: next ? lowest > Math.round(next.getBoundingClientRect().top) : false,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    studioToolbar: Boolean(document.querySelector('.studio-toolbar')),
    panels: document.querySelectorAll('#main-content section.panel').length,
  };
};

test('measure the shipped header on every page and width', async ({ page }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const table: Record<string, unknown> = {};
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const item of ROUTES) {
      await page.goto(item.route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      table[width + ':' + item.slug] = await page.evaluate(MEASURE);
      if (width !== 1024) await page.screenshot({ path: path.join(OUT, width + '-' + item.slug + '.png') });
    }
  }
  const LABELS = ['Undo', 'Redo', 'Auto layout', 'Horizontal', 'Readable', 'Fit all', 'Preview', 'Save draft', 'Validate', 'Create draft'];
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/admin/overview', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    await page.evaluate((labels) => {
      const row = document.querySelector('[data-testid=page-header] .page-actions') as HTMLElement;
      labels.forEach((label: string) => { const b = document.createElement('button'); b.className = 'btn btn-secondary'; b.textContent = label; row.appendChild(b); });
    }, LABELS);
    await page.waitForTimeout(200);
    table[width + ':injected-10-controls'] = await page.evaluate(MEASURE);
    await page.screenshot({ path: path.join(OUT, width + '-injected.png') });
  }
  fs.writeFileSync(path.join(OUT, 'before.json'), JSON.stringify(table, null, 1));
  expect(table['1440:overview']).toBeTruthy();
});