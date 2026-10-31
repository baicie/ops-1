import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { adminSeed, createAccount as createSeededAccount } from './support/accounts';

/**
 * G12 Phase C - the incident lifecycle in a real browser against the real kernel.
 *
 * What only a browser can prove, and therefore what this spec is for:
 *
 *   1. a CONCLUDED incident is actually closed from the page, and what the page shows afterwards
 *      is the closure of record (who, when, why) plus the audited write that produced it - not
 *      the form's own success message;
 *   2. a handover moves the incident out of the old owner's reach. The old owner is TOLD that,
 *      instead of being left with a form that would 404 on the next click, and the new owner
 *      finds the handover reason in the audit trail;
 *   3. a viewer reads a read-only explanation and is never shown a write form that is guaranteed
 *      to fail. That is presentation: tests/acceptance/g12_lifecycle.sh proves the kernel still
 *      answers 403 for the same requests, which is what makes the hint an explanation and not a
 *      gate.
 *
 * Fixtures are created through the public API, so this writes to the kernel it points at and
 * must run against a throw-away database.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = Date.now().toString(36).slice(-6);
const SHOTS = 'artifacts/g12c';

interface Actor {
  ctx: APIRequestContext;
  csrf: string;
  email: string;
  password: string;
  id: string;
}

async function signInApi(ctx: APIRequestContext, email: string, password: string): Promise<string> {
  const response = await ctx.post('/api/v1/auth/login', { data: { email, password } });
  expect(response.ok(), 'login for ' + email + ': ' + (await response.text())).toBeTruthy();
  const body = await response.json();
  return body.csrfToken as string;
}

function credentials(prefix: string) {
  return {
    email: prefix + '-g12c-' + RUN + '@example.invalid',
    password: prefix + '-g12c-password-1',
  };
}

/// Each actor gets its own request context: signing in mutates the context's cookie jar, so
/// reusing the admin's would end the admin session the next request needs.
async function makeUser(
  admin: Actor,
  baseURL: string | undefined,
  prefix: string,
  displayName: string,
  role: 'operator' | 'viewer',
): Promise<Actor> {
  const { email, password } = credentials(prefix);
  // Creation and the business-workspace grant are one act here, because they are one act for the
  // spec: an account created through the admin API belongs to no workspace, so opB could not be
  // handed a record (the kernel refuses a handover to a target that could never read it) and the
  // viewer could not read the one it is supposed to be told about. G12 D5, ADR section 3.4.
  const created = await createSeededAccount(
    admin.ctx,
    { csrf: admin.csrf, userId: admin.id },
    { email, password, displayName, role },
  );
  const ctx = await request.newContext({ baseURL });
  const csrf = await signInApi(ctx, email, password);
  return { ctx, csrf, email, password, id: created.id };
}

async function signInPage(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

test('G12 C: an operator closes a concluded incident, hands another one over, and a viewer is told why it is read-only', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);

  // ---- fixtures --------------------------------------------------------------
  const adminCtx = await request.newContext({ baseURL });
  // adminSeed signs in and performs the one grant a fresh database needs before the platform
  // administrator can create a single incident: migrations run before the bootstrap account
  // exists, so the migration's one-time membership grant does not cover it (ADR section 3.4).
  const adminSession = await adminSeed(adminCtx, ADMIN_EMAIL, ADMIN_PASSWORD);
  const admin: Actor = { ctx: adminCtx, csrf: adminSession.csrf, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, id: adminSession.userId };
  const opA = await makeUser(admin, baseURL, 'op-a', 'G12C Op Alice', 'operator');
  const opB = await makeUser(admin, baseURL, 'op-b', 'G12C Op Bob', 'operator');
  await makeUser(admin, baseURL, 'viewer', 'G12C Vic Viewer', 'viewer');
  const viewer = credentials('viewer');

  const now = new Date().toISOString();
  const created = await opA.ctx.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': opA.csrf },
    data: { title: 'g12c ui ready ' + RUN, severity: 'CRITICAL', startedAt: now, relatedEntity: 'service:checkout' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const ready = await created.json();
  const evidence = await opA.ctx.post('/api/v1/incidents/' + ready.id + '/evidence', {
    headers: { 'x-csrf-token': opA.csrf },
    data: { kind: 'LOG_EXCERPT', source: 'operator:g12c-ui', collectedAt: now, contentRef: 'sha256:g12c-ui-' + RUN },
  });
  expect(evidence.status(), await evidence.text()).toBe(201);
  const verdict = await opA.ctx.post('/api/v1/incidents/' + ready.id + '/verdict', {
    headers: { 'x-csrf-token': opA.csrf },
    data: { verdict: 'CONFIRMED', rationale: 'cpu saturation matches the reported window' },
  });
  expect(verdict.status(), await verdict.text()).toBe(201);

  const handoverCreated = await opA.ctx.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': opA.csrf },
    data: { title: 'g12c ui handover ' + RUN, severity: 'MAJOR', startedAt: now, relatedEntity: 'host:node-7' },
  });
  expect(handoverCreated.status(), await handoverCreated.text()).toBe(201);
  const handoverIncident = await handoverCreated.json();

  // ===========================================================================
  // 1. the operator closes it from the page
  // ===========================================================================
  await signInPage(page, opA.email, opA.password);
  await page.goto('/app/incidents/' + ready.id);
  await expect(page.getByTestId('incident-close-form')).toBeVisible();
  // The form states the revision it will decide against, so the operator can see what the
  // kernel is about to arbitrate on.
  const revision = await page.getByTestId('incident-revision').textContent();
  await expect(page.getByTestId('incident-close-form')).toHaveAttribute('data-expected-revision', revision ?? '');
  // A row an operator asserted is NOT presented as kernel-verified.
  await expect(page.getByTestId('incident-evidence-trusted')).toHaveAttribute('data-kernel-verified-count', '0');
  await expect(page.getByTestId('evidence-not-kernel-verified')).toBeVisible();

  await page.getByTestId('incident-close-note').fill('root cause was log rotation; fixed');
  await page.getByTestId('incident-close-submit').click();

  // The proof is the re-read, not the response: the page must now show the closure of record.
  await expect(page.getByTestId('incident-closure-record')).toBeVisible();
  await expect(page.getByTestId('incident-closure-record')).toHaveAttribute('data-closed-at', /.+/);
  await expect(page.getByTestId('incident-close-form')).toHaveCount(0);
  await expect(page.getByTestId('incident-closure-note')).toHaveText('root cause was log rotation; fixed');
  // The status chip carries the wire code in `data-status` and localised copy as its text, so the
  // assertion is on the code (a language switch must not break this spec).
  await expect(page.getByTestId('incident-detail-status').locator('[data-status]')).toHaveAttribute('data-status', 'CLOSED');
  // A closed incident refuses further writes in the UI as well, with the reason on screen.
  await expect(page.getByTestId('incident-evidence-sealed')).toBeVisible();
  await expect(page.getByTestId('incident-evidence-form')).toHaveCount(0);
  // And the audited write is in the trail, with the reason and the account that did it.
  const audit = page.getByTestId('incident-audit-list');
  await expect(audit.locator('[data-audit-event="INCIDENT_CLOSED"]')).toHaveCount(1);
  await expect(audit.locator('[data-audit-event="INCIDENT_CLOSED"] [data-testid="audit-note"]')).toContainText('root cause was log rotation; fixed');
  await expect(audit.locator('[data-audit-event="INCIDENT_CREATED"]')).toHaveCount(1);

  // The success toast is a confirmation of the write; it is dismissed before the captures so the
  // evidence is the page, not the page plus a floating banner.
  const dismiss = page.locator('.toast .icon-btn');
  if (await dismiss.count()) await dismiss.first().click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: SHOTS + '/operator-closed-1440-light.png', fullPage: true });
  // A narrow viewport must not scroll sideways: this page gained a lifecycle panel, an audit trail
  // and an evidence table, and any of them could have introduced a fixed width. The measurement is
  // taken after a fresh navigation, which is the state a phone user actually loads (a live viewport
  // change leaves the shell's navigation drawer open, and an open drawer is not a page width).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/incidents/' + ready.id);
  const overflowAt = () => page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // Why this is reached THROUGH the tab, and why BOTH widths are asserted rather than one.
  //
  // The property this spec bought at 390 was "the closure of record is readable after it is
  // written". When the assertion was written (25ba0a7) the page had no tabs, and one assertion
  // proved it. The page has three panes since 26ed53d and opens on 'analysis'
  // (IncidentDetail.tsx, initialPane), while the closure of record lives in the 'detail' pane - so
  // at 390 the record is in the DOM and out of sight, which is a fact about the layout and not
  // about the write. Left as a bare toBeVisible, that assertion would have been measuring "the
  // first pane happens to hold it".
  //
  // Neither width is relaxed: at 1440 the pane is a column and the record is visible with no
  // interaction (asserted above, and again in the dark re-read below); at 390 the reader switches
  // to the pane the record is in, and the switch is asserted in both directions - before the click
  // the tab is not selected and the record is in the DOM but not visible, after it both flip. The
  // pair is what makes this an assertion about the tab: without it, a page that drew the record in
  // the first pane would satisfy the click path too.
  const closureRecord = page.getByTestId('incident-closure-record');
  const detailTab = page.getByTestId('investigation-tab-detail');
  // The tablist exists only in the compact layout (max-width 1023), so its presence is what says
  // this viewport really is the tabbed one and not a column layout squeezed narrow.
  await expect(page.getByTestId('investigation-tabs')).toBeVisible();
  await expect(detailTab).toHaveAttribute('aria-selected', 'false');
  await expect(closureRecord).toHaveCount(1);
  await expect(closureRecord).toBeHidden();
  const narrow = await overflowAt();
  expect(narrow.scrollWidth, 'no horizontal overflow at 390px (analysis pane): ' + JSON.stringify(narrow)).toBeLessThanOrEqual(narrow.clientWidth + 1);
  await page.screenshot({ path: SHOTS + '/operator-closed-390-light.png', fullPage: true });

  await detailTab.click();
  await expect(detailTab).toHaveAttribute('aria-selected', 'true');
  await expect(closureRecord).toBeVisible();
  await expect(closureRecord).toHaveAttribute('data-closed-at', /.+/);
  const narrowDetail = await overflowAt();
  expect(narrowDetail.scrollWidth, 'no horizontal overflow at 390px (detail pane, where the closure is): ' + JSON.stringify(narrowDetail)).toBeLessThanOrEqual(narrowDetail.clientWidth + 1);
  await page.screenshot({ path: SHOTS + '/operator-closed-390-detail-light.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.getByTestId('incident-closure-record')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/operator-closed-1440-dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  // ===========================================================================
  // 2. the handover, and what each side of it can see
  // ===========================================================================
  await page.goto('/app/incidents/' + handoverIncident.id);
  await expect(page.getByTestId('incident-transfer-form')).toBeVisible();
  // An operator cannot read the admin-only user directory, so the target is typed, and the form
  // says so instead of offering an empty picker.
  await page.getByTestId('incident-transfer-target').fill(opB.id);
  await page.getByTestId('incident-transfer-reason').fill('night shift takes over; the pager is with them');
  await page.getByTestId('incident-transfer-submit').click();

  // The operator is told that access ended, instead of being reloaded into a 404.
  await expect(page.getByTestId('incident-handover-complete')).toBeVisible();
  await expect(page.getByTestId('incident-handover-complete')).toHaveAttribute('data-new-owner', opB.id);
  await expect(page.getByTestId('incident-handover-scope-lost')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: SHOTS + '/operator-handover-complete-1440-light.png', fullPage: true });

  // The old owner is now outside the record: the same URL answers 'not found / no access'.
  await page.goto('/app/incidents/' + handoverIncident.id);
  await expect(page.getByTestId('incident-not-found')).toBeVisible();

  // The new owner reads it, and finds the handover in the trail.
  const opBContext = await browser.newContext({ baseURL });
  const opBPage = await opBContext.newPage();
  await signInPage(opBPage, opB.email, opB.password);
  await opBPage.goto('/app/incidents/' + handoverIncident.id);
  await expect(opBPage.getByTestId('incident-detail')).toHaveAttribute('data-incident-id', handoverIncident.id);
  await expect(opBPage.getByTestId('incident-detail-owner')).toHaveAttribute('title', opB.id);
  const handoverAudit = opBPage.getByTestId('incident-audit-list');
  await expect(handoverAudit.locator('[data-audit-event="INCIDENT_OWNER_TRANSFERRED"]')).toHaveCount(1);
  await expect(handoverAudit.locator('[data-audit-event="INCIDENT_OWNER_TRANSFERRED"] [data-testid="audit-reason"]')).toContainText('night shift takes over; the pager is with them');
  await expect(opBPage.getByTestId('incident-transfer-form')).toBeVisible();
  await opBPage.screenshot({ path: SHOTS + '/new-owner-handover-trail-1440-light.png', fullPage: true });
  await opBContext.close();

  // ===========================================================================
  // 3. the viewer: a sentence, not a doomed form
  // ===========================================================================
  const viewerContext = await browser.newContext({ baseURL });
  const viewerPage = await viewerContext.newPage();
  await signInPage(viewerPage, viewer.email, viewer.password);
  await viewerPage.goto('/app/incidents/' + ready.id);
  await expect(viewerPage.getByTestId('incident-readonly-notice')).toBeVisible();
  await expect(viewerPage.getByTestId('incident-readonly-reason')).toContainText('viewer role');
  // No write affordance is drawn at all - not a disabled button, not an empty form.
  await expect(viewerPage.getByTestId('incident-close-form')).toHaveCount(0);
  await expect(viewerPage.getByTestId('incident-evidence-form')).toHaveCount(0);
  await expect(viewerPage.getByTestId('incident-verdict-form')).toHaveCount(0);
  await expect(viewerPage.getByTestId('incident-transfer-form')).toHaveCount(0);
  await expect(viewerPage.getByTestId('incident-evidence-readonly')).toBeVisible();
  // Reading still works: the record, the closure and the trail are all present.
  await expect(viewerPage.getByTestId('incident-closure-record')).toBeVisible();
  await expect(viewerPage.getByTestId('incident-audit-list')).toBeVisible();
  await expect(viewerPage.getByTestId('incident-verdict-record')).toBeVisible();

  await viewerPage.setViewportSize({ width: 1440, height: 1000 });
  await viewerPage.screenshot({ path: SHOTS + '/viewer-readonly-1440-light.png', fullPage: true });
  await viewerPage.setViewportSize({ width: 1024, height: 900 });
  await viewerPage.screenshot({ path: SHOTS + '/viewer-readonly-1024-light.png', fullPage: true });
  await viewerPage.emulateMedia({ colorScheme: 'dark' });
  await viewerPage.setViewportSize({ width: 1440, height: 1000 });
  await viewerPage.reload();
  await expect(viewerPage.getByTestId('incident-readonly-notice')).toBeVisible();
  await viewerPage.screenshot({ path: SHOTS + '/viewer-readonly-1440-dark.png', fullPage: true });
  await viewerPage.setViewportSize({ width: 390, height: 844 });
  await viewerPage.emulateMedia({ colorScheme: 'light' });
  await viewerPage.goto('/app/incidents/' + ready.id);
  await expect(viewerPage.getByTestId('incident-readonly-notice')).toBeVisible();
  const viewerNarrow = await viewerPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(viewerNarrow.scrollWidth, 'no horizontal overflow at 390px: ' + JSON.stringify(viewerNarrow)).toBeLessThanOrEqual(viewerNarrow.clientWidth + 1);
  await viewerPage.screenshot({ path: SHOTS + '/viewer-readonly-390-light.png', fullPage: true });
  await viewerContext.close();
  await adminCtx.dispose();
  await opA.ctx.dispose();
  await opB.ctx.dispose();
});