#!/usr/bin/env bash
# Run the 0.0.2 Data Foundation Golden Path on a Linux CI host with Docker.
# This script intentionally uses real OpsWeave Kernel/Node processes, real
# PostgreSQL, real OCI containers and the Kernel Capability Gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export OPSWEAVE_URL="http://127.0.0.1:18181"
export OPSWEAVE_DATA_CATALOG_SELECTOR="zone=node-a"
export OPSWEAVE_DATA_INTEGRATION_SELECTOR="zone=node-b"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  docker ps -aq --filter label=opsweave.managed=true | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== build binaries and frontends"
cargo build -q -p opsweave-kernel -p opsweave-node -p opsweave-opsctl -p opsweave-pipeline-worker
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
  OPSWEAVE_WORKLOAD_TOKEN_SECONDS=5 \
  OPSWEAVE_WORKLOAD_TOKEN_REFRESH_GRACE_SECONDS=1 \
  OPSWEAVE_PLUGIN_DB_HOST=172.17.0.1 \
  OPSWEAVE_PLUGIN_KERNEL_URL=http://172.17.0.1:18181 \
  OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS=172.17.0.1 \
  RUST_LOG=info ./target/debug/opsweave-kernel >/tmp/data-kernel.log 2>&1 &
KERNEL_PID=$!
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
    OPSWEAVE_NODE_LABELS="role=node,zone=$name" \
    OPSWEAVE_NODE_DATA_BIND="127.0.0.1:$port" \
    OPSWEAVE_NODE_DATA_ENDPOINT="http://127.0.0.1:$port" \
    OPSWEAVE_NODE_STATE_DIR="$ROOT/data-ci/$name" \
    OPSWEAVE_DOCKER_HOST='unix:///var/run/docker.sock' \
    OPSWEAVE_NODE_TOKEN_REFRESH_SECONDS=1 \
    OPSWEAVE_NODE_WORKER_ENABLED=1 \
    OPSWEAVE_PIPELINE_WORKER_BIN="$ROOT/target/debug/opsweave-pipeline-worker" \
    OPSWEAVE_WORKER_SOURCE_ALLOWLIST=172.17.0.1,127.0.0.1 \
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
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_authz.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_reliability.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/storage_migration_concurrency.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/storage_migration_parser.sh
tests/acceptance/data_token_security.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/dynamic_catalog_pipeline.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_jobs.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/catalog_fenced_sink.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker_advanced.sh
OPSWEAVE_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/opsweave' tests/acceptance/pipeline_worker_node_managed.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_ssrf.sh
if [ "${RUN_BROWSER_SMOKE:-0}" = "1" ]; then
  echo "== browser extension smoke and business flows"
  OPSWEAVE_URL="$OPSWEAVE_URL" OPSWEAVE_UI_FIXTURE=http://172.17.0.1:18090/data-hosts.json pnpm --filter @opsweave/ui-tests exec playwright test data-foundation.spec.ts data-foundation-flows.spec.ts
fi
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json OPSWEAVE_TEST_NODE_REVOCATION=0 OPSWEAVE_TEST_KERNEL_PID="$KERNEL_PID" tests/acceptance/data_token_refresh.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/capability_multi_provider.sh
OPSWEAVE_DATA_FIXTURE=http://172.17.0.1:18090/data-hosts.json tests/acceptance/data_token_revocation.sh
