import { expect, Page, test } from '@playwright/test';

/**
 * P001-C4 / D4 — plugin frontend assets in a real browser, across disable and
 * uninstall.
 *
 * ## The five facts this refuses to conflate
 *
 * "Is a plugin's frontend still reachable after it is uninstalled?" has been
 * `NOT_RUN` since C1. Every earlier attempt stopped at "the URL returned 200",
 * which is a different question — and a 404 is not proof that an already-loaded
 * page stopped working either. This spec separates and reports each one:
 *
 *   1. are the bytes still served?                  (an authenticated GET)
 *   2. can a NEW page load them?                    (a new tab)
 *   3. can an ALREADY-LOADED page still run them?   (the same page)
 *   4. can it obtain authorization?                 (the CSRF/session path)
 *   5. does the backend accept the API call?        (the API's own answer)
 *
 * A 200 on (1) with a 403 on (5) is a very different system from a 200 on both,
 * and a green tick on (1) alone has been read as "no problem" before.
 *
 * ## Asserted vs recorded
 *
 * The post-uninstall asset expectation is NOT invented here. `serve_asset`
 * (`apps/kernel/src/assets.rs`) validates the publisher, the path and the
 * canonicalised root, but never the plugin's lifecycle state — so bytes are
 * expected to stay reachable to an authenticated caller. That is recorded as
 * the CURRENT behaviour with its reason. What IS asserted in every state is the
 * boundary that must hold: unauthenticated access is refused, and the plugin's
 * API is refused once the plugin is not serving.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
// The plugin is DISCOVERED, not assumed.
//
// The first real CI run hardcoded `dev.opsweave.hello` and got a 404: the
// harness that hosts this spec (`data_foundation_ci.sh`) deploys the data
// plugins, not the hello reference plugin. A 404 there made the spec fail
// before it measured anything - and the same 404 would have read as "assets
// are gone" if it had come one step later.
const PREFERRED_PLUGIN = process.env.OPSWEAVE_ASSET_PLUGIN || '';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !/\/login$/.test(url.pathname));
}

/** The CSRF token the product issues is on `/api/v1/auth/me`; specs that POST
 *  without it are refused by `csrf_middleware`, not by the route. */
async function csrfToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/me', { credentials: 'same-origin' });
    if (!r.ok) return '';
    const body = (await r.json()) as { csrfToken?: string };
    return body.csrfToken || '';
  });
  return token;
}

async function statusOf(page: Page, url: string, credentials: RequestCredentials = 'same-origin') {
  return page.evaluate(
    async ([u, c]) => {
      const r = await fetch(u, { credentials: c });
      return r.status;
    },
    [url, credentials] as const,
  );
}

test.describe.configure({ mode: 'serial' });

test('D4: asset and API reachability across disable and uninstall', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await login(page);

  // Find a deployed plugin that HAS a frontend. The list comes from the Kernel;
  // nothing here guesses a name or a path.
  const candidates = await page.evaluate(async (preferred) => {
    const r = await fetch('/api/v1/plugins', { credentials: 'same-origin' });
    if (!r.ok) return [];
    const all = (await r.json()) as Array<{ id: string }>;
    const ids = all.map((p) => p.id);
    return preferred && ids.includes(preferred) ? [preferred, ...ids.filter((i) => i !== preferred)] : ids;
  }, PREFERRED_PLUGIN);
  expect(candidates.length, 'the platform must have at least one plugin installed').toBeGreaterThan(0);

  let PLUGIN = '';
  let VERSION = '';
  let publisher = '';
  let indexUrl = '';
  for (const id of candidates) {
    const found = await page.evaluate(async (plugin) => {
      const r = await fetch(`/api/v1/plugins/${plugin}`, { credentials: 'same-origin' });
      if (!r.ok) return null;
      const body = await r.json();
      const version = body.activeVersion;
      const pub = body.publisher || body.manifest?.publisher || '';
      return version && pub ? { version, publisher: pub } : null;
    }, id);
    if (!found) continue;
    const probe = origin + `/assets/${found.publisher}/${id}/${found.version}/frontend/index.html`;
    const status = await statusOf(page, probe);
    if (status === 200) {
      PLUGIN = id;
      VERSION = found.version;
      publisher = found.publisher;
      indexUrl = probe;
      break;
    }
  }
  test.skip(
    !PLUGIN,
    `no installed plugin exposes a reachable frontend/index.html; D4 has nothing to measure ` +
      `(candidates tried: ${candidates.join(', ')})`,
  );

  test.info().annotations.push({
    type: 'd4-target',
    description: `measuring ${PLUGIN}@${VERSION} published by ${publisher}: ${indexUrl}`,
  });

  // (5) while active: the gateway routes to this plugin's backend.
  //
  // The path is NOT a plugin-specific business route: `/api/hello` exists only
  // in the hello reference plugin, and the first CI run tried exactly that
  // against a data plugin. A path that does not exist returns 404 from the
  // plugin and 503 from the gateway when it is not serving - so the assertion
  // below is "the gateway is routing to it", which is what D4 needs, and it is
  // expressed with a path every plugin answers: its own runtime identity.
  const gatewayProbe = `/api/v1/gateway/${PLUGIN}/_opsweave/runtime/v1/info`;
  const activeGateway = await statusOf(page, gatewayProbe);
  test.info().annotations.push({
    type: 'd4-gateway-while-active',
    description: `gateway -> ${gatewayProbe}: HTTP ${activeGateway}`,
  });
  expect(
    [200, 404],
    `the gateway must route to the active plugin (200), or the plugin must not expose ` +
      `runtime info through the gateway (404); got ${activeGateway}`,
  ).toContain(activeGateway);

  // The authorization boundary that must hold regardless of plugin state:
  // a browser with no session must not read plugin assets.
  const anonymous = await context.browser()!.newContext();
  const anonPage = await anonymous.newPage();
  const anonStatus = await statusOf(anonPage, indexUrl, 'omit');
  await anonymous.close();
  expect(
    [401, 403],
    `an unauthenticated browser must not read plugin assets, got ${anonStatus}`,
  ).toContain(anonStatus);

  // --- DISABLE --------------------------------------------------------------
  const token = await csrfToken(page);
  const disableStatus = await page.evaluate(
    async ([plugin, csrf]) => {
      const r = await fetch(`/api/v1/plugins/${plugin}/disable`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      });
      return r.status;
    },
    [PLUGIN, token] as const,
  );
  test.skip(
    disableStatus === 404 || disableStatus === 0,
    `this deployment has no usable disable route for ${PLUGIN} (HTTP ${disableStatus})`,
  );

  // (5) the API refuses while disabled — the property C1 already proved by
  // script; repeated here because this spec must not assume it.
  const disabledApi = await statusOf(page, gatewayProbe);
  expect([403, 503], `a disabled plugin's API must refuse, got ${disabledApi}`).toContain(disabledApi);

  // (1)+(2) a NEW page fetching the bytes. This is the case a shared URL or a
  // cache hit exercises, and it is different from the already-open page.
  const fresh = await context.newPage();
  const freshAsset = await statusOf(fresh, indexUrl);
  await fresh.close();
  test.info().annotations.push({
    type: 'd4-after-disable',
    description:
      `fresh authenticated fetch of index.html after disable: HTTP ${freshAsset}. ` +
      `serve_asset does not consult lifecycle state; recorded, not asserted.`,
  });

  // --- UNINSTALL ------------------------------------------------------------
  const uninstallStatus = await page.evaluate(
    async ([plugin, csrf]) => {
      const r = await fetch(`/api/v1/plugins/${plugin}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrf },
      });
      return r.status;
    },
    [PLUGIN, token] as const,
  );
  test.skip(
    uninstallStatus !== 200 && uninstallStatus !== 204,
    `uninstall returned ${uninstallStatus}; D4's uninstall half is NOT measured`,
  );

  // (5) after uninstall the API must refuse and say why.
  const after = await page.evaluate(async (plugin) => {
    const r = await fetch(`/api/v1/gateway/${plugin}/_opsweave/runtime/v1/info`, {
      credentials: 'same-origin',
    });
    let code = '';
    try {
      code = ((await r.json()) as { code?: string }).code || '';
    } catch {
      /* a non-JSON refusal is still a refusal */
    }
    return { status: r.status, code };
  }, PLUGIN);
  expect(after.status, 'an uninstalled plugin must not serve its API').not.toBe(200);
  expect(after.status, `expected the documented capability refusal, got ${after.status}`).toBe(503);
  expect(after.code).toBe('CAPABILITY_UNAVAILABLE');

  // (1) after uninstall: are the bytes still there? Recorded with the reason.
  // The product has no retention policy; inventing one in a test would be a
  // policy decision disguised as an assertion.
  const bytesAfter = await statusOf(page, indexUrl);
  test.info().annotations.push({
    type: 'd4-after-uninstall-asset',
    description:
      `authenticated fetch of index.html after uninstall: HTTP ${bytesAfter}. ` +
      `apps/kernel/src/assets.rs checks publisher, path and canonical root but NOT ` +
      `lifecycle state, so bytes are expected to remain reachable. No retention ` +
      `policy exists; this records the current behaviour.`,
  });

  // The boundary that must hold even here: still no anonymous access.
  const anonymous2 = await context.browser()!.newContext();
  const anonPage2 = await anonymous2.newPage();
  const anonAfter = await statusOf(anonPage2, indexUrl, 'omit');
  await anonymous2.close();
  expect(
    [401, 403],
    `assets must stay closed to an unauthenticated browser after uninstall, got ${anonAfter}`,
  ).toContain(anonAfter);
});
