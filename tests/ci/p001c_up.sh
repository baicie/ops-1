#!/usr/bin/env bash
# P001-C1: start an ISOLATED OpsWeave platform for the TypeScript golden path.
#
# Why this exists instead of `scripts/demo_up.sh`:
#
#   demo_up.sh hard-codes OPSWEAVE_DATA_DIR="$ROOT/data" and defaults RESET=1,
#   which runs `dropdb --force` and `rm -rf data`. This checkout has a live
#   `data/` with three installed plugins and two node identities, and an
#   `opsweave` database with their rows. The task forbids deleting installed
#   plugin data, so demo_up.sh must not be run here.
#
# Everything below is namespaced under /tmp/p001c and database `p001c`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost

KERNEL_PORT=18281
KERNEL_URL="http://127.0.0.1:${KERNEL_PORT}"
DB=p001c
DATABASE_URL="postgres://localhost/${DB}?sslmode=disable"
STATE=/tmp/p001c
ADMIN_EMAIL=admin@opsweave.local
ADMIN_PASSWORD='OpsWeave!2026'

mkdir -p "$STATE"/{data,node-a,node-b}

echo "== reset ONLY the isolated database and state"
dropdb --if-exists --force "$DB" 2>/dev/null || true
createdb "$DB"
rm -rf "$STATE"/data/*
# Only containers this script's own nodes created, matched by the plugin label.
docker ps -aq --filter label=opsweave.managed=true | xargs -r docker rm -f >/dev/null 2>&1 || true

PUBLIC_KEY="$(cat keys/publisher.pub)"

echo "== start kernel on :${KERNEL_PORT}"
nohup env \
  OPSWEAVE_BIND="127.0.0.1:${KERNEL_PORT}" \
  OPSWEAVE_PUBLIC_URL="$KERNEL_URL" \
  DATABASE_URL="$DATABASE_URL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME="Platform Admin" \
  OPSWEAVE_DATA_DIR="$STATE/data" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-console/dist" \
  OPSWEAVE_OPS_WEB_DIST="$ROOT/apps/ops-web/dist" \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$PUBLIC_KEY" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=host.docker.internal \
  OPSWEAVE_LOG_FORMAT=json \
  ./target/debug/opsweave-kernel > "$STATE/kernel.log" 2>&1 &
echo $! > "$STATE/kernel.pid"

for _ in $(seq 1 60); do
  curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1 || {
  echo "kernel did not become live; see $STATE/kernel.log" >&2; tail -30 "$STATE/kernel.log" >&2; exit 1; }
echo "   kernel live"

echo "== authenticate"
./target/debug/opsctl --url "$KERNEL_URL" login --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null
TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.opsweave/session.json')))['token'])")"
echo "$TOKEN" > "$STATE/token"

start_node() {
  local name="$1" port="$2" token="$3"
  nohup env \
    OPSWEAVE_KERNEL_URL="$KERNEL_URL" \
    OPSWEAVE_ENROLLMENT_TOKEN="$token" \
    OPSWEAVE_NODE_NAME="$name" \
    OPSWEAVE_NODE_LABELS="role=node,zone=local" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${port}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${port}" \
    OPSWEAVE_NODE_STATE_DIR="$STATE/$name" \
    OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    ./target/debug/opsweave-node > "$STATE/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
}

echo "== enroll two nodes"
TOKEN_A="$(./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-a 2>/dev/null)"
TOKEN_B="$(./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-b 2>/dev/null)"
start_node node-a 9201 "$TOKEN_A"
start_node node-b 9202 "$TOKEN_B"

READY=0
for _ in $(seq 1 90); do
  READY="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$KERNEL_URL/api/v1/nodes" 2>/dev/null \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sum(1 for n in d if n.get("status")=="READY" and not n.get("stale")))' 2>/dev/null || echo 0)"
  [ "$READY" = "2" ] && break
  sleep 1
done
if [ "$READY" != "2" ]; then
  echo "expected 2 READY nodes, got ${READY:-0}" >&2
  tail -20 "$STATE"/node-a.log "$STATE"/node-b.log >&2 || true
  exit 1
fi
echo "   2 nodes READY"
echo "== platform up: $KERNEL_URL"
