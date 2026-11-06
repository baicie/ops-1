#!/usr/bin/env bash
# G13-A.1 golden path: real Kernel + real Node runtime + real OCI Zabbix plugin
# + Kernel Gateway + PostgreSQL + a local Zabbix JSON-RPC fixture + Playwright.
#
# Everything between the browser and the plugin uses the production protocol:
# the browser calls the Gateway, the Gateway calls the Node data endpoint, the
# Node starts the OCI container, and the plugin calls the fixture. The fixture is
# labelled UPSTREAM_ZABBIX_FIXTURE; real Zabbix is NOT_RUN.
#
# Requirements: Docker with a running daemon, a local registry on :5001, the
# kernel/node/opsctl binaries under target/debug, and the #39 UI dist built into
# /tmp/g13a1-ui-dist (the script says how if it is missing).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

URL="http://127.0.0.1:18185"
DB_PORT=55432
DB_NAME=opsweave_g13a1
DB_URL="postgres://postgres:postgres@127.0.0.1:${DB_PORT}/${DB_NAME}"
PLUGIN_HOST="${OPSWEAVE_G13A1_PLUGIN_HOST:-host.docker.internal}"
REGISTRY="${OPSWEAVE_REGISTRY:-127.0.0.1:5001}"
PULL_REGISTRY="${OPSWEAVE_PULL_REGISTRY:-localhost:5001}"
ADAPTER_ID="zabbix-main"
ADAPTER_SECRET="g13a1-adapter-secret"
ZABBIX_TOKEN="fixture-token"
APPROVED_ENDPOINT="http://${PLUGIN_HOST}:18090/api_jsonrpc.php"
ATTACKER_PORT=18091
ATTACKER_LOG=/tmp/g13a1-attacker-auth.log
# The developer shell may export an HTTP proxy; every call here is loopback or
# the Docker bridge, and a proxy turning a local receiver into a 502 would make
# the attack matrix unreadable. Keep local traffic direct.
export no_proxy="127.0.0.1,localhost,${PLUGIN_HOST}"
export NO_PROXY="$no_proxy"
PG_CONTAINER="opsweave-g13a1-pg"
NODE_STATE="$(mktemp -d /tmp/opsweave-g13a1-node.XXXXXX)"
OPSCTL_HOME="$(mktemp -d /tmp/opsweave-g13a1-home.XXXXXX)"
REAL_HOME="$HOME"
export HOME="$OPSCTL_HOME"
KERNEL_LOG=/tmp/g13a1-kernel.log
NODE_LOG=/tmp/g13a1-node.log
FIXTURE_LOG=/tmp/g13a1-fixture.log
PIDS=()
FAILED=0

ok() { printf 'PASS  %s\n' "$*"; }
bad() { FAILED=1; printf 'FAIL  %s\n' "$*"; }
step() { printf '\n######## %s ########\n' "$*"; }

cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  # Only this run's plugin containers: the node id is unique to this harness,
  # so a user's zabbix-source instance is never touched. --quiet ignores
  # --format, which is why the old form matched nothing.
  if [ -n "${NODE_ID:-}" ]; then
    docker ps --filter "label=opsweave.node-id=$NODE_ID" \
      --filter label=opsweave.plugin-id=opsweave.zabbix-source \
      --format '{{.ID}}' | while read -r id; do
        docker rm -f "$id" >/dev/null 2>&1 || true
      done
  fi
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$NODE_STATE" "$OPSCTL_HOME"
}
trap cleanup EXIT

json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
token() { python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])'; }
api() { # method path [body] -> status; body in /tmp/g13a1-body.json
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 30 -o /tmp/g13a1-body.json -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN")
  [ -n "$body" ] && args+=(-H 'content-type: application/json' --data-binary "$body")
  curl "${args[@]}" "$URL$path"
}
gateway() { # method plugin-path [body] -> status; body in /tmp/g13a1-body.json
  api "$1" "/api/v1/gateway/opsweave.zabbix-source$2" "${3:-}"
}

start_kernel() { # $1 = workspace-scoped OPSWEAVE_PLUGIN_SECRETS JSON, $2 = credential bindings JSON
  local secrets="$1"
  local bindings="$2"
  env \
    DATABASE_URL="$DB_URL" \
    OPSWEAVE_BIND=0.0.0.0:18185 \
    OPSWEAVE_PUBLIC_URL="$URL" \
    OPSWEAVE_WEB_DIST=/tmp/g13a1-ui-dist \
    OPSWEAVE_DATA_DIR=/tmp/g13a1-data \
    OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@opsweave.local \
    OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD='OpsWeave!2026' \
    OPSWEAVE_BOOTSTRAP_ADMIN_NAME='Platform Admin' \
    OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
    OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$(cat keys/publisher.pub)" \
    OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
    OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost \
    OPSWEAVE_EVIDENCE_ADAPTERS="${ADAPTER_ID}:${ADAPTER_SECRET}" \
    OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS="${ADAPTER_ID}:opsweave.zabbix-source" \
    OPSWEAVE_PLUGIN_SECRETS="$secrets" \
    OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS="$bindings" \
    OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS=1 \
    OPSWEAVE_PLUGIN_DB_HOST="$PLUGIN_HOST" \
    OPSWEAVE_PLUGIN_KERNEL_URL="http://${PLUGIN_HOST}:18185" \
    OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS="$PLUGIN_HOST" \
    RUST_LOG=info ./target/debug/opsweave-kernel >>"$KERNEL_LOG" 2>&1 &
  KERNEL_PID=$!
  PIDS+=($KERNEL_PID)
  for _ in $(seq 1 120); do curl -fsS "$URL/livez" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "$URL/livez" >/dev/null
  ./target/debug/opsctl --url "$URL" login --email admin@opsweave.local --password 'OpsWeave!2026' >/dev/null
  TOKEN="$(token)"
  [ -n "$TOKEN" ] || { echo "login failed"; exit 1; }
}

stop_kernel() {
  kill "$KERNEL_PID" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$KERNEL_PID" 2>/dev/null || break; sleep 0.2; done
  for _ in $(seq 1 50); do curl -fsS "$URL/livez" >/dev/null 2>&1 || break; sleep 0.2; done
}

[ -f /tmp/g13a1-ui-dist/index.html ] || {
  echo "missing /tmp/g13a1-ui-dist. Build it from the #39 branch:"
  echo "  git switch feat/g13-a-collect-ui && pnpm --filter @opsweave/platform-web build && cp -R apps/platform-web/dist /tmp/g13a1-ui-dist"
  exit 2
}
command -v docker >/dev/null || { echo "docker is required"; exit 2; }
docker info >/dev/null 2>&1 || { echo "docker daemon is not running"; exit 2; }
[ -f keys/publisher.pub ] || { echo "missing keys/publisher.pub; run ./target/debug/opsctl keygen --out-dir keys"; exit 2; }
for _ in $(seq 1 30); do curl -fsS "http://${REGISTRY}/v2/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://${REGISTRY}/v2/" >/dev/null || { echo "registry ${REGISTRY} is not reachable"; exit 2; }

step "isolated PostgreSQL"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
rm -rf /tmp/g13a1-data

docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB_NAME" -p "${DB_PORT}:5432" postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG_CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1 && break; sleep 1; done
docker exec "$PG_CONTAINER" pg_isready -U postgres -d "$DB_NAME" >/dev/null
ok "PostgreSQL on ${DB_PORT}"

step "OCI image and signed bundle"
OPSWEAVE_REGISTRY="$REGISTRY" OPSWEAVE_MANIFEST_PREFIX="$PULL_REGISTRY" scripts/build-zabbix-plugin.sh
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/opsweave/zabbix-source:0.0.1")"
ok "image ${DIGEST}"

step "local Zabbix fixture (UPSTREAM_ZABBIX_FIXTURE)"
ZABBIX_FIXTURE_PORT=18090 ZABBIX_FIXTURE_TOKEN="$ZABBIX_TOKEN" node tests/fixtures/zabbix_rpc_fixture.mjs >"$FIXTURE_LOG" 2>&1 &
PIDS+=($!)
sleep 1
curl -fsS -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"apiinfo.version","id":1}' "http://127.0.0.1:18090/" >/dev/null
ok "fixture answers apiinfo.version"

: > "$ATTACKER_LOG"
python3 tests/fixtures/zabbix_attacker_receiver.py "$ATTACKER_PORT" "$ATTACKER_LOG" >/tmp/g13a1-attacker.log 2>&1 &
PIDS+=($!)
sleep 1
curl -fsS -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","method":"host.get","id":1}' "http://127.0.0.1:${ATTACKER_PORT}/" >/dev/null
: > "$ATTACKER_LOG"
ok "attacker receiver is listening (and its auth log is empty)"

step "Kernel (bootstrap pass) and workspaces"
start_kernel '{}' '{}'
ok "Kernel ready and admin session acquired"

# Plugin secrets are keyed by workspace, so the workspace ids must exist before
# the Kernel process that will inject them starts. Create them now, then restart
# the Kernel with the workspace-scoped map (the same map the restart step uses).
api POST /api/v1/business-workspaces '{"key":"g13a1","name":"G13-A.1"}' >/dev/null
WORKSPACE_A="$(json "d['workspaceId']" < /tmp/g13a1-body.json)"
ADMIN_ID="$(api GET /api/v1/auth/me >/dev/null; json "d['user']['id']" < /tmp/g13a1-body.json)"
api POST "/api/v1/business-workspaces/${WORKSPACE_A}/members" "{\"userId\":\"${ADMIN_ID}\"}" >/dev/null
api POST /api/v1/business-workspaces '{"key":"g13a1-b","name":"G13-A.1 B"}' >/dev/null
WORKSPACE_B="$(json "d['workspaceId']" < /tmp/g13a1-body.json)"
api POST "/api/v1/business-workspaces/${WORKSPACE_B}/members" "{\"userId\":\"${ADMIN_ID}\"}" >/dev/null
api POST /api/v1/incidents "{\"title\":\"g13a1 cpu saturation\",\"severity\":\"MAJOR\",\"source\":\"API\",\"startedAt\":\"2026-11-06T09:00:00Z\",\"workspaceId\":\"${WORKSPACE_A}\"}" >/dev/null
INCIDENT_ID="$(json "d['id']" < /tmp/g13a1-body.json)"
[ -n "$WORKSPACE_A" ] && [ -n "$WORKSPACE_B" ] && [ -n "$INCIDENT_ID" ] || { echo "workspace/incident creation failed"; exit 1; }
SECRETS_JSON="$(python3 - "$WORKSPACE_A" "$WORKSPACE_B" "$ZABBIX_TOKEN" <<'JSON'
import json, sys
a, b, token = sys.argv[1:4]
print(json.dumps({"opsweave.zabbix-source": {
    a: {"secretref:zabbix/main": token},
    b: {"secretref:zabbix/main": token},
}}))
JSON
)"
BINDINGS_JSON="$(python3 - "$WORKSPACE_A" "$WORKSPACE_B" "$PLUGIN_HOST" <<'JSON'
import json, sys
a, b, host = sys.argv[1:4]
endpoint = f"http://{host}:18090/api_jsonrpc.php"
print(json.dumps({"opsweave.zabbix-source": {
    a: {"secretref:zabbix/main": {"endpoint": endpoint, "tls": "TEST_PLAINTEXT"}},
    b: {"secretref:zabbix/main": {"endpoint": endpoint, "tls": "TEST_PLAINTEXT"}},
}}))
JSON
)"
step "restart Kernel with workspace-scoped plugin secrets"
stop_kernel
start_kernel "$SECRETS_JSON" "$BINDINGS_JSON"
ok "Kernel restarted with workspace-scoped secrets"

step "real Node runtime"
NODE_TOKEN="$(./target/debug/opsctl --url "$URL" node-token --label node-a)"
env \
  OPSWEAVE_KERNEL_URL="$URL" \
  OPSWEAVE_ENROLLMENT_TOKEN="$NODE_TOKEN" \
  OPSWEAVE_NODE_NAME=node-a \
  OPSWEAVE_NODE_LABELS=role=node,zone=node-a \
  OPSWEAVE_NODE_DATA_BIND=127.0.0.1:9105 \
  OPSWEAVE_NODE_DATA_ENDPOINT=http://127.0.0.1:9105 \
  OPSWEAVE_NODE_STATE_DIR="$NODE_STATE" \
  OPSWEAVE_DOCKER_HOST=unix:///var/run/docker.sock \
  OPSWEAVE_NODE_WORKER_ENABLED=0 \
  RUST_LOG=info ./target/debug/opsweave-node >"$NODE_LOG" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 90); do
  code="$(api GET /api/v1/nodes)"
  ready="$(python3 -c 'import json;d=json.load(open("/tmp/g13a1-body.json"));print(sum(1 for n in d if n.get("status")=="READY" and not n.get("stale")))' 2>/dev/null || echo 0)"
  [ "$code" = "200" ] && [ "$ready" = "1" ] && break
  sleep 1
done
[ "${ready:-0}" = "1" ] || { echo "node did not become READY"; exit 1; }
NODE_ID="$(python3 -c 'import json;d=json.load(open("/tmp/g13a1-body.json"));print(next((n["id"] for n in d if n.get("status")=="READY" and not n.get("stale")),""))')"
[ -n "$NODE_ID" ] || { echo "cannot identify the enrolled node"; exit 1; }
ok "node READY (${NODE_ID})"

step "storage binding, install, deploy, activate"
api POST /api/v1/plugin-storage/opsweave.zabbix-source >/dev/null || true
./target/debug/opsctl --url "$URL" install dist/plugins/zabbix-source-0.0.1.plugin.zip
./target/debug/opsctl --url "$URL" deploy opsweave.zabbix-source 0.0.1 --replicas 1 --selector role=node --wait
./target/debug/opsctl --url "$URL" activate opsweave.zabbix-source 0.0.1
for _ in $(seq 1 120); do
  code="$(gateway GET /api/zabbix-source/sources)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-}" = "200" ] || { echo "gateway did not reach the plugin: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
ok "plugin instance is reachable through the Gateway"

step "source through the Gateway"
GW_SOURCE="$(python3 - "$WORKSPACE_A" "$PLUGIN_HOST" <<'PY'
import json, sys
print(json.dumps({
  "workspaceId": sys.argv[1],
  "name": "zabbix-main",
  "endpoint": f"http://{sys.argv[2]}:18090/api_jsonrpc.php",
  "credential": {"kind": "api-token", "ref": "secretref:zabbix/main"},
}))
PY
)"
code="$(gateway POST /api/zabbix-source/sources "$GW_SOURCE")"
[ "$code" = "201" ] || { echo "source create failed: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
SOURCE_ID="$(json "d['sourceId']" < /tmp/g13a1-body.json)"
ok "source ${SOURCE_ID} in workspace ${WORKSPACE_A}"

step "credential endpoint attack through the Gateway"
ATTACK_ENDPOINT="http://${PLUGIN_HOST}:${ATTACKER_PORT}/api_jsonrpc.php"
code="$(gateway PUT "/api/zabbix-source/sources/${SOURCE_ID}" "{\"name\":\"zabbix-main\",\"endpoint\":\"${ATTACK_ENDPOINT}\",\"credential\":{\"kind\":\"api-token\",\"ref\":\"secretref:zabbix/main\"}}")"
[ "$code" = "422" ] && [ "$(json "d['code']" < /tmp/g13a1-body.json)" = "ZBX_CREDENTIAL_ENDPOINT_MISMATCH" ] || { echo "PUT endpoint swap was not refused: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
code="$(gateway POST /api/zabbix-source/sources "{\"workspaceId\":\"${WORKSPACE_A}\",\"name\":\"attacker-source\",\"endpoint\":\"${ATTACK_ENDPOINT}\",\"credential\":{\"kind\":\"api-token\",\"ref\":\"secretref:zabbix/main\"}}")"
[ "$code" = "422" ] && [ "$(json "d['code']" < /tmp/g13a1-body.json)" = "ZBX_CREDENTIAL_ENDPOINT_MISMATCH" ] || { echo "attacker-endpoint source was not refused: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
: > "$ATTACKER_LOG"
code="$(gateway GET "/api/zabbix-source/sources/${SOURCE_ID}/hosts")"
[ "$code" = "200" ] || { echo "approved hosts failed after the refused swap: $code"; exit 1; }
[ ! -s "$ATTACKER_LOG" ] || { echo "the attacker receiver saw a credential: $(cat "$ATTACKER_LOG")"; exit 1; }
ok "endpoint swap and attacker-endpoint create refused; attacker received 0 credentials"

code="$(gateway POST "/api/zabbix-source/sources/${SOURCE_ID}/probe")"
[ "$code" = "200" ] && [ "$(json "d['outcome']" < /tmp/g13a1-body.json)" = "OK" ] || { echo "probe failed: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
ok "probe OK through Gateway (apiinfo.version is unauthenticated; the secret is proven by hosts/items/collect)"

code="$(gateway GET "/api/zabbix-source/sources/${SOURCE_ID}/hosts")"
[ "$code" = "200" ] || { echo "host list failed: $code"; exit 1; }
code="$(gateway GET "/api/zabbix-source/sources/${SOURCE_ID}/items?hostId=10084")"
[ "$code" = "200" ] || { echo "item list failed: $code"; exit 1; }

COLLECT_BODY="$(python3 - <<'PY'
import datetime, json
now = datetime.datetime.now(datetime.timezone.utc)
start = now - datetime.timedelta(hours=1)
print(json.dumps({"itemIds": ["10401"], "window": {"from": start.isoformat().replace("+00:00","Z"), "to": now.isoformat().replace("+00:00","Z")}}))
PY
)"
code="$(gateway POST "/api/zabbix-source/sources/${SOURCE_ID}/collect" "$COLLECT_BODY")"
[ "$code" = "200" ] || { echo "collect failed: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
COLLECTION_ID="$(json "d['collectionId']" < /tmp/g13a1-body.json)"
OUTCOME="$(json "d['outcome']" < /tmp/g13a1-body.json)"
[ "$OUTCOME" = "OK" ] || { echo "collect outcome ${OUTCOME}"; exit 1; }
ok "collection ${COLLECTION_ID} OK"

code="$(gateway POST "/api/zabbix-source/collections/${COLLECTION_ID}/attestation" "{\"incidentId\":\"${INCIDENT_ID}\",\"kind\":\"METRIC_SNAPSHOT\"}")"
[ "$code" = "200" ] || { echo "attestation failed: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
ATTESTATION_BODY="$(cat /tmp/g13a1-body.json)"
WORKSPACE_SIGNED="$(python3 -c 'import json,sys;print(json.load(open("/tmp/g13a1-body.json"))["evidence"]["attestation"]["workspaceId"])')"
[ "$WORKSPACE_SIGNED" = "$WORKSPACE_A" ] || { echo "signed workspace ${WORKSPACE_SIGNED} != ${WORKSPACE_A}"; exit 1; }
EVIDENCE_BODY="$(python3 - <<'PY'
import json
d = json.load(open('/tmp/g13a1-body.json'))
e = d['evidence']
print(json.dumps({
  'kind': e['kind'], 'source': e['source'], 'collectedAt': e['collectedAt'],
  'contentRef': e['contentRef'], 'content': e['content'], 'attestation': e['attestation'],
}))
PY
)"
code="$(api POST "/api/v1/incidents/${INCIDENT_ID}/evidence" "$EVIDENCE_BODY")"
[ "$code" = "201" ] || { echo "evidence write failed: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
EVIDENCE_ID="$(json "d['id']" < /tmp/g13a1-body.json)"
TRUST="$(json "d['verifiedTrust']" < /tmp/g13a1-body.json)"
[ "$TRUST" = "SOURCE_ATTESTED" ] || { echo "trust ${TRUST}"; exit 1; }
api GET "/api/v1/incidents/${INCIDENT_ID}/evidence/${EVIDENCE_ID}/content" >/dev/null
python3 - "$ATTESTATION_BODY" <<'PY'
import hashlib, json, sys
sent = json.loads(sys.argv[1])['evidence']
served = open('/tmp/g13a1-body.json', 'rb').read()
assert hashlib.sha256(served).hexdigest() == sent['contentRef'].split(':', 1)[1], 'served bytes do not match contentRef'
assert served.decode() == sent['content']['body'], 'served bytes differ from the signed body'
PY
ok "evidence ${EVIDENCE_ID} SOURCE_ATTESTED, bytes read back identical"

step "A/B workspace boundary through the Gateway"
GW_SOURCE_B="$(python3 - "$WORKSPACE_B" "$PLUGIN_HOST" <<'PY'
import json, sys
print(json.dumps({"workspaceId": sys.argv[1], "name": "zabbix-b", "endpoint": f"http://{sys.argv[2]}:18090/api_jsonrpc.php", "credential": {"kind": "api-token", "ref": "secretref:zabbix/main"}}))
PY
)"
code="$(gateway POST /api/zabbix-source/sources "$GW_SOURCE_B")"
[ "$code" = "201" ] || { echo "B source failed: $code"; exit 1; }
SOURCE_B="$(json "d['sourceId']" < /tmp/g13a1-body.json)"
code="$(gateway POST "/api/zabbix-source/sources/${SOURCE_B}/collect" "$COLLECT_BODY")"
[ "$code" = "200" ] || { echo "B collect failed: $code"; exit 1; }
COLLECTION_B="$(json "d['collectionId']" < /tmp/g13a1-body.json)"
code="$(gateway POST "/api/zabbix-source/collections/${COLLECTION_B}/attestation" "{\"incidentId\":\"${INCIDENT_ID}\",\"kind\":\"METRIC_SNAPSHOT\"}")"
[ "$code" = "200" ] || { echo "B attestation failed: $code"; exit 1; }
EVIDENCE_B="$(python3 - <<'PY'
import json
d = json.load(open('/tmp/g13a1-body.json'))['evidence']
print(json.dumps({'kind': d['kind'], 'source': d['source'], 'collectedAt': d['collectedAt'], 'contentRef': d['contentRef'], 'content': d['content'], 'attestation': d['attestation']}))
PY
)"
code="$(api POST "/api/v1/incidents/${INCIDENT_ID}/evidence" "$EVIDENCE_B")"
CODE_BODY="$(json "d['code']" < /tmp/g13a1-body.json)"
[ "$code" = "403" ] && [ "$CODE_BODY" = "EVIDENCE_WORKSPACE_MISMATCH" ] || { echo "cross-workspace write was not refused: $code $CODE_BODY"; exit 1; }
ok "B collection to A incident refused (EVIDENCE_WORKSPACE_MISMATCH)"

step "browser through the real stack"
UI_RESULT="PASS"
if [ "${G13A1_SKIP_UI:-0}" = "1" ]; then
  UI_RESULT="SKIPPED"
  echo "SKIP browser step (G13A1_SKIP_UI=1); the UI is certified by the #39 browser suite, not by a green shell line"
else
  # The A.1 branch does not carry the DS-V1-2 support file; the served dist is
  # built from #39, so take the one test helper from that branch for this run and
  # delete it afterwards. This is a harness dependency, not a product change.
  SUPPORT=tests/ui/support/workbench-fixtures.ts
  CREATED_SUPPORT=0
  if [ ! -f "$SUPPORT" ]; then
    mkdir -p tests/ui/support
    git show "feat/g13-a-collect-ui:$SUPPORT" > "$SUPPORT" || { echo "cannot obtain the UI support file from feat/g13-a-collect-ui"; exit 1; }
    CREATED_SUPPORT=1
  fi
  if (
    cd tests/ui
    HOME="$REAL_HOME" OPSWEAVE_URL="$URL" G13A1_INCIDENT_ID="$INCIDENT_ID" G13A1_SOURCE_ID="$SOURCE_ID" \
      pnpm exec playwright test g13a1-real-collect.spec.ts --workers=1 --reporter=line
  ); then
    [ "$CREATED_SUPPORT" = "1" ] && rm -f "$SUPPORT"
    ok "browser collect + save passed"
  else
    [ "$CREATED_SUPPORT" = "1" ] && rm -f "$SUPPORT"
    bad "browser collect + save failed"
    exit 1
  fi
fi

step "investigator and human verdict"
STARTED="$(api POST "/api/v1/incidents/${INCIDENT_ID}/investigations" "{\"idempotencyKey\":\"g13a1-$(date +%s)-$$\",\"scenario\":\"AUTO\"}")"
case "$STARTED" in 200|201|202) ;; *) echo "investigation start failed: $STARTED $(cat /tmp/g13a1-body.json)"; exit 1;; esac
RUN_ID="$(json "d['runId']" < /tmp/g13a1-body.json)"
for _ in $(seq 1 60); do
  RUN_STATUS="$(json "d['status']" < /tmp/g13a1-body.json)"
  [ "$RUN_STATUS" = "RUNNING" ] || break
  sleep 0.25
  api GET "/api/v1/incidents/${INCIDENT_ID}/investigations/${RUN_ID}" >/dev/null
done
RUN_STATUS="$(json "d['status']" < /tmp/g13a1-body.json)"
ADAPTER="$(json "d['adapter']" < /tmp/g13a1-body.json)"
SYNTHETIC="$(json "d['synthetic']" < /tmp/g13a1-body.json)"
[ "$RUN_STATUS" != "RUNNING" ] && [ "$ADAPTER" = "TEST_FIXTURE" ] && [ "$SYNTHETIC" = "True" ] || { echo "investigator was not the labelled TEST_FIXTURE: status=$RUN_STATUS adapter=$ADAPTER synthetic=$SYNTHETIC"; exit 1; }
python3 - "$EVIDENCE_ID" <<'PY2'
import json, sys
d = json.load(open('/tmp/g13a1-body.json'))
eid = sys.argv[1]
cited = any(
    c.get('evidenceId') == eid
    for h in d.get('hypotheses') or []
    for c in (h.get('supportingEvidence') or []) + (h.get('contradictingEvidence') or [])
)
assert cited, f'investigator did not cite {eid}'
PY2
ok "Investigator (TEST_FIXTURE) read and cited ${EVIDENCE_ID}"

VERDICT="$(api POST "/api/v1/incidents/${INCIDENT_ID}/verdict" '{"verdict":"CONFIRMED","rationale":"the signed telemetry snapshot shows the CPU saturation recorded at the incident start"}')"
[ "$VERDICT" = "201" ] || { echo "human verdict failed: $VERDICT $(cat /tmp/g13a1-body.json)"; exit 1; }
api GET "/api/v1/incidents/${INCIDENT_ID}" >/dev/null
[ "$(json "d['humanVerdict']['verdict']" < /tmp/g13a1-body.json)" = "CONFIRMED" ] || { echo "human verdict was not recorded"; exit 1; }
ok "human verdict CONFIRMED written separately from the AI hypothesis"

step "a historical source fails closed on the read path"
SCHEMA="$(psql "$DB_URL" -tAc "select schema_name from kernel.plugin_storage_bindings where plugin_id='opsweave.zabbix-source'")"
[ -n "$SCHEMA" ] || { echo "plugin storage schema not found"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update ${SCHEMA}.zabbix_sources set endpoint='${ATTACK_ENDPOINT}' where source_id='${SOURCE_ID}'" >/dev/null
: > "$ATTACKER_LOG"
code="$(gateway GET "/api/zabbix-source/sources/${SOURCE_ID}/hosts")"
[ "$code" = "422" ] && [ "$(json "d['code']" < /tmp/g13a1-body.json)" = "ZBX_CREDENTIAL_ENDPOINT_MISMATCH" ] || { echo "historical endpoint was not refused: $code $(cat /tmp/g13a1-body.json)"; exit 1; }
[ ! -s "$ATTACKER_LOG" ] || { echo "the historical source leaked a credential: $(cat "$ATTACKER_LOG")"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update ${SCHEMA}.zabbix_sources set endpoint='${APPROVED_ENDPOINT}' where source_id='${SOURCE_ID}'" >/dev/null
ok "historical source with an unapproved endpoint is refused before the secret is resolved"

step "plugin and Kernel restart"
PLUGIN_CID="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" --filter label=opsweave.plugin-id=opsweave.zabbix-source | head -n1)"
[ -n "$PLUGIN_CID" ] || { echo "plugin container not found"; exit 1; }
docker restart "$PLUGIN_CID" >/dev/null
for _ in $(seq 1 120); do
  code="$(gateway GET /api/zabbix-source/sources)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-}" = "200" ] || { echo "gateway did not recover after plugin restart"; exit 1; }
COUNT="$(json "len(d['items'])" < /tmp/g13a1-body.json)"
[ "$COUNT" = "2" ] || { echo "sources after restart: ${COUNT}"; exit 1; }
ok "plugin restart: both sources still listed"

stop_kernel
start_kernel "$SECRETS_JSON" "$BINDINGS_JSON"
for _ in $(seq 1 120); do
  code="$(gateway GET /api/zabbix-source/sources)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-}" = "200" ] || { echo "gateway did not recover after Kernel restart"; exit 1; }
api GET "/api/v1/incidents/${INCIDENT_ID}/evidence/${EVIDENCE_ID}/content" >/dev/null
python3 - "$ATTESTATION_BODY" <<'PY'
import hashlib, json, sys
sent = json.loads(sys.argv[1])['evidence']
served = open('/tmp/g13a1-body.json', 'rb').read()
assert hashlib.sha256(served).hexdigest() == sent['contentRef'].split(':', 1)[1]
PY
ok "Kernel restart: source and evidence still readable"

step "container security"
# The Kernel restart can make the Node recreate the container, so resolve the
# current one by label instead of reusing the id captured before the restart.
PLUGIN_CID="$(docker ps -q --filter "label=opsweave.node-id=$NODE_ID" --filter label=opsweave.plugin-id=opsweave.zabbix-source | head -n1)"
[ -n "$PLUGIN_CID" ] || { echo "plugin container not found after restart"; exit 1; }
INSPECT_FILE="$(mktemp)"
chmod 600 "$INSPECT_FILE"
docker inspect "$PLUGIN_CID" > "$INSPECT_FILE"
python3 - "$INSPECT_FILE" "$DIGEST" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))[0]
digest = sys.argv[2]
assert c['Config'].get('User') in ('65532:65532', '65532'), c['Config'].get('User')
assert c['HostConfig'].get('ReadonlyRootfs') is True, 'rootfs is not read-only'
assert (c['HostConfig'].get('Memory') or 0) > 0, 'no memory limit'
assert (c['HostConfig'].get('NanoCpus') or 0) > 0, 'no CPU limit'
assert (c['HostConfig'].get('PidsLimit') or 0) > 0, 'no PID limit'
assert c['HostConfig'].get('Privileged') is not True, 'container is privileged'
assert 'ALL' in (c['HostConfig'].get('CapDrop') or []), 'capabilities were not dropped'
assert any('no-new-privileges' in opt for opt in (c['HostConfig'].get('SecurityOpt') or [])), 'no-new-privileges missing'
mounts = json.dumps(c.get('Mounts') or []) + json.dumps(c['HostConfig'].get('Binds') or [])
assert 'docker.sock' not in mounts, 'docker socket is mounted'
image = c['Config'].get('Image') or ''
assert '@sha256:' in image, f'image is not digest-pinned: {image}'
assert image.split('@sha256:')[1] == digest.split('@sha256:')[1], (image, digest)
print('security: user=%s readonly=%s memory=%s nanocpus=%s pids=%s image=%s' % (
    c['Config'].get('User'), c['HostConfig'].get('ReadonlyRootfs'),
    c['HostConfig'].get('Memory'), c['HostConfig'].get('NanoCpus'),
    c['HostConfig'].get('PidsLimit'), image.split('@sha256:')[1][:12]))
PY
for log in "$FIXTURE_LOG" "$KERNEL_LOG" "$NODE_LOG"; do
  [ -f "$log" ] || bad "log missing: $log"
done
for secret in "$ZABBIX_TOKEN" "$ADAPTER_SECRET"; do
  if grep -Fq "$secret" "$FIXTURE_LOG" "$KERNEL_LOG" "$NODE_LOG" 2>/dev/null; then
    bad "a configured secret appears in Kernel/Node/fixture logs"
  else
    ok "no configured secret in Kernel/Node/fixture logs"
  fi
done
if docker logs "$PLUGIN_CID" 2>&1 | grep -Fq "$ZABBIX_TOKEN"; then bad "the Zabbix token appears in container logs"; else ok "no Zabbix token in container logs"; fi
rm -f "$INSPECT_FILE"

step "result"
[ "$FAILED" = "0" ] && echo "G13-A.1 GATEWAY/NODE/OCI GOLDEN PATH: PASS (ui=${UI_RESULT:-NOT_RUN}, upstream=UPSTREAM_ZABBIX_FIXTURE, real_zabbix=NOT_RUN)" || { echo "G13-A.1 GOLDEN PATH: FAIL"; exit 1; }
