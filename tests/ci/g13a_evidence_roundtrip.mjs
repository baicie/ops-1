// G13-A cross-process evidence round trip.
//
// Real Kernel process, real plugin process, real PostgreSQL, local Zabbix
// JSON-RPC fixture. No Gateway and no Node runtime: this test isolates the
// plugin -> Kernel evidence path, which is the one a decomposed test suite
// cannot prove (two implementations of the same digest are not a round trip).
//
// The fixture is labelled UPSTREAM_ZABBIX_FIXTURE. It does not prove real
// Zabbix response shapes, and the harness says so in its output.
//
// Run: node tests/ci/g13a_evidence_roundtrip.mjs
// Requires: target/debug/opsweave-kernel, local PostgreSQL on 127.0.0.1:5432,
//           node_modules in plugins/zabbix-source/backend (pg).

import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KERNEL_URL = 'http://127.0.0.1:18183';
const PLUGIN_URL = 'http://127.0.0.1:18098';
const DB_BASE = process.env.G13A_DATABASE_URL || 'postgres://liuzhiwei@127.0.0.1:5432/postgres';
const DB = `opsweave_g13a_roundtrip_${process.pid}`;
const DB_URL = (() => {
  const url = new URL(DB_BASE);
  url.pathname = `/${DB}`;
  return url.toString();
})();
const ADAPTER = { id: 'zabbix-main', secret: 'roundtrip-adapter-secret' };
const ADMIN = { email: 'admin@opsweave.local', password: 'OpsWeave!2026' };
const PLUGIN_ID = 'opsweave.zabbix-source';
const SOURCE_SECRET_MAP = JSON.stringify({ 'secretref:g13a/test': 'fixture-token' });

const children = [];
let cookie = '';
let csrf = '';

function log(message) {
  console.log(`[g13a] ${message}`);
}

function start(command, args, env, name) {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => process.env.G13A_VERBOSE === '1' && process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.env.G13A_VERBOSE === '1' && process.stderr.write(`[${name}] ${chunk}`));
  return child;
}

async function waitFor(url, { attempts = 100, delay = 200 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`${url} did not become ready`);
}

async function api(method, route, body) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(KERNEL_URL + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

async function login() {
  const response = await fetch(`${KERNEL_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  const payload = await response.json();
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';
  cookie = setCookie.split(';')[0];
  csrf = payload.csrfToken;
  if (!cookie || !csrf) throw new Error('login did not return a session');
}

async function pluginCall(method, route, { context, body } = {}) {
  const headers = { 'x-opsweave-user-context': context };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(PLUGIN_URL + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

function startFakeZabbix() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let rpc;
    try { rpc = JSON.parse(raw); } catch { res.writeHead(400).end('{}'); return; }
    let result = null;
    if (rpc.method === 'apiinfo.version') result = '7.0.0';
    else if (rpc.method === 'host.get') result = [{ hostid: '10084', name: 'web-01', available: '1' }];
    else if (rpc.method === 'item.get') result = [{ itemid: '10401', key_: 'system.cpu.util', name: 'CPU utilization', units: '%', value_type: '0' }];
    else if (rpc.method === 'history.get') result = [{ clock: 1793500200, value: '17.5', ns: 0 }];
    const payload = JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  return new Promise((resolve) => server.listen(18090, '127.0.0.1', () => resolve(server)));
}

async function main() {
  log('creating disposable database');
  execFileSync('psql', [DB_BASE, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${DB}"`]);

  log('starting Kernel');
  start(`${ROOT}/target/debug/opsweave-kernel`, [], {
    OPSWEAVE_BIND: '127.0.0.1:18183',
    OPSWEAVE_PUBLIC_URL: KERNEL_URL,
    DATABASE_URL: DB_URL,
    OPSWEAVE_DATA_DIR: `/tmp/g13a-roundtrip-${process.pid}`,
    OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
    OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    OPSWEAVE_BOOTSTRAP_ADMIN_NAME: 'Platform Admin',
    OPSWEAVE_EVIDENCE_ADAPTERS: `${ADAPTER.id}:${ADAPTER.secret}`,
    OPSWEAVE_PLUGIN_DB_HOST: '127.0.0.1',
    OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS: '127.0.0.1',
    OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT: '1',
    RUST_LOG: 'error',
  }, 'kernel');
  await waitFor(`${KERNEL_URL}/livez`);
  await login();
  const me = await api('GET', '/api/v1/auth/me');
  const adminId = me.body.user?.id ?? me.body.id;
  log(`Kernel ready, admin ${adminId}`);

  const workspace = await api('POST', '/api/v1/business-workspaces', { key: `g13a-${process.pid}`, name: 'G13-A round trip' });
  if (workspace.status !== 201) throw new Error(`workspace create failed: ${workspace.status} ${workspace.text}`);
  const workspaceId = workspace.body.workspaceId;
  const member = await api('POST', `/api/v1/business-workspaces/${workspaceId}/members`, { userId: adminId });
  if (member.status !== 201 && member.status !== 200) throw new Error(`member add failed: ${member.status} ${member.text}`);
  const incident = await api('POST', '/api/v1/incidents', {
    title: 'db-1 connection failures',
    severity: 'MAJOR',
    source: 'API',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    workspaceId,
  });
  if (incident.status !== 201) throw new Error(`incident create failed: ${incident.status} ${incident.text}`);
  const incidentId = incident.body.id;
  log(`workspace ${workspaceId}, incident ${incidentId}`);

  // The per-plugin context key is derived from the Kernel's cursor secret, just
  // as the Kernel derives it before injecting it into an instance environment.
  const psql = (sql) => execFileSync('psql', [DB_URL, '-tAc', sql], { encoding: 'utf8' }).trim();
  const cursorSecret = psql("SELECT value FROM kernel.platform_settings WHERE key='cursor_secret'");
  const contextKey = crypto
    .createHmac('sha256', Buffer.from(JSON.parse(cursorSecret), 'hex'))
    .update(`caller-context:${PLUGIN_ID}`)
    .digest('hex');

  function userContext(workspaceIds) {
    const now = Math.floor(Date.now() / 1000);
    const encoded = Buffer.from(JSON.stringify({
      v: 1,
      userId: adminId,
      role: 'admin',
      pluginId: PLUGIN_ID,
      workspaceIds,
      issuedAt: now,
      expiresAt: now + 120,
      requestId: crypto.randomUUID(),
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', Buffer.from(contextKey, 'hex')).update(encoded).digest('base64url');
    return `owu1.${encoded}.${signature}`;
  }

  const fixture = await startFakeZabbix();
  log('UPSTREAM_ZABBIX_FIXTURE listening on 127.0.0.1:18090');

  const pluginEnv = {
    PORT: '18098',
    OPSWEAVE_PLUGIN_DATABASE_URL: DB_URL,
    OPSWEAVE_CALLER_CONTEXT_KEY: contextKey,
    OPSWEAVE_EVIDENCE_ADAPTER_ID: ADAPTER.id,
    OPSWEAVE_EVIDENCE_ADAPTER_SECRET: ADAPTER.secret,
    OPSWEAVE_ZABBIX_SECRETS: SOURCE_SECRET_MAP,
    OPSWEAVE_ALLOW_LOOPBACK_SOURCE: '1',
    NODE_ENV: 'test',
  };
  let plugin = start(process.execPath, ['plugins/zabbix-source/backend/server.mjs'], pluginEnv, 'plugin');
  await waitFor(`${PLUGIN_URL}/_opsweave/health/ready`);

  const contextA = userContext([workspaceId]);
  const created = await pluginCall('POST', '/api/zabbix-source/sources', {
    context: contextA,
    body: {
      workspaceId,
      name: 'zabbix-main',
      endpoint: 'http://127.0.0.1:18090/api_jsonrpc.php',
      credential: { kind: 'api-token', ref: 'secretref:g13a/test' },
    },
  });
  if (created.status !== 201) throw new Error(`source create failed: ${created.status} ${created.text}`);
  const sourceId = created.body.sourceId;
  log(`source ${sourceId} created`);

  const probed = await pluginCall('POST', `/api/zabbix-source/sources/${sourceId}/probe`, { context: contextA });
  if (probed.status !== 200 || probed.body.outcome !== 'OK') throw new Error(`probe failed: ${probed.status} ${probed.text}`);
  log('probe OK');

  const collected = await pluginCall('POST', `/api/zabbix-source/sources/${sourceId}/collect`, {
    context: contextA,
    body: {
      itemIds: ['10401'],
      window: { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() },
    },
  });
  if (collected.status !== 200 || collected.body.outcome !== 'OK') throw new Error(`collect failed: ${collected.status} ${collected.text}`);
  const collection = collected.body;
  log(`collection ${collection.collectionId} outcome=${collection.outcome} contentRef=${collection.contentRef.slice(0, 20)}…`);

  const attested = await pluginCall('POST', `/api/zabbix-source/collections/${collection.collectionId}/attestation`, {
    context: contextA,
    body: { incidentId, kind: 'METRIC_SNAPSHOT' },
  });
  if (attested.status !== 200) throw new Error(`attestation failed: ${attested.status} ${attested.text}`);
  const evidence = attested.body.evidence;
  const digest = 'sha256:' + crypto.createHash('sha256').update(evidence.content.body, 'utf8').digest('hex');
  if (digest !== evidence.contentRef) throw new Error('plugin returned bytes that do not match its contentRef');
  log('plugin signed bytes; digest matches contentRef');

  const stored = await api('POST', `/api/v1/incidents/${incidentId}/evidence`, {
    kind: evidence.kind,
    source: evidence.source,
    collectedAt: evidence.collectedAt,
    contentRef: evidence.contentRef,
    content: evidence.content,
    attestation: evidence.attestation,
  });
  if (stored.status !== 201) throw new Error(`Kernel evidence write failed: ${stored.status} ${stored.text}`);
  if (stored.body.verifiedTrust !== 'SOURCE_ATTESTED') throw new Error(`Kernel did not verify: ${stored.text}`);
  const evidenceId = stored.body.id;
  log(`Kernel stored evidence ${evidenceId} verifiedTrust=${stored.body.verifiedTrust}`);

  const content = await api('GET', `/api/v1/incidents/${incidentId}/evidence/${evidenceId}/content`);
  if (content.status !== 200) throw new Error(`content read failed: ${content.status} ${content.text}`);
  if (content.text !== evidence.content.body) throw new Error('Kernel served different bytes than it stored');

  const list = await api('GET', `/api/v1/incidents/${incidentId}/evidence`);
  if (list.status !== 200 || !list.body.items.some((row) => row.id === evidenceId)) throw new Error('evidence row missing from the list');
  log('Kernel served identical bytes and lists the row');

  // A workspace outside the signed scope cannot see or use the source.
  const other = await api('POST', '/api/v1/business-workspaces', { key: `g13a-b-${process.pid}`, name: 'G13-A other' });
  const otherWorkspace = other.body.workspaceId;
  const contextB = userContext([otherWorkspace]);
  const hidden = await pluginCall('GET', '/api/zabbix-source/sources', { context: contextB });
  if (hidden.status !== 200 || hidden.body.items.length !== 0) throw new Error('cross-workspace source list leaked a source');
  const denied = await pluginCall('POST', `/api/zabbix-source/sources/${sourceId}/probe`, { context: contextB });
  if (denied.status !== 404) throw new Error(`cross-workspace probe returned ${denied.status}`);
  log('cross-workspace list is empty and probe is 404');

  // Restart the plugin: sources and the collection survive because they are in PostgreSQL.
  plugin.kill('SIGTERM');
  await once(plugin, 'exit');
  plugin = start(process.execPath, ['plugins/zabbix-source/backend/server.mjs'], pluginEnv, 'plugin');
  await waitFor(`${PLUGIN_URL}/_opsweave/health/ready`);
  const afterRestart = await pluginCall('GET', '/api/zabbix-source/sources', { context: contextA });
  if (afterRestart.status !== 200 || afterRestart.body.items.length !== 1) throw new Error('source did not survive the plugin restart');
  const reattested = await pluginCall('POST', `/api/zabbix-source/collections/${collection.collectionId}/attestation`, {
    context: contextA,
    body: { incidentId, kind: 'METRIC_SNAPSHOT' },
  });
  if (reattested.status !== 200) throw new Error(`collection did not survive the restart: ${reattested.status}`);
  log('plugin restart: source still listed, collection still attestable');

  // Evidence is still readable after the restart (Kernel was not restarted).
  const again = await api('GET', `/api/v1/incidents/${incidentId}/evidence/${evidenceId}/content`);
  if (again.status !== 200 || again.text !== evidence.content.body) throw new Error('evidence content changed after the plugin restart');

  log('PASS — upstream=UPSTREAM_ZABBIX_FIXTURE, gateway=NOT_RUN, real_zabbix=NOT_RUN');
  fixture.close();
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`[g13a] FAIL: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  try { execFileSync('psql', [DB_BASE, '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${DB}" WITH (FORCE)`]); } catch { /* best effort */ }
  process.exit(exitCode);
}
