import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G12 R2 phase 2 - the same panel, the same run, the same viewport, photographed before and after.
 *
 * The "before" half is this file run against the panel as HEAD shipped it; the "after" half is the
 * same file against the reworked panel. Nothing else changes between the two runs, so the pair is
 * a comparison of the component and not of a fixture.
 *
 * OPSWEAVE_G12R2_TAG=before|after selects the file names.
 */
const ROOT = path.resolve(process.cwd(), '..', '..');
const TAG = process.env.OPSWEAVE_G12R2_TAG || 'after';
const OUT = path.join(ROOT, 'artifacts', 'g12-r2p2', 'compare');
const SEED = JSON.parse(fs.readFileSync(process.env.OPSWEAVE_SEED_JSON || path.join(ROOT, 'artifacts', 'g12-r2p2', 'seed.json'), 'utf8'));
const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12r2.invalid';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12r2-admin-password-1';
const A = '/app/incidents/' + SEED.incidents.evidence;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await expect(page).not.toHaveURL(/\/login/);
}

test('the panel at 1440 and 390, before/after', async ({ page }) => {
  await page.goto('/login');
  await signIn(page);
  for (const [width, height, locale, name] of [[1440, 900, 'en', '1440-light-en'], [390, 844, 'zh-CN', '390-light-zh']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => {
      window.localStorage.setItem('opsweave-locale', value);
      window.localStorage.setItem('opsweave-theme', 'light');
    }, locale);
    await page.goto(A);
    const panel = page.locator('[data-testid=incident-investigations]');
    await expect(panel).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await page.click('li[data-run-id="' + SEED.runs.completed.id + '"] [data-testid=investigation-select]');
    await page.click('[data-testid=investigation-citation][data-evidence-id="' + SEED.evidence.storedLog + '"]');
    await page.locator('[data-testid=investigation-citation-content]').waitFor({ state: 'visible' });
    fs.mkdirSync(OUT, { recursive: true });
    await panel.screenshot({ path: path.join(OUT, TAG + '-' + name + '.png') });
  }
});
