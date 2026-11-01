import { defineConfig, devices } from '@playwright/test';

/**
 * Runner for the incidents workspace artifact + state suite.
 *
 * `tests/ui/playwright.config.ts` is the shared config, and several of its specs read files
 * relative to a different cwd or start their own servers, so collecting the whole directory to
 * run one spec fails at collection time. This config collects exactly `incidents-workspace.spec.ts`
 * and nothing else.
 *
 * It also selects the installed Google Chrome rather than the Playwright-bundled Chromium: the
 * bundled binary was not downloaded in this environment, and a suite that describes what a real
 * browser painted has to run in a real browser rather than be silently skipped.
 *
 *   OPSWEAVE_URL=http://127.0.0.1:18291 \
 *   OPSWEAVE_ADMIN_EMAIL=... OPSWEAVE_ADMIN_PASSWORD=... \
 *   node node_modules/@playwright/test/cli.js test --config tests/ui/incidents-workspace.config.ts
 *
 * The kernel it points at must be running against a THROW-AWAY database: the suite signs in as a
 * real admin and reads real incidents.
 */
const baseURL = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';

export default defineConfig({
  testDir: '.',
  testMatch: 'incidents-workspace.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    // The spec pins its own locale and theme through localStorage, per test.
    storageState: { cookies: [], origins: [] },
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
});
