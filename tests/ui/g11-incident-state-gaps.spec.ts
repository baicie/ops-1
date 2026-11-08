import { expect, request, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_WORKSPACE_ID, adminSeed, type AdminSeed } from './support/accounts';

/**
 * The five incident states `docs/design/g11-incident/g11-d3-ui.md` section 5 listed as
 * implemented but never exercised end to end, in a real browser against a real kernel:
 *
 *   1. evidence 'unavailable' - the incident read landed, the evidence read did not;
 *   2. the 409 INCIDENT_EVIDENCE_REQUIRED page presentation;
 *   3. the 409 INCIDENT_ALREADY_CONCLUDED page presentation;
 *   4. the list's nextCursor pagination, with more than one page of records;
 *   5. the CLOSED / 'sealed' verdict presentation.
 *
 * Four of the five are driven only through public HTTP and the real page. The exception is (1):
 * its precondition is "one read succeeded and its neighbour failed", which a healthy kernel will
 * not produce on demand - so Playwright aborts ONLY the evidence request. The incident read, the
 * timeline read and every write in that test are real, and the retry at the end is real: once the
 * route is removed, the same page must reach the answered-empty state. No response is rewritten.
 *
 * Fixtures are created through the public API (the same calls a client would make), so this spec
 * writes to the kernel it points at and must run against a throw-away database.
 *
 * Selectors are data attributes and roles, never localized copy. Where the copy IS the contract
 * (the refusal sentences and the "not an empty list" sentence), the assertion compares against
 * the same i18n catalog value the page renders, so the test follows the catalog rather than
 * duplicating it.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = process.env.OPSWEAVE_G11_GAPS_RUN || Date.now().toString(36).slice(-6);
const LOCALE = process.env.OPSWEAVE_TEST_LOCALE || 'en';

/** The repository root, found by walking up: the harness runs this spec from tests/ui. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), 'packages/platform-client/src/i18n/catalogs', LOCALE + '.json'), 'utf8'),
) as Record<string, string>;

/** The rendered copy of a key, from the catalog the page itself is built from. */
function copy(key: string): string {
  const value = CATALOG[key];
  expect(value, 'i18n catalog carries ' + key).toBeTruthy();
  return value;
}

interface IncidentVerdictView {
  verdict: string;
  rationale: string;
  decidedAt: string;
}

interface IncidentFixture {
  id: string;
  status: string;
  revision: number;
  humanVerdict: IncidentVerdictView | null;
}

/** One signed-in API session, with the workspace grant a fresh database's admin needs. */
interface Api {
  ctx: APIRequestContext;
  admin: AdminSeed;
}

async function apiFor(baseURL: string | undefined): Promise<Api> {
  const ctx = await request.newContext({ baseURL });
  const admin = await adminSeed(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { ctx, admin };
}

/**
 * A record filed in the legacy workspace by name.
 *
 * `workspaceId` is explicit rather than inferred: adminSeed grants it, so naming it is always
 * allowed, and it keeps this fixture independent of how many other memberships the admin has
 * accumulated from earlier specs in the same run.
 */
async function createIncident(api: Api, title: string, startedAt: string = new Date().toISOString()): Promise<IncidentFixture> {
  const response = await api.ctx.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': api.admin.csrf },
    data: {
      title,
      severity: 'MINOR',
      source: 'MANUAL',
      startedAt,
      relatedEntity: 'state-gap-fixture',
      workspaceId: LEGACY_WORKSPACE_ID,
    },
  });
  const body = await response.text();
  expect(response.status(), 'create incident "' + title + '" -> ' + response.status() + ': ' + body.slice(0, 300)).toBe(201);
  return JSON.parse(body) as IncidentFixture;
}

async function addEvidence(api: Api, incidentId: string, contentRef: string): Promise<void> {
  const response = await api.ctx.post('/api/v1/incidents/' + incidentId + '/evidence', {
    headers: { 'x-csrf-token': api.admin.csrf },
    data: {
      kind: 'LOG_EXCERPT',
      source: 'operator:' + ADMIN_EMAIL,
      collectedAt: new Date().toISOString(),
      contentRef,
    },
  });
  const body = await response.text();
  expect(response.status(), 'append evidence -> ' + response.status() + ': ' + body.slice(0, 300)).toBe(201);
}

async function recordVerdict(api: Api, incidentId: string, verdict: string, rationale: string): Promise<APIResponse> {
  return api.ctx.post('/api/v1/incidents/' + incidentId + '/verdict', {
    headers: { 'x-csrf-token': api.admin.csrf },
    data: { verdict, rationale },
  });
}

async function getIncident(api: Api, incidentId: string): Promise<IncidentFixture> {
  const response = await api.ctx.get('/api/v1/incidents/' + incidentId);
  const body = await response.text();
  expect(response.status(), 'read incident -> ' + response.status() + ': ' + body.slice(0, 300)).toBe(200);
  return JSON.parse(body) as IncidentFixture;
}

async function closeIncident(api: Api, incidentId: string, revision: number, note: string): Promise<IncidentFixture> {
  const response = await api.ctx.post('/api/v1/incidents/' + incidentId + '/close', {
    headers: { 'x-csrf-token': api.admin.csrf },
    data: { expectedRevision: revision, note, idempotencyKey: 'g11-gaps-close-' + RUN },
  });
  const body = await response.text();
  expect(response.status(), 'close incident -> ' + response.status() + ': ' + body.slice(0, 300)).toBe(200);
  return JSON.parse(body) as IncidentFixture;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

/** Picks one verdict on the detail page's form. */
async function chooseVerdict(page: Page, code: 'CONFIRMED' | 'INCONCLUSIVE'): Promise<void> {
  await page.getByTestId('incident-verdict-value').click();
  await page.locator('[data-testid="incident-verdict-option-' + code + '"]').click();
}

async function rowIds(page: Page): Promise<string[]> {
  return page.locator('[data-incident-row]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-incident-row') ?? ''));
}

test('the evidence panel says the read failed, not that there is no evidence, and its retry is real', async ({ page, baseURL }) => {
  const api = await apiFor(baseURL);
  const incident = await createIncident(api, 'G11 gaps evidence unavailable ' + RUN);
  try {
    await signIn(page);

    // The ONE interception in this spec, and it is the state under test: the evidence request is
    // aborted while every other request the page makes stays real.
    await page.route('**/api/v1/incidents/*/evidence', (route) => route.abort('failed'));
    await page.goto('/app/incidents/' + incident.id);

    // The incident itself loaded: this is not the whole-page failure branch.
    await expect(page.getByTestId('incident-detail')).toHaveAttribute('data-incident-id', incident.id);
    const panel = page.getByTestId('incident-evidence');
    await expect(panel).toHaveAttribute('data-evidence-state', 'unavailable');

    const unavailable = page.getByTestId('incident-evidence-unavailable');
    await expect(unavailable).toBeVisible();
    // The sentence that forbids reading this as "no evidence" is the contract.
    await expect(unavailable).toContainText(copy('incidents.detail.evidence.unavailable.title'));
    await expect(unavailable).toContainText(copy('incidents.detail.evidence.unavailable.description'));
    // The answered-empty state is a different fact and must not be on screen.
    await expect(page.getByTestId('incident-evidence-empty')).toHaveCount(0);
    // The failure itself is surfaced, with the machine-readable marker of an absent answer.
    await expect(page.getByTestId('incident-evidence-error')).toHaveAttribute('data-error-code', 'UNREACHABLE');

    // The retry is a control, not decoration. With the endpoint restored it must produce the
    // kernel's answered-empty state: proof that 'unavailable' was the abort, not the data.
    await page.unroute('**/api/v1/incidents/*/evidence');
    await unavailable.getByRole('button').click();
    await expect(panel).toHaveAttribute('data-evidence-state', 'missing');
    await expect(page.getByTestId('incident-evidence-empty')).toBeVisible();
    await expect(page.getByTestId('incident-evidence-unavailable')).toHaveCount(0);
  } finally {
    await api.ctx.dispose();
  }
});

test('a refused evidence read is a permission wall, not a retryable failure', async ({ page, baseURL }) => {
  const api = await apiFor(baseURL);
  const incident = await createIncident(api, 'G11 gaps evidence forbidden ' + RUN);
  try {
    await signIn(page);

    // A 403 is an answer, not a missing one: the incident loaded and the evidence request was
    // refused. The page must not offer a retry (a grant is the fix), must not share the
    // unavailable panel, and must not print a provenance count over rows it never received.
    await page.route('**/api/v1/incidents/*/evidence', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'FORBIDDEN', message: 'refused by g11-incident-state-gaps' }),
      }),
    );
    await page.goto('/app/incidents/' + incident.id);

    await expect(page.getByTestId('incident-detail')).toHaveAttribute('data-incident-id', incident.id);
    const panel = page.getByTestId('incident-evidence');
    await expect(panel).toHaveAttribute('data-evidence-state', 'forbidden');
    const forbidden = page.getByTestId('incident-evidence-forbidden');
    await expect(forbidden).toBeVisible();
    await expect(forbidden).toContainText(copy('incidents.detail.evidence.forbidden.title'));
    await expect(forbidden).toContainText(copy('incidents.detail.evidence.forbidden.description'));
    await expect(page.getByTestId('incident-evidence-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('incident-evidence-trusted')).toHaveCount(0);
    // A retry cannot create a grant; the panel must not pretend it can.
    await expect(forbidden.getByRole('button')).toHaveCount(0);

    // The stale banner names the failure in the page language. The wire code stays in the
    // attribute; printing "FORBIDDEN" in the sentence would be protocol data as copy.
    const freshness = page.getByTestId('incident-freshness');
    await expect(freshness).toHaveAttribute('data-error-code', 'FORBIDDEN');
    await expect(freshness).not.toContainText('FORBIDDEN');
    await expect(freshness).toContainText(copy('ui.error.rejected'));

    // The panel only exists for a refused read, so a fixture cannot replace this evidence.
    const shots = path.join(repoRoot(), 'artifacts/ui/visual-v1/after');
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, 'incident-forbidden-1440-light-en.png'), fullPage: true });
    await forbidden.screenshot({ path: path.join(shots, 'incident-forbidden-panel-1440-light-en.png') });
  } finally {
    await api.ctx.dispose();
  }
});

test('a CONFIRMED verdict with no evidence is refused as INCIDENT_EVIDENCE_REQUIRED and leaves the record OPEN', async ({ page, baseURL }) => {
  const api = await apiFor(baseURL);
  const incident = await createIncident(api, 'G11 gaps evidence required ' + RUN);
  try {
    await signIn(page);
    await page.goto('/app/incidents/' + incident.id);
    await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'open');

    await chooseVerdict(page, 'CONFIRMED');
    await page.getByTestId('incident-verdict-rationale').fill('confirming with no evidence at all (' + RUN + ')');
    await page.getByTestId('incident-verdict-submit').click();

    const failure = page.getByTestId('incident-verdict-error');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('data-error-code', 'INCIDENT_EVIDENCE_REQUIRED');
    await expect(failure).toContainText(copy('incidents.error.evidenceRequired'));
    await expect(page.getByTestId('incident-error-code')).toHaveText('INCIDENT_EVIDENCE_REQUIRED');

    // The refusal did not change the record: the page still says OPEN, and the authority agrees.
    await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'OPEN');
    const after = await getIncident(api, incident.id);
    expect(after.status, 'a refused confirming verdict must leave the record OPEN').toBe('OPEN');
    expect(after.humanVerdict ?? null, 'a refused verdict leaves no verdict behind').toBeNull();
    // The form stays: this was a server answer, not a state the page invented.
    await expect(page.getByTestId('incident-verdict-form')).toBeVisible();
  } finally {
    await api.ctx.dispose();
  }
});

test('a second verdict is refused as INCIDENT_ALREADY_CONCLUDED and the first verdict is unchanged', async ({ page, baseURL }) => {
  const api = await apiFor(baseURL);
  const incident = await createIncident(api, 'G11 gaps already concluded ' + RUN);
  try {
    await signIn(page);
    await page.goto('/app/incidents/' + incident.id);
    // The page reads the record while it is still open and holds this form. That stale read is
    // the real race: a second operator concludes the record after this reader loaded it.
    await expect(page.getByTestId('incident-verdict-form')).toBeVisible();

    const firstRationale = 'the first signed conclusion, written through the API while the page held its form (' + RUN + ')';
    const recorded = await recordVerdict(api, incident.id, 'INCONCLUSIVE', firstRationale);
    const recordedBody = await recorded.text();
    expect(recorded.status(), 'the first verdict is accepted -> ' + recorded.status() + ': ' + recordedBody.slice(0, 300)).toBe(201);
    const before = await getIncident(api, incident.id);
    expect(before.humanVerdict?.verdict).toBe('INCONCLUSIVE');
    expect(before.humanVerdict?.rationale).toBe(firstRationale);
    const decidedAt = before.humanVerdict?.decidedAt;

    // Submit from the stale form: the kernel answers 409, and the page must present that answer.
    await chooseVerdict(page, 'INCONCLUSIVE');
    await page.getByTestId('incident-verdict-rationale').fill('this second conclusion must never overwrite the first (' + RUN + ')');
    await page.getByTestId('incident-verdict-submit').click();

    const failure = page.getByTestId('incident-verdict-error');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('data-error-code', 'INCIDENT_ALREADY_CONCLUDED');
    await expect(failure).toContainText(copy('incidents.error.alreadyConcluded'));
    await expect(page.getByTestId('incident-error-code')).toHaveText('INCIDENT_ALREADY_CONCLUDED');

    // The first verdict — value, rationale and signing time — is untouched.
    const after = await getIncident(api, incident.id);
    expect(after.humanVerdict?.verdict, 'the refused second verdict did not replace the first').toBe('INCONCLUSIVE');
    expect(after.humanVerdict?.rationale).toBe(firstRationale);
    expect(after.humanVerdict?.decidedAt, 'the signature time is the first write, not the refused one').toBe(decidedAt);

    // A fresh read renders the first verdict, not the refused one.
    await page.reload();
    await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'recorded');
    await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'INCONCLUSIVE');
    await expect(page.getByTestId('incident-verdict-record')).toContainText(firstRationale);
    await expect(page.getByTestId('incident-verdict-record')).not.toContainText('must never overwrite the first');
  } finally {
    await api.ctx.dispose();
  }
});

test('the list pages past 20 records with an opaque cursor, and page two never repeats page one', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const api = await apiFor(baseURL);
  // Ordinary creation times, deliberately: a future-dated fixture would sort above every record
  // a LATER spec creates and push its row off the first page, which is how a pagination test
  // turns into a cross-spec failure. None of the assertions below depend on where these rows
  // rank - the contract under test is the cursor, and page two is compared to the kernel's own
  // answer to that cursor.
  try {
    for (let index = 0; index < 21; index += 1) {
      await createIncident(api, 'G11 gaps page ' + index + ' ' + RUN);
    }

    await signIn(page);
    await page.goto('/app/incidents');
    const rows = page.locator('[data-incident-row]');
    await expect(rows).toHaveCount(20);
    const firstPage = await rowIds(page);
    expect(firstPage, 'the first page is a full page of 20 rows').toHaveLength(20);

    const next = page.getByTestId('incidents-pagination-next');
    const first = page.getByTestId('incidents-pagination-first');
    await expect(next, 'a full page advertises a next one').toBeEnabled();
    await expect(first, 'nothing precedes the first page').toBeDisabled();

    // The cursor is observed on the real request the page sends, not read out of component state.
    const cursorRequest = page.waitForRequest((requestUrl) => {
      const url = new URL(requestUrl.url());
      return url.pathname === '/api/v1/incidents' && url.searchParams.has('cursor');
    });
    await next.click();
    const cursor = new URL((await cursorRequest).url()).searchParams.get('cursor') ?? '';
    expect(cursor, 'the next-page request carries a cursor').not.toBe('');
    // The cursor is opaque: a base64url token must not carry a separator or a path shape. The
    // contract forbids deriving a host path from it; this is the negative half that is observable
    // from the client side.
    expect(cursor, 'the cursor is opaque, not a host path').toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.startsWith('.')).toBe(false);
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('\\');

    // Wait for the second page to replace the first: no row of page one remains.
    await expect(page.locator('[data-incident-row="' + firstPage[0] + '"]')).toHaveCount(0);
    const secondPage = await rowIds(page);
    expect(secondPage.length, 'page two carries at least the one record beyond page one').toBeGreaterThan(0);
    expect(secondPage.filter((id) => firstPage.includes(id)), 'page two repeats rows from page one').toEqual([]);

    // The rendered second page is exactly the kernel's answer to the SAME cursor. That is what
    // makes this a pagination assertion rather than "the rows changed": a page that silently
    // re-read the first page, or dropped the cursor, could not match this list.
    const answered = await api.ctx.get('/api/v1/incidents?limit=20&cursor=' + encodeURIComponent(cursor));
    const answeredBody = await answered.text();
    expect(answered.status(), 'the kernel accepts the cursor the page sent -> ' + answered.status() + ': ' + answeredBody.slice(0, 300)).toBe(200);
    const expected = (JSON.parse(answeredBody) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(secondPage, 'page two is the kernel answer to the cursor, in order').toEqual(expected);

    await expect(first, 'a cursor exists once the reader is past the first page').toBeEnabled();
  } finally {
    await api.ctx.dispose();
  }
});

test('a closed incident seals the verdict panel: sealed, no form, and the signed verdict stays on record', async ({ page, baseURL }) => {
  const api = await apiFor(baseURL);
  const incident = await createIncident(api, 'G11 gaps sealed ' + RUN);
  try {
    await addEvidence(api, incident.id, 'sha256:g11-gaps-sealed-' + RUN);
    const verdict = await recordVerdict(api, incident.id, 'CONFIRMED', 'the evidence matches the reported window (' + RUN + ')');
    const verdictBody = await verdict.text();
    expect(verdict.status(), 'the verdict is accepted -> ' + verdict.status() + ': ' + verdictBody.slice(0, 300)).toBe(201);
    const concluded = await getIncident(api, incident.id);
    expect(concluded.status, 'a verdict concludes the record').toBe('CONCLUDED');
    const closed = await closeIncident(api, incident.id, concluded.revision, 'root cause recorded; closing (' + RUN + ')');
    expect(closed.status, 'the closure is the terminal state').toBe('CLOSED');
    expect(closed.humanVerdict?.verdict, 'closing does not erase the verdict it stands on').toBe('CONFIRMED');

    await signIn(page);
    await page.goto('/app/incidents/' + incident.id);
    await expect(page.locator('[data-testid="incident-detail-status"] [data-status]')).toHaveAttribute('data-status', 'CLOSED');
    await expect(page.getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'sealed');
    await expect(page.getByTestId('incident-verdict-form'), 'a closed record is not offered a form that would 409').toHaveCount(0);
    await expect(page.getByTestId('incident-verdict-sealed')).toBeVisible();
    await expect(page.getByTestId('incident-verdict-sealed')).toHaveText(copy('incidents.verdict.sealed'));
    // Sealed is not "the decision disappeared": the closed record still shows what was signed.
    await expect(page.getByTestId('incident-verdict-record')).toHaveAttribute('data-verdict-value', 'CONFIRMED');
    // The evidence panel states the same closure, and offers no append form.
    await expect(page.getByTestId('incident-evidence-sealed')).toBeVisible();
    await expect(page.getByTestId('incident-evidence-form')).toHaveCount(0);
  } finally {
    await api.ctx.dispose();
  }
});
