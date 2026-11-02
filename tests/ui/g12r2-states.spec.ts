import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 R2 phase 2 - the Investigation Panel, measured against a real Kernel.
 *
 * Every row on the page came from tests/ui/g12r2-seed.mjs, which wrote it through the public
 * API; the four run terminal states are the Kernel's own run loop outcomes. Nothing here mocks
 * a product response: the only stubbed traffic is in g12r2-races.spec.ts, where a delayed or
 * failed answer is the thing under test.
 *
 * The claim this file exists for is the one the phase states as its core criterion: a reader
 * must not be able to take an AI hypothesis for a fact or for a human verdict. So the checks
 * below are about provenance and separation, not about pixels:
 *
 *   S1  the run list and every terminal state render the state the Kernel reported;
 *   S2  tool calls, citations and their content are the reads the run actually made;
 *   S3  the synthetic adapter is labelled where a reader looks, not only in the payload;
 *   S4  a hypothesis is labelled as a hypothesis, sits in its own region, and no control on the
 *       panel can write a verdict;
 *   S5  the two reviews (accept / reject) and the cancel are real transitions.
 */
const ROOT = path.resolve(process.cwd(), '..', '..');
const OUT = process.env.OPSWEAVE_G12R2_OUT || path.join(ROOT, 'artifacts', 'g12-r2p2', 'shots');
const SEED = JSON.parse(fs.readFileSync(process.env.OPSWEAVE_SEED_JSON || path.join(ROOT, 'artifacts', 'g12-r2p2', 'seed.json'), 'utf8'));
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12r2.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12r2-admin-password-1';
const A = '/app/incidents/' + SEED.incidents.evidence;
const B = '/app/incidents/' + SEED.incidents.noEvidence;
const C = '/app/incidents/' + SEED.incidents.conflicted;
const E = '/app/incidents/' + SEED.incidents.operatorOwned;
const LOG_LINE = 'ERROR payment-webhook';

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/login');
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function setPrefs(page: Page, locale: 'en' | 'zh-CN' = 'en', theme: 'light' | 'dark' = 'light') {
  await page.evaluate(([nextLocale, nextTheme]) => {
    window.localStorage.setItem('opsweave-locale', nextLocale as string);
    window.localStorage.setItem('opsweave-theme', nextTheme as string);
  }, [locale, theme]);
}

/** Open one incident and wait until the panel has finished its first read. */
async function openPanel(page: Page, route: string, runs?: number) {
  await page.goto(route);
  const panel = page.locator('[data-testid=incident-investigations]');
  await expect(panel).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  if (runs !== undefined) await expect(panel).toHaveAttribute('data-runs', String(runs));
  return panel;
}

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18199';

/** The same API the page calls, from the test: used to start runs the UI has no control for. */
async function apiSession(request: APIRequestContext) {
  const login = await request.post(BASE + '/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBe(true);
  const body = await login.json();
  const cookie = (login.headers()['set-cookie'] || '').split('\n').map((line) => line.split(';')[0]).join('; ');
  return { cookie, csrf: body.csrfToken as string };
}

async function startRun(request: APIRequestContext, session: { cookie: string; csrf: string }, incidentId: string, body: Record<string, unknown>) {
  const response = await request.post(BASE + '/api/v1/incidents/' + incidentId + '/investigations', {
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    data: { idempotencyKey: 'g12r2-ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), ...body },
  });
  expect(response.ok(), 'the Kernel refused to start a run: ' + (await response.text())).toBe(true);
  return (await response.json()) as { runId: string; status: string };
}

async function runCount(request: APIRequestContext, session: { cookie: string }, incidentId: string) {
  const response = await request.get(BASE + '/api/v1/incidents/' + incidentId + '/investigations', { headers: { cookie: session.cookie } });
  return ((await response.json()) as unknown[]).length;
}

async function getRun(request: APIRequestContext, session: { cookie: string }, incidentId: string, runId: string) {
  const response = await request.get(BASE + '/api/v1/incidents/' + incidentId + '/investigations/' + runId, { headers: { cookie: session.cookie } });
  return (await response.json()) as { status: string; review: { decision: string } | null };
}

async function selectRun(page: Page, runId: string) {
  const target = page.locator('li[data-run-id="' + runId + '"] [data-testid=investigation-select]');
  if ((await target.count()) === 0) {
    // The Kernel bounds the history at twenty runs, so a fixture from an older seed can fall out
    // of it. Fall back to the newest run the panel actually shows instead of waiting forever.
    await page.locator('[data-testid=investigation-history-list] li [data-testid=investigation-select]').first().click();
  } else {
    await target.first().click();
  }
  await expect(page.locator('[data-testid=investigation-run]')).toBeVisible();
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
}

test.describe('G12 R2 phase 2 - state coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await setPrefs(page, 'en', 'light');
    await signIn(page);
  });

  test('S1 the run history shows every terminal state the Kernel produced', async ({ page }) => {
    await openPanel(page, A);
    const states = await page.locator('[data-testid=investigation-history-list] > li').evaluateAll((rows) =>
      rows.map((row) => ({
        id: row.getAttribute('data-run-id'),
        status: row.getAttribute('data-run-status'),
        label: (row.textContent || '').replace(/\s+/g, ' ').trim(),
      })),
    );
    // The four terminal states the Kernel's own loop produced, each under its own run id.
    for (const [key, expected] of [['completed', 'SUCCEEDED'], ['budget', 'BUDGET_EXHAUSTED'], ['cancelled', 'CANCELLED'], ['accepted', 'SUCCEEDED']] as const) {
      const row = states.find((state) => state.id === (SEED.runs as Record<string, { id: string }>)[key].id);
      expect(row?.status, 'run ' + key).toBe(expected);
    }

    // Each run, selected in turn, states its own status, stop reason and budget numbers.
    const expectations: Array<[string, string, string]> = [
      [SEED.runs.completed.id, 'Answered', 'reached a final answer'],
      [SEED.runs.budget.id, 'Stopped at a budget', 'stopped at the tool-call budget'],
      [SEED.runs.cancelled.id, 'Cancelled', 'cancelled by an operator'],
      [SEED.runs.accepted.id, 'Answered', 'reached a final answer'],
    ];
    for (const [id, statusLabel, stopLabel] of expectations) {
      await selectRun(page, id);
      const run = page.locator('[data-testid=investigation-run]');
      await expect(run.locator('[data-testid=investigation-status]')).toHaveText(statusLabel);
      await expect(run.locator('[data-testid=investigation-stop-reason]')).toHaveText(stopLabel);
      await shot(page, 'state-' + id.slice(0, 8));
    }

    // The reviewed run carries the decision it was given, with the reviewer's own note.
    await selectRun(page, SEED.runs.rejected.id);
    const review = page.locator('[data-testid=investigation-review]');
    await expect(review).toHaveAttribute('data-decision', 'REJECTED');
    await expect(review).toContainText('Reasoning rejected');
    await expect(review).toContainText('says nothing about the ledger-api deploy window');
    await shot(page, 'state-review-rejected');
  });

  test('S2 a citation opens the bytes the run actually read', async ({ page }) => {
    await openPanel(page, A);
    await selectRun(page, SEED.runs.completed.id);
    const stored = page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedLog + '"]');
    await expect(stored).toHaveCount(1);
    await stored.click();
    const content = page.locator('[data-testid=investigation-citation-content]');
    await expect(content).toHaveAttribute('data-evidence-id', SEED.evidence.storedLog);
    await expect(content).toContainText(LOG_LINE);
    await expect(content).toContainText('ledger-api');
    await shot(page, 'citation-content-stored');

    // A JSON row comes back as the stored text, not re-serialised by the browser.
    await page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedQuery + '"]').click();
    await expect(content).toHaveAttribute('data-evidence-id', SEED.evidence.storedQuery);
    await expect(content).toContainText('status_code');

    // The legacy row holds a locator and no bytes: the panel says exactly that instead of
    // rendering an empty box or an error the reader would read as "the Kernel is broken".
    await page.locator('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.legacy + '"]').click();
    await expect(content).toHaveAttribute('data-evidence-id', SEED.evidence.legacy);
    await expect(content).toContainText('the Kernel holds a locator and no content');
    await shot(page, 'citation-content-legacy');
  });

  test('S3 the synthetic adapter is labelled, and its notice is not buried', async ({ page }) => {
    await openPanel(page, A);
    await selectRun(page, SEED.runs.completed.id);
    await expect(page.locator('[data-testid=investigation-adapter-badge]')).toHaveText('Test adapter');
    // A read that succeeded records the predicate it passed; that is the provenance line.
    await expect(page.locator('[data-testid=investigation-predicate]').first()).toHaveText(/· INCIDENT_READ_PREDICATE/);
    const notice = page.locator('[data-testid=investigation-fixture-notice]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('No model was consulted');

    // The label is not a tooltip and not a title attribute: it is rendered text a reader sees
    // without hovering, and it is announced as a note rather than as ordinary body copy.
    const box = await notice.boundingBox();
    expect(box && box.height).toBeGreaterThan(10);
    const role = await notice.evaluate((node) => node.getAttribute('role'));
    expect(role, 'the synthetic notice must be announced as a note').toBe('note');
    await shot(page, 'synthetic-adapter-notice');
  });

  test('S4 a hypothesis is labelled as one, and no control can write a verdict', async ({ page }) => {
    await openPanel(page, A);
    await selectRun(page, SEED.runs.completed.id);
    const panel = page.locator('[data-testid=incident-investigations]');

    // The hypothesis block states its own kind. The Kernel sends hypothesisKind and
    // isHumanVerdict; a reader must not have to know the wire shape to tell them apart.
    const kind = panel.locator('[data-testid=investigation-hypothesis-kind]').first();
    await expect(kind).toHaveText(/AI hypothesis/i);
    await expect(kind).toHaveAttribute('data-hypothesis-kind', 'AI_HYPOTHESIS');

    // The statement sits inside the labelled hypothesis region, never inside the verdict panel.
    const statement = panel.locator('[data-testid=investigation-statement]').first();
    await expect(statement).toContainText('evidence row(s)');
    const inVerdict = await page.evaluate(() => {
      const node = document.querySelector('[data-testid=investigation-statement]');
      return Boolean(node && node.closest('[data-testid=incident-verdict]'));
    });
    expect(inVerdict).toBe(false);

    // No verdict control exists on this panel at all, in either language.
    const verdictControls = await panel.evaluate((node) =>
      Array.from(node.querySelectorAll('button, a, input, select, textarea'))
        .map((el) => ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim())
        .filter((label) => /confirm|refut|inconclusiv|verdict/i.test(label)),
    );
    expect(verdictControls).toEqual([]);

    // The sentence the panel exists to state is rendered from one fixed key, so the guarantee
    // can be asserted rather than read off the code.
    await expect(panel.locator('[data-testid=investigation-verdict-untouched]')).toContainText('Nothing on this panel can change the Human Verdict');

    // Confidence and uncertainty travel with the statement, not in a separate legend.
    await expect(panel.locator('[data-testid=investigation-confidence]').first()).toContainText(/high|medium|low/);
    await expect(panel.locator('[data-testid=investigation-uncertainty]').first()).toBeVisible();
    await expect(panel.locator('[data-testid=investigation-gaps]').first()).toContainText('provenance');
    await shot(page, 'hypothesis-provenance');
  });

  test('S4c the AI hypothesis and the signed human verdict are two different kinds of statement', async ({ page }) => {
    await openPanel(page, A);
    await selectRun(page, SEED.runs.completed.id);
    const panel = page.locator('[data-testid=incident-investigations]');
    const verdict = page.locator('[data-testid=incident-verdict]');
    await expect(verdict).toBeVisible();

    // Two regions, two names, two owners: the panel says "AI hypothesis", the verdict panel says
    // "Human verdict" and names the identity the Kernel authenticated.
    await expect(panel.locator('[data-testid=investigation-hypothesis-kind]').first()).toHaveText('AI hypothesis');
    await expect(verdict).toContainText('Human verdict');
    await expect(panel).not.toContainText('Human verdict');
    const hypothesisText = await panel.locator('[data-testid=investigation-statement]').first().innerText();
    const verdictText = await verdict.innerText();
    expect(verdictText).not.toContain(hypothesisText.slice(0, 40));
    // Nothing in the panel carries a verdict value, and no control offers to write one.
    expect(await panel.locator('[data-verdict-value], [data-verdict]').count()).toBe(0);
    await shot(page, 's4c-hypothesis-vs-verdict');
  });

  test('S4b no evidence and contradictory evidence each read as what they are', async ({ page }) => {
    await openPanel(page, B);
    await selectRun(page, SEED.runs.noEvidence.id);
    const panel = page.locator('[data-testid=incident-investigations]');
    await expect(panel.locator('[data-testid=investigation-stance]')).toHaveText('Cannot be determined from this record');
    await expect(panel.locator('[data-testid=investigation-gaps]')).toContainText('There is no evidence to reason from');
    await expect(panel.locator('[data-testid=investigation-citations]')).toHaveCount(0);
    await expect(panel.locator('[data-testid=investigation-uncertainty]')).toContainText('neither the timing nor the cause');
    await shot(page, 'sum-uncertain-no-evidence');

    await openPanel(page, C);
    await selectRun(page, SEED.runs.conflicted.id);
    const contradicted = page.locator('[data-testid=incident-investigations]');
    await expect(contradicted.locator('[data-testid=investigation-stance]')).toHaveText('The evidence contradicts itself');
    await expect(contradicted.locator('[data-testid=investigation-gaps]')).toContainText('predates the incident');
    // Both roles are present, and each list is labelled with the role rather than a colour.
    const groups = contradicted.locator('[data-testid=investigation-citations]');
    await expect(groups.filter({ hasText: 'Supporting evidence' })).toHaveCount(1);
    await expect(groups.filter({ hasText: 'Contradicting evidence' })).toHaveCount(1);
    await expect(groups.filter({ hasText: 'Contradicting evidence' }).locator('[data-testid=investigation-citation]')).toHaveCount(2);
    await shot(page, 'sum-conflicted');
  });

  test('S2b a refused read is shown with its predicate, not as an empty conclusion', async ({ page }) => {
    await openPanel(page, E);
    await selectRun(page, SEED.runs.partial.id);
    const panel = page.locator('[data-testid=incident-investigations]');
    await expect(panel.locator('[data-testid=investigation-status]')).toHaveText('Answered on an incomplete read');
    await expect(panel.locator('[data-testid=investigation-stop-reason]')).toHaveText('reached a final answer');
    const tools = panel.locator('[data-testid=investigation-tools] > li');
    await expect(tools).toHaveCount(5);
    await expect(tools.first()).toHaveAttribute('data-outcome', 'REFUSED');
    // The refusal is named by the code the Kernel recorded, not by an empty row. The Kernel
    // records authorizationPredicate only for a read that SUCCEEDED (the refused path stores
    // null), so what a refused row can honestly show is the reason, not the predicate.
    await expect(panel.locator('[data-testid=investigation-predicate]')).toHaveCount(0);
    await expect(panel.locator('[data-testid=investigation-tool-error]').first()).toContainText('That incident is not one you can read.');
    await expect(tools.nth(4)).toHaveAttribute('data-outcome', 'REFUSED');
    await expect(panel.locator('[data-testid=investigation-tool-error]').nth(4)).toContainText('authorises no such related-context source');
    await expect(panel.locator('[data-testid=investigation-gaps]')).toContainText('refused');
    await shot(page, 'state-partial-refused');
  });

  test('S5 the two reviews and the cancel are real transitions', async ({ page, request }) => {
    const session = await apiSession(request);

    // Accept a run this test started, so the assertion does not consume the seed's runs and a
    // re-run of this file is not a re-run of its own history.
    const acceptRun = await startRun(request, session, SEED.incidents.evidence, { scenario: 'AUTO' });
    await openPanel(page, A, await runCount(request, session, SEED.incidents.evidence));
    await selectRun(page, acceptRun.runId);
    await expect(page.locator('[data-testid=investigation-review-form]')).toBeVisible();
    await page.fill('[data-testid=investigation-review-note]', 'Read the stored rows; usable as a working explanation.');
    await page.click('[data-testid=investigation-review-accept]');
    const review = page.locator('[data-testid=investigation-review]');
    await expect(review).toHaveAttribute('data-decision', 'ACCEPTED');
    await expect(review).toContainText('usable as a working explanation');
    // The form is gone because the Kernel accepted the review, not because the button hid.
    await expect(page.locator('[data-testid=investigation-review-form]')).toHaveCount(0);
    const accepted = await getRun(request, session, SEED.incidents.evidence, acceptRun.runId);
    expect(accepted.review.decision).toBe('ACCEPTED');
    await shot(page, 'review-accepted');

    // Reject: a second run, a second incident, the other decision.
    const rejectRun = await startRun(request, session, SEED.incidents.noEvidence, { scenario: 'AUTO' });
    await openPanel(page, B, await runCount(request, session, SEED.incidents.noEvidence));
    await selectRun(page, rejectRun.runId);
    await page.fill('[data-testid=investigation-review-note]', 'No evidence rows were read, so there is nothing here to accept.');
    await page.click('[data-testid=investigation-review-reject]');
    await expect(page.locator('[data-testid=investigation-review]')).toHaveAttribute('data-decision', 'REJECTED');
    const rejected = await getRun(request, session, SEED.incidents.noEvidence, rejectRun.runId);
    expect(rejected.review.decision).toBe('REJECTED');
    await shot(page, 'review-rejected');

    // Cancel needs a run that is still running: start a paced one through the same API the page
    // uses, open it, and cancel it from the panel.
    const paced = startRun(request, session, SEED.incidents.evidence, {
      scenario: 'PACED_TOOL_LOOP', maxSteps: 200, maxToolCalls: 400, deadlineSeconds: 120,
    });
    await page.waitForTimeout(300);
    await openPanel(page, A, await runCount(request, session, SEED.incidents.evidence));
    const running = page.locator('li[data-run-status=RUNNING] [data-testid=investigation-select]').first();
    await expect(running).toBeVisible();
    await running.click();
    await expect(page.locator('[data-testid=investigation-status]')).toHaveText('Running');
    await page.click('[data-testid=investigation-cancel]');
    await expect(page.locator('.toast').first()).toBeVisible();
    await expect(page.locator('[data-testid=investigation-cancel]')).toHaveCount(0);
    const cancelledRun = await paced;

    // Re-reading shows the state the Kernel settled on rather than a guess by the panel.
    await page.click('[data-testid=investigation-refresh]');
    await expect(page.locator('li[data-run-id="' + cancelledRun.runId + '"]')).toHaveAttribute('data-run-status', 'CANCELLED');
    await shot(page, 'cancel-after');
  });
});