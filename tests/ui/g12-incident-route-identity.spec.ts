import { expect, test, type Page } from '@playwright/test';
import { adminSeed } from './support/accounts';

/**
 * G12 A2 - route identity in a real browser.
 *
 * What this spec can and cannot reach is worth stating, because the difference decides which
 * layer proves what.
 *
 * Reachable through today's UI: the incidents list is the only door between two incidents, so
 * every route change to another incident passes through the list and the detail component is
 * unmounted on the way. A browser test therefore cannot produce "the param changed while the
 * detail page stayed mounted", which is the case the reducer's route-identity rules exist for.
 * Those rules are proven - and were proven to discriminate by deliberately breaking them - in
 * src/incidents.test.ts (detailReducer / projectDetail), where they are plain functions.
 *
 * What this spec does prove, against the running UI and the running kernel:
 *
 *   1. no sample ever pairs another incident's URL with the record of the incident before it;
 *   2. a slow answer for a left incident that arrives after the next one is on screen does not
 *      overwrite it. The delay is injected by the test into the network - the product has no
 *      timer anywhere - so a product that "fixed" this by waiting would still fail;
 *   3. 404 clears the record instead of leaving it on screen, and a network failure on the same
 *      id keeps it, with the instant it was read;
 *   4. the A1 write form no longer offers the value the kernel reserves - and the server refuses
 *      it when the browser sends it anyway, so the form is not the gate;
 *   5. the A3 verdict separates what was signed from what was appended afterwards.
 *
 * Fixtures are created through the public API, never inserted by hand, so the spec writes to the
 * kernel it points at and must run against a throw-away database.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = Date.now().toString(36).slice(-6);

interface Incident {
  id: string;
  title: string;
}

/**
 * Signs the administrator in for fixture setup AND performs the one business-workspace grant a
 * fresh database needs before it can file a single incident.
 *
 * The second half is not a convenience. Since D5 (migration 0022) a business row is readable for
 * exactly one reason - the caller is a MEMBER of the workspace it lives in - and the kernel runs
 * migrations before it creates the bootstrap account, so on a fresh database the migration's
 * one-time grant does not cover it (ADR section 3.4: the administrator "can create workspaces and
 * grant, but reads no business row until it grants itself once, which is an audited platform
 * action and not an automatic acquisition"). Without the grant every fixture POST below answers
 * 403 INCIDENT_WORKSPACE_FORBIDDEN, and this spec fails on its own setup rather than on the rule
 * it exists to prove.
 *
 * Done here, per spec, rather than in a shared pre-test hook: a hook would perform the grant
 * against whatever OPSWEAVE_URL points at, and on a shared host that includes staging.
 */
async function adminToken(page: Page): Promise<string> {
  return (await adminSeed(page.request, ADMIN_EMAIL, ADMIN_PASSWORD)).csrf;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function createIncident(page: Page, csrf: string, title: string): Promise<Incident> {
  const response = await page.request.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': csrf },
    data: { title, severity: 'MAJOR', startedAt: new Date().toISOString() },
  });
  expect(response.ok(), 'create incident ' + title).toBeTruthy();
  const body = await response.json();
  return { id: body.id as string, title: body.title as string };
}

async function addEvidence(page: Page, csrf: string, incidentId: string, contentRef: string) {
  const response = await page.request.post('/api/v1/incidents/' + incidentId + '/evidence', {
    headers: { 'x-csrf-token': csrf },
    data: {
      kind: 'LOG_EXCERPT',
      source: 'syslog',
      collectedAt: new Date().toISOString(),
      contentRef,
    },
  });
  expect(response.ok(), 'append evidence ' + contentRef).toBeTruthy();
  return (await response.json()) as { id: string };
}

async function recordVerdict(page: Page, csrf: string, incidentId: string) {
  const response = await page.request.post('/api/v1/incidents/' + incidentId + '/verdict', {
    headers: { 'x-csrf-token': csrf },
    data: { verdict: 'CONFIRMED', rationale: 'g12 route identity spec ' + RUN + ': evidence matches' },
  });
  expect(response.ok(), 'record verdict').toBeTruthy();
  return (await response.json()) as { consideredEvidenceCount: number; snapshotKind: string };
}

/**
 * Starts sampling what the DOM is showing, keyed by the URL it is showing it for.
 *
 * Two samplers on purpose: requestAnimationFrame catches painted frames, and a 10ms timer keeps
 * the record dense even when a headless browser throttles frames. The timer is a property of the
 * *instrument*, not of the product - nothing under test waits for anything.
 */
async function startSampling(page: Page) {
  await page.evaluate(() => {
    const store: unknown[] = [];
    (window as unknown as { __g12samples: unknown[] }).__g12samples = store;
    const record = () => {
      const detail = document.querySelector('[data-testid="incident-detail"]');
      store.push({
        path: location.pathname,
        incidentId: detail?.getAttribute('data-incident-id') ?? null,
        routeId: detail?.getAttribute('data-route-id') ?? null,
        title: document.querySelector('h1')?.textContent ?? null,
      });
    };
    const loop = () => {
      record();
      (window as unknown as { __g12raf: number }).__g12raf = requestAnimationFrame(loop);
    };
    loop();
    (window as unknown as { __g12interval: number }).__g12interval = window.setInterval(record, 10);
  });
}

interface Sample {
  path: string;
  incidentId: string | null;
  routeId: string | null;
  title: string | null;
}

async function samples(page: Page): Promise<Sample[]> {
  return page.evaluate(() => (window as unknown as { __g12samples: Sample[] }).__g12samples);
}

async function openIncident(page: Page, incident: Incident) {
  await page.locator('[data-incident-row="' + incident.id + '"] a.ow-ident-link').click();
  await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-incident-id', incident.id);
}

test.describe('G12 A2 route identity', () => {
  let csrf = '';

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    csrf = await adminToken(page);
  });

  test('no observation pairs another incident URL with this incident record', async ({ page }) => {
    const a = await createIncident(page, csrf, 'g12 route A ' + RUN);
    const b = await createIncident(page, csrf, 'g12 route B ' + RUN);

    await page.goto('/app/incidents');
    await openIncident(page, a);
    await startSampling(page);

    await page.locator('[data-testid="incident-detail"] a[href="/app/incidents"]').first().click();
    await expect(page.locator('[data-testid="incidents-page"]')).toBeVisible();
    await openIncident(page, b);

    const seen = await samples(page);
    expect(seen.length, 'the sampler must have observed the whole transition').toBeGreaterThan(20);

    const bPath = '/app/incidents/' + b.id;
    const leaks = seen.filter((sample) => sample.path === bPath && (sample.incidentId === a.id || sample.title === a.title));
    expect(leaks, 'samples taken while the URL was B that still showed A: ' + JSON.stringify(leaks)).toEqual([]);

    // And the positive half: B really did render under B's URL.
    expect(seen.some((sample) => sample.path === bPath && sample.incidentId === b.id)).toBe(true);
  });

  test('while the next incident is still loading, the previous one is not on screen', async ({ page }) => {
    const a = await createIncident(page, csrf, 'g12 loading A ' + RUN);
    const b = await createIncident(page, csrf, 'g12 loading B ' + RUN);

    // The *entered* route is the slow one. This is the window in which a page that
    // merely "refetches on param change" keeps rendering the record it already had.
    await page.route('**/api/v1/incidents/' + b.id, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto('/app/incidents');
    await openIncident(page, a);
    await startSampling(page);

    await page.locator('[data-testid="incident-detail"] a[href="/app/incidents"]').first().click();
    await expect(page.locator('[data-testid="incidents-page"]')).toBeVisible();
    await page.locator('[data-incident-row="' + b.id + '"] a.ow-ident-link').click();
    await expect(page).toHaveURL(new RegExp('/app/incidents/' + b.id));

    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-detail-state', 'loading');
    await expect(page.locator('[data-testid="incident-detail"]')).not.toHaveAttribute('data-incident-id', a.id);

    const during = await samples(page);
    const bPath = '/app/incidents/' + b.id;
    const leaks = during.filter((sample) => sample.path === bPath && (sample.incidentId === a.id || sample.title === a.title));
    expect(leaks, 'samples taken while B was loading that still showed A: ' + JSON.stringify(leaks)).toEqual([]);

    // And B does arrive, under its own id.
    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-incident-id', b.id);
  });

  test('a slow answer for the previous incident does not overwrite the current one', async ({ page }) => {
    const a = await createIncident(page, csrf, 'g12 slow A ' + RUN);
    const b = await createIncident(page, csrf, 'g12 slow B ' + RUN);

    // The delay lives in the test, not in the product.
    await page.route('**/api/v1/incidents/' + a.id, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });

    await page.goto('/app/incidents');
    await page.locator('[data-incident-row="' + a.id + '"] a.ow-ident-link').click();
    await expect(page).toHaveURL(new RegExp('/app/incidents/' + a.id));
    // Leave while A is still in flight.
    await page.locator('[data-testid="incident-detail"] a[href="/app/incidents"]').first().click();
    await expect(page.locator('[data-testid="incidents-page"]')).toBeVisible();
    await openIncident(page, b);

    // Wait past the injected delay so A's answer really has been delivered.
    await page.waitForTimeout(3000);

    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-incident-id', b.id);
    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-route-id', b.id);
    await expect(page.locator('[data-testid="incident-detail"] h1')).not.toHaveText(a.title);
    await expect(page).toHaveURL(new RegExp('/app/incidents/' + b.id));
  });

  test('a 404 clears the record instead of leaving it on screen', async ({ page }) => {
    const b = await createIncident(page, csrf, 'g12 gone B ' + RUN);
    await page.goto('/app/incidents/' + b.id);
    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-incident-id', b.id);

    await page.route('**/api/v1/incidents/' + b.id, (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'INCIDENT_NOT_FOUND', message: 'incident not found', requestId: 'g12-404', retryable: false }),
    }));
    await page.click('[data-testid="incident-refresh"]');

    await expect(page.locator('[data-testid="incident-not-found"]')).toBeVisible();
    await expect(page.locator('[data-testid="incident-detail"]')).toHaveAttribute('data-detail-state', 'not-found');
    // The title that was on screen is gone: a 404 is an answer, and an answer takes data away.
    await expect(page.locator('[data-testid="incident-detail"]')).not.toHaveAttribute('data-incident-id', b.id);
    await expect(page.locator('[data-testid="incident-detail"] h1')).not.toHaveText(b.title);
  });

  test('a failed refresh on the same id keeps the record and dates it', async ({ page }) => {
    const b = await createIncident(page, csrf, 'g12 stale B ' + RUN);
    await addEvidence(page, csrf, b.id, 'sha256:stale-row-' + RUN);
    await page.goto('/app/incidents/' + b.id);
    await expect(page.locator('[data-evidence-row]')).toHaveCount(1);

    await page.route('**/api/v1/incidents/' + b.id + '/evidence', (route) => route.abort('failed'));
    await page.click('[data-testid="incident-refresh"]');

    await expect(page.locator('[data-testid="incident-freshness"]')).toHaveAttribute('data-stale', 'true');
    // The rows are still there: an absent answer is not a reason to erase a record.
    await expect(page.locator('[data-evidence-row]')).toHaveCount(1);
    await expect(page.locator('[data-testid="incident-detail"] h1')).toHaveText(b.title);
  });
});

test.describe('G12 A1 and A3 through the page', () => {
  let csrf = '';

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    csrf = await adminToken(page);
  });

  test('the write form offers a claim, not a verification, and says why', async ({ page }) => {
    const incident = await createIncident(page, csrf, 'g12 claim form ' + RUN);
    await page.goto('/app/incidents/' + incident.id);

    // The pre-G12 control is gone, not merely disabled.
    await expect(page.locator('[data-testid="incident-evidence-trust"]')).toHaveCount(0);

    await page.click('[data-testid="incident-evidence-claim"]');
    await expect(page.locator('[data-testid="incident-evidence-claim-option-OPERATOR_ASSERTED"]')).toBeVisible();
    await expect(page.locator('[data-testid="incident-evidence-claim-option-UNVERIFIED"]')).toBeVisible();
    await expect(page.locator('[data-testid="incident-evidence-claim-option-SOURCE_ATTESTED"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(page.locator('[data-testid="incident-evidence-claim-notice"]')).toBeVisible();

    // And the server refuses it even when the browser sends it anyway: the form is not the gate.
    const refused = await page.request.post('/api/v1/incidents/' + incident.id + '/evidence', {
      headers: { 'x-csrf-token': csrf },
      data: {
        kind: 'OPERATOR_NOTE',
        source: 'operator:bypass',
        collectedAt: new Date().toISOString(),
        contentRef: 'note:bypass-' + RUN,
        trust: 'SOURCE_ATTESTED',
      },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).code).toBe('EVIDENCE_TRUST_NOT_SELF_ASSERTABLE');
  });

  test('evidence appended after signing is marked, and the signed facts do not move', async ({ page }) => {
    const incident = await createIncident(page, csrf, 'g12 after verdict ' + RUN);
    const first = await addEvidence(page, csrf, incident.id, 'sha256:before-1-' + RUN);
    await addEvidence(page, csrf, incident.id, 'sha256:before-2-' + RUN);
    const verdict = await recordVerdict(page, csrf, incident.id);
    expect(verdict.consideredEvidenceCount).toBe(2);
    expect(verdict.snapshotKind).toBe('RECORDED');
    const late = await addEvidence(page, csrf, incident.id, 'sha256:after-1-' + RUN);

    await page.goto('/app/incidents/' + incident.id);

    await expect(page.locator('[data-evidence-row="' + late.id + '"]')).toHaveAttribute('data-after-verdict', 'true');
    await expect(page.locator('[data-evidence-row="' + first.id + '"]')).toHaveAttribute('data-after-verdict', 'false');
    await expect(page.locator('[data-testid="evidence-after-verdict"]')).toHaveCount(1);

    const considered = page.locator('[data-testid="incident-verdict-considered"]');
    await expect(considered).toHaveAttribute('data-snapshot-kind', 'RECORDED');
    await expect(considered).toHaveAttribute('data-considered-count', '2');
    await expect(considered).toHaveAttribute('data-after-count', '1');
    await expect(page.locator('[data-testid="incident-verdict-digest"] code')).toHaveText(/^[0-9a-f]{64}$/);
    await expect(page.locator('[data-testid="incident-verdict-after"]')).toBeVisible();

    // The trust cell reports both facts, and the badge is the verified one.
    const row = page.locator('[data-evidence-row="' + first.id + '"] [data-verified-trust]');
    await expect(row).toHaveAttribute('data-verified-trust', 'OPERATOR_ASSERTED');
    await expect(row).toHaveAttribute('data-claimed-trust', 'OPERATOR_ASSERTED');
    await expect(row).toHaveAttribute('data-trust-mismatch', 'false');
  });
});
