import { expect, test, type Page } from '@playwright/test';
import { adminSeed, createAccount, createWorkspace, type SeedAccount } from './support/accounts';

/**
 * G12 post-merge: the create affordance must follow the server's rules, on BOTH entries.
 *
 * The defect this file exists for: `PageHeader.primary` was unconditional, so a viewer or an
 * account with no workspace was invited to open a form whose submit `POST /api/v1/incidents`
 * refuses (`require_operator()`, then `INCIDENT_WORKSPACE_FORBIDDEN`). The empty-state button
 * had been gated a day earlier and the header had not, which is exactly the failure mode two
 * independent decisions for one capability produce.
 *
 * Nothing here stubs a permission: every account is created through the admin API, every
 * membership is granted through the admin API, and the page under test talks to the real
 * kernel. The two `unknown` cases intercept only the WORKSPACE LIST (never `/auth/me` and never
 * the incident list), because "the memberships did not answer" is a state the server cannot be
 * asked to produce on demand.
 *
 * Selectors are data-testids only - never localized copy (rules/06).
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = process.env.OPSWEAVE_CREATE_GATE_RUN || Date.now().toString(36).slice(-6);

let admin: Awaited<ReturnType<typeof adminSeed>>;

/** Accounts the matrix needs, each created once in `beforeAll` because they all cost API calls. */
const accounts: Record<string, SeedAccount> = {};

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

/**
 * Opens the list and waits for the page to be there.
 *
 * `settle` waits for the create gate to resolve - either a live entry or a stated refusal. The
 * workspace read starts on mount, so without it every assertion below races that read and can
 * see the `unknown` state instead of the account's answer. The `unknown` cases pass false:
 * there, "nothing was drawn" IS the assertion, so waiting for a control would hang.
 */
async function openIncidents(page: Page, { settle = true }: { settle?: boolean } = {}) {
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  await expect(page.locator('[data-testid=page-header]')).toBeVisible();
  if (settle) {
    await expect(
      page.locator('[data-testid=incident-create-open], [data-testid=incident-create-blocked]').first(),
      'the create gate must settle on this account (a live entry, or a stated refusal)',
    ).toBeVisible({ timeout: 15_000 });
  }
}

/**
 * POST /incidents from inside the signed-in page, so the CSRF token the app holds is used.
 *
 * `page.request` shares the cookie jar but NOT the in-memory CSRF token, so it is refused by
 * the CSRF layer and every "the server refuses this role" assertion would pass for that
 * reason instead of the one it names. Measured: CSRF_FAILED where the test expected FORBIDDEN.
 */
async function writeFromPage(page: Page, title: string): Promise<{ status: number; code: string | null }> {
  return page.evaluate(async (incidentTitle) => {
    // The token is not in a readable cookie; the kernel returns it on /auth/me.
    const me = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    const token = ((await me.json()) as { csrfToken?: string }).csrfToken;
    const response = await fetch('/api/v1/incidents', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
      body: JSON.stringify({ title: incidentTitle, severity: 'MINOR', source: 'MANUAL', startedAt: new Date().toISOString() }),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, code: (body as { code?: string }).code ?? null };
  }, title);
}

/** The two entries, read the same way a reader would: is there a control, and does it work. */
async function readEntries(page: Page) {
  const open = page.getByTestId('incident-create-open');
  const blocked = page.getByTestId('incident-create-blocked');
  const openInEmpty = page.getByTestId('incident-create-open-empty');
  const blockedInEmpty = page.getByTestId('incident-create-blocked-empty');
  return {
    headerOpen: (await open.count()) > 0,
    headerBlocked: (await blocked.count()) > 0,
    headerBlockedKind: (await blocked.count()) > 0 ? await blocked.getAttribute('data-create-blocked') : null,
    emptyOpen: (await openInEmpty.count()) > 0,
    emptyBlocked: (await blockedInEmpty.count()) > 0,
    emptyBlockedKind: (await blockedInEmpty.count()) > 0 ? await blockedInEmpty.getAttribute('data-create-blocked') : null,
    headerText: (await page.locator('[data-testid=page-header]').innerText()).replace(/\s+/g, ' ').trim(),
  };
}

test.beforeAll(async ({ request }) => {
  admin = await adminSeed(request, ADMIN_EMAIL, ADMIN_PASSWORD);
  const suffix = RUN;
  accounts.adminNoMembership = await createAccount(request, admin, {
    email: `cg-admin-${suffix}@example.invalid`,
    password: `cg-admin-pw-${suffix}`,
    displayName: `CG admin ${suffix}`,
    role: 'operator',
  }, { grant: false });
  accounts.operatorOne = await createAccount(request, admin, {
    email: `cg-op1-${suffix}@example.invalid`,
    password: `cg-op1-pw-${suffix}`,
    displayName: `CG op one ${suffix}`,
    role: 'operator',
  });
  accounts.operatorTwo = await createAccount(request, admin, {
    email: `cg-op2-${suffix}@example.invalid`,
    password: `cg-op2-pw-${suffix}`,
    displayName: `CG op two ${suffix}`,
    role: 'operator',
  });
  accounts.operatorNone = await createAccount(request, admin, {
    email: `cg-opn-${suffix}@example.invalid`,
    password: `cg-opn-pw-${suffix}`,
    displayName: `CG op none ${suffix}`,
    role: 'operator',
  }, { grant: false });
  accounts.viewerMember = await createAccount(request, admin, {
    email: `cg-vwm-${suffix}@example.invalid`,
    password: `cg-vwm-pw-${suffix}`,
    displayName: `CG viewer member ${suffix}`,
    role: 'viewer',
  });
  accounts.viewerNone = await createAccount(request, admin, {
    email: `cg-vwn-${suffix}@example.invalid`,
    password: `cg-vwn-pw-${suffix}`,
    displayName: `CG viewer none ${suffix}`,
    role: 'viewer',
  }, { grant: false });
  // A second workspace for `operatorTwo` only. One membership is the legacy one it already has;
  // the second is what forces the dialog to ask instead of guessing.
  await createWorkspace(request, admin, [accounts.operatorTwo.id], `cg-second-${suffix}`);
});

test('an admin with a workspace creates through the header, and the record is real', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openIncidents(page);
  const entries = await readEntries(page);
  expect(entries.headerOpen, 'the header offers create to an admin that may create').toBe(true);
  expect(entries.headerBlocked, 'nothing is blocked for this account').toBe(false);

  await page.getByTestId('incident-create-open').click();
  await expect(page.getByTestId('incident-create-form')).toBeVisible();
  // Exactly one membership means the kernel resolves the workspace; the form must not ask.
  await expect(page.getByTestId('incident-create-workspace')).toHaveCount(0);
  const title = `CG admin creates ${RUN}`;
  await page.getByTestId('incident-create-title').fill(title);
  await page.getByTestId('incident-create-submit').click();
  await expect(page).toHaveURL(/\/app\/incidents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
});

test('an operator with one workspace creates without being asked which', async ({ page }) => {
  await signIn(page, accounts.operatorOne.email, accounts.operatorOne.password);
  await openIncidents(page);
  const entries = await readEntries(page);
  expect(entries.headerOpen, 'one membership is enough to create').toBe(true);
  expect(entries.emptyOpen || entries.headerOpen, 'at least one entry is live').toBe(true);

  await page.getByTestId('incident-create-open').click();
  await expect(page.getByTestId('incident-create-form')).toBeVisible();
  await expect(page.getByTestId('incident-create-workspace')).toHaveCount(0);
  await page.getByTestId('incident-create-title').fill(`CG op one creates ${RUN}`);
  await page.getByTestId('incident-create-submit').click();
  await expect(page).toHaveURL(/\/app\/incidents\/[0-9a-f-]{36}$/);
});

test('an operator with several workspaces must choose one, and the choice is sent', async ({ page }) => {
  await signIn(page, accounts.operatorTwo.email, accounts.operatorTwo.password);
  await openIncidents(page);
  expect((await readEntries(page)).headerOpen, 'several memberships still allow creating').toBe(true);

  await page.getByTestId('incident-create-open').click();
  const chooser = page.getByTestId('incident-create-workspace');
  await expect(chooser, 'the kernel will not guess, so the form asks').toBeVisible();

  // Submitting without an answer is refused by the FORM, before the round trip, with the same
  // sentence the kernel's INCIDENT_WORKSPACE_REQUIRED maps to.
  await page.getByTestId('incident-create-title').fill(`CG op two creates ${RUN}`);
  await page.getByTestId('incident-create-submit').click();
  await expect(page.getByTestId('incident-create-field-error')).toBeVisible();

  await chooser.click();
  const options = page.locator('[data-testid^="incident-create-workspace-option-"]');
  await expect(options.first()).toBeVisible();
  expect(await options.count(), 'every writable workspace is offered').toBeGreaterThanOrEqual(2);
  // Read the selection BEFORE submitting: a successful submit closes the dialog and unmounts
  // every option, so a locator resolved afterwards waits on a node that no longer exists.
  const chosenKey = (await options.first().getAttribute('data-testid'))!.replace('incident-create-workspace-option-', '');
  await options.first().click();

  // What the page SENT is the claim in this test's name, and the response cannot carry it:
  // `IncidentView` has no workspaceId field, so the record's workspace is not on the wire.
  // Capturing the request body measures the thing directly instead of inferring it.
  const sent = page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/incidents');
  await page.getByTestId('incident-create-submit').click();
  const posted = JSON.parse((await sent).postData() || '{}') as { workspaceId?: string };
  await expect(page).toHaveURL(/\/app\/incidents\/[0-9a-f-]{36}$/);

  const listed = await page.request.get('/api/v1/business-workspaces');
  const workspaces = (await listed.json()) as Array<{ workspaceId: string; key: string }>;
  const expected = workspaces.find((workspace) => workspace.key === chosenKey);
  expect(expected, 'the chosen workspace is in the list the form was built from').toBeTruthy();
  expect(posted.workspaceId, 'the body names the workspace that was chosen, not one the page picked')
    .toBe(expected!.workspaceId);
});

test('an operator in no workspace gets no entry, and the reason says why', async ({ page }) => {
  await signIn(page, accounts.operatorNone.email, accounts.operatorNone.password);
  await openIncidents(page);
  const entries = await readEntries(page);
  expect(entries.headerOpen, 'no workspace means nowhere to file, so no live create').toBe(false);
  expect(entries.headerBlocked, 'the disabled control still says the capability exists').toBe(true);
  expect(entries.headerBlockedKind).toBe('workspace');
  expect(entries.headerText, 'the reason names the missing membership').toMatch(/workspace/i);
  // The empty state is the `workspace` kind and offers no button either.
  await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-empty-state', 'workspace');
  expect(entries.emptyOpen, 'no create button in the empty state').toBe(false);

  // And the server agrees: the form is not merely hidden, the write is refused.
  // Sent from the PAGE, not from `page.request`: a separate request context shares cookies but
  // not the CSRF token the app holds in memory, so it would be refused by the CSRF layer first
  // and the assertion would pass for the wrong reason (measured: CSRF_FAILED, not FORBIDDEN).
  const refused = await writeFromPage(page, `CG refused ${RUN}`);
  expect(refused.status, 'POST /incidents refuses an account in no workspace').toBe(403);
  expect(refused.code).toBe('INCIDENT_WORKSPACE_FORBIDDEN');
});

test('a viewer is refused on both entries even inside a workspace', async ({ page }) => {
  await signIn(page, accounts.viewerMember.email, accounts.viewerMember.password);
  await openIncidents(page);
  const entries = await readEntries(page);
  expect(entries.headerOpen, 'a viewer never creates, whatever it may read').toBe(false);
  expect(entries.headerBlockedKind, 'the reason names the role, not the workspace').toBe('role');
  expect(entries.emptyOpen, 'the empty state offers no create either').toBe(false);

  // Endpoint-level proof, so the assertion does not rest on a component being absent.
  const refused = await writeFromPage(page, `CG viewer refused ${RUN}`);
  expect(refused.status).toBe(403);
  expect(refused.code).toBe('FORBIDDEN');
});

test('a viewer in no workspace is told about the role, which outranks the membership', async ({ page }) => {
  await signIn(page, accounts.viewerNone.email, accounts.viewerNone.password);
  await openIncidents(page);
  const entries = await readEntries(page);
  expect(entries.headerOpen).toBe(false);
  // Role is the first gate: a viewer that also has no workspace is refused for the role, since
  // granting a membership would not make it able to write. The copy must not send it to an
  // administrator to ask for a workspace it still could not use.
  expect(entries.headerBlockedKind).toBe('role');
});

test('a workspace list that has not answered opens nothing', async ({ page }) => {
  await signIn(page, accounts.operatorOne.email, accounts.operatorOne.password);
  // Hold the workspace read open for the whole test. The incident list is untouched, so the page
  // renders normally and only this one fact is missing.
  await page.route('**/api/v1/business-workspaces', async () => { /* never fulfils */ });
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  // The incident list answers (it is a different endpoint), so the page is fully rendered and
  // only the gate is unknown. Waiting for it is what makes the counts below an assertion.
  await expect(page.locator('[data-testid=incidents-table-panel]')).toBeVisible();
  // Neither entry is live while the answer is unknown, and neither claims a refusal either:
  // `unknown` draws nothing, because it is not a permission decision.
  expect(await page.getByTestId('incident-create-open').count(), 'no create while the answer is in flight').toBe(0);
  expect(await page.getByTestId('incident-create-blocked').count(), 'and no invented refusal').toBe(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a failed workspace read is unknown, or a refusal when the incident list already says zero', async ({ page }) => {
  await signIn(page, accounts.operatorOne.email, accounts.operatorOne.password);
  await page.route('**/api/v1/business-workspaces', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await openIncidents(page, { settle: false });
  // Wait for the incident list itself to answer, so "no entry" is about the gate and not about
  // a page that has not rendered yet.
  await expect(page.locator('[data-testid=incidents-table-panel]')).toBeVisible();
  let entries = await readEntries(page);
  // The incident list answered with one workspace, so the failed read cannot be resolved either
  // way: no live entry, and no fabricated refusal.
  expect(entries.headerOpen).toBe(false);
  expect(entries.headerBlocked, 'a read that failed is not a permission decision').toBe(false);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  // The same failure against an account the incident list already reports as having zero
  // workspaces: there the page DOES know, so it may refuse.
  await signIn(page, accounts.operatorNone.email, accounts.operatorNone.password);
  await page.route('**/api/v1/business-workspaces', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await openIncidents(page);
  entries = await readEntries(page);
  expect(entries.headerOpen).toBe(false);
  expect(entries.headerBlockedKind, 'the incident list scope is a second witness for zero').toBe('workspace');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
