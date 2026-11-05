import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

async function stubWorld(page: Page, options: { collectOutcome?: string; sourcesStatus?: number; delaySaveMs?: number } = {}) {
  let saved = false;
  let postedEvidence: unknown = null;
  let postedAttestation: unknown = null;
  await page.route(`**/api/v1/incidents/${INCIDENT_ID}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(incident),
  }));
  await page.route(`**/api/v1/incidents/${INCIDENT_ID}/evidence`, async (route) => {
    if (route.request().method() === 'POST') {
      postedEvidence = route.request().postDataJSON();
      saved = true;
      if (options.delaySaveMs) await new Promise((resolve) => setTimeout(resolve, options.delaySaveMs));
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
    body: JSON.stringify({
      outcome: 'OK',
      items: [
        { hostId: '10084', name: 'web-01', available: 'AVAILABLE' },
        { hostId: '10085', name: 'db-01', available: 'UNKNOWN' },
      ],
      clamped: false,
      truncated: 0,
    }),
  }));
  await page.route(`**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources/${SOURCE_ID}/items?hostId=*`, (route) => {
    const hostId = new URL(route.request().url()).searchParams.get('hostId');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'OK',
        items: [{ itemId: hostId === '10085' ? '10402' : '10401', key: 'system.cpu.util', name: 'CPU utilization', unit: '%', valueType: 'FLOAT' }],
        clamped: false,
        truncated: 0,
      }),
    });
  });
  await page.route(`**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/sources/${SOURCE_ID}/collect`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(collection(options.collectOutcome ?? 'OK')),
  }));
  await page.route('**/api/v1/gateway/opsweave.zabbix-source/api/zabbix-source/collections/*/attestation', (route) => {
    postedAttestation = route.request().postDataJSON();
    return route.fulfill({
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
  });
  });
  return { posted: () => postedEvidence, attested: () => postedAttestation };
}

async function openDialog(page: Page) {
  await login(page);
  await page.goto(`/app/incidents/${INCIDENT_ID}`);
  await expect(page.getByTestId('incident-evidence')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { __beforeDoc: number }).__beforeDoc = document.documentElement.scrollWidth; });
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
  expect(world.posted(), 'collect must not write evidence').toBeNull();
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
  const attestationRequest = world.attested() as { incidentId: string; kind: string };
  expect(attestationRequest.incidentId).toBe(INCIDENT_ID);
  expect(attestationRequest.kind).toBe('METRIC_SNAPSHOT');
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

const MATRIX = [
  { width: 1440, height: 900, theme: 'light', locale: 'en' },
  { width: 1440, height: 900, theme: 'dark', locale: 'zh-CN' },
  { width: 1024, height: 900, theme: 'light', locale: 'zh-CN' },
  { width: 1024, height: 900, theme: 'dark', locale: 'en' },
  { width: 768, height: 900, theme: 'dark', locale: 'en' },
  { width: 390, height: 844, theme: 'light', locale: 'zh-CN' },
  { width: 390, height: 844, theme: 'dark', locale: 'en' },
  { width: 390, height: 844, theme: 'light', locale: 'en' },
];

for (const combo of MATRIX) {
  test(`collect dialog at ${combo.width}/${combo.theme}/${combo.locale}`, async ({ page }) => {
    await page.setViewportSize({ width: combo.width, height: combo.height });
    await page.addInitScript(([theme, locale]) => {
      localStorage.setItem('opsweave-theme', theme as string);
      localStorage.setItem('opsweave-locale', locale as string);
    }, [combo.theme, combo.locale]);
    await stubWorld(page);
    await openDialog(page);
    await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
    await page.getByTestId('incident-collect-host').selectOption('10084');
    await page.getByTestId('incident-collect-item-10401').check();
    await page.getByTestId('incident-collect-run').click();
    await expect(page.getByTestId('incident-collect-result')).toBeVisible();
    const metrics = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      iw: window.innerWidth,
      wide: [...document.querySelectorAll('body *')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .filter((el) => ![...el.children].some((child) => child.scrollWidth > child.clientWidth + 1))
        .slice(0, 12)
        .map((el) => `${el.tagName}.${(el as HTMLElement).className} sw=${el.scrollWidth} cw=${el.clientWidth} text=${(el.textContent || '').slice(0, 60)}`),
    }));
    const overflow = metrics.doc > metrics.iw;
    const offenders = overflow
      ? await page.evaluate(() => [...document.querySelectorAll('body *')]
          .map((el) => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.right > window.innerWidth + 1)
          .slice(0, 8)
          .map(({ el, rect }) => `${el.tagName}.${(el as HTMLElement).className} right=${Math.round(rect.right)} text=${(el.textContent || '').slice(0, 40)}`))
      : [];
    const beforeDoc = await page.evaluate(() => (window as unknown as { __beforeDoc: number }).__beforeDoc);
    expect(overflow, `the dialog must not scroll sideways: before=${beforeDoc} ${JSON.stringify(metrics)} ${offenders.join(' | ')}`).toBe(false);
    const out = path.resolve('../../artifacts/ui/g13-collect');
    fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, `collect-${combo.width}-${combo.theme}-${combo.locale}.png`), fullPage: true });
  });
}

test('changing the host drops the previous result instead of leaving it saveable', async ({ page }) => {
  await stubWorld(page);
  await openDialog(page);
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await page.getByTestId('incident-collect-item-10401').check();
  await page.getByTestId('incident-collect-run').click();
  await expect(page.getByTestId('incident-collect-result')).toBeVisible();

  await page.getByTestId('incident-collect-host').selectOption('10085');
  await expect(page.getByTestId('incident-collect-result')).toHaveCount(0);
  await expect(page.getByTestId('incident-collect-save')).toBeDisabled();
});

test('a save in flight cannot be dismissed, and reports saved only after the write', async ({ page }) => {
  await stubWorld(page, { delaySaveMs: 800 });
  await openDialog(page);
  await page.getByTestId('incident-collect-source').selectOption(SOURCE_ID);
  await page.getByTestId('incident-collect-host').selectOption('10084');
  await page.getByTestId('incident-collect-item-10401').check();
  await page.getByTestId('incident-collect-run').click();
  await page.getByTestId('incident-collect-save').click();
  await expect(page.getByTestId('incident-collect-cancel')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('incident-collect')).toBeVisible();
  await expect(page.getByTestId('incident-collect-saved')).toBeVisible();
});
