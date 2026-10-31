import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ADR-G11-001 section 4.5 - "a viewer keeps the write entries and earns a localised 403".
 *
 * The decision is a product rule, not an oversight: option (a) "disable the button and explain
 * why" was rejected, and option (b) "let the viewer click once and read the server's refusal"
 * was chosen. That rule had no automated guard, so the next person who "tidies the UX" by hiding
 * or disabling the entries for a read-only role would have broken a documented decision with
 * every check still green.
 *
 * What this file locks, and why each half matters:
 *
 *   1. the entries are PRESENT, VISIBLE and ENABLED for a viewer - a click must be possible, so
 *      a hidden (display:none) or disabled control fails here, not in a review comment;
 *   2. the click earns FORBIDDEN with a real request id - the refusal comes from the kernel and
 *      is not simulated client-side;
 *   3. the sentence rendered is the message-catalog value for the active locale, it is not the
 *      English sentence, and it is not the raw kernel message - a hardcoded English string, an
 *      untranslated key or a locale that silently fell back all fail here.
 *
 * A failure in 1 or 2 means the page stopped honouring ADR-G11-001 section 4.5; a failure in 3
 * means the page and incidents.error.forbidden disagreed about who owns the copy. Both point at
 * the ADR, which is where the decision lives.
 *
 * Nothing here is stubbed: the accounts are created through the admin API, the incident too, and
 * every assertion reads the DOM of a real build served by a real kernel.
 *
 * Selectors are data attributes only - never localised copy (rules/06) - so the guard keeps
 * working if the sentence is edited, and only fails if its provenance changes.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
/** Unique per run: the spec creates an account, so a re-run against the same database works. */
const RUN = process.env.OPSWEAVE_G11_RUN || Date.now().toString(36).slice(-6);

const VIEWER = {
  email: 'g11-guard-viewer-' + RUN + '@example.invalid',
  password: 'guard-viewer-' + RUN,
  displayName: 'G11 guard viewer ' + RUN,
};

/** The product default, and the locale this guard judges the copy in. */
const LOCALE = 'zh-CN' as const;

const CATALOG_DIR = fileURLToPath(new URL('../../apps/platform-web/src/i18n/catalogs/', import.meta.url));
const catalog = (locale: 'en' | 'zh-CN'): Record<string, string> =>
  JSON.parse(readFileSync(CATALOG_DIR + locale + '.json', 'utf8')) as Record<string, string>;

const ZH = catalog('zh-CN');
const EN = catalog('en');

/** The one key ADR-G11-001 section 4.5 names as the source of the 403 sentence. */
const FORBIDDEN_KEY = 'incidents.error.forbidden';
/** The label the page puts in front of the kernel request id. */
const REQUEST_ID_KEY = 'ui.error.requestId';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HAN = /[\u4e00-\u9fff]/;

/**
 * The three assertions the copy has to satisfy at once. One helper, so the create, evidence and
 * verdict notices are judged by exactly the same rule instead of three drifting variants.
 */
async function expectLocalisedForbidden(notice: ReturnType<Page['getByTestId']>, entry: string) {
  await expect(notice, entry + ': the kernel must refuse a viewer write and the page must show it (ADR-G11-001 section 4.5)').toBeVisible();
  await expect(notice, entry + ': a permission failure is FORBIDDEN, so that is the code the notice must carry').toHaveAttribute('data-error-code', 'FORBIDDEN');

  const sentence = (await notice.locator('p').first().innerText()).trim();
  // Provenance: the rendered sentence IS the catalog value, so the page cannot drift from it.
  expect(sentence, entry + ': ADR-G11-001 section 4.5 says the sentence comes from the catalog key ' + FORBIDDEN_KEY + ', but the page rendered something else').toBe(ZH[FORBIDDEN_KEY]);
  // A hardcoded English string renders the same under every locale; this one must not.
  expect(sentence, entry + ': the 403 sentence is the English catalog value - either it is hardcoded or the ' + LOCALE + ' catalog lost this key').not.toBe(EN[FORBIDDEN_KEY]);
  expect(sentence, entry + ': the 403 sentence carries no Chinese at all in the ' + LOCALE + ' build').toMatch(HAN);

  const meta = (await notice.locator('p').nth(1).innerText()).trim();
  expect(meta, entry + ': the notice must label the kernel request id with the catalog key ' + REQUEST_ID_KEY).toContain(ZH[REQUEST_ID_KEY]);
  expect(meta, entry + ': the notice must carry the request id the kernel returned, not a placeholder').toMatch(UUID);
}

test('a viewer keeps every write entry, and each one earns the catalog 403 in ' + LOCALE + ' (ADR-G11-001 section 4.5)', async ({ browser }) => {
  // The product ships Chinese; the locale is written into this context rather than inherited, so
  // the guard judges the same copy a first-time visitor sees whatever OPSWEAVE_TEST_LOCALE says.
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'opsweave-locale', value: LOCALE }] }] },
  });
  const page = await context.newPage();

  // --- the fixture half: an admin creates the viewer and one incident nobody has concluded ----
  const admin = await page.request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(admin.ok(), 'admin login for fixture setup').toBeTruthy();
  const { csrfToken } = await admin.json();
  const created = await page.request.post('/api/v1/users', {
    headers: { 'x-csrf-token': csrfToken },
    data: { email: VIEWER.email, displayName: VIEWER.displayName, password: VIEWER.password, role: 'viewer' },
  });
  expect([200, 201], 'create the viewer account').toContain(created.status());
  const incidentResponse = await page.request.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': csrfToken },
    data: { title: 'G11 guard: viewer write entries ' + RUN, severity: 'MAJOR', source: 'MANUAL', startedAt: new Date().toISOString(), relatedEntity: 'api-gateway' },
  });
  expect([200, 201], 'create the unconcluded incident').toContain(incidentResponse.status());
  const incident = await incidentResponse.json();
  await context.clearCookies();

  // --- the subject half: a viewer signs in through the page ----------------------------------
  await page.goto('/login');
  await page.fill('input[type=email]', VIEWER.email);
  await page.fill('input[type=password]', VIEWER.password);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('html'), 'the guard judges the copy in the product default locale').toHaveAttribute('lang', LOCALE);

  // 1. Create. The entry stays on screen and stays clickable; hiding or disabling it is the
  //    rejected option (a), and this is the assertion that fails when someone picks it anyway.
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  const createEntry = page.getByTestId('incident-create-open');
  await expect(createEntry, 'ADR-G11-001 section 4.5: a viewer KEEPS the record-an-incident entry - it must not be hidden by role').toBeVisible();
  await expect(createEntry, 'ADR-G11-001 section 4.5: a viewer KEEPS the record-an-incident entry - it must not be disabled by role').toBeEnabled();
  await createEntry.click();
  await page.getByTestId('incident-create-title').fill('G11 guard: a viewer must not create this ' + RUN);
  await page.getByTestId('incident-create-submit').click();
  await expectLocalisedForbidden(page.getByTestId('incident-create-error'), 'create');
  await page.keyboard.press('Escape');

  // 2. Evidence. Same rule on the detail page, and the form is still an append form.
  await page.goto('/app/incidents/' + incident.id);
  await expect(page.getByTestId('incident-detail')).toHaveAttribute('data-incident-id', incident.id);
  await expect(page.getByTestId('incident-evidence-form'), 'ADR-G11-001 section 4.5: the evidence form stays rendered for a viewer').toBeVisible();
  await expect(page.getByTestId('incident-evidence-submit'), 'ADR-G11-001 section 4.5: the evidence submit stays enabled for a viewer').toBeEnabled();
  await page.getByTestId('incident-evidence-content-ref').fill('sha256:g11-guard-' + RUN + '-log-excerpt');
  await page.getByTestId('incident-evidence-submit').click();
  await expectLocalisedForbidden(page.getByTestId('incident-evidence-write-error'), 'evidence');
  await expect(page.getByTestId('incident-evidence'), 'a refused append must not look like a stored row').toHaveAttribute('data-evidence-state', 'missing');

  // 3. Verdict. The half the ADR only argued from memory before: the verdict form is on screen
  //    for a viewer, it submits, and the kernel - not the page - refuses it.
  const verdictPanel = page.getByTestId('incident-verdict');
  await expect(verdictPanel, 'this fixture incident is unconcluded, so an open verdict panel is the state under test').toHaveAttribute('data-verdict-state', 'open');
  await expect(page.getByTestId('incident-verdict-form'), 'ADR-G11-001 section 4.5: the verdict form stays rendered for a viewer').toBeVisible();
  await expect(page.getByTestId('incident-verdict-submit'), 'ADR-G11-001 section 4.5: the verdict submit stays enabled for a viewer').toBeEnabled();
  await page.getByTestId('incident-verdict-rationale').fill('a viewer attempts a verdict; the kernel must refuse it (' + RUN + ')');
  await page.getByTestId('incident-verdict-submit').click();
  await expectLocalisedForbidden(page.getByTestId('incident-verdict-error'), 'verdict');
  await expect(verdictPanel, 'a refused verdict must leave the incident unconcluded').toHaveAttribute('data-verdict-state', 'open');

  await context.close();
});
