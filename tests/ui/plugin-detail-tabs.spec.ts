import { expect, type Page, test } from '@playwright/test';

// Plugin detail keeps its tab in the URL. Two entries reach that URL without remounting the
// page: the legacy redirect forwards ?tab=, and the overview tab links to its own
// deployments view. The second one used to be a no-op - the URL changed, the tab did not -
// so this spec clicks it and asserts the content, not just the address bar.
//
// The stack has no plugin whose deployment is active, and this spec must not create one, so
// the detail payload is supplied through route interception (the same technique
// admin-pages.spec.ts uses for states the running stack cannot produce on demand). The page
// keeps a single code path; only its input changes. Selectors are test ids and stable class
// hooks, never localized copy (rules/06).

const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

const PLUGIN_ID = 'dev.opsweave.tab-fixture';
const VERSION = '1.2.3';
const DETAIL_PATH = '/admin/plugins/' + PLUGIN_ID;

const DETAIL = {
  id: PLUGIN_ID,
  name: 'Tab Fixture',
  publisher: 'trusted-team',
  state: 'ACTIVE',
  activeVersion: VERSION,
  activeRevision: {
    id: 'revision-tab-fixture',
    version: VERSION,
    generation: 7,
    status: 'ACTIVE',
    activatedAt: '2026-10-01T00:00:00Z',
  },
  manifest: null,
  permissions: [],
  provides: [],
  requires: [],
  resources: null,
  packageVersions: [
    {
      version: VERSION,
      status: 'VERIFIED',
      signatureState: 'SIGNED',
      bundleDigest: 'sha256:' + 'a'.repeat(64),
      artifactDigest: 'sha256:' + 'b'.repeat(64),
      imageRef: 'registry.local/tab-fixture@sha256:' + 'c'.repeat(64),
      createdAt: '2026-10-01T00:00:00Z',
    },
  ],
  deployments: [
    {
      id: 'deployment-tab-fixture',
      pluginId: PLUGIN_ID,
      version: VERSION,
      desiredReplicas: 1,
      generation: 3,
      status: 'READY',
      statusReason: null,
      placement: {},
      resources: { cpuMillis: 100, memoryMiB: 64 },
      readyInstances: 1,
      totalInstances: 1,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
      activatedAt: '2026-10-01T00:00:00Z',
      drainUntil: null,
      instances: [
        {
          id: 'instance-tab-fixture',
          slot: 0,
          nodeId: 'node-tab-fixture',
          nodeName: 'node-tab-fixture',
          nodeStatus: 'READY',
          state: 'RUNNING',
          containerId: 'container-tab-fixture',
          restartCount: 0,
          lastError: null,
          observedAt: '2026-10-01T00:00:00Z',
        },
      ],
    },
  ],
  isSystem: false,
};

/** The deployments panel is the only place that renders a deployment card. */
function deploymentsPanel(page: Page) {
  return page.locator('[role="tabpanel"][data-state="active"]').locator('.deployment-card');
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function stubDetail(page: Page) {
  await page.route('**/api/v1/plugins/' + PLUGIN_ID + '**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(DETAIL),
  }));
  await page.route('**/api/v1/audit**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([]),
  }));
}

test('the in-page deployments link switches the tab without remounting the page', async ({ page }) => {
  await stubDetail(page);
  await signIn(page);

  await page.goto(DETAIL_PATH);
  const link = page.getByTestId('plugin-detail-deployments-link');
  await expect(link).toBeVisible();

  // Overview is the tab this page starts on; the deployments panel is not mounted yet.
  await expect(deploymentsPanel(page)).toHaveCount(0);

  await link.click();

  // The address bar is not the assertion - it also changed while the bug was live.
  await expect(page).toHaveURL(new RegExp('[?&]tab=deployments'));
  await expect(deploymentsPanel(page).first()).toBeVisible();
  await expect(deploymentsPanel(page).first()).toContainText(VERSION);
});

test('a deep link still opens the deployments tab on a cold load', async ({ page }) => {
  await stubDetail(page);
  await signIn(page);

  await page.goto(DETAIL_PATH + '?tab=deployments');

  await expect(deploymentsPanel(page).first()).toBeVisible();
  await expect(deploymentsPanel(page).first()).toContainText(VERSION);
});
