import crypto from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { login } from './support/workbench-fixtures';

/**
 * G13-A: the Incident evidence panel can collect real telemetry and save it.
 *
 * The plugin and Kernel are stubbed here, deliberately: this spec proves the UI
 * contract - that collect and save are separate steps, that the bytes the plugin
 * signs are the bytes the UI posts, and that a TIMEOUT is never offered as
 * saveable evidence. The real plugin -> Kernel path is the golden-path harness's
 * job; neither replaces the other.
 */

const INCIDENT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLECTED_AT = '2026-11-06T09:59:00Z';
const CONTENT_BODY = '{"clamped":[],"outcome":"OK","requestedItems":1,"series":[{"itemId":"10401","samples":[{"occurredAt":"2026-11-06T09:30:00Z","value":17.5}],"unit":"%"}],"sourceId":"22222222-2222-4222-8222-222222222222"}';
const CONTENT_REF = 'sha256:' + crypto.createHash('sha256').update(CONTENT_BODY, 'utf8').digest('hex');

const incident = {
  id: INCIDENT_ID,
  title: 'db-1 connection failures',
  severity: 'HIGH',
  status: 'OPEN',
  source: 'zabbix:db-1',
  nativeId: 'INC-1',
  relatedEntity: 'db-1',
  startedAt: '2026-11-06T09:00:00Z',
  updatedAt: '2026-11-06T09:30:00Z',
  owner: '11111111-1111-4111-8111-111111111111',
  ownerAssignedAt: '2026-11-06T09:00:00Z',
  revision: 1,
  closedAt: null,
  closedBy: null,
  closureNote: null,
  evidenceRefs: [],
  humanVerdict: null,
};

function collection(outcome = 'OK') {
  return {
    collectionId: '3c7b1a90-5d42-4e18-8f6a-1d9e0b2c4f55',
    sourceId: SOURCE_ID,
    outcome,
    requestedItems: 1,
    answeredItems: outcome === 'OK' ? 1 : 0,
    clamped: [],
    series: outcome === 'OK'
      ? [{ itemId: '10401', outcome: 'OK', samples: [{ occurredAt: '2026-11-06T09:30:00Z', value: 17.5 }] }]
      : [],
    observedAt: COLLECTED_AT,
    contentRef: CONTENT_REF,
  };
}

async function stubWorld(page: Page, options: { collectOutcome?: string; sourcesStatus?: number } = {}) {
  let saved = false;
  let postedEvidence: unknown = null;
  await page.route(`**/api/v1/incidents/${INCIDENT_ID}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(incident),
  }));
  await page.route(`**/api/v1/incidents/${INCIDENT_ID}/evidence`, (route) => {
    if (route.request().method() === 'POST') {
      postedEvidence = route.request().postDataJSON();
      saved = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '99999999-9999-4999-8999-999999999999' }) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: saved
          ? [{
              id: '99999999-9999-4999-8999-999999999999',
              kind: 'METRIC_SNAPSHOT',
              source: `zabbix:${SOURCE_ID}`,
              collectedAt: COLLECTED_AT,
              contentRef: CONTENT_REF,
              claimedTrust: 'OPERATOR_ASSERTED',
              verifiedTrust: 'SOURCE_ATTESTED',
              verificationMethod: 'SOURCE_ADAPTER',
              verifierIdentity: 'zabbix-main',
              contentStatus: 'STORED',
              afterVerdict: false,
            }]
          : [],
      }),
    });
  });
  await page.route('**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources', (route: Route) => {
    if (options.sourcesStatus && options.sourcesStatus !== 200) {
      return route.fulfill({ status: options.sourcesStatus, contentType: 'application/json', body: JSON.stringify({ code: 'FORBIDDEN', message: 'no' }) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [{ sourceId: SOURCE_ID, workspaceId: WORKSPACE_ID, name: 'zabbix-main', endpoint: 'https://zabbix.invalid', status: 'READY' }],
      }),
    });
  });
  await page.route(`**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources/${SOURCE_ID}/hosts`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ outcome: 'OK', items: [{ hostId: '10084', name: 'web-01', available: 'AVAILABLE' }], clamped: false, truncated: 0 }),
  }));
  await page.route(`**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources/${SOURCE_ID}/items?hostId=10084`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ outcome: 'OK', items: [{ itemId: '10401', key: 'system.cpu.util', name: 'CPU utilization', unit: '%', valueType: 'FLOAT' }], clamped: false, truncated: 0 }),
  }));
  await page.route(`**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources/${SOURCE_ID}/collect`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(collection(options.collectOutcome ?? 'OK')),
  }));
  await page.route('**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/collections/*/attestation', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      evidence: {
        kind: 'METRIC_SNAPSHOT',
        source: `zabbix:${SOURCE_ID}`,
        collectedAt: COLLECTED_AT,
        contentRef: CONTENT_REF,
        content: { contentType: 'application/json', body: CONTENT_BODY },
        attestation: { adapterId: 'zabbix-main', issuedAt: '2026-11-06T10:00:00Z', signature: 'f'.repeat(43) },
      },
      outcome: 'OK',
    }),
  }));
  return { posted: () => postedEvidence };
}

async function openDialog(page: Page) {
  await login(page);
  await page.goto(`/app/incidents/${INCIDENT_ID}`);
  await expect(page.getByTestId('incident-evidence')).toBeVisible();
  await page.getByTestId('incident-collect-open').click();
  await expect(page.getByTestId('incident-collect')).toBeVisible();
}

test('collect and save are separate steps, and the posted bytes are the signed bytes', async ({ page }) => {
  const world = await stubWorld(page);
  await openDialog(page);

  await expect(page.getByTestId('incident-collect')).toHaveAttribute('data-collect-state', 'initial');
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await page.getByTestId('incident-collect-item-10401').check();

  // Nothing is saved by collecting.
  await page.getByTestId('incident-collect-run').click();
  await expect(page.getByTestId('incident-collect-result')).toHaveAttribute('data-outcome', 'OK');
  await expect(page.getByTestId('incident-collect-content-ref')).toHaveText(CONTENT_REF);

  await page.getByTestId('incident-collect-save').click();
  await expect(page.getByTestId('incident-collect-saved')).toBeVisible();

  const posted = world.posted() as {
    content: { contentType: string; body: string };
    contentRef: string;
    attestation: { signature: string };
    kind: string;
  };
  expect(posted.kind).toBe('METRIC_SNAPSHOT');
  expect(posted.content.contentType).toBe('application/json');
  expect(posted.content.body).toBe(CONTENT_BODY);
  expect('sha256:' + crypto.createHash('sha256').update(posted.content.body, 'utf8').digest('hex')).toBe(posted.contentRef);
  expect(posted.attestation.signature).toHaveLength(43);

  // The re-read after save is what puts the row on the page.
  await expect(page.locator('[data-evidence-row="99999999-9999-4999-8999-999999999999"]')).toBeVisible();
});

test('a TIMEOUT collection is displayed as TIMEOUT and cannot be saved', async ({ page }) => {
  await stubWorld(page, { collectOutcome: 'TIMEOUT' });
  await openDialog(page);
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await page.getByTestId('incident-collect-item-10401').check();
  await page.getByTestId('incident-collect-run').click();
  await expect(page.getByTestId('incident-collect')).toHaveAttribute('data-collect-state', 'timeout');
  await expect(page.getByTestId('incident-collect-timeout')).toBeVisible();
  await expect(page.getByTestId('incident-collect-save')).toBeDisabled();
});

test('a forbidden source list is a permission wall, not an empty list', async ({ page }) => {
  await stubWorld(page, { sourcesStatus: 403 });
  await openDialog(page);
  await expect(page.getByTestId('incident-collect')).toHaveAttribute('data-collect-state', 'forbidden');
  await expect(page.getByTestId('incident-collect-forbidden')).toBeVisible();
  await expect(page.getByTestId('incident-collect-empty')).toHaveCount(0);
});

test('a phone can open, collect and save from the evidence panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubWorld(page);
  await openDialog(page);
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await page.getByTestId('incident-collect-item-10401').check();
  await page.getByTestId('incident-collect-run').click();
  await expect(page.getByTestId('incident-collect-save')).toBeVisible();
  await page.getByTestId('incident-collect-save').click();
  await expect(page.getByTestId('incident-collect-saved')).toBeVisible();
});
