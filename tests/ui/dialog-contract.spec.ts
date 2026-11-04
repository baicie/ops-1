import { expect, test, type Page } from '@playwright/test';

/**
 * The dialog frame's accessible contract and its busy policy.
 *
 * These are DOM facts, not component-tree facts: the assertions read `aria-labelledby` and
 * `aria-describedby` off the rendered `role="dialog"` and resolve the ids in the document, so a
 * dangling reference fails here even though React rendered "something".
 *
 * The confirm dialog is reached through the real Access page with one fixture user appended to
 * the list response (the same technique as admin-polish); the write itself is never sent.
 */
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const FIXTURE_USER = 'dialog-contract-user';

async function login(page: Page) {
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('opsweave-locale', 'en');
    localStorage.setItem('opsweave-theme', 'light');
  });
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function openConfirm(page: Page) {
  await page.route('**/api/v1/users', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const users = await response.json();
    await route.fulfill({
      response,
      json: [...users, { id: FIXTURE_USER, email: 'dialog@opsweave.local', displayName: 'Dialog Fixture', role: 'viewer', disabled: false, createdAt: new Date().toISOString() }],
    });
  });
  await page.goto('/admin/access');
  const row = page.locator('[data-user="' + FIXTURE_USER + '"]');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Disable' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function resolveOptionalId(page: Page, id: string | null) {
  if (!id) return null;
  return page.evaluate((value) => document.getElementById(value)?.textContent?.trim() ?? null, id);
}

test('a described dialog points at the description element and names itself', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const dialog = await openConfirm(page);
  const labelledby = await dialog.getAttribute('aria-labelledby');
  const describedby = await dialog.getAttribute('aria-describedby');
  expect(labelledby, 'aria-labelledby').toBeTruthy();
  expect(describedby, 'aria-describedby').toBeTruthy();
  const name = await resolveOptionalId(page, labelledby);
  const description = await resolveOptionalId(page, describedby);
  const visible = (await dialog.locator('.ow-dialog-description').innerText()).trim();
  expect(name).toContain('Disable Dialog Fixture?');
  expect(description).toBe(visible);
  expect(visible.length).toBeGreaterThan(10);
  await expect(dialog.locator('.ow-dialog-head button')).toHaveCount(1);
});

test('a dialog without a description carries no dangling describedby', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/app/incidents');
  await expect(page.getByTestId('incidents-page')).toBeVisible();
  // The gate resolves after the workspace read; wait for either branch before deciding.
  const gate = page.locator('[data-testid="incident-create-open"], [data-testid="incident-create-blocked"]').first();
  await expect(gate).toBeVisible({ timeout: 15_000 });
  const open = page.getByTestId('incident-create-open');
  // This is a gate in the deterministic job: a closed create gate means the no-description
  // ARIA case was not measured, so fail instead of recording a skip as a pass.
  await expect(open, 'the create-incident entry must be available for this run').toBeVisible();
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  const labelledby = await dialog.getAttribute('aria-labelledby');
  expect(labelledby, 'aria-labelledby').toBeTruthy();
  expect(await resolveOptionalId(page, labelledby), 'accessible name').toBeTruthy();
  expect(await dialog.getAttribute('aria-describedby'), 'no description means no reference').toBeNull();
  await expect(dialog.locator('.ow-dialog-head button[aria-label="Close dialog"]')).toHaveCount(1);
});

test('pending blocks the close control, Escape, the overlay and a second write', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  let writes = 0;
  await page.route('**/api/v1/users/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'FIXTURE_REFUSED', message: 'the fixture refused this write' }) });
  });
  const dialog = await openConfirm(page);
  const close = dialog.locator('.ow-dialog-head .icon-btn');
  await expect(close).toBeEnabled();
  await dialog.locator('[data-confirm-submit]').click();
  await expect(dialog).toHaveAttribute('data-confirm-state', 'pending');
  await expect(dialog).toHaveAttribute('data-dismissible', 'false');
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(close).toBeDisabled();
  await expect(close).toHaveAttribute('aria-label', /Cannot close/);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-confirm-submit]').click({ force: true }).catch(() => undefined);
  await expect(dialog).toHaveAttribute('data-confirm-state', 'error', { timeout: 10_000 });
  await expect(dialog).toHaveAttribute('data-dismissible', 'true');
  await expect(dialog).not.toHaveAttribute('aria-busy', 'true');
  await expect(close).toBeEnabled();
  expect(writes, 'exactly one write left the page').toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('the command palette has an accessible name at both widths and a description only where it renders one', async ({ page }) => {
  await login(page);
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/admin/overview');
    await expect(page.getByTestId('command-trigger')).toBeVisible();
    await page.getByTestId('command-trigger').click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const labelledby = await dialog.getAttribute('aria-labelledby');
    const describedby = await dialog.getAttribute('aria-describedby');
    expect(labelledby, 'palette labelledby at ' + width).toBeTruthy();
    expect(await resolveOptionalId(page, labelledby), 'palette name at ' + width).toBeTruthy();
    // The centred palette renders a sr-only description; the compact sheet does not.
    if (width === 1440) {
      expect(describedby, 'palette describedby at 1440').toBeTruthy();
      expect(await resolveOptionalId(page, describedby), 'palette description at 1440').toBeTruthy();
    } else {
      expect(describedby, 'palette describedby at 1024').toBeNull();
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  }
});
