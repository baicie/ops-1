import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G13-B1.4 - the workspace automation-incident queue, in a real browser against the real kernel.
 *
 * The incident rows are a labelled FIXTURE (the exact state the Event handler writes: origin
 * AUTOMATION, owner = the non-login automation service user). Everything the browser does with
 * them is the production path: GET /incidents/claimable, POST /claim, the 409 conflict, the
 * ordinary detail page after ownership moves. REAL_ZABBIX_VERIFIED = NOT_RUN.
 *
 * Screenshots go to artifacts/g13b14 and are CI artifacts, never tracked: the PNG budget is full.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const DATABASE_URL = process.env.OPSWEAVE_DATABASE_URL;
const SERVICE_USER = '00000000-0000-4000-8000-0000000000a1';

function repoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const OUT = process.env.OPSWEAVE_G13B14_OUT || path.join(repoRoot(), 'artifacts', 'g13b14');
fs.mkdirSync(OUT, { recursive: true });

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PASSWORD = 'g13-b14-ui-password-1';
type Fixture = { operatorEmail: string; otherEmail: string; viewerEmail: string; workspaceId: string; incidents: string[] };
let fixture: Fixture;

function psql(sql: string) {
  const url = DATABASE_URL;
  if (!url) throw new Error('OPSWEAVE_DATABASE_URL is required for the labelled incident fixture');
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { stdio: 'pipe' });
}

async function adminLogin(request: APIRequestContext) {
  const response = await request.post('/api/v1/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  return body.csrfToken as string;
}

async function createUser(request: APIRequestContext, csrf: string, role: 'operator' | 'viewer', email: string) {
  const response = await request.post('/api/v1/users', {
    headers: { 'x-csrf-token': csrf },
    data: { email, displayName: `g13 b14 ${role}`, password: PASSWORD, role },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).id as string;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request, playwright }) => {
  const csrf = await adminLogin(request);

  const operatorEmail = `g13-b14-op-${RUN}@example.invalid`;
  const otherEmail = `g13-b14-other-${RUN}@example.invalid`;
  const viewerEmail = `g13-b14-view-${RUN}@example.invalid`;
  const operatorId = await createUser(request, csrf, 'operator', operatorEmail);
  const otherId = await createUser(request, csrf, 'operator', otherEmail);
  const viewerId = await createUser(request, csrf, 'viewer', viewerEmail);

  const workspace = await request.post('/api/v1/business-workspaces', {
    headers: { 'x-csrf-token': csrf },
    data: { key: `g13-b14-${RUN}`.slice(0, 60), name: 'G13 B1.4 browser workspace' },
  });
  expect(workspace.ok()).toBeTruthy();
  const workspaceId = (await workspace.json()).workspaceId as string;
  for (const userId of [operatorId, otherId, viewerId]) {
    const granted = await request.post(`/api/v1/business-workspaces/${workspaceId}/members`, {
      headers: { 'x-csrf-token': csrf },
      data: { userId },
    });
    expect(granted.ok()).toBeTruthy();
  }

  const incidents: string[] = [];
  for (const kind of ['claim', 'conflict', 'responsive', 'network']) {
    const id = crypto.randomUUID();
    incidents.push(id);
    psql(
      `INSERT INTO kernel.incidents
         (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,origin)
       VALUES ('${id}','browser ${kind} automation failure','MAJOR','OPEN','ZABBIX','ui-${kind}-${RUN}',now(),'${SERVICE_USER}','${workspaceId}','AUTOMATION')`,
    );
  }
  fixture = { operatorEmail, otherEmail, viewerEmail, workspaceId, incidents };
  void playwright;
});

test.afterAll(async ({ request }) => {
  if (!fixture) return;
  const ids = fixture.incidents.map((id) => `'${id}'`).join(',');
  psql(`DELETE FROM kernel.audit_events WHERE subject_type='INCIDENT' AND subject_id IN (${ids})`);
  psql(`DELETE FROM kernel.incidents WHERE incident_id IN (${ids})`);
  psql(`DELETE FROM kernel.business_workspaces WHERE workspace_id='${fixture.workspaceId}'`);
  psql(`DELETE FROM kernel.users WHERE email LIKE '%${RUN}@example.invalid'`);
  void request;
});

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto('/app/incidents');
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((value) => window.localStorage.setItem('opsweave-theme', value), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
}

test('the operator sees the queue and claims with the keyboard; a viewer sees no queue', async ({ browser }) => {
  test.setTimeout(120_000);
  const operatorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await operatorContext.newPage();
  await signIn(page, fixture.operatorEmail);
  const queue = page.locator('[data-testid=incident-claim-queue]');
  await expect(queue).toBeVisible();
  const row = queue.locator(`[data-testid=incident-claim-row][data-incident-id="${fixture.incidents[0]}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('browser claim automation failure');
  await page.screenshot({ path: path.join(OUT, 'queue-1440-light.png'), fullPage: true });

  const claim = row.locator('[data-testid=incident-claim-button]');
  await claim.focus();
  await expect(claim).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/incidents/${fixture.incidents[0]}$`));
  // The claimed incident is an ordinary operator-owned record: the detail page reads it,
  // the unclaimed badge is gone, and the release action (not the claim action) is offered.
  await expect(page.locator('[data-testid=incident-unclaimed-badge]')).toHaveCount(0);
  await expect(page.locator('[data-testid=incident-release-detail]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'detail-1440-light.png'), fullPage: true });
  await operatorContext.close();

  const viewerContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const viewerPage = await viewerContext.newPage();
  await signIn(viewerPage, fixture.viewerEmail);
  await expect(viewerPage.locator('[data-testid=incidents-page]')).toBeVisible();
  await expect(viewerPage.locator('[data-testid=incident-claim-queue]')).toHaveCount(0);
  await setTheme(viewerPage, 'dark');
  await expect(viewerPage.locator('[data-testid=incidents-page]')).toBeVisible();
  await viewerPage.screenshot({ path: path.join(OUT, 'viewer-1024-dark.png'), fullPage: true });
  await viewerContext.close();
});

test('a conflict is explained and the queue refreshes', async ({ browser, playwright }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, fixture.operatorEmail);
  const row = page.locator(`[data-testid=incident-claim-row][data-incident-id="${fixture.incidents[1]}"]`);
  await expect(row).toBeVisible();

  // The second operator claims the same row through the real API; the first operator's
  // click is then decided against a row that has moved.
  const rival = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const rivalLogin = await rival.post('/api/v1/auth/login', { data: { email: fixture.otherEmail, password: PASSWORD } });
  const rivalCsrf = (await rivalLogin.json()).csrfToken as string;
  const claimed = await rival.post(`/api/v1/incidents/${fixture.incidents[1]}/claim`, {
    headers: { 'x-csrf-token': rivalCsrf },
    data: { expectedRevision: 1 },
  });
  expect(claimed.status()).toBe(200);
  await rival.dispose();

  await row.locator('[data-testid=incident-claim-button]').click();
  await expect(page.locator('.toast-danger')).toContainText('Another operator claimed this incident first');
  await expect(page.locator(`[data-testid=incident-claim-row][data-incident-id="${fixture.incidents[1]}"]`)).toHaveCount(0);
  await context.close();
});

test('the queue holds its shape at 1440, 1024 and 390 in both themes', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, fixture.operatorEmail);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);
      const row = page.locator('[data-testid=incident-claim-row]').first();
      await expect(row).toBeVisible();
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(Math.min(300, width - 40));
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: path.join(OUT, `matrix-${width}-${theme}.png`), fullPage: true });
    }
  }
  await context.close();
});

test('390px renders the queue as cards, and the loading and network states are distinct', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page, fixture.operatorEmail);
  await setTheme(page, 'dark');
  const row = page.locator(`[data-testid=incident-claim-row][data-incident-id="${fixture.incidents[2]}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-testid=incident-claim-button]')).toBeVisible();
  const box = await row.boundingBox();
  expect(box?.width).toBeGreaterThan(250);
  await page.screenshot({ path: path.join(OUT, 'queue-390-dark.png'), fullPage: true });
  await context.close();

  // Loading is not drawn as an answered empty queue, and a failed read is not either.
  const loadingContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const loadingPage = await loadingContext.newPage();
  await loadingPage.route('**/api/v1/incidents/claimable', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await signIn(loadingPage, fixture.operatorEmail);
  await expect(loadingPage.locator('[data-testid=incident-claim-loading]')).toBeVisible();
  await loadingContext.close();

  const failedContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const failedPage = await failedContext.newPage();
  await failedPage.route('**/api/v1/incidents/claimable', (route) => route.abort());
  await signIn(failedPage, fixture.operatorEmail);
  await expect(failedPage.locator('[data-testid=incident-claim-failed]')).toBeVisible();
  await failedPage.screenshot({ path: path.join(OUT, 'queue-failed-1024-light.png'), fullPage: true });
  await failedPage.unroute('**/api/v1/incidents/claimable');
  await failedPage.getByRole('button', { name: /retry/i }).first().click();
  await expect(failedPage.locator(`[data-testid=incident-claim-row][data-incident-id="${fixture.incidents[3]}"]`)).toBeVisible();
  await failedContext.close();
});
