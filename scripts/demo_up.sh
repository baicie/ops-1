#!/usr/bin/env bash
# Start a local, reproducible OpsWeave 0.0.1 environment:
# Kernel + PostgreSQL + 2 Node Runtimes + three signed Runtime v1 plugins.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KERNEL_PORT="${OPSWEAVE_PORT:-18181}"
KERNEL_URL="http://127.0.0.1:${KERNEL_PORT}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}"
RESET="${RESET:-1}"
BUILD="${BUILD:-0}"
DB="${OPSWEAVE_DB:-opsweave}"
DATABASE_URL="${OPSWEAVE_DATABASE_URL:-postgres://localhost/${DB}?sslmode=disable}"

kill_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true; }

echo "== stop previous local platform processes"
kill_port "$KERNEL_PORT"; kill_port 9101; kill_port 9102
sleep 1

if [ ! -f keys/publisher.key ]; then
  cargo build -q -p opsweave-opsctl
  ./target/debug/opsctl keygen --out-dir keys >/dev/null
fi
PUBLIC_KEY="$(cat keys/publisher.pub)"

if ! docker ps --format '{{.Names}}' | grep -qx 'opsweave-registry'; then
  docker rm -f opsweave-registry >/dev/null 2>&1 || true
  docker run -d --name opsweave-registry -p 127.0.0.1:5001:5000 registry:2 >/dev/null
  sleep 1
fi

if [ "$RESET" = "1" ]; then
  echo "== reset control-plane database and local state"
  dropdb --if-exists --force "$DB" 2>/dev/null || true
  createdb "$DB"
  rm -rf data
  docker ps -a --filter label=opsweave.managed=true --format '{{.Names}}' | xargs -r docker rm -f >/dev/null 2>&1 || true
fi

cargo build -q -p opsweave-kernel -p opsweave-node -p opsweave-opsctl
pnpm --filter @opsweave/platform-web build >/dev/null

if [ "$BUILD" = "1" ]; then
  BUILD=1 scripts/build-plugins.sh
elif [ ! -f dist/plugins/hello-ops-0.0.1.plugin.zip ]; then
  echo "No plugin bundles found. Run BUILD=1 scripts/demo_up.sh for a full build." >&2
  exit 1
fi

echo "== start kernel"
nohup env \
  OPSWEAVE_BIND="127.0.0.1:${KERNEL_PORT}" \
  OPSWEAVE_PUBLIC_URL="$KERNEL_URL" \
  DATABASE_URL="$DATABASE_URL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL="$ADMIN_EMAIL" \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME="Platform Admin" \
  OPSWEAVE_DATA_DIR="$ROOT/data" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-web/dist" \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$PUBLIC_KEY" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=host.docker.internal \
  OPSWEAVE_LOG_FORMAT=json \
  ./target/debug/opsweave-kernel > /tmp/opsweave-kernel.log 2>&1 &
echo $! > /tmp/opsweave-kernel.pid
for _ in $(seq 1 40); do
  if curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -fsS "$KERNEL_URL/livez" >/dev/null 2>&1; then
  echo "Kernel did not become live; see /tmp/opsweave-kernel.log" >&2
  exit 1
fi

echo "== authenticate"
./target/debug/opsctl --url "$KERNEL_URL" login --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null
TOKEN="$(python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])')"

start_node() {
  local name="$1" port="$2" token="$3"
  nohup env \
    OPSWEAVE_KERNEL_URL="$KERNEL_URL" \
    OPSWEAVE_ENROLLMENT_TOKEN="$token" \
    OPSWEAVE_NODE_NAME="$name" \
    OPSWEAVE_NODE_LABELS="role=node,zone=local" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:${port}" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:${port}" \
    OPSWEAVE_NODE_STATE_DIR="$ROOT/data/$name" \
    OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
    ./target/debug/opsweave-node > "/tmp/opsweave-$name.log" 2>&1 &
  echo $! > "/tmp/opsweave-$name.pid"
}

if [ "$RESET" = "1" ]; then
  echo "== enroll two nodes"
  TOKEN_A="$(./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-a 2>/dev/null)"
  TOKEN_B="$(./target/debug/opsctl --url "$KERNEL_URL" node-token --label node-b 2>/dev/null)"
  start_node node-a 9101 "$TOKEN_A"
  start_node node-b 9102 "$TOKEN_B"
else
  echo "== restart nodes with existing identities"
  start_node node-a 9101 ""
  start_node node-b 9102 ""
fi

for _ in $(seq 1 60); do
  READY="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$KERNEL_URL/api/v1/nodes" 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(sum(1 for n in d if n.get("status")=="READY" and not n.get("stale")))' 2>/dev/null || echo 0)"
  if [ "$READY" = "2" ]; then break; fi
  sleep 1
done
if [ "${READY:-0}" != "2" ]; then
  echo "Warning: expected 2 READY nodes, got ${READY:-0}. Check /tmp/opsweave-node-*.log" >&2
fi

echo "== upload signed bundles"
for bundle in dist/plugins/hello-ops-0.0.1.plugin.zip dist/plugins/hello-ops-0.0.2.plugin.zip dist/plugins/hello-go-0.0.1.plugin.zip dist/plugins/hello-java-0.0.1.plugin.zip; do
  ./target/debug/opsctl --url "$KERNEL_URL" install "$bundle" >/dev/null
done

echo "== deploy and activate TypeScript full-stack plugin (2 replicas)"
./target/debug/opsctl --url "$KERNEL_URL" deploy dev.opsweave.hello 0.0.1 --replicas 2 --selector role=node --wait
./target/debug/opsctl --url "$KERNEL_URL" activate dev.opsweave.hello 0.0.1

echo "== deploy and activate Go backend plugin"
./target/debug/opsctl --url "$KERNEL_URL" deploy dev.opsweave.hello-go 0.0.1 --replicas 1 --selector role=node --wait
./target/debug/opsctl --url "$KERNEL_URL" activate dev.opsweave.hello-go 0.0.1

echo "== deploy and activate Java 21 backend plugin"
./target/debug/opsctl --url "$KERNEL_URL" deploy dev.opsweave.hello-java 0.0.1 --replicas 1 --selector role=node --wait
./target/debug/opsctl --url "$KERNEL_URL" activate dev.opsweave.hello-java 0.0.1

echo
echo "OpsWeave 0.0.1 is up at $KERNEL_URL"
echo "  admin:  $ADMIN_EMAIL / $ADMIN_PASSWORD"
echo "  nodes:  http://127.0.0.1:9101/healthz · http://127.0.0.1:9102/healthz"
echo "  logs:   /tmp/opsweave-kernel.log · /tmp/opsweave-node-a.log · /tmp/opsweave-node-b.log"
./target/debug/opsctl --url "$KERNEL_URL" plugins
