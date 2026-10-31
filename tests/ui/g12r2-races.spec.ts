import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 R2 phase 2 - the seven asynchronous races, each measured rather than assumed.
 *
 * The rule this file exists for: a panel may be slow, but it may not show one incident's content
 * on another incident's page. Every test below makes one answer arrive after the reader has
 * already moved somewhere else, and then asserts on what is on screen.
 *
 * How the ordering is produced: a route handler fetches the REAL response from the Kernel and
 * then waits on a gate the test opens by hand. No timer decides anything and no product data is
 * fabricated - the only invented traffic is in the failure tests (R6, R7), where the failure is
 * the thing under test. Where a list has to lose a row (R3) the real response is filtered, and
 * the test says so.
 */
const ROOT = path.resolve(process.cwd(), '..', '..');
const OUT = process.env.OPSWEAVE_G12R2_OUT || path.join(ROOT, 'artifacts', 'g12-r2p2', 'shots');
const SEED = JSON.parse(fs.readFileSync(process.env.OPSWEAVE_SEED_JSON || path.join(ROOT, 'artifacts', 'g12-r2p2', 'seed.json'), 'utf8'));
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12r2.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12r2-admin-password-1';
const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18199';
const A_ID = SEED.incidents.evidence;
const B_ID = SEED.incidents.noEvidence;
const A = '/app/incidents/' + A_ID;
const B = '/app/incidents/' + B_ID;
const A_LIST = BASE + '/api/v1/incidents/' + A_ID + '/investigations';
const B_LIST = BASE + '/api/v1/incidents/' + B_ID + '/investigations';
const PANEL = '[data-testid=incident-investigations]';

/** A gate the test opens by hand: the handler waits on it, so ordering is decided here. */
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function openReady(page: Page, route: string) {
  await page.goto(route);
  await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
}

async function apiSession(request: APIRequestContext) {
  const login = await request.post(BASE + '/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  const body = await login.json();
  const cookie = (login.headers()['set-cookie'] || '').split('\n').map((line) => line.split(';')[0]).join('; ');
  return { cookie, csrf: body.csrfToken as string };
}

async function listRuns(request: APIRequestContext, session: { cookie: string }, incidentId: string) {
  const response = await request.get(BASE + '/api/v1/incidents/' + incidentId + '/investigations', { headers: { cookie: session.cookie } });
  expect(response.ok()).toBe(true);
  return (await response.json()) as Array<{ runId: string; status: string; adapter: string; idempotencyKey: string }>;
}

async function startRun(request: APIRequestContext, session: { cookie: string; csrf: string }, incidentId: string, body: Record<string, unknown>) {
  const response = await request.post(BASE + '/api/v1/incidents/' + incidentId + '/investigations', {
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    data: { idempotencyKey: 'g12r2-race-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), ...body },
  });
  expect(response.ok(), 'the Kernel refused to start a run: ' + (await response.text())).toBe(true);
  return (await response.json()) as { runId: string; status: string };
}

async function panelRunIds(page: Page) {
  return page.locator('[data-testid=investigation-history-list] > li').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-run-id')));
}

test.describe('G12 R2 phase 2 - asynchronous races', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await signIn(page);
  });

  test('R1 a list answer for incident A that arrives after the reader moved to B is dropped', async ({ page, request }) => {
    const session = await apiSession(request);
    const aRuns = await listRuns(request, session, A_ID);
    const bRuns = await listRuns(request, session, B_ID);
    await openReady(page, A);

    const gate = hold();
    let hit = false;
    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET' || hit) return route.continue();
      hit = true;
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.click('[data-testid=investigation-refresh]');
    await expect.poll(() => hit, { message: 'the test must hold a real answer for A before switching' }).toBe(true);

    // The reader leaves before that answer arrives.
    await page.click('[data-rail-incident="' + B_ID + '"]');
    await expect(page).toHaveURL(new RegExp(B_ID));
    await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready');
    expect(await panelRunIds(page)).toEqual(bRuns.map((run) => run.runId));

    gate.release();
    await page.waitForLoadState('networkidle');

    // Nothing from A may appear on B's page: not a run id, not the run count.
    const after = await panelRunIds(page);
    expect(after).toEqual(bRuns.map((run) => run.runId));
    for (const run of aRuns) expect(after, 'A run ' + run.runId + ' leaked into B').not.toContain(run.runId);
    await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready');
    await shot(page, 'race-r1-late-list');
  });

  test('R2 a citation body for A that arrives after the reader moved to B is dropped', async ({ page }) => {
    await openReady(page, A);
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
    await expect(page.locator('[data-testid=investigation-run]')).toBeVisible();

    const contentUrl = BASE + '/api/v1/incidents/' + A_ID + '/evidence/' + SEED.evidence.storedLog + '/content';
    const gate = hold();
    let hit = false;
    await page.route(contentUrl, async (route: Route) => {
      hit = true;
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.click('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedLog + '"]');
    await expect.poll(() => hit).toBe(true);

    await page.click('[data-rail-incident="' + B_ID + '"]');
    await expect(page).toHaveURL(new RegExp(B_ID));
    await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready');
    gate.release();
    await page.waitForLoadState('networkidle');

    // The bytes belong to A's incident: they may not be rendered under B, in any form.
    await expect(page.locator('[data-testid=investigation-citation-content]')).toHaveCount(0);
    await expect(page.locator(PANEL)).not.toContainText('ERROR payment-webhook');
    await shot(page, 'race-r2-late-citation');
  });

  test('R2b an older citation answer does not replace the citation the reader opened later', async ({ page }) => {
    await openReady(page, A);
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
    const first = BASE + '/api/v1/incidents/' + A_ID + '/evidence/' + SEED.evidence.storedLog + '/content';
    const second = BASE + '/api/v1/incidents/' + A_ID + '/evidence/' + SEED.evidence.storedQuery + '/content';
    const gate = hold();
    let hit = false;
    await page.route(first, async (route: Route) => {
      hit = true;
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.click('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedLog + '"]');
    await expect.poll(() => hit).toBe(true);
    await page.click('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedQuery + '"]');
    const body = page.locator('[data-testid=investigation-citation-content]');
    await expect(body).toHaveAttribute('data-evidence-id', SEED.evidence.storedQuery);

    gate.release();
    await page.waitForLoadState('networkidle');
    await expect(body).toHaveAttribute('data-evidence-id', SEED.evidence.storedQuery);
    await expect(body).toContainText('status_code');
    await expect(page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedQuery + '"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedLog + '"]')).toHaveAttribute('aria-expanded', 'false');
    await shot(page, 'race-r2b-citation-order');
  });

  test('R3 a selected run that is no longer in the list is replaced, and said so', async ({ page, request }) => {
    const session = await apiSession(request);
    const runs = await listRuns(request, session, A_ID);
    const selected = runs.find((run) => run.runId === SEED.runs.budget.id) ?? runs[runs.length - 1];
    await openReady(page, A);
    await page.click('li[data-run-id="' + selected.runId + '"] [data-testid=investigation-select]');
    await expect(page.locator('[data-testid=investigation-run]')).toHaveAttribute('data-run-status', selected.status);

    // The list the Kernel bounds at twenty rows: this response is the real one with the open run
    // removed, which is exactly what a bounded list does to an old selection.
    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const rows = await response.json();
      await route.fulfill({ response, json: rows.filter((row: { runId: string }) => row.runId !== selected.runId) });
    });
    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('[data-testid=investigation-selection-gone]')).toBeVisible();
    // The detail pane is filled with the newest run rather than left blank under the title.
    const now = page.locator('[data-testid=investigation-run]');
    await expect(now).toBeVisible();
    await expect(now).not.toHaveAttribute('data-run-status', /^$/);
    const shown = await page.locator('[data-testid=investigation-history-list] [data-testid=investigation-select][data-selected=true]').evaluateAll((nodes) => nodes.length);
    expect(shown, 'exactly one run is selected after the fallback').toBe(1);
    await shot(page, 'race-r3-selection-gone');
  });

  test('R4 a run that finishes while it is open is re-read, not guessed', async ({ page, request }) => {
    const session = await apiSession(request);
    await openReady(page, A);
    // This test's run, identified by the key this test sends: a second suite (or a second
    // invocation) sharing the Kernel creates runs of its own, and "the newest running run" would
    // then be somebody else's run. The idempotency key is what makes the run this one.
    const key = 'g12r2-race-r4-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    // The start request does not answer until the run has finished, so it is issued without
    // being awaited: the run exists as RUNNING in the Kernel while that request is in flight.
    const pending = request.post(BASE + '/api/v1/incidents/' + A_ID + '/investigations', {
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
      data: { idempotencyKey: key, scenario: 'PACED_TOOL_LOOP', maxSteps: 200, maxToolCalls: 500, tokenBudget: 4_000_000, deadlineSeconds: 300 },
    });
    type Run = { runId: string; status: string; idempotencyKey: string };
    const findRunning = async (): Promise<Run | null> => (await listRuns(request, session, A_ID)).find((run) => run.idempotencyKey === key) ?? null;
    await expect.poll(async () => Boolean(await findRunning()), { timeout: 20_000 }).toBe(true);
    const running = (await findRunning())!;

    await page.click('[data-testid=investigation-refresh]');
    await page.click('li[data-run-id="' + running.runId + '"] [data-testid=investigation-select]');
    await expect(page.locator('[data-testid=investigation-status]')).toHaveText('Running');
    await expect(page.locator('[data-testid=investigation-review-form]')).toHaveCount(0);
    await expect(page.locator('[data-testid=investigation-cancel]')).toBeVisible();

    const cancel = await request.post(BASE + '/api/v1/incidents/' + A_ID + '/investigations/' + running.runId + '/cancel', {
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(cancel.ok()).toBe(true);
    const finished = await pending;
    expect(finished.ok()).toBe(true);
    expect((await finished.json()).status).toBe('CANCELLED');

    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('li[data-run-id="' + running.runId + '"]')).toHaveAttribute('data-run-status', 'CANCELLED');
    // The pane describes the run it now reads: status, stop reason, and the review form a
    // finished unreviewed run is owed.
    await page.click('li[data-run-id="' + running.runId + '"] [data-testid=investigation-select]');
    await expect(page.locator('[data-testid=investigation-status]')).toHaveText('Cancelled');
    await expect(page.locator('[data-testid=investigation-stop-reason]')).toHaveText('cancelled by an operator');
    await expect(page.locator('[data-testid=investigation-review-form]')).toBeVisible();
    await shot(page, 'race-r4-finished-while-open');
  });

  test('R5 a review answered after the reader switched incidents is not painted into the new one', async ({ page, request }) => {
    const session = await apiSession(request);
    const run = await startRun(request, session, A_ID, { scenario: 'AUTO' });
    await openReady(page, A);
    await page.click('li[data-run-id="' + run.runId + '"] [data-testid=investigation-select]');
    await page.fill('[data-testid=investigation-review-note]', 'A review written while the reader was leaving this page.');

    const gate = hold();
    let hit = false;
    const reviewUrl = BASE + '/api/v1/incidents/' + A_ID + '/investigations/' + run.runId + '/review';
    await page.route(reviewUrl, async (route: Route) => {
      hit = true;
      const response = await route.fetch();
      await gate.promise;
      await route.fulfill({ response });
    });
    await page.click('[data-testid=investigation-review-accept]');
    await expect.poll(() => hit).toBe(true);

    await page.click('[data-rail-incident="' + B_ID + '"]');
    await expect(page).toHaveURL(new RegExp(B_ID));
    await expect(page.locator(PANEL)).toHaveAttribute('data-state', 'ready');
    gate.release();
    await page.waitForLoadState('networkidle');

    // B's panel is unchanged: none of A's runs, none of this review's note, and no toast that
    // claims a review happened here.
    const rows = await panelRunIds(page);
    expect(rows).not.toContain(run.runId);
    await expect(page.locator(PANEL)).not.toContainText('A review written while the reader was leaving this page.');
    await expect(page.locator('.toast')).toHaveCount(0);
    // The review did land on the server - dropping it in the UI must not drop the write.
    const stored = await request.get(BASE + '/api/v1/incidents/' + A_ID + '/investigations/' + run.runId, { headers: { cookie: session.cookie } });
    expect((await stored.json()).review?.decision).toBe('ACCEPTED');
    await shot(page, 'race-r5-review-during-switch');
  });

  test('R6 a refused re-read keeps the record but removes every write control', async ({ page }) => {
    await openReady(page, A);
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
    await expect(page.locator('[data-testid=investigation-start]')).toBeVisible();

    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'FORBIDDEN', message: 'this account may no longer read this record', retryable: false }),
      });
    });
    await page.click('[data-testid=investigation-refresh]');
    const banner = page.locator('[data-testid=investigation-stale-banner]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('data-stale-code', 'FORBIDDEN');
    await expect(banner).toContainText('requires the operator or admin role');
    await expect(page.locator(PANEL)).toHaveAttribute('data-stale', 'true');
    await expect(page.locator('[data-testid=investigation-run]')).toHaveAttribute('data-stale', 'true');
    // The rows stay - they are the only record the reader has - but nothing can be written on
    // the strength of a read that just failed.
    await expect(page.locator('[data-testid=investigation-history-list] > li').first()).toBeVisible();
    await expect(page.locator('[data-testid=investigation-start]')).toHaveCount(0);
    await expect(page.locator('[data-testid=investigation-review-form]')).toHaveCount(0);
    await expect(page.locator('[data-testid=investigation-cancel]')).toHaveCount(0);
    await shot(page, 'race-r6-403-stale');

    // And the recovery path is real: the next successful read clears the banner and restores them.
    await page.unroute(A_LIST);
    await page.click('[data-testid=investigation-refresh]');
    await expect(banner).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveAttribute('data-stale', 'false');
    await expect(page.locator('[data-testid=investigation-start]')).toBeVisible();
    await shot(page, 'race-r6-recovered');
  });

  test('R7 a 404 is named, a network failure is named, and neither leaves stale data unlabelled', async ({ page }) => {
    await openReady(page, A);
    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'INCIDENT_NOT_FOUND', message: 'gone', retryable: false }) });
    });
    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('[data-testid=investigation-stale-banner]')).toContainText('not one you can read');
    await shot(page, 'race-r7-404');

    await page.unroute(A_LIST);
    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.abort('failed');
    });
    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('[data-testid=investigation-stale-banner]')).toContainText('the network failed');
    await expect(page.locator('[data-testid=investigation-stale-banner]')).toHaveAttribute('data-stale-code', 'NETWORK');
    await shot(page, 'race-r7-network');

    await page.unroute(A_LIST);
    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('[data-testid=investigation-stale-banner]')).toHaveCount(0);
  });

  test('R7b a 401 signs the reader out instead of leaving the last read on screen', async ({ page }) => {
    await openReady(page, A);
    await page.route(A_LIST, async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED', message: 'expired', retryable: false }) });
    });
    await page.click('[data-testid=investigation-refresh]');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    await expect(page.locator(PANEL)).toHaveCount(0);
    await shot(page, 'race-r7b-401-signout');
  });
});