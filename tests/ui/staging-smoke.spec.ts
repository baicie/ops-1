import { expect, Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Staging browser acceptance: prove which build the browser is looking at, then
 * capture the core surfaces after a real login.
 *
 * Screenshots land in <repo>/artifacts/staging-preview/screenshots using the same
 * ../../artifacts convention as tests/ui/visual.spec.ts. Playwright keeps traces
 * for any failure under tests/ui/test-results/ (trace: 'retain-on-failure').
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/staging-preview/screenshots');
// The commit this workflow run built (build job output). Without it a green smoke proves only that
// some build is up, which is exactly the failure that let a stale preview pass as a deployment.
const EXPECTED_SHA = (process.env.OPSWEAVE_EXPECTED_SHA || '').trim();
const ALLOW_UNPINNED = process.env.OPSWEAVE_ALLOW_UNPINNED === '1';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });

type Surface = {
  name: string;
  route: string;
  title: string;
  screenshot: string;
  optional?: boolean;
};

// Each title is the <h1> rendered by PageHeader (apps/platform-web/src/components/Ui.tsx)
// from the page modules listed in apps/platform-web/src/App.tsx.
const SURFACES: Surface[] = [
  { name: 'Overview', route: '/', title: 'Overview', screenshot: 'overview.png' },
  { name: 'Nodes', route: '/nodes', title: 'Nodes', screenshot: 'nodes.png' },
  { name: 'Plugins', route: '/plugins', title: 'Plugins', screenshot: 'plugins.png' },
  { name: 'Governance', route: '/governance', title: 'Governance', screenshot: 'governance.png' },
  // No /quality route exists in this build; kept optional so an added route is
  // captured automatically and its absence is reported as SKIP, never a failure.
  { name: 'Quality', route: '/quality', title: 'Quality', screenshot: 'quality.png', optional: true },
];

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

// Declared first and serial, so an unpinned or stale preview fails before any screenshot is taken.
test('the preview serves exactly the commit this run built', async ({ request }) => {
  if (!EXPECTED_SHA) {
    // Fail closed: a skipped identity check would report green for an unverified deployment.
    expect(
      ALLOW_UNPINNED,
      'OPSWEAVE_EXPECTED_SHA is required to certify the served commit. Set it to the 40-character SHA this run built, or set OPSWEAVE_ALLOW_UNPINNED=1 for a deliberate unpinned smoke.',
    ).toBe(true);
    test.info().annotations.push({
      type: 'warning',
      description: 'unpinned smoke: OPSWEAVE_ALLOW_UNPINNED=1 was set, so the served commit is not verified',
    });
    return;
  }
  expect(EXPECTED_SHA, 'OPSWEAVE_EXPECTED_SHA must be a full 40-character commit SHA').toMatch(/^[0-9a-f]{40}$/);
  const response = await request.get('/api/v1/version');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(
    body.commitSha,
    `/api/v1/version must report commitSha ${EXPECTED_SHA}; this preview is serving a different build`,
  ).toBe(EXPECTED_SHA);
});

test('version endpoint is public and exposes build identity only', async ({ request }) => {
  // No session cookie: staging must be able to read the build before anyone signs in.
  const response = await request.get('/api/v1/version');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(['buildTime', 'commitSha', 'environment', 'startedAt', 'version']);
  expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(['STAGING', 'DEVELOPMENT', 'UNKNOWN']).toContain(body.environment);
  expect(body.commitSha === null || /^[0-9a-f]{40}$/.test(body.commitSha)).toBe(true);
  expect(body.buildTime === null || !Number.isNaN(Date.parse(body.buildTime))).toBe(true);
  expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
});

test('deployment badge reflects the served build and is absent in production', async ({ page, request }) => {
  const served = await (await request.get('/api/v1/version')).json();
  await login(page);
  await page.goto('/');
  const badge = page.locator('[aria-label="Deployment version"]');
  if (served.environment === 'PRODUCTION') {
    // Production must never advertise its commit from the shell.
    await expect(badge).toHaveCount(0);
    return;
  }
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Environment');
  await expect(badge).toContainText('Commit');
  await expect(badge).toContainText('Deployed At');
  await expect(badge).toContainText('Status');
  // The badge reads the endpoint instead of hardcoding a build.
  await expect(badge.locator('[data-version-field="environment"] strong')).toHaveText(served.environment);
  await expect(badge.locator('[data-version-field="commit"] strong')).toHaveText(
    served.commitSha ? served.commitSha.slice(0, 7) : 'UNKNOWN',
  );
});

test('core surfaces render behind a real login and are captured', async ({ baseURL, page }) => {
  expect(baseURL, 'playwright config must define baseURL').toBeTruthy();
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  expect(page.url()).not.toContain('/login');

  for (const surface of SURFACES) {
    await page.goto(surface.route);
    const heading = page.locator('.page-header h1').first();
    const rendered = (await heading.count()) > 0 && (await heading.innerText()).trim() === surface.title;
    if (!rendered && surface.optional) {
      const note = `SKIP ${surface.name} (${surface.route}): no page renders this title in the running build`;
      test.info().annotations.push({ type: 'skip', description: note });
      console.log(note);
      continue;
    }
    await expect(heading).toHaveText(surface.title);
    await expect(page.getByRole('heading', { name: surface.title, exact: true })).toBeVisible();
    expect(page.url()).not.toContain('/login');
    // Bounded, non-failing wait for first data paint instead of networkidle,
    // which never settles on pages that poll.
    await page.locator('.skeleton').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    const file = path.join(OUT, surface.screenshot);
    await page.screenshot({ path: file, fullPage: true });
    expect(fs.statSync(file).size).toBeGreaterThan(0);
  }
});

test('deployment badge stays inside a 390px viewport', async ({ page, request }) => {
  const served = await (await request.get('/api/v1/version')).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  const badge = page.locator('[aria-label="Deployment version"]');
  if (served.environment === 'PRODUCTION') {
    await expect(badge).toHaveCount(0);
  } else {
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('Commit');
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'overview-390.png'), fullPage: true });
});
