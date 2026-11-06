// Local Zabbix JSON-RPC fixture for the G13-A.1 golden path.
//
// It is an HTTP server, not a mock module: the plugin reaches it over a real
// socket through the same `rpc()` path production uses. It is labelled
// UPSTREAM_ZABBIX_FIXTURE everywhere it is reported; it does not prove real
// Zabbix response shapes.
//
// It requires the configured token on every authenticated method. That is how
// the golden path proves the Kernel-delivered secret actually reached the
// plugin: without it, host.get/history.get answer 401.

import http from 'node:http';

const PORT = Number(process.env.ZABBIX_FIXTURE_PORT || 18090);
const TOKEN = process.env.ZABBIX_FIXTURE_TOKEN || 'fixture-token';

const HOSTS = [
  { hostid: '10084', name: 'web-01', available: '1' },
  { hostid: '10085', name: 'db-01', available: '0' },
];
const ITEMS = [
  { itemid: '10401', hostid: '10084', key_: 'system.cpu.util', name: 'CPU utilization', units: '%', value_type: '0' },
  { itemid: '10402', hostid: '10084', key_: 'vm.memory.utilization', name: 'Memory utilization', units: '%', value_type: '0' },
  { itemid: '10501', hostid: '10085', key_: 'system.cpu.load[avg1]', name: 'Load average (1m)', units: '', value_type: '0' },
];
const HISTORY = [
  { clock: 1793500200, value: '17.5', ns: 0 },
  { clock: 1793500260, value: '23.0', ns: 0 },
  { clock: 1793500320, value: '19.25', ns: 0 },
];

function answer(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') return answer(res, 405, { error: 'POST only' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let rpc;
  try {
    rpc = JSON.parse(raw);
  } catch {
    return answer(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null });
  }
  if (rpc.method !== 'apiinfo.version') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return answer(res, 200, { jsonrpc: '2.0', error: { code: -32602, message: 'Not authorized.' }, id: rpc.id });
    }
  }
  let result = null;
  switch (rpc.method) {
    case 'apiinfo.version':
      result = '7.0.0';
      break;
    case 'host.get':
      result = HOSTS;
      break;
    case 'item.get': {
      const wanted = rpc.params?.hostids?.[0];
      result = ITEMS.filter((item) => !wanted || item.hostid === wanted);
      break;
    }
    case 'history.get':
      result = HISTORY;
      break;
    default:
      return answer(res, 200, { jsonrpc: '2.0', error: { code: -32601, message: 'method not found' }, id: rpc.id });
  }
  return answer(res, 200, { jsonrpc: '2.0', result, id: rpc.id });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`UPSTREAM_ZABBIX_FIXTURE listening on 0.0.0.0:${PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
