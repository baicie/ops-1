import { expect, request, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-G11-001 section 4.5 - "the viewer reads the record and is told why it cannot write; the
 * server, not the page, is what refuses the write".
 *
 * This guard used to lock the opposite mechanism, so the history matters. Until the decision was
 * re-taken, section 4.5 chose option (b) "keep the write entries and let the viewer earn a 403",
 * and this file asserted that the evidence and verdict FORMS were rendered and enabled for a
 * viewer. The page never did that - IncidentDetail.tsx renders a read-only sentence instead - so
 * the guard was red against the product it claimed to guard.
 *
 * What settled it was not "the test was inconvenient". Phase C4 asks for two things at once:
 * (1) a viewer must not have to submit a form that is guaranteed to fail in order to learn it is
 * read-only; (2) the server-side 403 stays under test. A rendered form contradicts (1) and has
 * nothing to do with (2), so the mechanism - not the refusal - was over-specified. The assertions
 * move to where the authority is:
 *
 *   1. STRUCTURE: a viewer is SHOWN the read-only sentence ('incident-evidence-readonly' /
 *      'incident-verdict-readonly') and the form is ABSENT - toHaveCount(0), i.e. not in the DOM.
 *      "Hidden with CSS" fails here, because there is no element to hide.
 *   2. SERVER: the same session POSTs the endpoint directly and the kernel answers 403 with the
 *      stable code FORBIDDEN. That is stronger than the click-through it replaces: no page code
 *      can produce this response, and "some error" does not satisfy it.
 *   3. CONTROL: an operator POSTs the SAME body to the SAME record and the kernel answers 201.
 *      This is the half that gives (2) its meaning - a red there cannot be excused as a broken
 *      endpoint, a bad body, or a record that refuses every write. The only variable is the role.
 *
 * The static test at the bottom keeps its old job: the copy a viewer reads belongs to the message
 * catalog, and no component source carries a copy of it - now including the read-only sentence.
 *
 * Nothing here is stubbed: the accounts are created through the admin API, the record too, and
 * every assertion reads a real kernel's answer - from the DOM or from the endpoint itself.
 *
 * Selectors are data attributes only - never localised copy (rules/06) - so the guard keeps
 * working if the sentence is edited, and only fails if its provenance changes.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
/** Unique per run: the spec creates accounts, so a re-run against the same database works. */
const RUN = process.env.OPSWEAVE_G11_RUN || Date.now().toString(36).slice(-6);

const VIEWER = {
  email: 'g11-guard-viewer-' + RUN + '@example.invalid',
  password: 'guard-viewer-' + RUN,
  displayName: 'G11 guard viewer ' + RUN,
};

/**
 * The operator owns the record the pair below writes to, because the second half has to be a
 * write that is allowed: on a viewer's own record an operator would get 404 (scope), which would
 * prove the wrong thing.
 */
const OPERATOR = {
  email: 'g11-guard-operator-' + RUN + '@example.invalid',
  password: 'guard-operator-' + RUN,
  displayName: 'G11 guard operator ' + RUN,
};

/** The product default, and the locale this guard judges the copy in. */
const LOCALE = 'zh-CN' as const;

const CATALOG_DIR = fileURLToPath(new URL('../../apps/platform-web/src/i18n/catalogs/', import.meta.url));
const catalog = (locale: 'en' | 'zh-CN'): Record<string, string> =>
  JSON.parse(readFileSync(CATALOG_DIR + locale + '.json', 'utf8')) as Record<string, string>;

const ZH = catalog('zh-CN');
const EN = catalog('en');

/** The key ADR-G11-001 section 4.5 names as the source of the 403 sentence. */
const FORBIDDEN_KEY = 'incidents.error.forbidden';
/** The key the page uses for the sentence it shows a viewer INSTEAD of a form. */
const READONLY_KEY = 'incidents.permission.writeBlocked';
/** The label the page puts in front of the kernel request id. */
const REQUEST_ID_KEY = 'ui.error.requestId';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HAN = /[\u4e00-\u9fff]/;

/** One API session: its own cookie jar, and the token a write needs. */
interface ApiSession {
  api: APIRequestContext;
  csrfToken: string;
}

/**
 * Signs an account in through the API, in a cookie jar of its own - the browser is signed in as
 * the viewer, and the operator call must not borrow that session, or both halves of the pair
 * would be one role and the comparison would prove nothing.
 */
async function apiSignIn(origin: string, email: string, password: string): Promise<ApiSession> {
  const api = await request.newContext({ baseURL: origin });
  const login = await api.post('/api/v1/auth/login', { data: { email, password } });
  expect(login.ok(), 'api sign-in for ' + email).toBeTruthy();
  const { csrfToken } = await login.json();
  return { api, csrfToken };
}

/**
 * The server half of section 4.5: a write the page no longer offers must still be refused AT THE
 * ENDPOINT. 403 is the status, FORBIDDEN is the stable code the page and the tests both name.
 */
async function expectEndpointForbidden(response: APIResponse, entry: string) {
  expect(response.status(), entry + ': the kernel must refuse a viewer write with 403 - a client-side guard proves nothing').toBe(403);
  const body = (await response.json()) as { code?: string };
  expect(body.code, entry + ': the refusal carries the stable code FORBIDDEN, not just any failure').toBe('FORBIDDEN');
}

/** One evidence body, so the two calls in the pair differ only in the session that sends them. */
const evidenceBody = (source: string) => ({
  kind: 'LOG_EXCERPT',
  source,
  collectedAt: new Date().toISOString(),
  contentRef: 'sha256:g11-guard-' + RUN + '-log-excerpt',
});

/** One verdict body, for the same reason. INCONCLUSIVE is the verdict the kernel accepts with no evidence. */
const verdictBody = () => ({ verdict: 'INCONCLUSIVE', rationale: 'the same call from two roles; only the role differs (' + RUN + ')' });

/**
 * The three assertions the 403 copy has to satisfy at once. One helper, so every notice the page
 * still shows a viewer is judged by exactly the same rule instead of three drifting variants.
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

test('a viewer is told it cannot write, and the kernel still refuses the write it cannot send (ADR-G11-001 section 4.5)', async ({ browser }) => {
  // The product ships Chinese; the locale is written into this context rather than inherited, so
  // the guard judges the same copy a first-time visitor sees whatever OPSWEAVE_TEST_LOCALE says.
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'opsweave-locale', value: LOCALE }] }] },
  });
  const page = await context.newPage();

  // --- the fixture half: an admin creates both accounts, the operator creates the record ------
  const admin = await page.request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(admin.ok(), 'admin login for fixture setup').toBeTruthy();
  const { csrfToken } = await admin.json();
  for (const account of [{ ...VIEWER, role: 'viewer' }, { ...OPERATOR, role: 'operator' }]) {
    const created = await page.request.post('/api/v1/users', {
      headers: { 'x-csrf-token': csrfToken },
      data: { email: account.email, displayName: account.displayName, password: account.password, role: account.role },
    });
    expect([200, 201], 'create the ' + account.role + ' account').toContain(created.status());
  }
  const operatorSession = await apiSignIn(origin, OPERATOR.email, OPERATOR.password);
  const incidentResponse = await operatorSession.api.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': operatorSession.csrfToken },
    data: { title: 'G11 guard: role pair ' + RUN, severity: 'MAJOR', source: 'MANUAL', startedAt: new Date().toISOString(), relatedEntity: 'api-gateway' },
  });
  expect(incidentResponse.status(), 'the operator creates the record both roles will write to').toBe(201);
  const incident = (await incidentResponse.json()) as { id: string };
  await context.clearCookies();

  // --- the subject half: a viewer signs in through the page ----------------------------------
  await page.goto('/login');
  await page.fill('input[type=email]', VIEWER.email);
  await page.fill('input[type=password]', VIEWER.password);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('html'), 'the guard judges the copy in the product default locale').toHaveAttribute('lang', LOCALE);

  // 1. Create. This entry is still RENDERED for a viewer, and that is not an inconsistency with
  //    the two below: it is one dialog that is opened and closed, its refusal is shown in place,
  //    and the kernel - not the page - produces it. The assertions on it are unchanged.
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  const createEntry = page.getByTestId('incident-create-open');
  await expect(createEntry, 'a viewer still sees the record-an-incident entry').toBeVisible();
  await expect(createEntry, 'the entry is not disabled by role - the server answers, not the page').toBeEnabled();
  await createEntry.click();
  await page.getByTestId('incident-create-title').fill('G11 guard: a viewer must not create this ' + RUN);
  await page.getByTestId('incident-create-submit').click();
  await expectLocalisedForbidden(page.getByTestId('incident-create-error'), 'create');
  await page.keyboard.press('Escape');

  // 2. Evidence. STRUCTURE: the read-only sentence is on screen and the form is NOT IN THE DOM.
  //    toHaveCount(0) is the assertion hiding cannot satisfy: a display:none form still counts.
  await page.goto('/app/incidents/' + incident.id);
  await expect(page.getByTestId('incident-detail')).toHaveAttribute('data-incident-id', incident.id);
  const evidenceNote = page.getByTestId('incident-evidence-readonly');
  await expect(evidenceNote, 'a viewer is told its role cannot write evidence').toBeVisible();
  await expect(evidenceNote, 'the sentence is the ' + LOCALE + ' catalog value, not a second copy in the component').toHaveText(ZH[READONLY_KEY]);
  await expect(page.getByTestId('incident-evidence-form'), 'no evidence form is rendered for a viewer - nothing to hide').toHaveCount(0);

  // 3. Verdict. Same structure, on the panel that has to be open for the pair below to mean
  //    anything: the record is unconcluded, so an operator CAN still conclude it.
  const verdictPanel = page.getByTestId('incident-verdict');
  await expect(verdictPanel, 'this fixture record is unconcluded, so an open verdict panel is the state under test').toHaveAttribute('data-verdict-state', 'open');
  const verdictNote = page.getByTestId('incident-verdict-readonly');
  await expect(verdictNote, 'a viewer is told its role cannot record a verdict').toBeVisible();
  await expect(verdictNote, 'the sentence is the ' + LOCALE + ' catalog value, not a second copy in the component').toHaveText(ZH[READONLY_KEY]);
  await expect(page.getByTestId('incident-verdict-form'), 'no verdict form is rendered for a viewer - nothing to hide').toHaveCount(0);

  // 4. SERVER + CONTROL. The viewer session sends the write the page no longer offers, and gets
  //    the kernel's 403 FORBIDDEN; the operator session sends the SAME body to the SAME record
  //    and gets 201. Both halves run on one record, so "the endpoint is broken" cannot pass as
  //    "the role was refused", and "the role was refused" cannot pass as "the endpoint is broken".
  const viewerSession = await apiSignIn(origin, VIEWER.email, VIEWER.password);

  const viewerEvidence = await viewerSession.api.post('/api/v1/incidents/' + incident.id + '/evidence', {
    headers: { 'x-csrf-token': viewerSession.csrfToken },
    data: evidenceBody('operator:' + VIEWER.email),
  });
  await expectEndpointForbidden(viewerEvidence, 'evidence');
  // The page assertion this replaces said "a refused append must not look like a stored row".
  // Read from the kernel instead: the refusal wrote nothing.
  const evidenceAfterRefusal = (await (await viewerSession.api.get('/api/v1/incidents/' + incident.id + '/evidence')).json()) as { items?: unknown[] };
  expect(evidenceAfterRefusal.items?.length, 'a refused evidence write leaves no row behind').toBe(0);

  const operatorEvidence = await operatorSession.api.post('/api/v1/incidents/' + incident.id + '/evidence', {
    headers: { 'x-csrf-token': operatorSession.csrfToken },
    data: evidenceBody('operator:' + OPERATOR.email),
  });
  expect(operatorEvidence.status(), 'the same evidence body, sent by an operator, is accepted - so the 403 above is the role').toBe(201);
  const evidenceAfterAccept = (await (await viewerSession.api.get('/api/v1/incidents/' + incident.id + '/evidence')).json()) as { items?: unknown[] };
  expect(evidenceAfterAccept.items?.length, 'exactly the accepted row is stored - one write, one row').toBe(1);

  const viewerVerdict = await viewerSession.api.post('/api/v1/incidents/' + incident.id + '/verdict', {
    headers: { 'x-csrf-token': viewerSession.csrfToken },
    data: verdictBody(),
  });
  await expectEndpointForbidden(viewerVerdict, 'verdict');
  const afterRefusal = (await (await viewerSession.api.get('/api/v1/incidents/' + incident.id)).json()) as { status?: string; humanVerdict?: unknown };
  expect(afterRefusal.humanVerdict ?? null, 'a refused verdict leaves no verdict behind').toBeNull();
  expect(afterRefusal.status, 'the operator evidence above landed, so that read is the kernel and not a stale copy').toBe('INVESTIGATING');
  await page.reload();
  await expect(verdictPanel, 'and a reload says the same: the refused verdict left the record open').toHaveAttribute('data-verdict-state', 'open');

  const operatorVerdict = await operatorSession.api.post('/api/v1/incidents/' + incident.id + '/verdict', {
    headers: { 'x-csrf-token': operatorSession.csrfToken },
    data: verdictBody(),
  });
  expect(operatorVerdict.status(), 'the same verdict body, sent by an operator, is accepted - so the 403 above is the role').toBe(201);
  expect(((await operatorVerdict.json()) as { verdict?: string }).verdict, 'the accepted verdict is the one that was sent').toBe('INCONCLUSIVE');

  await viewerSession.api.dispose();
  await operatorSession.api.dispose();
  await context.close();
});

/* ----------------------------------------------------------------------------------------------
 * The static half of ADR-G11-001 section 4.5. No browser, no kernel, no database: it reads the
 * sources as text, so it also fails on a machine where nothing is running.
 * --------------------------------------------------------------------------------------------*/

/** The two pages section 4.5 names as the places a viewer meets a write it cannot make. */
const WRITE_ENTRY_PAGES = ['Incidents.tsx', 'IncidentDetail.tsx'] as const;
const PAGE_DIR = fileURLToPath(new URL('../../apps/platform-web/src/pages/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../apps/platform-web/src/', import.meta.url));

/**
 * The copy a component would have to paste in, taken from the catalog rather than retyped here.
 * Both sentences a viewer can read are listed: the 403 the list still shows it, and the read-only
 * sentence that took the place of the two forms.
 */
const SENTENCES: { locale: string; key: string; sentence: string }[] = [
  { locale: 'zh-CN', key: FORBIDDEN_KEY, sentence: ZH[FORBIDDEN_KEY] },
  { locale: 'en', key: FORBIDDEN_KEY, sentence: EN[FORBIDDEN_KEY] },
  { locale: 'zh-CN', key: READONLY_KEY, sentence: ZH[READONLY_KEY] },
  { locale: 'en', key: READONLY_KEY, sentence: EN[READONLY_KEY] },
];

/**
 * The longest run of a sentence that still counts as a hardcode. Twenty is the copy for a long
 * sentence and a coincidence for a short one; a sentence shorter than twice this gets half its own
 * length instead, because a fixed twenty could never match it and that sweep would pass by being
 * impossible to satisfy rather than by finding nothing.
 */
const MIN_HARDCODED_RUN = 20;

/** Whitespace-blind: a literal wrapped over two source lines is still one literal. */
const flatten = (text: string): string => text.replace(/\s+/g, '');

/** Every .ts/.tsx file under the app source. The .json message catalogs are not sources here. */
function componentSources(directory: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...componentSources(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Fails when `source` carries a catalog sentence instead of asking the catalog for it.
 *
 * Two shapes, because they fail differently: the whole sentence verbatim (the literal hardcode),
 * and any run of it (half a sentence pasted in, or a literal that a formatter broke across lines).
 * The run check subsumes the verbatim one; it is kept separate because "the whole sentence" is
 * the clearer failure to read.
 */
function expectNoHardcodedCopy(source: string, where: string) {
  const flatSource = flatten(source);
  const windowsOf = (size: number): Set<string> => {
    const windows = new Set<string>();
    for (let at = 0; at + size <= flatSource.length; at += 1) windows.add(flatSource.slice(at, at + size));
    return windows;
  };
  const cache = new Map<number, Set<string>>();
  const windowsOfSize = (size: number): Set<string> => {
    let windows = cache.get(size);
    if (!windows) {
      windows = windowsOf(size);
      cache.set(size, windows);
    }
    return windows;
  };

  for (const { locale, key, sentence } of SENTENCES) {
    expect(
      source.includes(sentence),
      where + ': the ' + locale + ' sentence for ' + key + ' appears here verbatim. ADR-G11-001 section 4.5 keeps that copy in the catalog and nowhere else',
    ).toBe(false);

    const flatSentence = flatten(sentence);
    const run = Math.min(MIN_HARDCODED_RUN, Math.floor(flatSentence.length / 2));
    const windows = windowsOfSize(run);
    const found: string[] = [];
    for (let at = 0; at + run <= flatSentence.length; at += 1) {
      const slice = flatSentence.slice(at, at + run);
      if (windows.has(slice)) found.push(slice);
    }
    expect(
      found,
      where + ': ' + run + '+ characters of the ' + locale + ' ' + key + ' sentence appear here (' + found.join(' / ') + '). Half the sentence is still a hardcode: the copy belongs to the catalog key ' + key,
    ).toEqual([]);
  }
}

test('the sentences a viewer reads belong to the catalog, and no component source carries a copy (ADR-G11-001 section 4.5)', () => {
  // Belt first: if a key were renamed, SENTENCES would hold undefined and both sweeps below
  // would pass against the empty string - green, and hunting nothing.
  for (const [locale, dictionary] of [['en', EN], ['zh-CN', ZH]] as const) {
    for (const key of [FORBIDDEN_KEY, READONLY_KEY]) {
      const value = dictionary[key];
      expect(typeof value, 'the ' + locale + ' catalog still owns ' + key + ', a key ADR-G11-001 section 4.5 names').toBe('string');
      // The 403 sentence keeps its old floor; the read-only sentence only has to be longer than
      // the run measured against it, or that run would be the whole sentence and match nothing.
      const floor = key === FORBIDDEN_KEY ? MIN_HARDCODED_RUN * 1.5 : MIN_HARDCODED_RUN;
      expect(
        value.length,
        'the ' + locale + ' value of ' + key + ' must be longer than ' + floor + ' characters, or a run of it means nothing',
      ).toBeGreaterThan(floor);
    }
  }

  // 1. The two pages the ADR names.
  for (const page of WRITE_ENTRY_PAGES) {
    const source = readFileSync(PAGE_DIR + page, 'utf8');
    expect(source.length, page + ': read as source text').toBeGreaterThan(2000);
    expectNoHardcodedCopy(source, 'apps/platform-web/src/pages/' + page);
  }

  // 2. Every other component source, so relocating a sentence to a third file does not escape
  //    the guard. Only the .json catalogs may hold it.
  const others = componentSources().filter((file) => !WRITE_ENTRY_PAGES.some((page) => file === PAGE_DIR + page));
  expect(others.length, 'the sweep reached the application source tree').toBeGreaterThan(20);
  for (const file of others) expectNoHardcodedCopy(readFileSync(file, 'utf8'), file.slice(SRC_DIR.length));
});
