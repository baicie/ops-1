import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * G12 Phase B - the evidence content viewer, in a real browser against the real kernel.
 *
 * What only a browser can prove, and therefore what this spec is for:
 *
 *   1. untrusted payloads are INERT. A <script> tag, an img onerror and an svg onload are
 *      submitted as evidence, and the spec asserts they are visible verbatim as text, that no
 *      element was constructed from them, and that window.__xss was never set. A unit test
 *      cannot make that claim: escaping is a browser behaviour.
 *   2. a direct visit to the content URL cannot execute anything either - the kernel serves the
 *      bytes as text/plain with nosniff and a sandbox CSP, so navigations stays text.
 *   3. the digest the kernel sent is recomputed FROM THE BROWSER over the text on screen, and the
 *      page says so. The expected value here is computed independently in Node, so a kernel that
 *      hashed something else fails.
 *   4. a Legacy reference is labelled as one, and its panel says there is nothing to show instead
 *      of opening a request that would 404.
 *
 * Fixtures are created through the public API, so this writes to the kernel it points at and must
 * run against a throw-away database.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const RUN = Date.now().toString(36).slice(-6);

const XSS_PAYLOAD = [
  '2026-10-31T05:00:00Z ERROR upstream=db-1 reason="connection reset"',
  '<script>window.__xss = 1;</script>',
  '<img src=x onerror="window.__xss = 2">',
  '<svg onload="window.__xss = 3"></svg>',
  '</pre><script>window.__xss = 4;</script>',
  'tail line after the payloads',
].join('\n');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.click('[data-testid="login-submit"]');
  await expect(page).not.toHaveURL(/\/login/);
}

async function csrfFrom(page: Page): Promise<string> {
  const response = await page.request.post('/api/v1/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(response.ok(), 'admin login for fixture setup').toBeTruthy();
  const body = await response.json();
  return body.csrfToken as string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('the evidence content viewer shows stored bytes as inert text and labels legacy references', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const csrf = await csrfFrom(page);

  // ---------------------------------------------------------------------------------------
  // Fixtures: one incident with a stored-content row, an HTML/script payload row, and a
  // Legacy reference that has no bytes at all.
  // ---------------------------------------------------------------------------------------
  const incidentResponse = await page.request.post('/api/v1/incidents', {
    headers: { 'x-csrf-token': csrf },
    data: {
      title: 'g12b viewer ' + RUN,
      severity: 'MAJOR',
      startedAt: new Date().toISOString(),
      relatedEntity: 'host:g12b-viewer',
    },
  });
  expect(incidentResponse.status(), await incidentResponse.text()).toBe(201);
  const incident = await incidentResponse.json();

  const storedResponse = await page.request.post('/api/v1/incidents/' + incident.id + '/evidence', {
    headers: { 'x-csrf-token': csrf },
    data: {
      kind: 'LOG_EXCERPT',
      source: 'operator:playwright',
      collectedAt: new Date().toISOString(),
      content: { contentType: 'text/plain', body: XSS_PAYLOAD },
    },
  });
  expect(storedResponse.status(), await storedResponse.text()).toBe(201);
  const stored = await storedResponse.json();

  const legacyResponse = await page.request.post('/api/v1/incidents/' + incident.id + '/evidence', {
    headers: { 'x-csrf-token': csrf },
    data: {
      kind: 'QUERY_RESULT',
      source: 'operator:playwright-legacy',
      collectedAt: new Date().toISOString(),
      contentRef: 's3://logs/2026/10/31/legacy.log#L10-20',
    },
  });
  expect(legacyResponse.status(), await legacyResponse.text()).toBe(201);
  const legacy = await legacyResponse.json();

  // The kernel's own digest of what it stored, checked against an independent computation here.
  const expectedDigest = sha256(XSS_PAYLOAD);
  expect(stored.contentStatus).toBe('STORED');
  expect(stored.contentSha256).toBe(expectedDigest);
  expect(legacy.contentStatus).toBe('LEGACY_REFERENCE');
  expect(legacy.contentSha256).toBeNull();

  // ---------------------------------------------------------------------------------------
  // The incident page: both rows state where their bytes are.
  // ---------------------------------------------------------------------------------------
  await page.goto('/app/incidents/' + incident.id);
  const evidencePanel = page.locator('[data-testid="incident-evidence"]');
  await expect(evidencePanel).toBeVisible();

  const storedStatus = evidencePanel.locator('[data-evidence-row="' + stored.id + '"] [data-testid="evidence-content-status"]');
  await expect(storedStatus).toHaveAttribute('data-content-status', 'STORED');
  await expect(storedStatus).toHaveText('Stored bytes');

  const legacyStatus = evidencePanel.locator('[data-evidence-row="' + legacy.id + '"] [data-testid="evidence-content-status"]');
  await expect(legacyStatus).toHaveAttribute('data-content-status', 'LEGACY_REFERENCE');
  await expect(legacyStatus).toHaveText('Legacy / Unverified Reference');

  // ---------------------------------------------------------------------------------------
  // Open the stored row: the bytes render as text, the digest is verified in the browser.
  // ---------------------------------------------------------------------------------------
  await evidencePanel.locator('[data-testid="evidence-open"][data-evidence-id="' + stored.id + '"]').click();
  const viewer = page.locator('[data-testid="evidence-content-panel"]');
  await expect(viewer).toHaveAttribute('data-content-state', 'ready', { timeout: 15_000 });
  await expect(viewer).toHaveAttribute('data-content-mode', 'stored');
  await expect(viewer).toHaveAttribute('data-content-type', 'text/plain');

  // The digest came from the kernel and was recomputed here; a kernel that hashed anything else
  // would fail this line rather than passing a header through.
  await expect(viewer).toHaveAttribute('data-digest-verdict', 'match');
  const digestLine = viewer.locator('[data-testid="evidence-content-digest"]');
  await expect(digestLine).toHaveAttribute('data-server-digest', expectedDigest);
  await expect(digestLine).toContainText(expectedDigest);
  await expect(viewer.locator('[data-testid="evidence-digest-verdict"]')).toHaveText('Digest verified in this browser');

  // Verbatim, as text.
  const content = viewer.locator('[data-testid="evidence-content-text"]');
  await expect(content).toHaveText(XSS_PAYLOAD);
  await expect(viewer.locator('[data-testid="evidence-content-bytes"]')).toHaveText(String(Buffer.byteLength(XSS_PAYLOAD, 'utf8')));

  // ---------------------------------------------------------------------------------------
  // XSS: nothing was constructed and nothing executed.
  // ---------------------------------------------------------------------------------------
  // Scoped to the content element on purpose: the panel around it legitimately contains icons
  // (inline SVG), so a viewer-wide count would measure the design system instead of the payload.
  expect(await content.locator('script, img, svg, iframe').count(), 'nothing was parsed into an element').toBe(0);
  expect(await page.locator('script:has-text("__xss")').count(), 'no injected script reached the document').toBe(0);
  const xss = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss);
  expect(xss, 'window.__xss must stay unset: no payload handler ran').toBeUndefined();
  // The <pre> holds exactly one text node: it is a text child, not parsed markup.
  const childElements = await content.evaluate((node) => node.children.length);
  expect(childElements, 'the content element has no element children').toBe(0);
  const nodeType = await content.evaluate((node) => node.firstChild?.nodeType);
  expect(nodeType, 'the content is a TEXT node (3)').toBe(3);

  // ---------------------------------------------------------------------------------------
  // A direct visit to the content URL is inert too: text/plain, nosniff, sandbox CSP.
  // ---------------------------------------------------------------------------------------
  const contentUrl = '/api/v1/incidents/' + incident.id + '/evidence/' + stored.id + '/content';
  const raw = await page.request.get(contentUrl);
  expect(raw.status()).toBe(200);
  expect(raw.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(raw.headers()['x-content-type-options']).toBe('nosniff');
  expect(raw.headers()['content-security-policy']).toBe("default-src 'none'; sandbox");
  expect(raw.headers()['x-evidence-digest']).toBe(expectedDigest);
  // The header is recomputed over the body that was actually sent.
  expect(sha256(await raw.text())).toBe(expectedDigest);

  const navigation = await page.goto(contentUrl);
  expect(navigation?.headers()['content-type']).toContain('text/plain');
  expect(await page.evaluate(() => document.contentType)).toBe('text/plain');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('script, img, svg').count(), 'a text/plain document is not HTML').toBe(0);
  expect(await page.locator('body *').count(), 'the text document has no parsed elements').toBeLessThanOrEqual(1);

  // ---------------------------------------------------------------------------------------
  // Screenshots for the 1440 / 390 and light / dark review the rules ask for.
  // ---------------------------------------------------------------------------------------
  await page.goto('/app/incidents/' + incident.id);
  await page.locator('[data-testid="evidence-open"][data-evidence-id="' + stored.id + '"]').click();
  await expect(viewer).toHaveAttribute('data-content-state', 'ready');
  for (const view of [
    { name: 'r1440-light', width: 1440, height: 900, scheme: 'light' as const },
    { name: 'r1024-light', width: 1024, height: 800, scheme: 'light' as const },
    { name: 'r390-light', width: 390, height: 844, scheme: 'light' as const },
    { name: 'r1440-dark', width: 1440, height: 900, scheme: 'dark' as const },
  ]) {
    await page.setViewportSize({ width: view.width, height: view.height });
    await page.emulateMedia({ colorScheme: view.scheme });
    await expect(viewer).toBeVisible();
    // Scrolled into view first: a 390-wide screenshot of the top of a long page shows the
    // incident header and proves nothing about the panel being reviewed.
    await viewer.scrollIntoViewIfNeeded();
    await content.scrollIntoViewIfNeeded();
    // Relative to this spec's directory (tests/ui), so a run from anywhere lands in the
    // repository artifacts directory rather than next to the spec.
    await page.screenshot({ path: '../../artifacts/g12b/' + view.name + '.png', fullPage: false });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------------------------------------
  // The Legacy row: labelled, and its panel does not pretend it can fetch anything.
  // ---------------------------------------------------------------------------------------
  await page.locator('[data-testid="evidence-open"][data-evidence-id="' + legacy.id + '"]').click();
  await expect(viewer).toHaveAttribute('data-content-mode', 'legacy');
  await expect(viewer).toHaveAttribute('data-content-state', 'unavailable');
  await expect(viewer.locator('[data-testid="evidence-content-notice"]')).toContainText('No content is stored for this row');
  await expect(viewer.locator('[data-testid="evidence-content-text"]')).toHaveCount(0);
  await expect(viewer).not.toHaveAttribute('data-digest-verdict', 'match');

  // Closing the panel removes it rather than leaving a stale one behind.
  await viewer.locator('[data-testid="evidence-content-close"]').click();
  await expect(page.locator('[data-testid="evidence-content-panel"]')).toHaveCount(0);
});
