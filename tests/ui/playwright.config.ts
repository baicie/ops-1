import { defineConfig, devices } from '@playwright/test';

// The product default is Chinese, but the existing specs assert English copy. Pin the
// locale through storage state instead of depending on the default: a spec that cares
// about a specific language must say so. Override with OPSWEAVE_TEST_LOCALE.
const baseURL = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18181';
const testLocale = process.env.OPSWEAVE_TEST_LOCALE || 'en';
const pinnedLocale = {
  cookies: [],
  origins: [
    {
      origin: new URL(baseURL).origin,
      localStorage: [{ name: 'opsweave-locale', value: testLocale }],
    },
  ],
};

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    storageState: pinnedLocale,
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
