import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G08 batch C acceptance: the high-density surfaces (Pipeline Studio editor, install wizard,
 * plugin detail, instance log stream) after the visual/interaction close-out.
 *
 * What is asserted here and nowhere else:
 *   - the four page-level surfaces render the *shared* PageHeader (one .page-header, one h1, one
 *     description) instead of a hand-written title block;
 *   - a value the source did not answer is a NO_DATA / UNKNOWN token, never a 0 or a dash;
 *   - the irreversible operations of plugin detail are ConfirmAction dialogs that block a second
 *     submit and keep the failure on the dialog;
 *   - the two overwriting writes of the studio editor leave window.confirm for the same component,
 *     and where a second submit is stopped (the studio case does not render an error state - it
 *     hands the failure to the page surface, which PipelineEditor.tsx says it intends);
 *   - the log stream keeps its own toolbar/terminal layout and states a paused view as STALE.
 *
 * States the running stack cannot produce on demand are produced by rewriting the response the
 * page already consumes - the technique admin-polish.spec.ts and plugin-detail-tabs.spec.ts use.
 * No mock branch enters the application.
 *
 * Selectors are test ids and stable class hooks; localized copy is never a selector.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/g08-batch-c');
const PIPELINE_ID = process.env.OPSWEAVE_PIPELINE_ID || 'host-metrics-pipeline';
const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'dev.opsweave.hello';
const INSTANCE_ID = 'instance-batch-c';

/**
 * This stack runs no installed plugin (the detail route answers "plugin not found"), so the detail
 * payload is a fixture with the API's own shape. It deliberately carries the holes the page has to
 * report honestly: an image digest the version does not declare, a deployment with no resource
 * request, and an instance with no container. Every write the page performs still goes live.
 */
const PLUGIN_DETAIL_FIXTURE = {
  id: PLUGIN_ID,
  name: 'Batch C Fixture',
  publisher: 'trusted-team',
  state: 'ACTIVE',
  activeVersion: '1.2.3',
  activeRevision: { id: 'revision-batch-c', version: '1.2.3', generation: 4, status: 'ACTIVE', activatedAt: '2026-10-01T00:00:00Z' },
  manifest: null,
  permissions: ['data:read'],
  provides: [],
  requires: [],
  resources: null,
  packageVersions: [
    {
      version: '1.2.3',
      status: 'VERIFIED',
      signatureState: 'SIGNED',
      bundleDigest: 'sha256:' + 'a'.repeat(64),
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      imageRef: null,
      createdAt: '2026-10-01T00:00:00Z',
    },
  ],
  deployments: [
    {
      id: 'deployment-batch-c',
      pluginId: PLUGIN_ID,
      version: '1.2.3',
      desiredReplicas: 1,
      generation: 2,
      status: 'READY',
      statusReason: null,
      placement: {},
      resources: null,
      readyInstances: 1,
      totalInstances: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      activatedAt: '2026-10-01T00:00:00Z',
      drainUntil: null,
      instances: [
        {
          id: INSTANCE_ID,
          slot: 0,
          nodeId: 'node-batch-c',
          nodeName: 'node-batch-c',
          nodeStatus: 'READY',
          state: 'RUNNING',
          containerId: null,
          restartCount: 0,
          lastError: null,
          observedAt: '2026-10-01T00:00:00Z',
        },
      ],
    },
  ],
  isSystem: false,
};

/**
 * The same stack publishes no pipeline (the editor route answers "pipeline not found"), so the
 * published definition below is a fixture with the API's own shape: two nodes, one edge, a config
 * the inspector can render. Draft writes still go live.
 */
const PIPELINE_DEFINITION = {
  schemaVersion: '1',
  pipelineId: PIPELINE_ID,
  name: 'Host metrics pipeline',
  revision: 1,
  status: 'PUBLISHED',
  nodes: [
    {
      nodeId: 'source',
      type: 'builtin.source.http_json',
      typeVersion: 1,
      config: { endpoint: 'https://metrics.invalid/api', timeoutSeconds: 17 },
      inputs: [],
      outputs: [{ name: 'out', dataType: 'records' }],
    },
    {
      nodeId: 'sink',
      type: 'builtin.sink.dataset',
      typeVersion: 1,
      config: { datasetId: 'host_metrics' },
      inputs: [{ name: 'in', dataType: 'records', required: true }],
      outputs: [],
    },
  ],
  edges: [{ fromNode: 'source', fromPort: 'out', toNode: 'sink', toPort: 'in', dataType: 'records' }],
  createdAt: '2026-10-01T00:00:00Z',
  digest: 'sha256:' + 'a'.repeat(64),
};

async function stubPipeline(page: Page) {
  await page.route('**/api/v1/pipelines/' + PIPELINE_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pipelineId: PIPELINE_ID,
      name: PIPELINE_DEFINITION.name,
      latestRevision: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      latest: {
        pipelineId: PIPELINE_ID,
        revision: 1,
        digest: PIPELINE_DEFINITION.digest,
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        definition: PIPELINE_DEFINITION,
        plan: {},
      },
      revisions: [{ revision: 1, digest: PIPELINE_DEFINITION.digest, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }],
    }),
  }));
  await page.route('**/api/v1/pipelines/' + PIPELINE_ID + '/drafts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([]),
  }));
}

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

/**
 * The kernel this stack runs is not this working tree, so its /auth/me carries no console
 * declaration and the admin shell answers "access denied" to every route. The declaration is
 * stubbed onto the real response (the same technique dual-surface and admin-polish use): the
 * cookie, CSRF token and session stay the live ones - only the missing field is supplied.
 */
const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };

async function stubAdminGrant(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = ADMIN_GRANT;
    await route.fulfill({ response, json: body });
  });
}

async function stubPluginDetail(page: Page) {
  await page.route('**/api/v1/plugins/' + PLUGIN_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(PLUGIN_DETAIL_FIXTURE),
  }));
  await page.route('**/api/v1/audit**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([]),
  }));
}

async function login(page: Page) {
  // The enforced 1440/light capture: the product default theme follows the OS, so pin it.
  await page.addInitScript(() => window.localStorage.setItem('opsweave-theme', 'light'));
  await stubAdminGrant(page);
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** One header, one title, one description - for a page that renders the shared PageHeader. */
async function expectSharedHeader(page: Page, slug: string) {
  const header = page.getByTestId('page-header');
  await expect(header, slug + ': one shared page header').toHaveCount(1);
  await expect(page.locator('.page-header'), slug + ': one header container').toHaveCount(1);
  await expect(page.locator('h1'), slug + ': one h1 on the page').toHaveCount(1);
  await expect(header.locator('h1'), slug + ': the header owns the h1').toHaveCount(1);
  await expect(header.locator('.page-description'), slug + ': one description sentence').toHaveCount(1);
}

async function noOverflow(page: Page, slug: string) {
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(measured.scrollWidth, slug + ': no page-level horizontal overflow').toBeLessThanOrEqual(measured.clientWidth + 1);
}

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

// --- 1. one shared header on every surface ------------------------------------------------

test('the install wizard renders the shared header', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.goto('/admin/plugins/install');
  await expectSharedHeader(page, 'install-wizard');
  // The wizard keeps its dedicated layout: stepper, one panel per step, its own drop zone.
  await expect(page.locator('.stepper')).toHaveCount(1);
  await expect(page.locator('.dropzone')).toHaveCount(1);
  await noOverflow(page, 'install-wizard');
  await page.screenshot({ path: path.join(OUT, 'g08-c-install-wizard-1440-light.png'), fullPage: true });
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});

test('plugin detail renders the shared header and NO_DATA where the source is silent', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubPluginDetail(page);
  await login(page);
  await page.goto('/admin/plugins/' + PLUGIN_ID);
  await expectSharedHeader(page, 'plugin-detail');
  // The tabbed layout is untouched: Radix owns the tablist, one panel is mounted.
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
  // The fixture declares no image digest and its instance reports no container: both are tokens.
  const tokens = page.locator('.value-token[data-value="NO_DATA"]');
  expect(await tokens.count(), 'a missing digest and a missing container are NO_DATA').toBeGreaterThanOrEqual(2);
  const trustText = await page.locator('.summary-grid').first().innerText();
  expect(trustText, 'a dash never stands in for a missing value').not.toContain('—');
  await noOverflow(page, 'plugin-detail');
  await page.screenshot({ path: path.join(OUT, 'g08-c-plugin-detail-1440-light.png'), fullPage: true });
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});

test('the studio editor renders the shared header and keeps the canvas its own layout', async ({ page }) => {
  await stubPipeline(page);
  await login(page);
  await page.goto('/admin/pipelines/' + PIPELINE_ID + '/editor');
  await expectSharedHeader(page, 'pipeline-editor');
  // Requirement 1 of the design pack: a canvas is not a card. The three dedicated columns and the
  // React Flow nodes survive the header change.
  await expect(page.locator('.studio-shell .studio-palette')).toHaveCount(1);
  await expect(page.locator('.studio-shell .studio-canvas')).toHaveCount(1);
  await expect(page.locator('.studio-shell .studio-inspector')).toHaveCount(1);
  await expect(page.locator('.studio-rf-node').first()).toBeVisible();
  const canvas = page.getByLabel('Pipeline canvas');
  const box = await canvas.boundingBox();
  const palette = await page.locator('.studio-palette').boundingBox();
  // "The canvas owns the primary workspace": it is taller than its minimum and wider than the
  // panels beside it. Pinning an exact pixel width here would test the sidebar, not the canvas.
  expect(box && box.height, 'the canvas keeps its dedicated height').toBeGreaterThan(400);
  expect(box && palette && box.width, 'the canvas is the widest column').toBeGreaterThan(palette.width * 2);
  // The facts that used to sit in one mono sentence are header meta chips now.
  await expect(page.getByTestId('page-header').locator('.page-header-meta .meta-chip').first()).toBeVisible();
  await expect(page.getByTestId('page-header').locator('.status-indicator').first()).toBeVisible();
  await noOverflow(page, 'pipeline-editor');
  await page.screenshot({ path: path.join(OUT, 'g08-c-pipeline-editor-1440-light.png'), fullPage: true });
});

// --- 2. missing facts are tokens, not zeros -----------------------------------------------

test('a manifest that omits a value prints NO_DATA / UNKNOWN in the wizard', async ({ page }) => {
  await login(page);
  // The package response the upload already returns; only the answers it gives are fixed.
  await page.route('**/api/v1/plugins/packages', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      packageId: 'pkg-batch-c-fixture',
      pluginId: 'dev.opsweave.batch-c-fixture',
      version: '0.1.0',
      publisher: 'trusted-team',
      status: 'VERIFIED',
      signatureState: 'SIGNED',
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      bundleDigest: 'sha256:' + 'b'.repeat(64),
      payloadDigest: 'sha256:' + 'c'.repeat(64),
      imageRef: null,
      frontendIndex: null,
      // compatibility, resources and backend.apiPrefix are deliberately absent.
      manifest: { permissions: [], backend: { protocol: { name: 'http-json' } }, compatibility: {} },
      rejectionReason: null,
      createdAt: new Date().toISOString(),
    }),
  }));
  await page.goto('/admin/plugins/install');
  await page.locator('input[type=file]').setInputFiles({
    name: 'fixture.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('PK\u0005\u0006'),
  });
  // The trust panel also has a hole: the package declares no backend image.
  await expect(page.locator('.wizard-panel').first().locator('.value-token[data-value="NO_DATA"]'), 'a package with no image is NO_DATA, not a dash').toHaveCount(1);
  const compat = page.locator('.summary-grid .panel').last();
  await expect(compat).toBeVisible();
  // Six cells, five of which the fixture manifest cannot answer.
  await expect(compat.locator('.value-token[data-value="NO_DATA"]')).toHaveCount(5);
  await expect(compat.locator('.value-token[data-value="UNKNOWN"]')).toHaveCount(1);
  const text = await compat.innerText();
  expect(text, 'no fabricated mCPU zero').not.toMatch(/0 mCPU/);
  expect(text, 'no dash placeholder').not.toContain('—');
  await noOverflow(page, 'install-wizard-step2');
  await page.screenshot({ path: path.join(OUT, 'g08-c-install-wizard-step2-no-data-1440-light.png'), fullPage: true });
});

// --- 3. dangerous operations confirm, block and report ------------------------------------

test('disabling a plugin confirms, blocks a second submit and keeps the failure on the dialog', async ({ page }) => {
  await stubPluginDetail(page);
  let writes = 0;
  await page.route('**/api/v1/plugins/' + PLUGIN_ID + '/disable', async (route) => {
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 900));
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'BATCH_C_REFUSED', message: 'the fixture refused this write' }),
    });
  });
  await login(page);
  await page.goto('/admin/plugins/' + PLUGIN_ID);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'idle');
  await page.screenshot({ path: path.join(OUT, 'g08-c-plugin-detail-confirm-idle-1440-light.png'), fullPage: true });

  const confirm = dialog.locator('[data-confirm-submit]');
  await confirm.click();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'pending');
  await expect(confirm).toBeDisabled();
  await page.screenshot({ path: path.join(OUT, 'g08-c-plugin-detail-confirm-pending-1440-light.png'), fullPage: true });

  await expect(dialog).toHaveAttribute('data-confirm-state', 'error', { timeout: 15_000 });
  await expect(dialog.locator('[data-confirm-error]')).toContainText('BATCH_C_REFUSED');
  await expect(confirm).toHaveText('Retry');
  await expect(confirm).toBeEnabled();
  expect(writes, 'exactly one write left the page').toBe(1);
  await page.screenshot({ path: path.join(OUT, 'g08-c-plugin-detail-confirm-error-1440-light.png'), fullPage: true });
});

// --- 3b. the studio conflict dialogs: idle, pending, and who owns the failure -------------

/**
 * G08 batch C item 1: the two writes that overwrite work in the studio editor - "reload latest"
 * and "use local & retry" - ask through the shared ConfirmAction instead of window.confirm.
 *
 * A real draft conflict needs the seeded host-metrics-pipeline, so the four responses the editor
 * already consumes are supplied here in the kernel's own shape (DraftView, apps/kernel/src/jobs.rs,
 * including a UUID draft id because the route parses one). Everything between them is the
 * product's code: the conflict comes from a real 409 on the save, the retry carries the version it
 * has just read, and the failure surfaces where PipelineEditor.tsx sends it.
 */
const STUDIO_DRAFT_ID = '5f1b0c3e-9d2a-4c7b-8e11-3a6d5c4b2f10';

function studioDefinition(timeoutSeconds: number) {
  return {
    ...PIPELINE_DEFINITION,
    nodes: PIPELINE_DEFINITION.nodes.map((node) =>
      node.nodeId === 'source' ? { ...node, config: { ...node.config, timeoutSeconds } } : node),
  };
}

function studioDraft(version: number, timeoutSeconds: number) {
  return {
    draftId: STUDIO_DRAFT_ID,
    pipelineId: PIPELINE_ID,
    baseRevision: 1,
    definition: studioDefinition(timeoutSeconds),
    definitionDigest: 'sha256:' + 'd'.repeat(64),
    version,
    status: 'DRAFT',
    createdBy: '00000000-0000-4000-8000-000000000001',
    updatedBy: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

/**
 * The draft starts at v1/17. The first save is refused with the kernel's own 409 (a second
 * editor moved the draft to v2/18, which the page then reads back), and every later save is
 * answered by "refuse": either a slow 500 or a success. Writes are logged with the version they
 * carried, so "the retry sent the version it had just read" is an assertion, not a comment.
 */
async function stubStudioConflict(page: Page, refuse: 'slow-500' | 'accept') {
  const escaped = PIPELINE_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const detail = new RegExp('/api/v1/pipelines/' + escaped + '$');
  const drafts = new RegExp('/api/v1/pipelines/' + escaped + '/drafts(/[^/?]+)?$');
  const state = { loads: 0, writeLog: [] as { ifMatch: string | null }[] };

  await page.route(detail, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pipelineId: PIPELINE_ID,
      name: PIPELINE_DEFINITION.name,
      latestRevision: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      latest: {
        pipelineId: PIPELINE_ID,
        revision: 1,
        digest: PIPELINE_DEFINITION.digest,
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00Z',
        definition: PIPELINE_DEFINITION,
        plan: {},
      },
      revisions: [{ revision: 1, digest: PIPELINE_DEFINITION.digest, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }],
    }),
  }));

  await page.route(drafts, async (route) => {
    const request = route.request();
    const method = request.method();
    const onOneDraft = new URL(request.url()).pathname.endsWith('/drafts/' + STUDIO_DRAFT_ID);
    if (method === 'GET' && !onOneDraft) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([studioDraft(1, 17)]) });
    }
    if (method === 'GET') {
      state.loads += 1;
      // v1 is what the page opened; every read after it is the newer draft, edited to 18. Those
      // reads are slow on purpose: the reload swaps the editor for a skeleton, and that window is
      // what the discard case asserts.
      if (state.loads === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(studioDraft(1, 17)) });
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(studioDraft(2, 18)) });
    }
    state.writeLog.push({ ifMatch: request.headers()['if-match'] ?? null });
    if (state.writeLog.length === 1) {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'DRAFT_VERSION_CONFLICT', message: 'draft was updated by another editor' }),
      });
    }
    if (refuse === 'slow-500') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'STUDIO_WRITE_REFUSED', message: 'the fixture refused this draft write' }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(studioDraft(3, 19)) });
  });

  return {
    writeLog: () => state.writeLog,
    writeCount: () => state.writeLog.length,
  };
}

/**
 * Samples "data-confirm-state" every frame, so "the dialog never rendered an error" is a recorded
 * fact rather than an inference from the final DOM. States are de-duplicated and 'absent' marks a
 * frame in which no dialog was mounted.
 */
async function startConfirmStateTrace(page: Page) {
  await page.evaluate(() => {
    const store = window as unknown as { __confirmStates: string[]; __confirmSampling: boolean };
    store.__confirmStates = [];
    store.__confirmSampling = true;
    const sample = () => {
      const dialog = document.querySelector('[data-testid="confirm-dialog"]');
      const state = dialog ? dialog.getAttribute('data-confirm-state') || 'unknown' : 'absent';
      if (store.__confirmStates[store.__confirmStates.length - 1] !== state) store.__confirmStates.push(state);
      if (store.__confirmSampling) window.requestAnimationFrame(sample);
    };
    window.requestAnimationFrame(sample);
  });
}

async function stopConfirmStateTrace(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window as unknown as { __confirmStates: string[]; __confirmSampling: boolean };
    store.__confirmSampling = false;
    return store.__confirmStates;
  });
}

/** The editor as an operator reaches it: a draft loaded through ?draft, one node selected. */
async function openStudioDraft(page: Page) {
  await page.goto('/admin/pipelines/' + PIPELINE_ID + '/editor?draft=' + STUDIO_DRAFT_ID);
  await expect(page.locator('.studio-inspector')).toBeVisible();
  await page.locator('.studio-palette .palette-item small.mono').filter({ hasText: /^source$/ }).click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue('17');
}

/** A save the server refuses because the draft moved on, leaving the conflict banner behind. */
async function saveIntoConflict(page: Page) {
  await page.locator('.studio-inspector').getByLabel('timeoutSeconds').fill('19');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('.studio-conflict')).toContainText('DRAFT_VERSION_CONFLICT');
  await expect(page.locator('.conflict-diff')).toContainText('timeoutSeconds');
  await expect(page.locator('.conflict-diff')).toContainText('19');
  await expect(page.locator('.conflict-diff')).toContainText('18');
}

test('the studio overwrite dialog asks, blocks a second submit and leaves the refusal to the page', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const stub = await stubStudioConflict(page, 'slow-500');
  await login(page);
  await openStudioDraft(page);
  await saveIntoConflict(page);

  await page.getByRole('button', { name: 'Use local & retry' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog, 'overwriting the newer draft asks first').toBeVisible();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'idle');
  const confirm = dialog.locator('[data-confirm-submit]');
  await expect(confirm).toBeEnabled();
  await startConfirmStateTrace(page);
  await page.screenshot({ path: path.join(OUT, 'g08-c-studio-overwrite-confirm-idle-1440-light.png'), fullPage: true });

  // Two activations in one task: React has not re-rendered yet, so the second one lands on a
  // button the disabled attribute has not touched. The component's in-flight ref is all that can
  // drop it, which is what this case is for.
  const armed = await page.evaluate(() => {
    const button = document.querySelector('[data-testid="confirm-dialog"] [data-confirm-submit]') as HTMLButtonElement | null;
    if (!button) return 'missing';
    button.click();
    const secondReachedAnEnabledButton = !button.disabled;
    button.click();
    return secondReachedAnEnabledButton ? 'enabled' : 'disabled';
  });
  expect(armed, 'the second activation really did reach a live button').toBe('enabled');

  await expect(dialog).toHaveAttribute('data-confirm-state', 'pending');
  await expect(confirm).toBeDisabled();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await page.screenshot({ path: path.join(OUT, 'g08-c-studio-overwrite-confirm-pending-1440-light.png'), fullPage: true });
  expect(stub.writeCount(), 'the dropped activation never became a second write').toBe(2);

  // The refusal is not the dialog's to render: PipelineEditor.tsx resolves on failure so the page
  // surface reports it, and the dialog closes.
  await expect(page.locator('.error-state')).toContainText('the fixture refused this draft write');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  const trace = await stopConfirmStateTrace(page);
  expect(trace, 'no error state is rendered on this dialog').not.toContain('error');
  expect(trace, 'the operator saw the button working').toContain('pending');
  expect(trace[trace.length - 1], 'the dialog is gone once the page owns the failure').toBe('absent');
  expect(stub.writeLog(), 'the first save carried v1 and the retry carried the v2 it had just read').toEqual([
    { ifMatch: '1' },
    { ifMatch: '2' },
  ]);
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});

test('the studio reload dialog discards only on confirm, writes nothing and returns the server draft', async ({ page }) => {
  const stub = await stubStudioConflict(page, 'accept');
  await login(page);
  await openStudioDraft(page);
  await saveIntoConflict(page);
  const writesBeforeReload = stub.writeCount();

  await page.getByRole('button', { name: 'Reload latest' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog, 'discarding local edits asks first').toBeVisible();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'idle');

  // Cancel has to be a real exit: the local edit and the banner are both still there.
  await expect(dialog.locator('[data-confirm-cancel]')).toBeEnabled();
  await dialog.locator('[data-confirm-cancel]').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.locator('.studio-conflict')).toContainText('DRAFT_VERSION_CONFLICT');
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds')).toHaveValue('19');
  expect(stub.writeCount(), 'cancelling wrote nothing').toBe(writesBeforeReload);

  // Confirmed: the reload replaces the whole editor, so the dialog is gone before a pending state
  // could render - the skeleton is the pending surface for this write.
  await page.getByRole('button', { name: 'Reload latest' }).click();
  await expect(page.getByTestId('confirm-dialog')).toHaveAttribute('data-confirm-state', 'idle');
  await startConfirmStateTrace(page);
  await page.getByTestId('confirm-dialog').locator('[data-confirm-submit]').click();
  await expect(page.locator('.skeleton-stack')).toBeVisible();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.locator('.studio-inspector')).toBeVisible();
  await expect(page.locator('.studio-conflict')).toHaveCount(0);
  await page.locator('.studio-palette .palette-item small.mono').filter({ hasText: /^source$/ }).click();
  await expect(page.locator('.studio-inspector').getByLabel('timeoutSeconds'), 'the server draft, not the local one').toHaveValue('18');
  const trace = await stopConfirmStateTrace(page);
  expect(trace, 'the sampler was live before the confirmation').toContain('idle');
  expect(trace, 'this dialog has no error state: the reload surfaces its own failure').not.toContain('error');
  expect(trace, 'the reload swaps the editor in the same task, so pending never renders').not.toContain('pending');
  expect(trace[trace.length - 1], 'the dialog is gone once the reload owns the page').toBe('absent');
  expect(stub.writeCount(), 'discarding a draft writes nothing').toBe(writesBeforeReload);
  await page.screenshot({ path: path.join(OUT, 'g08-c-studio-reload-dialog-result-1440-light.png'), fullPage: true });
});

// --- 4. the log stream keeps its own layout, header shared --------------------------------

test('the log stream renders the shared header over its own toolbar and terminal', async ({ page }) => {
  const now = new Date().toISOString();
  await page.route('**/api/v1/instances/' + INSTANCE_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: INSTANCE_ID, deploymentId: 'deployment-batch-c', nodeId: 'node-batch-c', nodeName: '',
      nodeStatus: 'UNKNOWN', nodeLastSeenAt: null, slot: 0, state: 'RUNNING', observedAt: now,
      containerId: null, imageDigest: null, restartCount: 0, lastError: null,
      pluginId: PLUGIN_ID, version: '1.0.0', deploymentStatus: 'READY', streamId: 'stream-batch-c-fixture',
    }),
  }));
  await page.route('**/api/v1/instances/' + INSTANCE_ID + '/logs/live*', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: [
      'event: log',
      'id: 1',
      'data: ' + JSON.stringify({
        eventId: 'event-batch-c-1', streamId: 'stream-batch-c-fixture', streamEpoch: 1, sequence: 1,
        occurredAt: now, observedAt: now, nodeId: 'node-batch-c', instanceId: INSTANCE_ID,
        channel: 'stdout', level: 'INFO', message: 'batch C acceptance line', truncated: false,
      }),
      '',
      '',
    ].join('\n'),
  }));
  await login(page);
  await page.goto('/admin/instances/' + INSTANCE_ID + '/logs');
  await expectSharedHeader(page, 'instance-logs');
  // The stream keeps its dedicated layout: toolbar, terminal, footer, one line per event.
  await expect(page.locator('.log-toolbar')).toHaveCount(1);
  await expect(page.locator('.terminal')).toHaveCount(1);
  await expect(page.locator('.log-footer')).toHaveCount(1);
  await expect(page.locator('.log-line').first()).toBeVisible({ timeout: 20_000 });
  // An unreported node name is UNKNOWN, and the connection state is the shared indicator.
  await expect(page.locator('.log-meta .value-token[data-value="UNKNOWN"]')).toHaveCount(1);
  await expect(page.locator('.log-meta .status-indicator')).toHaveCount(2);
  await noOverflow(page, 'instance-logs');
  await page.screenshot({ path: path.join(OUT, 'g08-c-instance-logs-1440-light.png'), fullPage: true });

  // A paused view is STALE by definition: newer lines are buffered and not shown.
  await page.getByRole('button', { name: /Pause view/ }).click();
  await expect(page.locator('[data-notice="stale"]')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'g08-c-instance-logs-paused-stale-1440-light.png'), fullPage: true });
});
