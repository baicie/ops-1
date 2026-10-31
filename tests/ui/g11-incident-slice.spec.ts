import { expect, request, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { adminSeed, createAccount as createSeededAccount } from './support/accounts';

/**
 * G11 D4 - the real golden path, in a real browser against a real kernel and a real database.
 *
 * Six steps are proven here and nothing is stubbed: the browser creates an incident, reloads and
 * finds it, appends evidence whose source and content reference it then reads back from the API,
 * queries the list through the filters, records a human verdict that survives a reload, and meets
 * the permission wall for a viewer and the data scope of an operator.
 *
 * Two consequences of "nothing is stubbed" are worth stating rather than hiding:
 *
 *   * this spec WRITES to the kernel it points at (users, incidents, evidence, verdicts), so it
 *     must run against a throw-away database - the same rule as
 *     tests/acceptance/incident_slice_api.sh;
 *   * every account it needs is created through the admin API, so it needs only the admin
 *     credentials below. Nothing is read from a fixture and no response is intercepted.
 *
 * Selectors are data attributes and roles only - never localized copy (rules/06) - so the same
 * spec runs with the shell in English or Chinese.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = process.env.OPSWEAVE_G11_RUN || Date.now().toString(36).slice(-6);
const SHOTS = process.env.OPSWEAVE_G11_SHOTS || 'artifacts/g11-d3';

interface Account {
  email: string;
  password: string;
  displayName: string;
  role: 'operator' | 'viewer';
}

const OPERATOR: Account = { email: `g11-operator-${RUN}@example.invalid`, password: `operator-password-${RUN}`, displayName: `G11 operator ${RUN}`, role: 'operator' };
/**
 * A second operator, whose only job is to own the record the role-pair check writes to.
 *
 * It exists because the two roles have to meet on ONE record, and OPERATOR owns nothing: the
 * scope test below proves that with an empty list. Reusing OPERATOR here would leave it owning a
 * record and turn that scope assertion into a different question.
 */
const SECOND_OPERATOR: Account = { email: `g11-operator-b-${RUN}@example.invalid`, password: `operator-b-password-${RUN}`, displayName: `G11 second operator ${RUN}`, role: 'operator' };
const VIEWER: Account = { email: `g11-viewer-${RUN}@example.invalid`, password: `viewer-password-${RUN}`, displayName: `G11 viewer ${RUN}`, role: 'viewer' };

/** The three records this run keeps track of across serial tests. */
let concludedId = '';
let openId = '';
let operatorIncidentId = '';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

/** Drops the session cookie so the next sign-in is a different account. */
async function signOut(page: Page) {
  await page.context().clearCookies();
}

/**
 * Creates the non-admin accounts through the admin API, as an admin would - and grants each one
 * the legacy business workspace, which is the half this seed was missing (G12 D5,
 * docs/design/g12-scope/d5-business-workspace-adr.md section 3.4: an account created AFTER the
 * migration is a member of nothing until an administrator grants it).
 *
 * The missing half was invisible rather than merely wrong. Before D5 a viewer read every
 * incident on the platform, so "the viewer reads the operator's record" passed on a predicate
 * that said nothing about the accounts this spec fabricates; after D5 the same assertion can
 * only be true because of a grant. That is why the creation and the grant now live together in
 * tests/ui/support/accounts.ts instead of being retyped per spec: a spec that forgets the grant
 * gets an account that reads nothing and can file nothing, which is a failure three assertions
 * away from its cause. adminSeed() also gives THIS test's administrator the one grant a fresh
 * database needs before it can create a single incident (ADR section 3.4).
 */
async function createAccount(page: Page, account: Account) {
  const admin = await adminSeed(page.request, ADMIN_EMAIL, ADMIN_PASSWORD);
  await createSeededAccount(page.request, admin, account);
}

/** One API session: its own cookie jar, and the token a write needs. */
interface ApiSession {
  api: APIRequestContext;
  csrfToken: string;
}

/**
 * Signs an account in through the API, in a cookie jar of its own. A separate jar is the point:
 * the browser is signed in as the viewer, and the operator call below must not borrow that
 * session - if it did, both calls would be one role and the comparison would prove nothing.
 */
async function apiSignIn(origin: string, email: string, password: string): Promise<ApiSession> {
  const api = await request.newContext({ baseURL: origin });
  const login = await api.post('/api/v1/auth/login', { data: { email, password } });
  expect(login.ok(), 'api sign-in for ' + email).toBeTruthy();
  const { csrfToken } = await login.json();
  return { api, csrfToken };
}

/** Creates an incident as the signed-in API session, so the session also owns the record. */
async function apiCreateIncident(session: ApiSession, title: string): Promise<string> {
  const created = await session.api.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': session.csrfToken },
    data: { title, severity: 'MINOR', source: 'MANUAL', startedAt: new Date().toISOString(), relatedEntity: 'api-gateway' },
  });
  expect(created.status(), 'the record owner creates it').toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** POST /verdict, with one body for every caller: the role is the only variable between calls. */
async function apiRecordVerdict(session: ApiSession, incidentId: string): Promise<APIResponse> {
  return session.api.post('/api/v1/incidents/' + incidentId + '/verdict', {
    headers: { 'x-csrf-token': session.csrfToken },
    data: { verdict: 'INCONCLUSIVE', rationale: 'the same call from two roles; only the role differs (' + RUN + ')' },
  });
}

/** Reads the record id out of the detail route the page navigated to. */
async function incidentIdFromUrl(page: Page): Promise<string> {
  await page.waitForURL(/\/app\/incidents\/[0-9a-f-]{36}$/);
  const match = /\/app\/incidents\/([0-9a-f-]{36})$/.exec(page.url());
  expect(match, 'detail route carries the incident id').not.toBeNull();
  return (match as RegExpExecArray)[1];
}

async function createIncident(page: Page, title: string, severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'WARNING' = 'MAJOR'): Promise<string> {
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  await page.getByTestId('incident-create-open').click();
  await page.getByTestId('incident-create-title').fill(title);
  await page.getByTestId('incident-create-severity').click();
  await page.locator('[data-testid="incident-create-severity-option-' + severity + '"]').click();
  await page.getByTestId('incident-create-related').fill('api-gateway');
  await page.getByTestId('incident-create-submit').click();
  return incidentIdFromUrl(page);
}

test.describe.configure({ mode: 'serial' });

test('the admin creates an incident, it survives a reload, evidence is verifiable, the list queries it, and a verdict sticks', async ({ page }) => {
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await createAccount(page, OPERATOR);
  await createAccount(page, SECOND_OPERATOR);
  await createAccount(page, VIEWER);

  // 1. Create on the page, marked as a manual record.
  const title = `G11 e2e gateway 5xx spike ${RUN}`;
  concludedId = await createIncident(page, title);
  const detail = page.getByTestId('incident-detail');
  await expect(detail).toHaveAttribute('data-incident-id', concludedId);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  // The record says where it came from: a manual entry, because that is the only way this page writes.
  await expect(page.getByTestId('incident-detail-source')).toHaveAttribute('data-source', 'MANUAL');
  await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'OPEN');
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'missing');
  await page.screenshot({ path: SHOTS + '/01-created-detail.png', fullPage: true });

  // 2. Reload: the record is in the database, not in component state.
  await page.reload();
  await expect(detail).toHaveAttribute('data-incident-id', concludedId);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // 3. Evidence whose source and content reference are read back as typed.
  const contentRef = 'sha256:g11-e2e-' + RUN + '-log-excerpt';
  const source = 'operator:' + ADMIN_EMAIL;
  await page.getByTestId('incident-evidence-source').fill(source);
  await page.getByTestId('incident-evidence-content-ref').fill(contentRef);
  await page.getByTestId('incident-evidence-submit').click();
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'present');
  const evidenceRow = page.locator('[data-evidence-row]').first();
  await expect(evidenceRow).toBeVisible();
  await expect(page.locator('[data-testid="evidence-content-ref"]').first()).toHaveText(contentRef);
  await expect(evidenceRow.locator('[data-evidence-source]')).toHaveAttribute('data-evidence-source', source);
  await expect(evidenceRow.locator('[data-evidence-kind]')).toHaveAttribute('data-evidence-kind', 'LOG_EXCERPT');
  await expect(page.getByTestId('incident-detail-evidence-count')).toHaveText('1');
  // The first evidence row moves the incident into investigation (kernel state machine, T2).
  await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'INVESTIGATING');
  await page.reload();
  await expect(page.locator('[data-testid="evidence-content-ref"]').first()).toHaveText(contentRef);
  await page.screenshot({ path: SHOTS + '/02-evidence-persisted.png', fullPage: true });

  // 4. The list queries it: the filters run in the kernel, and a filter that cannot match says so.
  await page.goto('/app/incidents');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();
  await page.getByTestId('incident-filter-status').click();
  await page.locator('[data-testid="incident-filter-status-option-INVESTIGATING"]').click();
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();
  await page.getByTestId('incident-filter-severity').click();
  await page.locator('[data-testid="incident-filter-severity-option-MINOR"]').click();
  await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-empty-state', 'filtered');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toHaveCount(0);
  await page.getByTestId('incident-filter-severity').click();
  await page.locator('[data-testid="incident-filter-severity-option-MAJOR"]').click();
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/03-list-filtered.png', fullPage: true });

  // 5. The human verdict is written once and survives a reload.
  await page.goto('/app/incidents/' + concludedId);
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'open');
  await page.getByTestId('incident-verdict-value').click();
  await page.locator('[data-testid="incident-verdict-option-CONFIRMED"]').click();
  await page.getByTestId('incident-verdict-rationale').fill('gateway returned 502 for four minutes; the log excerpt matches that window (' + RUN + ')');
  await page.getByTestId('incident-verdict-submit').click();
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'recorded');
  await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'CONFIRMED');
  await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'CONCLUDED');
  await page.reload();
  await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'CONFIRMED');
  await page.screenshot({ path: SHOTS + '/04-verdict-persisted.png', fullPage: true });

  // Evidence is still appendable after the verdict (ADR-G11-001 §3.1: a late paste during review
  // is a real audit case), and appending it must not reopen the incident. This is the one place
  // the page previously claimed the opposite, so it is asserted rather than assumed.
  await expect(page.getByTestId('incident-evidence-form')).toBeVisible();
  await page.getByTestId('incident-evidence-content-ref').fill('sha256:g11-e2e-' + RUN + '-post-verdict-review');
  await page.getByTestId('incident-evidence-submit').click();
  await expect(page.getByTestId('incident-detail-evidence-count')).toHaveText('2');
  await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'CONCLUDED');
  await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'CONFIRMED');

  // The list reflects the verdict: a CONCLUDED filter finds it, an OPEN filter does not.
  await page.goto('/app/incidents');
  await page.getByTestId('incident-filter-status').click();
  await page.locator('[data-testid="incident-filter-status-option-CONCLUDED"]').click();
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();
  await page.getByTestId('incident-filter-status').click();
  await page.locator('[data-testid="incident-filter-status-option-OPEN"]').click();
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toHaveCount(0);

  // A second incident is left open on purpose: the viewer and the operator need a record that
  // can still accept a verdict, and this one has no evidence at all.
  openId = await createIncident(page, `G11 e2e unproven incident ${RUN}`, 'MINOR');
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'missing');
});

test('a viewer reads incidents it does not own and is refused every write, with the refusal explained', async ({ page }) => {
  await signOut(page);
  await signIn(page, VIEWER.email, VIEWER.password);

  // Read: a viewer sees incidents it does not own.
  await page.goto('/app/incidents');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();
  await expect(page.locator('[data-incident-row="' + openId + '"]')).toBeVisible();
  await page.goto('/app/incidents/' + concludedId);
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'recorded');

  // Write: creating is refused by the server (403), and the page says which code refused it.
  await page.goto('/app/incidents');
  await page.getByTestId('incident-create-open').click();
  await page.getByTestId('incident-create-title').fill('G11 e2e viewer must not create this ' + RUN);
  await page.getByTestId('incident-create-submit').click();
  const createError = page.getByTestId('incident-create-error');
  await expect(createError).toBeVisible();
  await expect(createError).toHaveAttribute('data-error-code', 'FORBIDDEN');
  await page.screenshot({ path: SHOTS + '/05-viewer-create-refused.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toHaveCount(1);

  // Write: a verdict. The refusal itself has not moved, but WHERE the viewer meets it has
  // (ADR-G11-001 section 4.5), so both halves are asserted instead of one being assumed.
  //
  // The page half: a viewer is told its role cannot write, and no form is rendered for it - a
  // role that can never submit a verdict is not invited to try. The server half is unchanged and
  // NOT weakened: the same POST is refused 403 FORBIDDEN for the viewer session, and the same
  // call on the same record by an operator is accepted with 201. Without that second call a red
  // here could not be told apart from a broken endpoint, a bad body or a record that refuses
  // every verdict - with it, the role is the only variable left.
  await page.goto('/app/incidents/' + openId);
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'open');
  await expect(
    page.getByTestId('incident-verdict-readonly'),
    'a viewer is told its role cannot write, instead of being handed a form that can only fail',
  ).toBeVisible();
  await expect(page.getByTestId('incident-verdict-form'), 'no verdict form is rendered for a viewer').toHaveCount(0);
  await page.screenshot({ path: SHOTS + '/06-viewer-verdict-readonly.png', fullPage: true });

  const origin = new URL(page.url()).origin;
  const viewerApi = await apiSignIn(origin, VIEWER.email, VIEWER.password);
  const verdictOwner = await apiSignIn(origin, SECOND_OPERATOR.email, SECOND_OPERATOR.password);
  const pairId = await apiCreateIncident(verdictOwner, 'G11 e2e verdict role pair ' + RUN);

  const refused = await apiRecordVerdict(viewerApi, pairId);
  expect(refused.status(), 'the kernel, not the page, refuses a viewer verdict').toBe(403);
  expect(((await refused.json()) as { code?: string }).code, 'a refused viewer write carries FORBIDDEN, not just any error').toBe('FORBIDDEN');
  const untouched = (await (await viewerApi.api.get('/api/v1/incidents/' + pairId)).json()) as { status?: string; humanVerdict?: unknown };
  expect(untouched.status, 'a refused verdict leaves the record open').toBe('OPEN');
  expect(untouched.humanVerdict ?? null, 'a refused verdict leaves no verdict behind').toBeNull();

  const accepted = await apiRecordVerdict(verdictOwner, pairId);
  expect(accepted.status(), 'the same call on the same record by an operator - so the 403 above is the role').toBe(201);
  expect(((await accepted.json()) as { verdict?: string }).verdict, 'the accepted verdict is the one that was sent').toBe('INCONCLUSIVE');
  await viewerApi.api.dispose();
  await verdictOwner.api.dispose();
});

test('an operator cannot see a record owned by someone else, and can still close its own loop', async ({ page }) => {
  await signOut(page);
  await signIn(page, OPERATOR.email, OPERATOR.password);

  // Scope: this operator owns nothing, and the page names WHICH empty list this is. The kernel
  // answers a narrowed caller and an unnarrowed one with the same items: [], so the narrowing
  // travelling beside the rows is the only thing that can separate the two facts. What the
  // kernel names is a field ('owner'), not a verdict about the platform: the page may say
  // "this list carries only the incidents you own", and it may not say "nothing was recorded".
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-empty-state', 'scoped');
  await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-narrowed-to', 'owner');
  // Positive half: the copy that belongs to the narrowed read is the one on screen.
  await expect(page.getByTestId('incidents-empty')).toContainText('incidents you own');
  // Negative half. This assertion used to deny 'nothing has been entered'; when the unnarrowed
  // copy stopped claiming the world that phrase was deleted, which would have left the
  // assertion vacuously true. It is retargeted at the sentence that copy carries now, so its
  // absence still proves this page rendered the narrowed state instead of the platform report.
  await expect(page.getByTestId('incidents-empty')).not.toContainText('no owner narrowing');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toHaveCount(0);
  await page.screenshot({ path: SHOTS + '/07-operator-empty-state.png', fullPage: true });

  // Scope: the admin's record is a 404 for this operator, not a redacted row.
  await page.goto('/app/incidents/' + concludedId);
  await expect(page.getByTestId('incident-detail')).toHaveAttribute('data-detail-state', 'not-found');
  await expect(page.getByTestId('incident-not-found')).toBeVisible();
  await page.screenshot({ path: SHOTS + '/08-operator-not-found.png', fullPage: true });

  // The operator's own record goes through the whole loop, and INCONCLUSIVE is allowed with no
  // evidence - the one verdict the kernel accepts without any.
  operatorIncidentId = await createIncident(page, `G11 e2e operator incident ${RUN}`, 'WARNING');
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'missing');
  await page.getByTestId('incident-verdict-rationale').fill('no evidence could be collected before the window closed (' + RUN + ')');
  await page.getByTestId('incident-verdict-submit').click();
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'recorded');
  await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'INCONCLUSIVE');
  await page.reload();
  await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'INCONCLUSIVE');

  // And the operator's list contains that record and still not the admin's.
  await page.goto('/app/incidents');
  await expect(page.locator('[data-incident-row="' + operatorIncidentId + '"]')).toBeVisible();
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toHaveCount(0);
  await page.screenshot({ path: SHOTS + '/09-operator-scoped-list.png', fullPage: true });
});

test('the loading state is a real pending read, and a real transport failure is reported as stale', async ({ page }) => {
  await signOut(page);
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/app/incidents');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();

  // Slow the transport down (CDP network emulation - no response is intercepted or rewritten),
  // then navigate inside the app: the detail page must show its pending state, not a blank page
  // and not a zero.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: 250000, uploadThroughput: 250000 });
  await page.locator('[data-incident-row="' + concludedId + '"] a.ow-ident-link').click();
  const pending = page.getByTestId('incident-detail');
  await expect(pending).toHaveAttribute('data-detail-state', 'loading');
  await page.screenshot({ path: SHOTS + '/10-loading-state.png', fullPage: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'recorded');

  // A real transport failure: the transport is taken away and the page is asked to refresh. It
  // keeps the data it read before, marks itself stale, and names the read time - the alternative
  // (an empty panel, or silently showing old rows as current) is what this assertion forbids.
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.getByTestId('incident-refresh').click();
  const stale = page.getByTestId('incident-freshness');
  await expect(stale).toHaveAttribute('data-stale', 'true');
  // The rows it already had are still there: a failed refresh does not erase evidence.
  await expect(page.getByTestId('incident-evidence')).toHaveAttribute('data-evidence-state', 'present');
  await page.screenshot({ path: SHOTS + '/11-offline-refresh-stale.png', fullPage: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.getByTestId('incident-refresh').click();
  await expect(page.getByTestId('incident-freshness')).toHaveCount(0);
});
/**
 * AGENTS.md requires a UI change to be reviewed at 1440/1024/390 in both themes. This test takes
 * those captures from the same real backend (no fixture) and asserts the two things a screenshot
 * cannot: the page never scrolls sideways, and the header's primary action is the element a click
 * actually reaches.
 *
 * The second assertion is a regression guard, not a formality: the first run of this spec found
 * .page-header's fixed 80px height (styles.css, page-template §2.1) letting a wrapped header put
 * its actions under the next panel, which then intercepted every click on the create button.
 */
test('the list and the detail survive 1440/1024/390 in both themes, and the header action is reachable', async ({ page }) => {
  await signOut(page);
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.goto('/app/incidents');
  await expect(page.locator('[data-incident-row="' + concludedId + '"]')).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    const current = await page.evaluate(() => document.documentElement.dataset.theme);
    if (current !== theme) {
      await page.getByTestId('theme-toggle').click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    }
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, name] of [['/app/incidents', 'list'], ['/app/incidents/' + concludedId, 'detail']] as const) {
        await page.goto(path);
        await expect(page.locator('[data-testid="incident-detail"], [data-testid="incidents-page"]').first()).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, path + ' at ' + width + '/' + theme).toBeLessThanOrEqual(1);
        await page.screenshot({ path: SHOTS + '/matrix-' + width + '-' + theme + '-' + name + '.png', fullPage: true });
      }
    }
  }

  // Geometry, not a screenshot: at 1440 the create button must be the element the pointer reaches.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/app/incidents');
  const create = page.getByTestId('incident-create-open');
  await expect(create).toBeVisible();
  const box = await create.boundingBox();
  expect(box).not.toBeNull();
  const reached = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return Boolean(element && element.closest('[data-testid="incident-create-open"]'));
  }, { x: (box as { x: number; width: number }).x + (box as { width: number }).width / 2, y: (box as { y: number; height: number }).y + (box as { height: number }).height / 2 });
  expect(reached, 'the header primary action is not covered by the next panel').toBe(true);
});
