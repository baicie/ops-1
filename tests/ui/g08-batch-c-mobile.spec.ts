import { expect, type Page, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * G08 batch C, the 390-wide half: the two acceptance items g08-batch-c.spec.ts (pinned to 1440)
 * cannot reach.
 *
 * What is asserted here and nowhere else:
 *   - gap 2: the mobile Studio node list prints an execution index the *topology* derives. When
 *     the topology is not VALID there is no order to print, so the chip is the UNKNOWN token
 *     (.flow-index-token) - never a fabricated '?' and never a guessed position;
 *   - gap 4: the log stream at 390 - the toolbar / terminal / footer this batch reshaped - has no
 *     horizontal overflow, and its toolbar controls stay inside their own bar.
 *
 * Every test carries its own control, so a green run cannot mean "the assertion measured
 * nothing": the VALID and non-VALID node lists are each other's counter-example, and the overflow
 * test re-runs its own measurement on a deliberately broken bar.
 *
 * States the running stack cannot produce on demand come from rewriting the response the page
 * already consumes - the technique g08-batch-c.spec.ts and admin-polish.spec.ts use. No mock
 * branch enters the application and nothing in the product is touched.
 *
 * Selectors are stable class hooks; localized copy is never a selector.
 */

const ADMIN_EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@opsweave.local';
const ADMIN_PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'OpsWeave!2026';
const OUT = path.resolve('../../artifacts/ui/g08-batch-c-mobile');
const PIPELINE_ID = process.env.OPSWEAVE_PIPELINE_ID || 'host-metrics-pipeline';
const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'dev.opsweave.hello';
const INSTANCE_ID = 'instance-batch-c-mobile';

const SOURCE_NODE = {
  nodeId: 'source',
  type: 'builtin.source.http_json',
  typeVersion: 1,
  config: { endpoint: 'https://metrics.invalid/api', timeoutSeconds: 17 },
  inputs: [],
  outputs: [{ name: 'out', dataType: 'records' }],
};

const SINK_NODE = {
  nodeId: 'sink',
  type: 'builtin.sink.dataset',
  typeVersion: 1,
  config: { datasetId: 'host_metrics' },
  inputs: [{ name: 'in', dataType: 'records', required: true }],
  outputs: [],
};

const SOURCE_TO_SINK = { fromNode: 'source', fromPort: 'out', toNode: 'sink', toPort: 'in', dataType: 'records' };

/** One entry node, one edge, one sink: the topology resolves and the order is derivable. */
const LINEAR_DEFINITION = {
  schemaVersion: '1',
  pipelineId: PIPELINE_ID,
  name: 'Host metrics pipeline',
  revision: 1,
  status: 'PUBLISHED',
  nodes: [SOURCE_NODE, SINK_NODE],
  edges: [SOURCE_TO_SINK],
  createdAt: '2026-10-01T00:00:00Z',
  digest: 'sha256:' + 'a'.repeat(64),
};

/**
 * The same revision plus a second entry node nothing consumes: two leaf sources, so
 * getPipelineExecutionOrder reports MULTIPLE_SOURCES and the execution order is not derivable.
 * The node list still renders - what it must stop doing is inventing an index.
 */
const NON_LINEAR_DEFINITION = {
  ...LINEAR_DEFINITION,
  nodes: [
    SOURCE_NODE,
    SINK_NODE,
    {
      nodeId: 'source-alt',
      type: 'builtin.source.http_json',
      typeVersion: 1,
      config: { endpoint: 'https://alt.invalid/api', timeoutSeconds: 5 },
      inputs: [],
      outputs: [{ name: 'out', dataType: 'records' }],
    },
  ],
};
const NON_LINEAR_NODE_COUNT = NON_LINEAR_DEFINITION.nodes.length;

/** The GET the editor already performs, carrying the definition under test. */
function pipelineDetail(definition: typeof LINEAR_DEFINITION) {
  return {
    pipelineId: PIPELINE_ID,
    name: definition.name,
    latestRevision: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    latest: {
      pipelineId: PIPELINE_ID,
      revision: 1,
      digest: definition.digest,
      status: 'PUBLISHED',
      publishedAt: '2026-10-01T00:00:00Z',
      definition,
      plan: {},
    },
    revisions: [{ revision: 1, digest: definition.digest, status: 'PUBLISHED', publishedAt: '2026-10-01T00:00:00Z' }],
  };
}

async function stubPipeline(page: Page, definition: typeof LINEAR_DEFINITION) {
  await page.route('**/api/v1/pipelines/' + PIPELINE_ID + '/drafts', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([]),
  }));
  await page.route('**/api/v1/pipelines/' + PIPELINE_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(pipelineDetail(definition)),
  }));
}

/**
 * The kernel this stack runs is not this working tree, so its /auth/me carries no console
 * declaration and the admin shell answers "access denied" to every route. The declaration is
 * stubbed onto the real response: cookie, CSRF token and session stay the live ones.
 */
const ADMIN_GRANT = { allowedSurfaces: ['workspace', 'admin'], capabilities: ['platform:access', 'workspace:access'] };

async function login(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem('opsweave-theme', 'light'));
  await page.route('**/api/v1/auth/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.access = ADMIN_GRANT;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/login');
  await page.fill('input[type=email]', ADMIN_EMAIL);
  await page.fill('input[type=password]', ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/**
 * The node list is the mobile half of the canvas, switched by the two-button toggle the page
 * renders at this width. The toggle is addressed by position, not by its localized label.
 */
async function openMobileNodeList(page: Page) {
  const toggle = page.locator('.mobile-view-toggle button');
  await expect(toggle, 'the mobile view toggle exists at 390').toHaveCount(2);
  await toggle.first().click();
  await expect(page.locator('.mobile-node-list'), 'the node list replaces the canvas').toHaveCount(1);
}

/** Both instance responses the log page already consumes: the detail row and the live stream. */
async function stubInstanceStream(page: Page) {
  const now = new Date().toISOString();
  await page.route('**/api/v1/instances/' + INSTANCE_ID, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      id: INSTANCE_ID, deploymentId: 'deployment-batch-c', nodeId: 'node-batch-c', nodeName: 'node-batch-c',
      nodeStatus: 'READY', nodeLastSeenAt: now, slot: 0, state: 'RUNNING', observedAt: now,
      containerId: null, imageDigest: null, restartCount: 0, lastError: null,
      pluginId: PLUGIN_ID, version: '1.0.0', deploymentStatus: 'READY', streamId: 'stream-batch-c-mobile',
    }),
  }));
  await page.route('**/api/v1/instances/' + INSTANCE_ID + '/logs/live*', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: [
      'event: log',
      'id: 1',
      'data: ' + JSON.stringify({
        eventId: 'event-mobile-1', streamId: 'stream-batch-c-mobile', streamEpoch: 1, sequence: 1,
        occurredAt: now, observedAt: now, nodeId: 'node-batch-c', instanceId: INSTANCE_ID,
        channel: 'stdout', level: 'INFO',
        message: 'a 390-wide acceptance line that is long enough to need wrapping inside the terminal grid',
        truncated: false,
      }),
      '',
      '',
    ].join('\n'),
  }));
}

test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(() => { fs.mkdirSync(OUT, { recursive: true }); });

// --- gap 2: the node list index is derived, or it is UNKNOWN -------------------------------

/**
 * The control for the assertion below. The same page, the same node list, the same chip element:
 * a topology that resolves prints the position, so the UNKNOWN token in the non-VALID case is the
 * topology talking, not a blanket render that never prints an index at all.
 */
test('gap 2 control: a VALID topology prints the real execution index at 390', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubPipeline(page, LINEAR_DEFINITION);
  await login(page);
  await page.goto('/admin/pipelines/' + PIPELINE_ID + '/editor');
  await openMobileNodeList(page);

  const chips = page.locator('.mobile-node-list .flow-index');
  await expect(chips, 'one chip per node').toHaveCount(LINEAR_DEFINITION.nodes.length);
  await expect(page.locator('.mobile-node-list .flow-index-token'), 'a derivable order is not a token').toHaveCount(0);
  await expect(page.locator('.mobile-node-list .value-token[data-value="UNKNOWN"]'), 'no UNKNOWN chip').toHaveCount(0);
  const texts = await chips.allInnerTexts();
  console.log('[gap2 control] valid topology, chips=' + JSON.stringify(texts) + ' tokens=' + await page.locator('.mobile-node-list .flow-index-token').count());
  expect(texts, 'the chip is the position itself').toEqual(['1', '2']);
  await page.screenshot({ path: path.join(OUT, 'g08-c-mobile-node-list-valid-390-light.png'), fullPage: true });
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});

test('gap 2: a topology that is not VALID shows the UNKNOWN token, not a "?" index, at 390', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubPipeline(page, NON_LINEAR_DEFINITION);
  await login(page);
  await page.goto('/admin/pipelines/' + PIPELINE_ID + '/editor');
  await openMobileNodeList(page);

  const list = page.locator('.mobile-node-list');
  await expect(list.locator('button'), 'every node is still listed').toHaveCount(NON_LINEAR_NODE_COUNT);
  // The chip is the token, and the token is the shared UNKNOWN value token - not a text placeholder.
  const tokens = list.locator('.flow-index-token');
  await expect(tokens, 'no derivable order means every chip is a token').toHaveCount(NON_LINEAR_NODE_COUNT);
  await expect(tokens.locator('.value-token[data-value="UNKNOWN"]'), 'the token carries the shared UNKNOWN marker').toHaveCount(NON_LINEAR_NODE_COUNT);
  // Counter-check on the same list: not one chip claims a position.
  await expect(list.locator('.flow-index:not(.flow-index-token)'), 'no chip fabricates an index').toHaveCount(0);
  const text = await list.innerText();
  console.log('[gap2] non-VALID topology, nodes=' + NON_LINEAR_NODE_COUNT + ' tokenChips=' + await tokens.count() + ' numberedChips=' + await list.locator('.flow-index:not(.flow-index-token)').count() + ' chipText=' + JSON.stringify((await tokens.first().innerText()).split('\n')[0]));
  expect(text, 'the chip says UNKNOWN').toContain('UNKNOWN');
  expect(text, 'the old "?" placeholder is gone').not.toContain('?');
  await page.screenshot({ path: path.join(OUT, 'g08-c-mobile-node-list-unknown-390-light.png'), fullPage: true });
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});

// --- gap 4: the log stream at 390 ----------------------------------------------------------

type ToolbarReport = {
  pageOverflow: number;
  barOverflow: number;
  rows: number;
  outside: string[];
  overlaps: string[];
  barWidth: number;
  contentWidth: number;
};

/**
 * One measurement of the log toolbar at this width: the document overflow, the bar's own scroll
 * overflow, the number of rows its controls occupy, any control whose box leaves the bar, and any
 * pair of controls whose boxes intersect.
 */
async function toolbarReport(page: Page): Promise<ToolbarReport> {
  return page.evaluate(() => {
    const bar = document.querySelector('.log-toolbar') as HTMLElement;
    const barBox = bar.getBoundingClientRect();
    const slack = 1;
    const boxes = Array.from(bar.children).map((child) => {
      const element = child as HTMLElement;
      return { label: element.className || element.tagName, box: element.getBoundingClientRect() };
    });
    const outside = boxes
      .filter((entry) => entry.box.width > 0 && (entry.box.left < barBox.left - slack || entry.box.right > barBox.right + slack))
      .map((entry) => entry.label);
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i].box;
        const b = boxes[j].box;
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (dx > slack && dy > slack) overlaps.push(boxes[i].label + ' x ' + boxes[j].label);
      }
    }
    const rows = new Set(boxes.filter((entry) => entry.box.width > 0).map((entry) => Math.round(entry.box.top))).size;
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      barOverflow: bar.scrollWidth - bar.clientWidth,
      rows,
      outside,
      overlaps,
      barWidth: Math.round(barBox.width),
      contentWidth: bar.clientWidth,
    };
  });
}

test('gap 4: the log stream at 390 keeps its toolbar inside the bar with no horizontal overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubInstanceStream(page);
  await login(page);
  await page.goto('/admin/instances/' + INSTANCE_ID + '/logs');

  // The shared header still owns the page at this width; the stream keeps its own layout.
  await expect(page.getByTestId('page-header'), 'one shared page header').toHaveCount(1);
  await expect(page.locator('.page-header'), 'one header container').toHaveCount(1);
  await expect(page.locator('h1'), 'one h1 on the page').toHaveCount(1);
  await expect(page.locator('.log-toolbar'), 'the toolbar survives').toHaveCount(1);
  await expect(page.locator('.terminal'), 'the terminal survives').toHaveCount(1);
  await expect(page.locator('.log-footer'), 'the footer survives').toHaveCount(1);
  await expect(page.locator('.log-line').first(), 'the stream still prints lines').toBeVisible({ timeout: 20_000 });

  const report = await toolbarReport(page);
  expect(report.pageOverflow, 'no page-level horizontal overflow at 390 (bar ' + report.barWidth + 'px)').toBeLessThanOrEqual(1);
  expect(report.barOverflow, 'the toolbar does not scroll horizontally').toBeLessThanOrEqual(1);
  expect(report.outside, 'no control leaves the toolbar box').toEqual([]);
  expect(report.overlaps, 'no two controls overlap').toEqual([]);
  // Control A: at this width the controls really wrap, so "inside the bar" is not "clipped anyway".
  expect(report.rows, 'the toolbar reflows onto more than one row at 390').toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: path.join(OUT, 'g08-c-mobile-instance-logs-390-light.png'), fullPage: true });

  // Control B: the same measurement on a deliberately broken bar. Without this, a green
  // "no overflow" could just mean the measurement never looks at anything.
  const probe = await page.evaluate(() => {
    const bar = document.querySelector('.log-toolbar') as HTMLElement;
    const first = bar.children[0] as HTMLElement;
    const saved = first.getAttribute('style');
    first.style.minWidth = '900px';
    first.style.flex = 'none';
    const mutated = bar.scrollWidth - bar.clientWidth;
    if (saved === null) first.removeAttribute('style');
    else first.setAttribute('style', saved);
    return { mutated, restored: bar.scrollWidth - bar.clientWidth };
  });
  console.log('[gap4] at 390 ' + JSON.stringify(report) + ' probe=' + JSON.stringify(probe));
  expect(probe.mutated, 'the probe proves the overflow measurement is live').toBeGreaterThan(1);
  expect(probe.restored, 'and the bar measures clean again once the probe is removed').toBeLessThanOrEqual(1);
  expect(errors, 'page errors: ' + errors.join('; ')).toEqual([]);
});
