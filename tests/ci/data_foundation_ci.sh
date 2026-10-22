#!/usr/bin/env bash
# Run the 0.0.2 Data Foundation Golden Path on a Linux CI host with Docker.
# This script intentionally uses real OpsWeave Kernel/Node processes, real
# PostgreSQL, real OCI containers and the Kernel Capability Gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export OPSWEAVE_URL="http://127.0.0.1:18181"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  docker ps -aq --filter label=opsweave.managed=true | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== build binaries and frontends"
cargo build -q -p opsweave-kernel -p opsweave-node -p opsweave-opsctl
pnpm install --frozen-lockfile
pnpm --filter @opsweave/platform-web build >/dev/null
mkdir -p keys
./target/debug/opsctl keygen --out-dir keys >/dev/null

echo "== local OCI registry"
docker rm -f opsweave-ci-registry >/dev/null 2>&1 || true
docker run -d --name opsweave-ci-registry -p 5001:5000 registry:2 >/dev/null

echo "== data plugin images and signed bundles"
OPSWEAVE_REGISTRY=localhost:5001 scripts/build-data-plugins.sh

echo "== fixture server"
(cd tests/fixtures && python3 -m http.server 18090 --bind 0.0.0.0 >/tmp/data-fixture.log 2>&1) &
PIDS+=($!)
sleep 1

echo "== Kernel"
env \
  OPSWEAVE_BIND=0.0.0.0:18181 \
  OPSWEAVE_PUBLIC_URL="$OPSWEAVE_URL" \
  DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' \
  OPSWEAVE_DATA_DIR="$ROOT/data-ci" \
  OPSWEAVE_WEB_DIST="$ROOT/apps/platform-web/dist" \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@opsweave.local \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD='OpsWeave!2026' \
  OPSWEAVE_BOOTSTRAP_ADMIN_NAME='Platform Admin' \
  OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
  OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$(cat keys/publisher.pub)" \
  OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1 \
  OPSWEAVE_ALLOWED_NODE_DATA_HOSTS=127.0.0.1,localhost,::1 \
  OPSWEAVE_PLUGIN_DB_HOST=172.17.0.1 \
  OPSWEAVE_PLUGIN_KERNEL_URL=http://172.17.0.1:18181 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=172.17.0.1 \
  RUST_LOG=info ./target/debug/opsweave-kernel >/tmp/data-kernel.log 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -fsS "$OPSWEAVE_URL/livez" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS "$OPSWEAVE_URL/livez" >/dev/null

echo "== authenticate and enroll two real Node runtimes"
./target/debug/opsctl login --email admin@opsweave.local --password 'OpsWeave!2026' >/dev/null
start_node() {
  local name="$1" port="$2" token="$3"
  env \
    OPSWEAVE_KERNEL_URL="$OPSWEAVE_URL" \
    OPSWEAVE_ENROLLMENT_TOKEN="$token" \
    OPSWEAVE_NODE_NAME="$name" \
    OPSWEAVE_NODE_LABELS='role=node' \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:$port" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:$port" \
    OPSWEAVE_NODE_STATE_DIR="$ROOT/data-ci/$name" \
    OPSWEAVE_DOCKER_HOST='unix:///var/run/docker.sock' \
    RUST_LOG=info ./target/debug/opsweave-node >"/tmp/$name.log" 2>&1 &
  PIDS+=($!)
}
TOKEN_A="$(./target/debug/opsctl node-token --label node-a)"
TOKEN_B="$(./target/debug/opsctl node-token --label node-b)"
start_node node-a 9101 "$TOKEN_A"
start_node node-b 9102 "$TOKEN_B"
for _ in $(seq 1 90); do
  READY="$(curl -fsS -H "Authorization: Bearer $(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')" "$OPSWEAVE_URL/api/v1/nodes" | python3 -c 'import json,sys;print(sum(1 for n in json.load(sys.stdin) if n.get("status")=="READY" and not n.get("stale")))')"
  [ "$READY" = "2" ] && break
  sleep 1
done
[ "${READY:-0}" = "2" ] || { echo "nodes not ready"; exit 1; }

echo "== install/activate both data plugins"
scripts/demo_data_up.sh

echo "== real OCI Golden Path"
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_foundation.sh
