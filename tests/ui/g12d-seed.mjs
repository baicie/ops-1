#!/usr/bin/env node
/**
 * G12 D - fixtures for the Investigation Workspace visual acceptance.
 *
 * Every row here is created through the public API against a throw-away kernel, so the numbers a
 * screenshot shows are the numbers the Kernel returns. Nothing is stubbed at the network layer and
 * no product copy is edited. Closed enum sets come from the Kernel's own 400 responses:
 * severity {CRITICAL,MAJOR,MINOR,WARNING}, source {MANUAL,API},
 * kind {METRIC_SNAPSHOT,LOG_EXCERPT,QUERY_RESULT,OPERATOR_NOTE}, trust {OPERATOR_ASSERTED,UNVERIFIED}.
 *
 *   node tests/ui/g12d-seed.mjs            (OPSWEAVE_URL defaults to 127.0.0.1:18199)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18199';
const EMAIL = process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12d.invalid';
const PASSWORD = process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12d-admin-password-1';
const OUT = process.env.OPSWEAVE_SEED_OUT || '/tmp/g12d/seed.json';

let cookie = '';
let csrf = '';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}

async function login() {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('login -> ' + res.status + ': ' + text.slice(0, 300));
  csrf = JSON.parse(text).csrfToken;
  const raw = res.headers.getSetCookie?.() ?? [];
  cookie = raw.map((c) => c.split(';')[0]).join('; ');
}

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const LOG_BODY = Array.from({ length: 26 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return '2026-10-31T0' + (i % 6) + ':' + n + ':12.4Z  ERROR ingest-worker-7  pipeline=orders-ingest  '
    + 'stage=transform  rows=1200  reason="column order_id declared TEXT, expected UUID"  retry=' + (i % 3);
}).join('\n') + '\n2026-10-31T06:26:12.9Z  WARN  ingest-worker-7  circuit=open  upstream=postgres-orders\n';

async function createIncident(spec) {
  return call('POST', '/api/v1/incidents', spec);
}

async function addEvidence(incidentId, spec) {
  return call('POST', '/api/v1/incidents/' + incidentId + '/evidence', spec);
}

async function main() {
  await login();

  const a = await createIncident({
    title: 'orders-ingest 连续 17 次变换阶段失败，导致下游 revenue-daily 产出停滞后仍被标记为健康（含 zh-CN 全角标点与 English 混排的极长标题）',
    severity: 'CRITICAL',
    source: 'API',
    nativeId: 'native-' + Math.random().toString(36).slice(2, 8),
    relatedEntity: 'pipeline/orders-ingest@prod-cluster-a',
    startedAt: ago(180),
  });
  const aId = a.id;

  await addEvidence(aId, {
    kind: 'LOG_EXCERPT',
    source: 'node-agent:prod-cluster-a/ingest-worker-7',
    collectedAt: ago(174),
    content: { contentType: 'text/plain', body: LOG_BODY },
    claimedTrust: 'UNVERIFIED',
  });
  await addEvidence(aId, {
    kind: 'METRIC_SNAPSHOT',
    source: 'prometheus:orders_ingest_transform_failures_total',
    collectedAt: ago(168),
    content: {
      contentType: 'text/plain',
      body: 'orders_ingest_transform_failures_total{stage="transform"} 17\norders_ingest_rows_written_total 0\n',
    },
    claimedTrust: 'UNVERIFIED',
  });
  await addEvidence(aId, {
    kind: 'OPERATOR_NOTE',
    source: 'operator:' + EMAIL,
    collectedAt: ago(120),
    contentRef: 'note://g12d/operator-triage-1',
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  await addEvidence(aId, {
    kind: 'QUERY_RESULT',
    source: 'opsctl:prod-cluster-a',
    collectedAt: ago(96),
    contentRef: 'query://g12d/orders-ingest-transform-count',
    claimedTrust: 'UNVERIFIED',
  });
  await addEvidence(aId, {
    kind: 'OPERATOR_NOTE',
    source: 'runbook:orders-ingest/column-type-mismatch',
    collectedAt: ago(60),
    contentRef: 's3://opsweave-evidence/prod-cluster-a/2026-10-31/orders-ingest-transform-17.log',
    claimedTrust: 'UNVERIFIED',
  });

  const b = await createIncident({
    title: 'revenue-daily 窗口延迟 42 分钟',
    severity: 'MAJOR',
    source: 'API',
    nativeId: 'native-' + Math.random().toString(36).slice(2, 8),
    relatedEntity: 'dataset/revenue-daily',
    startedAt: ago(600),
  });
  const bId = b.id;
  await addEvidence(bId, {
    kind: 'LOG_EXCERPT',
    source: 'alertmanager:revenue-daily',
    collectedAt: ago(590),
    content: {
      contentType: 'text/plain',
      body: 'window_start 2026-10-31T00:00Z\nwindow_end 2026-10-31T01:00Z\nlag_minutes 42\n',
    },
    claimedTrust: 'UNVERIFIED',
  });
  await call('POST', '/api/v1/incidents/' + bId + '/verdict', {
    verdict: 'CONFIRMED',
    rationale: '上游 orders-ingest 窗口空转，下游日批因此延迟 42 分钟；证据包含一次窗口统计与一条告警，已足够确认而非推测。',
  });

  const c = await createIncident({
    title: 'node-a 心跳抖动 3 秒',
    severity: 'MINOR',
    source: 'MANUAL',
    nativeId: 'native-' + Math.random().toString(36).slice(2, 8),
    relatedEntity: 'node/node-a',
    startedAt: ago(1500),
  });

  mkdirSync(dirname(OUT), { recursive: true });
  const seed = { base: BASE, admin: EMAIL, incidentA: aId, incidentB: bId, incidentC: c.id, at: new Date().toISOString() };
  writeFileSync(OUT, JSON.stringify(seed, null, 2));
  console.log(JSON.stringify(seed));
}

main().catch((error) => { console.error(error); process.exit(1); });
