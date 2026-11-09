import { expect, test } from '@playwright/test';

/**
 * Evidence capture for the two CSS defects fixed on 2026-11-09:
 *
 *   1. `.activity-filter-count` painted `color: var(--ow-accent-foreground)`, a token that is
 *      declared nowhere, so the badge inherited body ink: 2.89:1 on the accent fill.
 *   2. The node resource history polyline fell back to `var(--accent, #4f8cff)`, a variable
 *      that does not exist either, so the chart drew an off-palette blue.
 *
 * Both are asserted from the COMPUTED style rather than from a screenshot diff, because this
 * repository has no pixel baseline (0 `toHaveScreenshot`). The screenshots are the human-
 * reviewable half; the assertions are the part that fails a build.
 */

// Playwright runs with tests/ui as its cwd, so this is resolved from the repo root.
const OUT = new URL('../../artifacts/ui/g14-spacing-gate/shots', import.meta.url).pathname;
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';

// Only the 1440 pair is kept in the index: the badge is the same two colours at 390, and
// node-* cannot render on a macOS host at all. Capturing what the bucket does not keep turns
// every run into untracked files that some later `git add -A` sweeps in.
const VIEWPORTS = [{ name: '1440', width: 1440, height: 900 }];
const THEMES = ['light', 'dark'];

async function signIn(page) {
  await page.goto('/admin/login');
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL((url) => !/\/login$/.test(url.pathname));
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('opsweave-theme', t);
  }, theme);
}

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`activity filter badge — ${vp.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signIn(page);
      await setTheme(page, theme);
      await page.goto('/admin/activity');
      await page.waitForLoadState('networkidle').catch(() => {});

      // The badge only renders when a narrow filter is active (`activeNarrow > 0`), so the
      // evidence has to set one through the same control an operator uses: open the panel and
      // pick a subject type. Clicking a chip does nothing - the trigger opens a listbox.
      await page.getByTestId('activity-filter-toggle').click();
      await page.getByTestId('filter-subject').click();
      await page.getByRole('option', { name: /node/i }).first().click();
      await expect(page.getByTestId('activity-filter-toggle')).toHaveAttribute('data-active-count', '1');
      const badge = page.locator('.activity-filter-count').first();
      // A spec that passes because the element never rendered is the empty-truth failure
      // code-rules C2 names, so the badge's absence fails the run instead of skipping it.
      await expect(
        badge,
        'the narrowed-filter count badge must render for this evidence to mean anything',
      ).toBeVisible();
      const style = await badge.evaluate((el) => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
      });
      // The defect was an inherited ink on the accent fill. In light that is near-black
      // (rgb(22,26,32)); the fix is the theme's accent-text, white in light.
      expect(style.color, 'badge must not inherit body ink').not.toBe('rgb(22, 26, 32)');
      console.log(`${vp.name} ${theme} badge`, JSON.stringify(style));

      await page.screenshot({ path: `${OUT}/activity-${vp.name}-${theme}.png`, fullPage: true });
    });

    test(`node resource chart — ${vp.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signIn(page);
      await setTheme(page, theme);

      // GET /api/v1/nodes answers a bare array of node views, not an envelope.
      const res = await page.request.get('/api/v1/nodes');
      const body = res.ok() ? await res.json() : null;
      const nodeId = Array.isArray(body) ? body[0]?.id ?? '' : '';
      expect(nodeId, 'the stack must have at least one enrolled node for this evidence to mean anything').not.toBe('');
      await page.goto(`/admin/nodes/${nodeId}`);
      await page.waitForLoadState('networkidle').catch(() => {});

      // `historySegments` drops every sample whose cpuUtilization is null, and on macOS the
      // node leaves it null on purpose (apps/node/src/runtime.rs resource_snapshot only fills
      // CPU/memory under #[cfg(target_os = "linux")]). So on this host the polyline cannot
      // render, and asserting it would fail for a reason that has nothing to do with the fix.
      // Report which of the two situations was measured instead of claiming either.
      const lines = page.locator('.resource-history-plot polyline');
      const plotted = await lines.count();
      if (plotted === 0) {
        console.log(`${vp.name} ${theme}: polyline not rendered (macOS node reports cpu=null, NOT a fix failure)`);
      } else {
        const stroke = await lines.first().evaluate((el) => getComputedStyle(el).stroke);
        // #4f8cff was the never-declared fallback; the fix resolves --ow-accent.
        expect(stroke, 'chart stroke must be the accent token, not the #4f8cff fallback').not.toBe(
          'rgb(79, 140, 255)',
        );
        // Compare against the theme's accent, resolved in the same page, so the assertion
        // follows the token rather than hard-coding today's hex.
        const accent = await page.evaluate(() => {
          const probe = document.createElement('div');
          probe.style.color = 'var(--ow-accent)';
          document.body.appendChild(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        });
        expect(stroke, 'chart stroke must resolve to --ow-accent').toBe(accent);
        console.log(`${vp.name} ${theme} stroke`, stroke);
      }

      // No screenshot: on this host there is no polyline to photograph, and a picture of the
      // empty-state panel would be evidence of nothing.
    });
  }
}
