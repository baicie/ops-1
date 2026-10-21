import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PLUGIN_ID = process.env.OPSWEAVE_PLUGIN_ID || 'dev.opsweave.hello';
const VERSION = process.env.OPSWEAVE_PLUGIN_VERSION || '0.0.1';
const CAPABILITY_DIGEST = process.env.OPSWEAVE_CAPABILITY_DIGEST || 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const BUILD_DIGEST = process.env.OPSWEAVE_BUILD_DIGEST || 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const PORT = Number(process.env.PORT || 8080);
const INSTANCE_ID = process.env.OPSWEAVE_INSTANCE_ID || 'dev-instance';
let ready = false;
let stopping = false;
const startedAt = Date.now();

function requestId(req) {
  const incoming = req.headers['x-opsweave-request-id'];
  return typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
}

function send(res, status, body, id) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-opsweave-request-id': id,
  });
  res.end(payload);
}

function error(res, status, code, message, id, retryable = false) {
  send(res, status, { code, message, requestId: id, retryable }, id);
}

const server = http.createServer(async (req, res) => {
  const id = requestId(req);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/_opsweave/runtime/v1/info') {
    return send(res, 200, {
      pluginId: PLUGIN_ID,
      version: VERSION,
      runtimeProtocol: 'http-json-v1',
      capabilityDigest: CAPABILITY_DIGEST,
      buildDigest: BUILD_DIGEST,
    }, id);
  }
  if (url.pathname === '/_opsweave/health/live') {
    return send(res, stopping ? 503 : 200, { status: stopping ? 'stopping' : 'live' }, id);
  }
  if (url.pathname === '/_opsweave/health/startup') {
    return send(res, 200, { status: 'started' }, id);
  }
  if (url.pathname === '/_opsweave/health/ready') {
    return send(res, ready && !stopping ? 200 : 503, {
      status: ready && !stopping ? 'ready' : 'not_ready',
      version: VERSION,
    }, id);
  }
  if (url.pathname === '/api/hello' && req.method === 'GET') {
    return send(res, 200, {
      pluginId: PLUGIN_ID,
      version: VERSION,
      message: `Hello from OpsWeave ${VERSION}`,
      instanceId: INSTANCE_ID,
      requestId: id,
      runtime: {
        language: 'TypeScript / Node.js',
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      },
      timestamp: new Date().toISOString(),
    }, id);
  }
  if (url.pathname === '/api/hello/echo' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) {
        return error(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 64 KiB', id);
      }
    }
    let parsed;
    try { parsed = body ? JSON.parse(body) : {}; } catch {
      return error(res, 400, 'INVALID_JSON', 'Body must be valid JSON', id);
    }
    const forged = req.headers['x-opsweave-user-role'];
    return send(res, 200, {
      echoed: parsed,
      pluginId: PLUGIN_ID,
      version: VERSION,
      instanceId: INSTANCE_ID,
      requestId: id,
      serverVerifiedCallerRole: typeof forged === 'string' ? forged : null,
      note: 'Caller context headers are set by the Kernel Gateway; clients cannot self-assert them.',
    }, id);
  }
  if (url.pathname.startsWith('/api/hello')) {
    return error(res, 404, 'NOT_FOUND', 'No such hello-ops API route', id);
  }
  return error(res, 404, 'NOT_FOUND', 'No such route', id);
});

setTimeout(() => { ready = true; }, 600);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  ready = false;
  console.log(JSON.stringify({ level: 'INFO', message: `received ${signal}; readiness disabled`, timestamp: new Date().toISOString() }));
  setTimeout(() => server.close(() => process.exit(0)), 1200);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'INFO', message: `hello-ops TypeScript runtime listening on ${PORT}`, version: VERSION, instanceId: INSTANCE_ID, timestamp: new Date().toISOString() }));
});
