#!/usr/bin/env node
/**
 * G12 R2 phase 2 fixtures - every row is created through the public API of a throw-away
 * kernel, so every number the screenshots show is a number the Kernel returned.
 *
 * The four run terminal states come from the Kernel's own run loop, not from a fixture flag:
 *
 *   SUCCEEDED        fixture AUTO over four evidence rows collected after the incident start
 *   PARTIAL          fixture CROSS_SCOPE_PROBE, whose reads are refused by the scope predicate
 *   CANCELLED        fixture PACED_TOOL_LOOP, cancelled by a second request while it runs
 *   BUDGET_EXHAUSTED fixture BUDGET_TOOL_CALLS with a two-call budget
 *
 * Every run below is answered by the TEST_FIXTURE provider (test-fixture-v1), which the Kernel
 * labels synthetic on the wire; the UI-side notice is asserted in the spec, not here.
 *
 *   node tests/ui/g12r2-seed.mjs        OPSWEAVE_URL defaults to 127.0.0.1:18199
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.OPSWEAVE_URL || 'http://127.0.0.1:18199';
const OUT = process.env.OPSWEAVE_SEED_OUT || 'artifacts/g12-r2p2/seed.json';
const CREDS = {
  admin: { email: process.env.OPSWEAVE_ADMIN_EMAIL || 'admin@g12r2.invalid', password: process.env.OPSWEAVE_ADMIN_PASSWORD || 'g12r2-admin-password-1' },
  operator: { email: 'operator@g12r2.invalid', password: 'g12r2-password-operator-1' },
  other: { email: 'other@g12r2.invalid', password: 'g12r2-password-other-1' },
  viewer: { email: 'viewer@g12r2.invalid', password: 'g12r2-password-viewer-1' },
};

async function login(who) {
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREDS[who]),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('login ' + who + ' -> ' + res.status + ' ' + text.slice(0, 200));
  return {
    who,
    csrf: JSON.parse(text).csrfToken,
    cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '),
  };
}

async function call(session, method, path, body) {
  const headers = { cookie: session.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = session.csrf;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

async function must(session, method, path, body) {
  const r = await call(session, method, path, body);
  if (r.status >= 300) throw new Error(session.who + ' ' + method + ' ' + path + ' -> ' + r.status + ': ' + r.text.slice(0, 300));
  return r.json;
}

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const key = (label) => 'g12r2-' + label + '-' + Math.random().toString(36).slice(2, 10);

const LOG_BODY = Array.from({ length: 24 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return '2026-10-31T0' + (i % 6) + ':' + n + ':12.412Z  ERROR payment-webhook  trace=4f9c2b' + n
    + '  route=/v1/settle  status=502  upstream=ledger-api  retry=' + (i % 3)
    + '  reason="upstream closed connection before response headers (connection reset by peer)"';
}).join('\n') + '\n';

const JSON_BODY = JSON.stringify({
  window: '2026-10-31T06:00:00Z/2026-10-31T06:45:00Z',
  query: 'select status_code, count(*) from gateway_access where route = \'/v1/settle\' group by 1 order by 2 desc',
  rows: [
    { status_code: 502, count: 4182 },
    { status_code: 504, count: 311 },
    { status_code: 200, count: 96 },
  ],
  note: 'the 502s begin at the exact minute the ledger-api deploy finished, and no row shows a 4xx',
}, null, 2);

async function createIncident(session, spec) {
  return must(session, 'POST', '/api/v1/incidents', spec);
}
async function addEvidence(session, incidentId, spec) {
  return must(session, 'POST', '/api/v1/incidents/' + incidentId + '/evidence', spec);
}
async function startRun(session, incidentId, body) {
  return must(session, 'POST', '/api/v1/incidents/' + incidentId + '/investigations', { idempotencyKey: key('run'), ...body });
}

async function main() {
  const admin = await login('admin');
  const report = { users: [], incidents: {}, runs: {} };

  const members = { admin: null, operator: null, other: null, viewer: null };
  for (const [who, role, name] of [['operator', 'operator', 'Ops Operator'], ['other', 'operator', 'Other Operator'], ['viewer', 'viewer', 'Read Only']]) {
    const r = await call(admin, 'POST', '/api/v1/users', {
      email: CREDS[who].email, displayName: name, password: CREDS[who].password, role,
    });
    // A re-run of this script finds the account already there: a 409 still names the id
    // through the directory, which is what the membership grant below needs.
    report.users.push({ who, status: r.status, code: r.json?.code ?? r.json?.role ?? null });
  }
  const directory = await must(admin, 'GET', '/api/v1/users');
  for (const account of directory) {
    for (const who of Object.keys(members)) {
      if (CREDS[who].email === account.email) members[who] = account.id;
    }
  }
  for (const who of Object.keys(members)) {
    if (!members[who]) throw new Error('no user id for ' + who);
  }

  // A business workspace is the unit of data visibility: without one, nobody may file an
  // incident at all (INCIDENT_WORKSPACE_FORBIDDEN). One workspace, four members.
  let workspace = (await call(admin, 'POST', '/api/v1/business-workspaces', { key: 'g12r2', name: 'G12 R2 Acceptance' })).json;
  if (!workspace?.workspaceId) {
    const listed = await must(admin, 'GET', '/api/v1/business-workspaces');
    workspace = (Array.isArray(listed) ? listed : listed.items ?? []).find((row) => row.key === 'g12r2');
    if (!workspace?.workspaceId) throw new Error('workspace g12r2 could not be created or found');
  }
  const WORKSPACE_ID = workspace.workspaceId;
  report.workspace = { id: WORKSPACE_ID, key: workspace.key };
  for (const who of ['admin', 'operator', 'other', 'viewer']) {
    await call(admin, 'POST', '/api/v1/business-workspaces/' + WORKSPACE_ID + '/members', { userId: members[who] });
  }

  // ---- A: the incident with a real evidence record (two rows with stored bytes) ----
  const a = await createIncident(admin, {
    title: '支付回调 /v1/settle 大面积 502：ledger-api 发布后 4 分钟开始，revenue-daily 仍显示 healthy（含 zh-CN 与 English 混排的长标题，用于检验换行与标题层级）',
    severity: 'CRITICAL',
    source: 'API',
    nativeId: 'native-' + Math.random().toString(36).slice(2, 8),
    relatedEntity: 'service/payment-webhook@prod-cluster-a',
    startedAt: ago(60),
    workspaceId: WORKSPACE_ID,
  });
  const evidences = {};
  evidences.log = await addEvidence(admin, a.id, {
    kind: 'LOG_EXCERPT',
    source: 'node-agent:prod-cluster-a/payment-webhook-3',
    collectedAt: ago(50),
    content: { contentType: 'text/plain', body: LOG_BODY },
    claimedTrust: 'UNVERIFIED',
  });
  evidences.query = await addEvidence(admin, a.id, {
    kind: 'QUERY_RESULT',
    source: 'opsctl:prod-cluster-a',
    collectedAt: ago(44),
    content: { contentType: 'application/json', body: JSON_BODY },
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  evidences.legacy = await addEvidence(admin, a.id, {
    kind: 'OPERATOR_NOTE',
    source: 'runbook:payment-webhook/settle-502',
    collectedAt: ago(38),
    contentRef: 's3://opsweave-evidence/prod-cluster-a/2026-10-31/settle-502.log',
    claimedTrust: 'UNVERIFIED',
  });
  evidences.metric = await addEvidence(admin, a.id, {
    kind: 'METRIC_SNAPSHOT',
    source: 'prometheus:gateway_5xx_ratio',
    collectedAt: ago(30),
    content: { contentType: 'text/plain', body: 'gateway_5xx_ratio{route="/v1/settle"} 0.93\ngateway_5xx_ratio{route="/v1/refund"} 0.01\n' },
    claimedTrust: 'UNVERIFIED',
  });

  // ---- B: an incident with no evidence at all ----
  const b = await createIncident(admin, {
    title: 'ingest-worker 队列积压 4.2 万条，尚未提交任何证据',
    severity: 'MAJOR',
    source: 'MANUAL',
    relatedEntity: 'pipeline/orders-ingest@prod-cluster-a',
    startedAt: ago(120),
    workspaceId: WORKSPACE_ID,
  });

  // ---- C: an incident whose evidence contradicts its own recorded start ----
  const c = await createIncident(admin, {
    title: 'revenue-daily 产出缺失：记录的开始时间与证据采集时间互相矛盾',
    severity: 'MAJOR',
    source: 'MANUAL',
    relatedEntity: 'job/revenue-daily',
    startedAt: ago(30),
    workspaceId: WORKSPACE_ID,
  });
  const cEarly1 = await addEvidence(admin, c.id, {
    kind: 'LOG_EXCERPT', source: 'node-agent:prod-cluster-a/worker-1', collectedAt: ago(96),
    content: { contentType: 'text/plain', body: '2026-10-31T04:12:00Z WARN revenue-daily upstream=orders missing partition 2026-10-30\n' },
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  const cEarly2 = await addEvidence(admin, c.id, {
    kind: 'METRIC_SNAPSHOT', source: 'prometheus:revenue_partitions_missing', collectedAt: ago(88),
    content: { contentType: 'text/plain', body: 'revenue_partitions_missing 1\n' },
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  const cLate1 = await addEvidence(admin, c.id, {
    kind: 'OPERATOR_NOTE', source: 'operator:' + CREDS.admin.email, collectedAt: ago(18),
    contentRef: 'note://g12r2/revenue-daily-triage',
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  const cLate2 = await addEvidence(admin, c.id, {
    kind: 'QUERY_RESULT', source: 'opsctl:prod-cluster-a', collectedAt: ago(12),
    content: { contentType: 'application/json', body: JSON.stringify({ partitions_present: ['2026-10-31'], partitions_missing: ['2026-10-30'] }) },
    claimedTrust: 'OPERATOR_ASSERTED',
  });

  // ---- D: an incident owned by somebody else (the operator must not be able to read it) ----
  const other = await login('other');
  const d = await createIncident(other, {
    title: '另一个运维的私有事故：operator 账号不应看到这一条',
    severity: 'MINOR',
    source: 'MANUAL',
    relatedEntity: 'service/checkout-legacy',
    startedAt: ago(20),
    workspaceId: WORKSPACE_ID,
  });

  // ---- the runs ----
  const runCompleted = await startRun(admin, a.id, { scenario: 'AUTO' });
  const runAccepted = await startRun(admin, a.id, { scenario: 'AUTO' });
  const runRejected = await startRun(admin, a.id, { scenario: 'AUTO' });
  // The probe run lives on an incident the OPERATOR owns, and it asks its tools for an
  // incident the operator may not read. Run as the admin instead, the probe's reads would
  // succeed (an admin reads every incident) and the fixture would then cite another
  // incident's evidence - the schema refuses that with a 500, which is a Kernel defect this
  // phase recorded rather than a state a UI can show.
  const operator = await login('operator');
  const e = await createIncident(operator, {
    title: 'operator 自己的事故：这次调查尝试读取另一个运维的事故，被范围谓词拒绝',
    severity: 'MINOR',
    source: 'MANUAL',
    relatedEntity: 'service/checkout-legacy',
    startedAt: ago(45),
    workspaceId: WORKSPACE_ID,
  });
  await addEvidence(operator, e.id, {
    kind: 'LOG_EXCERPT', source: 'node-agent:prod-cluster-a/checkout-1', collectedAt: ago(40),
    content: { contentType: 'text/plain', body: '2026-10-31T05:20:00Z WARN checkout-legacy timeout=3000ms upstream=ledger-api\n' },
    claimedTrust: 'OPERATOR_ASSERTED',
  });
  const runPartial = await startRun(operator, e.id, {
    scenario: 'CROSS_SCOPE_PROBE',
    probeIncidentId: d.id,
    probeEvidenceId: cEarly2.evidenceId ?? cEarly2.id,
  });
  const runBudget = await startRun(admin, a.id, { scenario: 'BUDGET_TOOL_CALLS', maxToolCalls: 2, maxSteps: 40 });
  const runNoEvidence = await startRun(admin, b.id, { scenario: 'AUTO' });
  const runConflicted = await startRun(admin, c.id, { scenario: 'AUTO' });

  await must(admin, 'POST', '/api/v1/incidents/' + a.id + '/investigations/' + runAccepted.runId + '/review', {
    decision: 'ACCEPTED',
    note: 'The two stored reads match the timeline; accepted as the working explanation, not as the cause.',
  });
  await must(admin, 'POST', '/api/v1/incidents/' + a.id + '/investigations/' + runRejected.runId + '/review', {
    decision: 'REJECTED',
    note: 'Rejected: it restates the record shape and says nothing about the ledger-api deploy window.',
  });

  // Cancellation needs a second request while the first is still running: the paced loop
  // never finalises on its own, so the cancel is what ends it.
  const paced = fetch(BASE + '/api/v1/incidents/' + a.id + '/investigations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    body: JSON.stringify({ idempotencyKey: key('cancelled'), scenario: 'PACED_TOOL_LOOP', maxSteps: 200, maxToolCalls: 400, deadlineSeconds: 120 }),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const running = await call(admin, 'GET', '/api/v1/incidents/' + a.id + '/investigations');
  const runningRun = (running.json ?? []).find((run) => run.status === 'RUNNING' && run.adapter === 'TEST_FIXTURE');
  if (!runningRun) throw new Error('no RUNNING run was visible to cancel: ' + running.text.slice(0, 200));
  const cancelled = await call(admin, 'POST', '/api/v1/incidents/' + a.id + '/investigations/' + runningRun.runId + '/cancel');
  const pacedResult = await paced;
  const runCancelled = await pacedResult.json().catch(() => null);

  // ---- what an operator may not read ----
  const denied = await call(operator, 'GET', '/api/v1/incidents/' + d.id);
  const deniedInvestigations = await call(operator, 'GET', '/api/v1/incidents/' + d.id + '/investigations');
  const viewer = await login('viewer');
  const viewerRead = await call(viewer, 'GET', '/api/v1/incidents/' + a.id + '/investigations');

  report.incidents = {
    evidence: a.id,
    noEvidence: b.id,
    conflicted: c.id,
    otherOwner: d.id,
    operatorOwned: e.id,
  };
  report.evidence = {
    storedLog: evidences.log.evidenceId ?? evidences.log.id,
    storedQuery: evidences.query.evidenceId ?? evidences.query.id,
    legacy: evidences.legacy.evidenceId ?? evidences.legacy.id,
    unverified: evidences.metric.evidenceId ?? evidences.metric.id,
    conflictedEarly: [cEarly1.evidenceId ?? cEarly1.id, cEarly2.evidenceId ?? cEarly2.id],
    conflictedLate: [cLate1.evidenceId ?? cLate1.id, cLate2.evidenceId ?? cLate2.id],
  };
  report.contentStatus = {
    storedLog: evidences.log.contentStatus ?? null,
    storedQuery: evidences.query.contentStatus ?? null,
    legacy: evidences.legacy.contentStatus ?? null,
  };
  report.runs = {
    completed: { id: runCompleted.runId, status: runCompleted.status, stopReason: runCompleted.stopReason },
    accepted: { id: runAccepted.runId, status: runAccepted.status, review: 'ACCEPTED' },
    rejected: { id: runRejected.runId, status: runRejected.status, review: 'REJECTED' },
    partial: { id: runPartial.runId, status: runPartial.status, stopReason: runPartial.stopReason, invocations: runPartial.toolInvocations?.map((i) => i.outcome) },
    budget: { id: runBudget.runId, status: runBudget.status, stopReason: runBudget.stopReason },
    cancelled: { id: runCancelled?.runId ?? runningRun.runId, status: runCancelled?.status ?? cancelled.json?.status, stopReason: runCancelled?.stopReason ?? null, cancelStatus: cancelled.status },
    noEvidence: { id: runNoEvidence.runId, status: runNoEvidence.status, stance: runNoEvidence.hypotheses?.[0]?.stance, gaps: runNoEvidence.hypotheses?.[0]?.gapCodes },
    conflicted: { id: runConflicted.runId, status: runConflicted.status, stance: runConflicted.hypotheses?.[0]?.stance, supporting: runConflicted.hypotheses?.[0]?.supportingEvidence?.length, contradicting: runConflicted.hypotheses?.[0]?.contradictingEvidence?.length, gaps: runConflicted.hypotheses?.[0]?.gapCodes },
  };
  report.permissions = {
    operatorReadOtherOwner: { status: denied.status, code: denied.json?.code ?? null },
    operatorReadOtherOwnerInvestigations: { status: deniedInvestigations.status, code: deniedInvestigations.json?.code ?? null },
    viewerReadsInvestigations: { status: viewerRead.status, runs: Array.isArray(viewerRead.json) ? viewerRead.json.length : null },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
